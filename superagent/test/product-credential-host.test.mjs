import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { completedToolCount, lastUserText } from './input-support.mjs'

async function waitFor(read) {
  const deadline = Date.now() + 8000
  do {
    const value = await read()
    if (value) return value
    await sleep(20)
  } while (Date.now() < deadline)
  assert.fail('The Work credential request did not settle.')
}

test('a Worker requests only credential metadata and a stopped assignment cannot obtain its grant', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-chat-credential-'))
  const workspaceRoot = join(root, 'work')
  const stateRoot = join(root, 'state')
  await Promise.all([mkdir(workspaceRoot), mkdir(stateRoot)])
  const value = 'fixture-only-chat-credential'
  let resourceId
  let host
  let visibleToModel = false
  let resumed = false
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    visibleToModel ||= JSON.stringify(options.messages).includes(value)
    if (options.model === 'router') { yield* routerResponse(options); return }
    const text = lastUserText(options)
    if (options.model === 'worker' && text.includes('The local user approved credential resource')) {
      resumed = true
      yield* textResponse('I will continue with the approved tool.'); return
    }
    if (completedToolCount(options) === 0 && options.model === 'worker') {
      yield* toolResponse('request_secret', { resourceId }); return
    }
    if (completedToolCount(options) === 0 && options.model === 'main' && text.startsWith('Prepare credential work')) {
      yield* toolResponse('delegate_work', { goal: text, constraints: 'Ask for the stored credential only.',
        acceptanceCriteria: 'Report that the credential permission was requested.' }); return
    }
    yield* textResponse('Credential approval is pending.')
  })
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await native.plugin(LocalCredentials, { path: join(root, 'credentials.yaml'), watch: false })
  const instanceId = 'personal'
  host = await createProductHost(native, { instanceId, actorId: 'owner', workspaceRoot, databasePath: join(stateRoot, 'business.sqlite'),
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId, ...payload })
  const resource = await call('resource-create', { commandId: 'save-fixture', label: 'Test credential', value })
  resourceId = resource.id
  const requestFor = async suffix => {
    const text = `Prepare credential work ${suffix}.`
    await call('send', { commandId: `work-${suffix}`, text })
    const work = await waitFor(async () => (await call('history')).works.find(item => item.brief?.goal === text && item.control?.assignment))
    const request = await waitFor(async () => (await call('resource-request-list')).items.find(item => item.scope.workItemId === work.brief.workItemId))
    assert.equal(request.status, 'pending')
    assert.equal(request.resourceId, resource.id)
    assert.ok(request.scope.environmentId)
    assert.equal(Object.hasOwn(request, 'assignment'), false)
    assert.equal(JSON.stringify(request).includes(value), false)
    return { work, request }
  }
  const approve = (request, expectedRevision) => call('resource-grant', { commandId: `grant:${request.id}`,
    requestId: request.id, resourceId, expectedRevision, scope: request.scope, purposes: ['tool'] })
  const first = await requestFor('first')
  const granted = await approve(first.request, resource.revision)
  assert.deepEqual(granted.grants[0].scope, first.request.scope)
  assert.equal((await call('resource-request-read', { requestId: first.request.id })).status, 'granted')
  await waitFor(() => resumed)

  const second = await requestFor('second')
  const { work } = second
  await call('work-stop', { commandId: 'stop-second', workItemId: work.brief.workItemId, ticketId: work.receipt.ticketId,
    expectedGeneration: work.control.assignment.generation, expectedTicketVersion: work.control.ticketVersion, reason: 'Stop the credential test work.' })
  await assert.rejects(approve(second.request, granted.revision), { code: 'REQUEST_UNAVAILABLE' })
  assert.equal((await call('resource-cancel', { commandId: 'cancel-second', requestId: second.request.id })).status, 'cancelled')
  assert.equal(visibleToModel, false)
})

test('the trusted product Host manages durable credential records without exposing values', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-credential-host-'))
  const work = join(directory, 'work')
  const core = join(directory, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Main is ready.'))
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const config = { databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  host = await createProductHost(native, config)
  const instanceId = 'personal'
  const input = { instanceId, commandId: 'create-one', label: 'Issue delivery', value: 'fictional-resource-value' }
  const created = await host.dispatch('resource-create', input)
  assert.deepEqual(await host.dispatch('resource-create', input), created)
  const listed = await host.dispatch('resource-list', { instanceId })
  assert.equal(listed.items.length, 1)
  assert.equal(JSON.stringify(listed).includes(input.value), false)
  assert.equal(JSON.stringify(listed).includes('vault-'), false)
  const remote = { id: 'read-only-client', label: 'Reader', grants: [{ instanceId, capabilities: ['read'] }], createdAt: 1 }
  await assert.rejects(host.dispatch('resource-list', { instanceId }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('resource-create', { ...input, commandId: 'remote-create' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('resource-rotate', { instanceId, commandId: 'remote-rotate', resourceId: created.id,
    expectedRevision: 1, value: 'fictional-next-value' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('resource-rotation-read', { instanceId, commandId: 'rotate-one' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  const scope = { role: 'worker', workItemId: 'item-one', environmentId: 'work-one' }
  const request = await host.dispatch('resource-request', { instanceId, commandId: 'request-one', resourceId: created.id,
    scope, purpose: 'tool' })
  assert.equal(request.status, 'pending')
  assert.deepEqual((await host.dispatch('resource-request-list', { instanceId, limit: 1 })).items, [request])
  await assert.rejects(host.dispatch('resource-request-list', { instanceId }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  const cancelled = await host.dispatch('resource-request', { instanceId, commandId: 'request-cancelled', resourceId: created.id,
    scope, purpose: 'tool' })
  assert.equal((await host.dispatch('resource-cancel', { instanceId, commandId: 'cancel-request', requestId: cancelled.id })).status, 'cancelled')
  const granted = await host.dispatch('resource-grant', { instanceId, commandId: 'grant-one', resourceId: created.id,
    expectedRevision: 1, scope, purposes: ['tool'], requestId: request.id })
  assert.equal(granted.grants.length, 1)
  assert.equal((await host.dispatch('resource-request-read', { instanceId, requestId: request.id })).status, 'granted')
  const rotation = await host.dispatch('resource-rotate', { instanceId, commandId: 'rotate-one', resourceId: created.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' })
  assert.equal(rotation.status, 'committed')
  assert.equal(rotation.resource.revision, 3)
  assert.equal(JSON.stringify(rotation).includes('fictional-next-value'), false)
  assert.equal((await host.dispatch('resource-rotation-read', { instanceId, commandId: 'rotate-one' })).status, 'committed')
  const revoked = await host.dispatch('resource-revoke', { instanceId, commandId: 'revoke-one', resourceId: created.id,
    grantId: granted.grants[0].id, expectedRevision: rotation.resource.revision })
  assert.equal(revoked.grants.length, 0)
  const raw = await SqliteStorage.open(config.databasePath)
  const leaseKey = JSON.stringify(['host-lease', instanceId])
  const originalLease = await raw.transaction(instanceId, tx => tx.get('host-lease', leaseKey))
  await raw.transaction(instanceId, tx => tx.replace('host-lease', leaseKey, { ...originalLease, token: 'fenced' }))
  try {
    await assert.rejects(host.dispatch('resource-rename', { instanceId, commandId: 'stale-host', resourceId: created.id,
      expectedRevision: revoked.revision, label: 'Changed by a stale Host' }), { code: 'HOST_LEASED' })
  } finally {
    await raw.transaction(instanceId, tx => tx.replace('host-lease', leaseKey, originalLease))
    await raw.close()
  }
  await host.close()
  host = await createProductHost(native, config)
  const restored = await host.dispatch('resource-read', { instanceId, resourceId: created.id })
  assert.equal(restored.revision, 4)
  const deleted = await host.dispatch('resource-delete', { instanceId, commandId: 'delete-one', resourceId: created.id,
    expectedRevision: restored.revision })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.cleanupPending, undefined)
  await assert.rejects(host.dispatch('resource-grant', { instanceId, commandId: 'later', resourceId: created.id,
    expectedRevision: deleted.revision, scope: { role: 'worker', workItemId: 'item-one' }, purposes: ['tool'] }), { code: 'RESOURCE_UNAVAILABLE' })
  assert.deepEqual(await host.dispatch('resource-cleanup', { instanceId }),
    { creations: { reconciled: 0, pending: 0 }, rotations: { reconciled: 1, pending: 0 }, deletions: { cleaned: 0, pending: 0 } })
})

test('a missing DSH credential record service leaves Main available and fails resource commands closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-resource-unavailable-'))
  const work = join(directory, 'work')
  const core = join(directory, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Main is ready.'))
  const host = await createProductHost(native, { databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await host.dispatch('open')).instanceId, 'personal')
  await assert.rejects(host.dispatch('resource-list', { instanceId: 'personal' }), { code: 'UNAVAILABLE' })
})
