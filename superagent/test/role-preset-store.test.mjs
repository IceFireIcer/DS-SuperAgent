import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { PostgresStorage } from '../dist/postgres-storage.js'
import { SqliteStorage } from '../dist/storage.js'
import { startPostgres } from './fixtures/postgres-harness.mjs'

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/role-preset-store.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, target: 'node24' })
const { RolePresetStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)

const preset = (id = 'writer') => ({ id, name: 'Writer', model: { provider: 'mock', model: 'writer' },
  instructions: '{{goal}} {{constraints}} Write clearly.', skills: ['office'], appearance: { shape: 'square', color: '#123456' } })
const legacy = () => ({ mainBotIds: ['writer'], secret: 'hidden', bots: { writer: {
  name: 'Writer', model: 'mock/writer', instructions: '{{goal}} {{constraints}} Write clearly.',
  skills: ['office'], color: '#123456', main: true, permissions: ['admin'], workDir: '/private', secret: 'hidden',
} } })
const copy = state => ({ sourceIdentity: 'export-1', sourceBotId: 'writer', targetRole: 'worker', state })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'role-preset-store-'))
  const path = join(directory, 'presets.sqlite')
  const storage = await SqliteStorage.open(path, { busyTimeoutMs: 1500 })
  const connections = [storage]
  t.after(async () => {
    for (const connection of connections) await connection.close()
    await rm(directory, { recursive: true, force: true })
  })
  const reopen = async () => {
    const connection = await SqliteStorage.open(path)
    connections.push(connection)
    return connection
  }
  return { storage, store: new RolePresetStore(storage, 'personal', () => 42), reopen }
}

test('manual CRUD is instance-scoped, revisioned, replayable and queryable after restart', async t => {
  const { storage, store, reopen } = await fixture(t)
  const input = { instanceId: 'personal', commandId: 'create-writer', preset: preset() }
  const created = await store.create(input)
  assert.equal(created.revision, 1)
  assert.equal(created.status, 'active')
  assert.deepEqual(created.preset, preset())
  assert.deepEqual(await store.create(input), created)
  await assert.rejects(store.create({ ...input, preset: preset('different') }), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(store.create({ ...input, commandId: 'other-create' }), { code: 'PRESET_EXISTS' })
  await assert.rejects(store.get({ instanceId: 'elsewhere', presetId: 'writer' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  assert.equal((await new RolePresetStore(storage, 'elsewhere').list({ instanceId: 'elsewhere' })).items.length, 0)

  const changed = await store.update({ instanceId: 'personal', commandId: 'update-writer', expectedRevision: 1,
    preset: { ...preset(), name: 'Editor' } })
  assert.equal(changed.revision, 2)
  assert.equal((await store.get({ instanceId: 'personal', presetId: 'writer' })).preset.name, 'Editor')
  await assert.rejects(store.update({ instanceId: 'personal', commandId: 'stale', expectedRevision: 1,
    preset: preset() }), { code: 'PRESET_REVISION_CONFLICT' })
  const removed = await store.delete({ instanceId: 'personal', commandId: 'delete-writer', presetId: 'writer', expectedRevision: 2 })
  assert.equal(removed.status, 'deleted')
  assert.equal((await store.list({ instanceId: 'personal' })).items[0].status, 'deleted')
  const reopened = await reopen()
  const afterRestart = new RolePresetStore(reopened, 'personal')
  assert.deepEqual(await afterRestart.get({ instanceId: 'personal', presetId: 'writer' }), removed)
  assert.deepEqual(await afterRestart.create(input), created, 'original command replays its original revision')
  assert.deepEqual(await afterRestart.update({ instanceId: 'personal', commandId: 'update-writer', expectedRevision: 1,
    preset: { ...preset(), name: 'Editor' } }), changed)
  assert.deepEqual(await afterRestart.delete({ instanceId: 'personal', commandId: 'delete-writer', presetId: 'writer', expectedRevision: 2 }), removed)
})

test('large embedded images survive storage limits, previews, updates and immutable command replay', async t => {
  const { store, reopen } = await fixture(t)
  const image = `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(119_992)]).toString('base64')}`
  const first = await store.create({ instanceId: 'personal', commandId: 'large-image',
    preset: { ...preset(), appearance: { image } } })
  assert.equal((await store.get({ instanceId: 'personal', presetId: 'writer' })).preset.appearance.image, image)
  await store.update({ instanceId: 'personal', commandId: 'remove-image', expectedRevision: 1, preset: preset() })
  assert.deepEqual(await store.create({ instanceId: 'personal', commandId: 'large-image',
    preset: { ...preset(), appearance: { image } } }), first)
  assert.equal((await store.get({ instanceId: 'personal', presetId: 'writer' })).preset.appearance.image, undefined)
  const state = legacy()
  state.bots.writer.avatar = { image }
  const reviewed = await store.recordPreview({ instanceId: 'personal', commandId: 'image-preview', copy: copy(state) })
  assert.equal(reviewed.preview.draft.appearance.image, image)
  assert.equal((await new RolePresetStore(await reopen(), 'personal').getPreview({ instanceId: 'personal', previewId: reviewed.id }))
    .preview.draft.appearance.image, image)
  await assert.rejects(store.create({ instanceId: 'personal', commandId: 'invalid-authority',
    preset: { ...preset('unsafe'), permissions: ['admin'] } }), { code: 'INVALID_PRESET' })
})

test('preview, cancel, duplicate selection and content conflicts remain inspectable across restart', async t => {
  const { store, reopen } = await fixture(t)
  const state = legacy()
  const original = structuredClone(state)
  const reviewed = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-one', copy: copy(state) })
  assert.equal(reviewed.preview.draft.name, 'Writer')
  assert.ok(reviewed.preview.ignored.includes('bot.permissions'))
  assert.doesNotMatch(JSON.stringify(reviewed), /hidden|\/private|admin/u)
  assert.deepEqual(state, original)
  const cancelled = await store.decideImport({ instanceId: 'personal', commandId: 'skip-one', previewId: reviewed.id, decision: 'skip' })
  assert.equal(cancelled.status, 'skipped')
  assert.equal(cancelled.presetId, undefined)
  const second = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-two', copy: copy(state) })
  const selected = await store.decideImport({ instanceId: 'personal', commandId: 'select-two', previewId: second.id,
    decision: 'select', copy: copy(state), preset: preset() })
  assert.equal(selected.status, 'selected')
  assert.equal(selected.presetId, 'writer')
  assert.equal((await store.get({ instanceId: 'personal', presetId: 'writer' })).origin.source.botId, 'writer')
  const third = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-three', copy: copy(state) })
  const duplicate = await store.decideImport({ instanceId: 'personal', commandId: 'select-three', previewId: third.id,
    decision: 'select', copy: copy(state), preset: preset() })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.duplicateOf, selected.id)
  assert.equal(duplicate.presetId, 'writer')
  const fourth = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-four', copy: copy(state) })
  const conflict = await store.decideImport({ instanceId: 'personal', commandId: 'select-four', previewId: fourth.id,
    decision: 'select', copy: copy(state), preset: { ...preset('other'), name: 'Changed' } })
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.reason, 'PRESET_CONTENT_CONFLICT')
  assert.equal(conflict.conflictWith, selected.id)

  state.bots.writer.instructions = 'Changed after preview.'
  const stale = await store.decideImport({ instanceId: 'personal', commandId: 'stale-three', previewId: third.id,
    decision: 'select', copy: copy(state), preset: preset() })
  assert.equal(stale.status, 'conflict')
  assert.equal(stale.reason, 'PRESET_SOURCE_CONFLICT')
  const reopenedStorage = await reopen()
  const restarted = new RolePresetStore(reopenedStorage, 'personal')
  assert.deepEqual(await restarted.getPreview({ instanceId: 'personal', previewId: reviewed.id }), reviewed)
  assert.deepEqual(await restarted.getImport({ instanceId: 'personal', importId: selected.id }), selected)
  assert.deepEqual(await restarted.decideImport({ instanceId: 'personal', commandId: 'select-two', previewId: second.id,
    decision: 'select', copy: copy(original), preset: preset() }), selected)
  assert.deepEqual((await restarted.listImports({ instanceId: 'personal' })).items.map(item => item.status).sort(),
    ['conflict', 'conflict', 'duplicate', 'selected', 'skipped'])
  assert.equal((await restarted.listPreviews({ instanceId: 'personal' })).items.length, 4)
})

test('two concurrent selections of the same source create one preset and retain the duplicate attempt', async t => {
  const { store, reopen } = await fixture(t)
  const other = new RolePresetStore(await reopen(), 'personal')
  const state = legacy()
  const [one, two] = await Promise.all(['one', 'two'].map(commandId =>
    store.recordPreview({ instanceId: 'personal', commandId, copy: copy(state) })))
  const results = await Promise.all([
    store.decideImport({ instanceId: 'personal', commandId: 'select-one', previewId: one.id,
      decision: 'select', copy: copy(state), preset: preset() }),
    other.decideImport({ instanceId: 'personal', commandId: 'select-two', previewId: two.id,
      decision: 'select', copy: copy(state), preset: preset() }),
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['duplicate', 'selected'])
  assert.equal((await store.list({ instanceId: 'personal' })).items.length, 1)
  assert.equal((await other.listImports({ instanceId: 'personal' })).items.length, 2)
})

test('editing an imported preset makes another extraction an inspectable content conflict', async t => {
  const { store } = await fixture(t)
  const state = legacy()
  const first = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-first', copy: copy(state) })
  const selected = await store.decideImport({ instanceId: 'personal', commandId: 'select-first', previewId: first.id,
    decision: 'select', copy: copy(state), preset: preset() })
  await store.update({ instanceId: 'personal', commandId: 'edit-imported', expectedRevision: 1,
    preset: { ...preset(), name: 'Changed' } })
  const next = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-again', copy: copy(state) })
  const conflict = await store.decideImport({ instanceId: 'personal', commandId: 'select-again', previewId: next.id,
    decision: 'select', copy: copy(state), preset: preset() })
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.reason, 'PRESET_CONTENT_CONFLICT')
  assert.equal(conflict.conflictWith, selected.id)
  assert.equal((await store.get({ instanceId: 'personal', presetId: 'writer' })).preset.name, 'Changed')
})

test('explicit source replacement keeps the old preset and rejects a stale decision', async t => {
  const { store, reopen } = await fixture(t)
  const state = legacy()
  const firstPreview = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-one', copy: copy(state) })
  const first = await store.decideImport({ instanceId: 'personal', commandId: 'select-one', previewId: firstPreview.id,
    decision: 'select', copy: copy(state), preset: preset() })
  const replacementPreview = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-two', copy: copy(state) })
  const attempt = { instanceId: 'personal', previewId: replacementPreview.id, copy: copy(state), preset: preset('new-writer') }
  const conflict = await store.decideImport({ ...attempt, commandId: 'select-two', decision: 'select' })
  assert.equal(conflict.reason, 'PRESET_CONTENT_CONFLICT')
  assert.equal(conflict.conflictWith, first.id)
  const replaced = await store.decideImport({ ...attempt, commandId: 'replace-one', decision: 'replace', expectedDecisionId: first.id })
  assert.equal(replaced.status, 'replaced')
  assert.equal(replaced.conflictWith, first.id)
  assert.equal(replaced.presetId, 'new-writer')
  assert.deepEqual(await store.decideImport({ ...attempt, commandId: 'replace-one', decision: 'replace', expectedDecisionId: first.id }), replaced)
  await assert.rejects(store.decideImport({ ...attempt, commandId: 'replace-one', decision: 'replace', expectedDecisionId: 'changed' }),
    { code: 'IDENTITY_CONFLICT' })
  const stalePreview = await store.recordPreview({ instanceId: 'personal', commandId: 'preview-three', copy: copy(state) })
  const stale = await store.decideImport({ instanceId: 'personal', commandId: 'replace-stale', previewId: stalePreview.id,
    decision: 'replace', expectedDecisionId: first.id, copy: copy(state), preset: preset('third-writer') })
  assert.equal(stale.status, 'conflict')
  assert.equal(stale.conflictWith, replaced.id)
  const restarted = new RolePresetStore(await reopen(), 'personal')
  assert.equal((await restarted.get({ instanceId: 'personal', presetId: 'writer' })).status, 'active')
  assert.equal((await restarted.get({ instanceId: 'personal', presetId: 'new-writer' })).status, 'active')
  const newPreview = await restarted.recordPreview({ instanceId: 'personal', commandId: 'preview-four', copy: copy(state) })
  const duplicate = await restarted.decideImport({ instanceId: 'personal', commandId: 'select-four', previewId: newPreview.id,
    decision: 'select', copy: copy(state), preset: preset('new-writer') })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.duplicateOf, replaced.id)
})

test('PostgreSQL uses the same records for previews, images and command replay', {
  skip: process.platform === 'win32' && 'The embedded PostgreSQL fixture does not start on this Windows host.',
  timeout: 120000,
}, async t => {
  const postgres = await startPostgres('role-preset-store-pg-')
  t.after(() => postgres.close())
  const { storage, database } = await postgres.newStorage()
  const store = new RolePresetStore(storage, 'personal')
  const image = `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(90_000)]).toString('base64')}`
  const manual = { instanceId: 'personal', commandId: 'manual', preset: { ...preset('manual'), appearance: { image } } }
  const created = await store.create(manual)
  const state = legacy()
  const reviewed = await store.recordPreview({ instanceId: 'personal', commandId: 'preview', copy: copy(state) })
  const selected = await store.decideImport({ instanceId: 'personal', commandId: 'choose', previewId: reviewed.id,
    decision: 'select', copy: copy(state), preset: preset() })
  const reopened = postgres.register(await PostgresStorage.open({ ...postgres.configuration, database }))
  const next = new RolePresetStore(reopened, 'personal')
  assert.deepEqual(await next.create(manual), created)
  assert.equal((await next.get({ instanceId: 'personal', presetId: 'manual' })).preset.appearance.image, image)
  assert.deepEqual(await next.getPreview({ instanceId: 'personal', previewId: reviewed.id }), reviewed)
  assert.deepEqual(await next.getImport({ instanceId: 'personal', importId: selected.id }), selected)
  assert.equal((await next.list({ instanceId: 'personal' })).items.length, 2)
})
