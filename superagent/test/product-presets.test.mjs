import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProductHost, CoreError, Engine, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { productHttpPlugin } from '../dist/index.js'

const preset = (id = 'reviewer') => ({ id, name: 'Reviewer', model: { provider: 'mock', model: 'writer' },
  instructions: '{{goal}} under {{constraints}}.', skills: ['review'], appearance: { shape: 'square' } })
const copy = (identity = 'export-one') => ({ sourceIdentity: identity, sourceBotId: 'old-bot', targetRole: 'worker',
  state: { mainBotIds: ['old-bot'], bots: { 'old-bot': { name: 'Old reviewer', model: 'mock/writer',
    instructions: '{{goal}} under {{constraints}}.', skills: ['review'], main: true,
    admin: true, permissions: ['all'], unknownResource: 'private-value' } } } })

test('applying a preset preserves an in-flight Worker model and routes the next turn to the new revision', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-preset-in-flight-'))
  const requests = []
  let signalStarted
  let releaseOld
  const started = new Promise(resolve => { signalStarted = resolve })
  const oldTurn = new Promise(resolve => { releaseOld = resolve })
  const native = await nativeContext(join(directory, 'sessions'), async function* (options) {
    requests.push(options.model)
    if (options.model === 'worker') { signalStarted(); await oldTurn }
    yield* textResponse('Ready.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'desktop', actorId: 'owner', allowedActorIds: ['owner'] }, {}, sessions)
  t.after(async () => {
    releaseOld()
    await engine.shutdown(); await sessions.close(); await native.fiber.dispose(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const initial = await engine.getRoleConfig()
  await engine.createRolePreset({ instanceId: 'personal', commandId: 'create', preset: preset() })
  const running = sessions.run({ sessionId: 'worker-before', role: 'worker', text: 'Review this.', tools: [] })
  try {
    await started
    const applied = await engine.applyRolePreset({ instanceId: 'personal', commandId: 'apply',
      presetId: 'reviewer', targetRole: 'worker', expectedRevision: initial.revision })
    assert.equal(applied.revision, initial.revision + 1)
  } finally { releaseOld() }
  await running
  await sessions.run({ sessionId: 'worker-after', role: 'worker', text: 'Review this.', tools: [] })
  assert.deepEqual(requests, ['worker', 'writer'])
  assert.equal((await engine.getRoleConfig()).roles.worker.model.model, 'writer')
})

test('product Host authorizes preset commands and persists reviewed choices and role revision ownership', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-presets-'))
  const opened = []
  const routes = new Map()
  const open = async () => {
    const native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Ready.') })
    native.llm.listProviders = () => [{ id: 'mock' }]
    native.llm.listModels = async () => [{ id: 'main' }, { id: 'router' }, { id: 'worker' }, { id: 'writer' }]
    const host = await createProductHost(native, { databasePath: join(directory, 'state.sqlite'),
      main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
      worker: { provider: 'mock', model: 'worker' } })
    native.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
    native.provide('superagentProduct', host)
    await native.plugin(productHttpPlugin)
    opened.push({ host, native })
    return host
  }
  t.after(async () => {
    for (const { host, native } of opened.reverse()) { await host.close(); await native.fiber.dispose() }
    await rm(directory, { recursive: true, force: true })
  })
  const host = await open()
  const http = async (endpoint, payload) => {
    const response = await routes.get('/api/product').fetch(new Request('http://fixture/api/product', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) }))
    return { status: response.status, ...await response.json() }
  }
  const instanceId = 'personal'
  const create = { instanceId, commandId: 'new-preset', preset: preset() }
  await assert.rejects(host.dispatch('preset-list', { instanceId: 'other' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('preset-list', { instanceId }, { id: 'remote' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('preset-create', create, { id: 'remote' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('preset-create', { ...create, permission: 'admin' }), { code: 'INVALID_INPUT' })
  await assert.rejects(host.dispatch('preset-create', { ...create, preset: { ...preset(), capabilities: ['all'] } }), { code: 'INVALID_PRESET' })
  const createdResponse = await http('preset-create', create)
  assert.equal(createdResponse.status, 200)
  const created = createdResponse.value
  assert.equal(created.revision, 1)
  assert.deepEqual(await host.dispatch('preset-create', create), created)
  await assert.rejects(host.dispatch('preset-create', { ...create, preset: preset('other') }), { code: 'IDENTITY_CONFLICT' })

  const imported = copy()
  const preview = await host.dispatch('preset-preview', { instanceId, commandId: 'preview-one', copy: imported })
  assert.ok(preview.preview.ignored.includes('bot.admin'))
  assert.doesNotMatch(JSON.stringify(preview), /private-value|permissions.*all/u)
  const selected = await host.dispatch('preset-select', { instanceId, commandId: 'select-one', previewId: preview.id,
    decision: 'select', copy: imported, preset: preset('from-old') })
  assert.equal(selected.status, 'selected')
  const repeated = await host.dispatch('preset-preview', { instanceId, commandId: 'preview-again', copy: imported })
  const duplicate = await host.dispatch('preset-select', { instanceId, commandId: 'select-again', previewId: repeated.id,
    decision: 'select', copy: imported, preset: preset('from-old') })
  assert.equal(duplicate.status, 'duplicate')
  const conflictPreview = await host.dispatch('preset-preview', { instanceId, commandId: 'preview-conflict', copy: imported })
  const conflict = await host.dispatch('preset-select', { instanceId, commandId: 'select-conflict', previewId: conflictPreview.id,
    decision: 'select', copy: imported, preset: { ...preset('from-old'), name: 'Changed' } })
  assert.equal(conflict.status, 'conflict')
  const replaced = await host.dispatch('preset-select', { instanceId, commandId: 'replace-source', previewId: conflictPreview.id,
    decision: 'replace', expectedDecisionId: selected.id, copy: imported, preset: preset('from-updated') })
  assert.equal(replaced.status, 'replaced')
  assert.equal(replaced.conflictWith, selected.id)
  assert.equal((await host.dispatch('preset-list', { instanceId })).items.find(item => item.id === 'from-old')?.status, 'active')
  await assert.rejects(host.dispatch('preset-select', { instanceId, commandId: 'remote-replace', previewId: conflictPreview.id,
    decision: 'replace', expectedDecisionId: selected.id, copy: imported, preset: preset('other') }, { id: 'remote' }),
  { code: 'SOURCE_NOT_AUTHORIZED' })
  const skippedPreview = await host.dispatch('preset-preview', { instanceId, commandId: 'preview-skip', copy: copy('another-export') })
  const skipped = await host.dispatch('preset-select', { instanceId, commandId: 'skip-one', previewId: skippedPreview.id, decision: 'skip' })
  assert.equal(skipped.status, 'skipped')
  assert.deepEqual((await host.dispatch('preset-imports', { instanceId })).items.map(item => item.status).sort(),
    ['conflict', 'duplicate', 'replaced', 'selected', 'skipped'])
  const initial = await host.dispatch('settings', { instanceId })
  const application = { instanceId, commandId: 'apply-one', presetId: created.id, targetRole: 'worker', expectedRevision: initial.revision }
  const appliedResponse = await http('preset-apply', application)
  assert.equal(appliedResponse.status, 200, JSON.stringify(appliedResponse))
  const applied = appliedResponse.value
  assert.equal(applied.revision, initial.revision + 1)
  assert.equal(applied.presetRevision, 1)
  assert.equal((await host.dispatch('settings', { instanceId })).roles.worker.name, 'Reviewer')
  assert.deepEqual(await host.dispatch('preset-apply', application), applied)
  assert.deepEqual(await host.dispatch('preset-application-read', { instanceId, commandId: 'apply-one' }), applied)
  await assert.rejects(host.dispatch('preset-apply', { ...application, targetRole: 'router' }), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(host.dispatch('preset-apply', { ...application, commandId: 'stale-application' }), { code: 'CONFIG_REVISION_CONFLICT' })
  await assert.rejects(host.dispatch('preset-apply', { ...application, commandId: 'bad-model', presetId: 'missing',
    expectedRevision: applied.revision }), { code: 'PRESET_UNAVAILABLE' })
  await host.close()
  const reopened = await open()
  assert.deepEqual(await reopened.dispatch('preset-application-read', { instanceId, commandId: 'apply-one' }), applied)
  assert.deepEqual((await reopened.dispatch('preset-applications', { instanceId })).items, [applied])
  assert.equal((await reopened.dispatch('preset-preview-read', { instanceId, previewId: preview.id })).id, preview.id)
  assert.equal((await reopened.dispatch('preset-import-read', { instanceId, importId: skipped.id })).status, 'skipped')
  assert.equal((await reopened.dispatch('preset-list', { instanceId })).items.length, 3)
})

test('Engine reconciles a lost preset-apply commit by its original command identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-preset-unknown-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  let loseReceipt = true
  const uncertain = {
    async transaction(instanceId, operation) {
      let applied = false
      const result = await storage.transaction(instanceId, tx => operation({ ...tx,
        insert: async (kind, key, value) => {
          if (kind === 'role-preset-application') applied = true
          return tx.insert(kind, key, value)
        } }))
      if (applied && loseReceipt) { loseReceipt = false; throw new CoreError('COMMIT_UNKNOWN', 'The commit response was lost.') }
      return result
    },
    async reconnect() { throw new CoreError('STORAGE_UNAVAILABLE', 'Connection unavailable.') },
    close: () => storage.close(),
  }
  const owner = new Engine(uncertain, 'personal', { sourceInstanceId: 'desktop', actorId: 'owner',
    allowedActorIds: ['owner', 'reader'], authoringActorIds: ['owner'] })
  const reader = new Engine(uncertain, 'personal', { sourceInstanceId: 'desktop', actorId: 'reader',
    allowedActorIds: ['owner', 'reader'], authoringActorIds: ['owner'] })
  assert.throws(() => reader.createRolePreset({ instanceId: 'personal', commandId: 'forbidden', preset: preset() }), { code: 'SOURCE_NOT_AUTHORIZED' })
  assert.throws(() => reader.previewRolePreset({ instanceId: 'personal', commandId: 'forbidden-preview', copy: copy() }), { code: 'SOURCE_NOT_AUTHORIZED' })
  assert.deepEqual((await reader.listRolePresets({ instanceId: 'personal' })).items, [])
  await owner.createRolePreset({ instanceId: 'personal', commandId: 'create', preset: preset() })
  const peer = new Engine(uncertain, 'personal', { sourceInstanceId: 'desktop', actorId: 'peer',
    allowedActorIds: ['owner', 'peer'], authoringActorIds: ['owner', 'peer'] })
  const other = await peer.createRolePreset({ instanceId: 'personal', commandId: 'create', preset: preset('peer-preset') })
  assert.equal(other.id, 'peer-preset', 'one actor cannot replay another actor’s preset command ID')
  const command = { instanceId: 'personal', commandId: 'apply-unknown', presetId: 'reviewer', targetRole: 'worker', expectedRevision: 1 }
  await assert.rejects(owner.applyRolePreset(command), { code: 'COMMIT_UNKNOWN' })
  const recorded = await owner.getRolePresetApplication({ instanceId: 'personal', commandId: command.commandId })
  assert.equal(recorded.revision, 2)
  assert.equal(recorded.presetId, 'reviewer')
  assert.deepEqual(await owner.applyRolePreset(command), recorded)
  assert.equal((await owner.getRoleConfig()).revision, 2)
  assert.equal((await owner.listRolePresetApplications({ instanceId: 'personal' })).items.length, 1)
  await assert.rejects(reader.applyRolePreset({ ...command, commandId: 'reader-apply', expectedRevision: 2 }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(owner.getRolePresetApplication({ instanceId: 'elsewhere', commandId: command.commandId }), { code: 'SOURCE_NOT_AUTHORIZED' })
})
