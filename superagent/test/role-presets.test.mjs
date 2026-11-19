import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Engine, RoleConfigStore } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

// This module is intentionally not registered in the shared package entry until its Host integration lands.
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/role-presets.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, target: 'node24' })
const presets = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)
const { createRolePreset, previewLegacyRolePreset, prepareLegacyPresetDecision, prepareRolePresetApplication } = presets

const manual = () => ({ id: 'writer', name: 'Writer', model: { provider: 'mock', model: 'writer' },
  instructions: '{{goal}} {{constraints}} Write clearly.', skills: ['office'], appearance: { shape: 'whale', color: '#123456' } })
const legacy = () => ({ version: 1, mainBotIds: ['old-writer'], credentials: { secret: 'do-not-project' },
  bots: { 'old-writer': { id: 'old-writer', name: 'Writer', model: 'mock/writer', effort: 'high',
    instructions: '{{goal}} {{constraints}} Write clearly.', skills: ['office'], color: '#123456', avatar: { shape: 'whale' },
    main: true, admin: true, permissions: ['admin'], capabilities: ['shell'], workDir: '/private',
    secret: 'do-not-project' } }, rooms: { private: {} }, works: { inFlight: {} } })
const source = state => ({ sourceIdentity: 'explicit-copy-1', sourceBotId: 'old-writer', state, targetRole: 'worker' })
const roles = () => ({ main: { name: 'Main', model: { provider: 'mock', model: 'main' }, instructions: '', skills: [] },
  router: { name: 'Router', model: { provider: 'mock', model: 'router' }, instructions: '', skills: [] },
  worker: { name: 'Worker', model: { provider: 'mock', model: 'worker' }, instructions: '', skills: [] } })

test('manual presets work without a legacy team and reject authority or unknown fields', () => {
  assert.deepEqual(createRolePreset(manual()), manual())
  for (const extra of [{ main: true }, { permissions: ['admin'] }, { capabilities: ['shell'] }, { source: { mainBot: true } }]) {
    assert.throws(() => createRolePreset({ ...manual(), ...extra }), { code: 'INVALID_PRESET' })
  }
  assert.throws(() => createRolePreset({ ...manual(), model: { ...manual().model, permission: 'admin' } }), { code: 'INVALID_CONFIG' })
  assert.throws(() => createRolePreset({ ...manual(), appearance: { image: 'https://example.invalid/photo.png' } }), { code: 'INVALID_PRESET' })
  assert.throws(() => createRolePreset({ ...manual(), skills: ['office', 'office'] }), { code: 'INVALID_CONFIG' })
  assert.throws(() => createRolePreset({ ...manual(), name: 'Writer\nAdmin' }), { code: 'INVALID_PRESET' })
})

test('preview maps only explicit old configuration, retains source identity and ignores admin rights', () => {
  const state = legacy()
  const original = structuredClone(state)
  const preview = previewLegacyRolePreset(source(state))
  assert.deepEqual(preview.draft, { name: 'Writer', model: { provider: 'mock', model: 'writer', effort: 'high' },
    instructions: '{{goal}} {{constraints}} Write clearly.', skills: ['office'], appearance: { shape: 'whale', color: '#123456' } })
  assert.equal(preview.targetRole, 'worker')
  assert.equal(preview.source.identity, 'explicit-copy-1')
  assert.equal(preview.source.botId, 'old-writer')
  assert.match(preview.source.digest, /^[0-9a-f]{64}$/u)
  assert.ok(preview.fields.some(field => field.from === 'bot.avatar' && field.to === 'preset.appearance'))
  assert.ok(preview.ignored.includes('state.mainBotIds'))
  assert.ok(preview.ignored.includes('bot.permissions'))
  assert.ok(preview.ignored.includes('bot.capabilities'))
  assert.deepEqual(preview.issues, [])
  assert.doesNotMatch(JSON.stringify(preview), /do-not-project|inFlight|\/private|shell/u)
  assert.deepEqual(state, original)
  state.bots['old-writer'].permissions = ['new-admin']
  assert.equal(previewLegacyRolePreset(source(state)).source.digest, preview.source.digest, 'rights are not preset content')
  state.bots['old-writer'].model = 'different-invalid-ref'
  assert.notEqual(previewLegacyRolePreset(source(state)).source.digest, preview.source.digest)
})

test('selection and cancellation require the same reviewed copy; repeat inputs have stable keys and fingerprints', () => {
  const state = legacy()
  const preview = previewLegacyRolePreset(source(state))
  const input = { ...source(state), expectedDigest: preview.source.digest, decision: 'select',
    preset: { id: 'from-copy', ...preview.draft } }
  const selected = prepareLegacyPresetDecision(input)
  assert.deepEqual(selected.preset, { id: 'from-copy', ...preview.draft })
  assert.equal(selected.status, 'selected')
  assert.equal(prepareLegacyPresetDecision(input).fingerprint, selected.fingerprint)
  assert.equal(prepareLegacyPresetDecision({ ...input, decision: 'skip', preset: undefined }).status, 'skipped')
  assert.notEqual(prepareLegacyPresetDecision({ ...input, decision: 'skip', preset: undefined }).fingerprint, selected.fingerprint)
  state.bots['old-writer'].instructions = '{{goal}} {{constraints}} New text.'
  assert.throws(() => prepareLegacyPresetDecision(input), { code: 'PRESET_SOURCE_CONFLICT' })
  assert.throws(() => prepareLegacyPresetDecision({ ...input, expectedDigest: preview.source.digest.slice(1) }), { code: 'PRESET_SOURCE_CONFLICT' })
})

test('bad or absent legacy values stay in preview issues until explicitly reviewed', () => {
  const state = legacy()
  state.bots['old-writer'].model = 'ambiguous-model'
  state.bots['old-writer'].skills = ['office', 'superagent-role']
  state.bots['old-writer'].avatar = { image: 'file:///private/photo.png' }
  const preview = previewLegacyRolePreset(source(state))
  assert.equal(preview.draft.model, undefined)
  assert.deepEqual(preview.draft.skills, [])
  assert.deepEqual(preview.draft.appearance, { color: '#123456' })
  assert.ok(preview.issues.some(issue => issue.field === 'model'))
  assert.ok(preview.issues.some(issue => issue.field === 'skills'))
  assert.ok(preview.issues.some(issue => issue.field === 'appearance'))
  assert.throws(() => prepareLegacyPresetDecision({ ...source(state), expectedDigest: preview.source.digest, decision: 'select',
    preset: { id: 'unreviewed', ...preview.draft } }), { code: 'INVALID_PRESET' })
  assert.throws(() => previewLegacyRolePreset(source({ bots: {} })), { code: 'INVALID_PRESET_SOURCE' })
  state.bots['old-writer'].name = 'Writer\nAdmin'
  assert.equal(previewLegacyRolePreset(source(state)).draft.name, 'old-writer')
})

test('embedded appearance images preserve a matching signature and reject mismatched or oversized data', () => {
  const state = legacy()
  const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString('base64')}`
  state.bots['old-writer'].avatar.image = png
  const preview = previewLegacyRolePreset(source(state))
  assert.equal(preview.draft.appearance.image, png)
  assert.equal(createRolePreset({ id: 'with-photo', ...preview.draft }).appearance.image, png)
  state.bots['old-writer'].avatar.image = `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(80_000),
  ]).toString('base64')}`
  assert.equal(previewLegacyRolePreset(source(state)).draft.appearance.image, state.bots['old-writer'].avatar.image)
  state.bots['old-writer'].avatar.image = png.replace('image/png', 'image/jpeg')
  assert.deepEqual(previewLegacyRolePreset(source(state)).draft.appearance, { shape: 'whale', color: '#123456' })
  assert.throws(() => createRolePreset({ ...manual(), appearance: { image: `data:image/png;base64,${'A'.repeat(200000)}` } }),
    { code: 'INVALID_PRESET' })
})

test('application drafts replace exactly one role through the revisioned config command', () => {
  const current = { revision: 7, roles: roles(), updatedAt: 100 }
  const before = structuredClone(current)
  const command = prepareRolePresetApplication({ commandId: 'apply-writer', current, targetRole: 'worker', preset: manual() })
  assert.deepEqual(command, { commandId: 'apply-writer', expectedRevision: 7,
    roles: { ...before.roles, worker: { name: 'Writer', model: manual().model,
      instructions: manual().instructions, skills: ['office'], appearance: manual().appearance } } })
  assert.deepEqual(current, before)
  assert.equal('permissions' in command.roles.worker, false)
  assert.throws(() => prepareRolePresetApplication({ commandId: 'invalid-router', current, targetRole: 'router',
    preset: { ...manual(), instructions: 'No required placeholder.' } }), { code: 'INVALID_CONFIG' })
  assert.throws(() => prepareRolePresetApplication({ commandId: 'bad-revision', current: { ...current, revision: 0 },
    targetRole: 'worker', preset: manual() }), { code: 'INVALID_PRESET' })
})

test('the prepared command uses the Engine revision contract and survives a repeat', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'role-preset-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const engine = new Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] })
  const initial = await engine.getRoleConfig()
  const command = prepareRolePresetApplication({ commandId: 'apply-writer', current: initial, targetRole: 'worker', preset: manual() })
  const saved = await engine.updateRoleConfig(command)
  assert.equal(saved.revision, initial.revision + 1)
  assert.equal(saved.roles.worker.name, 'Writer')
  assert.deepEqual(await engine.updateRoleConfig(command), saved)
  await assert.rejects(engine.updateRoleConfig({ ...command, commandId: 'stale-apply' }), { code: 'CONFIG_REVISION_CONFLICT' })
  assert.deepEqual((await engine.getRoleConfig()).roles.router, initial.roles.router)
})

test('applying a bounded image survives restart without changing another role or the captured revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'role-preset-appearance-'))
  const path = join(directory, 'state.sqlite')
  const opened = []
  const open = async () => {
    const storage = await SqliteStorage.open(path)
    opened.push(storage)
    return { storage, engine: new Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }) }
  }
  t.after(async () => { for (const storage of opened) await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const { engine, storage } = await open()
  const image = `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(119_992)]).toString('base64')}`
  const initial = await engine.getRoleConfig()
  const router = { ...initial.roles.router, appearance: { color: '#aabbcc' } }
  const configured = await engine.updateRoleConfig({ commandId: 'router-appearance', expectedRevision: initial.revision,
    roles: { ...initial.roles, router } })
  const inFlight = structuredClone(configured)
  const use = await storage.transaction('private', tx => new RoleConfigStore(storage, 'private', configured.roles).recordUse(tx, {
    sessionId: 'worker-in-flight', role: 'worker', revision: inFlight.revision,
    router: inFlight.roles.router.model, worker: inFlight.roles.worker.model }))
  await engine.createRolePreset({ instanceId: 'private', commandId: 'create-image',
    preset: { ...manual(), appearance: { shape: 'square', color: '#123456', image } } })
  const application = { instanceId: 'private', commandId: 'apply-image', presetId: 'writer', targetRole: 'worker',
    expectedRevision: configured.revision }
  const applied = await engine.applyRolePreset(application)
  assert.equal(applied.revision, inFlight.revision + 1)
  assert.deepEqual(await engine.applyRolePreset(application), applied)
  const withImage = await engine.getRoleConfig()
  await storage.transaction('private', tx => new RoleConfigStore(storage, 'private', withImage.roles).recordUse(tx, {
    sessionId: 'worker-with-image', role: 'worker', revision: withImage.revision,
    router: withImage.roles.router.model, worker: withImage.roles.worker.model }))
  const records = await storage.transaction('private', async tx => ({
    current: await tx.get('role-config', 'role-config'),
    history: await tx.scan('role-config-history', { limit: 10 }),
    images: await tx.scan('role-preset-image', { limit: 10 }),
    uses: await tx.scan('role-config-use', { limit: 10 }),
    recentUses: await tx.scan('role-config-use-recent', { limit: 10 }),
  }))
  assert.equal(records.current.imageChunks.worker, 3)
  assert.equal(records.current.roles.worker.appearance.image, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(records.current)) < 131072)
  assert.ok(records.history.items.every(item => Buffer.byteLength(JSON.stringify(item.value)) < 131072))
  assert.ok(records.images.items.every(item => Buffer.byteLength(JSON.stringify(item.value)) < 131072))
  assert.equal(records.uses.items.length, 2)
  assert.equal(records.recentUses.items.length, 2)
  assert.ok([...records.uses.items, ...records.recentUses.items].every(item =>
    Buffer.byteLength(JSON.stringify(item.value)) < 131072 && !JSON.stringify(item.value).includes('data:image/')))
  const { engine: restarted } = await open()
  const current = await restarted.getRoleConfig()
  assert.equal(current.revision, applied.revision)
  assert.deepEqual(current.roles.worker.appearance, { shape: 'square', color: '#123456', image })
  assert.deepEqual(current.roles.router, router)
  assert.deepEqual(inFlight.roles, configured.roles)
  assert.equal((await restarted.getRoleConfigUses('worker-in-flight'))[0].revision, use.revision)
  assert.deepEqual((await restarted.getRoleConfigHistory()).find(item => item.revision === inFlight.revision).roles, inFlight.roles)
  assert.deepEqual((await restarted.getRoleConfigHistory()).find(item => item.revision === applied.revision).roles, current.roles)
  await assert.rejects(restarted.applyRolePreset({ ...application, commandId: 'stale-image' }), { code: 'CONFIG_REVISION_CONFLICT' })
  const next = await restarted.updateRoleConfig({ commandId: 'another-role', expectedRevision: current.revision,
    roles: { ...current.roles, router: { ...router, name: 'Updated Router' } } })
  assert.deepEqual(next.roles.worker.appearance, current.roles.worker.appearance)
  const afterSecondRestart = (await (await open()).engine.getRoleConfig())
  assert.deepEqual(afterSecondRestart.roles.worker.appearance, current.roles.worker.appearance)
  assert.deepEqual((await restarted.getRoleConfigHistory()).find(item => item.revision === applied.revision).roles.worker.appearance,
    current.roles.worker.appearance)
})
