import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the product capability library requires local approval and an exact execution scope', async context => {
  const root = await mkdtemp(join(tmpdir(), 'ds-capability-contract-'))
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('Ready.'))
  const workspaceRoot = join(root, 'work')
  await mkdir(workspaceRoot)
  await mkdir(join(root, 'state'))
  let host
  const config = { databasePath: join(root, 'state', 'product.sqlite'), workspaceRoot, instanceId: 'personal', actorId: 'owner',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  context.after(async () => {
    await host?.close()
    await native.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  host = await createProductHost(native, config)
  const dispatch = (endpoint, data = {}, client) => host.dispatch(endpoint, { instanceId: 'personal', ...data }, client)
  const mainScope = { role: 'main' }
  const workerScope = { role: 'worker', workItemId: 'a-work-item' }
  const readOnlyClient = { id: 'remote-reader', grants: [{ instanceId: 'personal', capabilities: ['read'] }] }
  const draft = { commandId: 'create', expectedRevision: 0, name: 'Review receipts',
    definition: { kind: 'skill', instructions: 'Check the receipt before reporting completion.' } }
  await assert.rejects(dispatch('capability-save', draft, readOnlyClient), { code: 'SOURCE_NOT_AUTHORIZED' })
  const saved = await dispatch('capability-save', draft)
  assert.deepEqual(await dispatch('capability-save', draft), saved)
  assert.equal(saved.approved, false)
  assert.deepEqual((await dispatch('capability-list', {}, readOnlyClient)).items,
    [{ id: saved.id, name: saved.name, kind: 'skill', revision: saved.revision, approved: false }])
  const bound = await dispatch('capability-bind', { commandId: 'bind', id: saved.id, expectedRevision: saved.revision,
    scope: workerScope, enabled: true })
  assert.deepEqual((await dispatch('capability-resolve', { scope: workerScope })).items, [])
  const approved = await dispatch('capability-approve', { commandId: 'approve', id: saved.id,
    expectedRevision: bound.revision, approved: true })
  assert.equal((await dispatch('capability-resolve', { scope: workerScope })).items[0].id, saved.id)
  assert.deepEqual((await dispatch('capability-resolve', { scope: mainScope })).items, [])
  assert.deepEqual((await dispatch('capability-resolve', { scope: { ...workerScope, workItemId: 'other' } })).items, [])
  await assert.rejects(dispatch('capability-delete', { id: approved.id, expectedRevision: bound.revision, commandId: 'stale' }),
    { code: 'CAPABILITY_REVISION_CONFLICT' })
  await assert.rejects(dispatch('capability-resolve', { scope: { role: 'main', botId: 'legacy' } }), { code: 'INVALID_INPUT' })
  await host.close()
  host = await createProductHost(native, config)
  assert.equal((await dispatch('capability-list')).items[0].revision, approved.revision)
  await dispatch('capability-delete', { id: approved.id, expectedRevision: approved.revision, commandId: 'delete' })
  assert.deepEqual((await dispatch('capability-list')).items, [])
})
