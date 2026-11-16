import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

const json = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) })
const sourceInstanceId = 'feishu:tenant:group:app:cli_test'

function mockTransport(calls, currentSecret = () => 'fixture-resource-secret') {
  return async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      assert.equal(JSON.parse(init.body).app_secret, currentSecret())
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }) }
    }
    if (path === '/open-apis/tenant/v2/tenant/query') return json({ tenant: { tenant_key: 'tenant' } })
    if (path === '/open-apis/im/v1/chats/group') return json({ chat_mode: 'group' })
    if (path === '/open-apis/im/v1/chats/group/members') return json({ items: [{ member_id: 'alice', member_id_type: 'open_id' }], has_more: false })
    if (path === '/open-apis/im/v1/messages') return json({ items: [], has_more: false })
    if (path === '/open-apis/im/v1/messages/om_request') return json({ items: [{ message_id: 'om_request', chat_id: 'group' }] })
    if (path === '/open-apis/im/v1/messages/om_request/reply') return json({ message_id: 'om_sent' })
    throw new Error('Unexpected mock Feishu request.')
  }
}

test('product Host selection controls real source requests, including cached-token revocation', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-feishu-host-credential-'))
  const work = join(directory, 'work')
  const coreDir = join(directory, 'core')
  await Promise.all([mkdir(work), mkdir(coreDir)])
  const native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Main is ready.') })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const calls = []
  let currentSecret = 'fixture-resource-secret'
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const instanceId = 'private'
  const config = { databasePath: join(coreDir, 'state.sqlite'), workspaceRoot: work,
    instanceId, actorId: 'desktop-owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    feishu: { tenantKey: 'tenant', chatIds: ['group'], actorId: 'receiver', selfActorIds: ['ou_bot'],
      allowedActorIds: ['receiver'], intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
        allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] },
      api: { appId: 'cli_test', fetch: mockTransport(calls, () => currentSecret) }, intervalMs: 30, maxBackoffMs: 30 } }
  host = await core.createProductHost(native, config)
  const status = () => host.dispatch('feishu-status', { instanceId })
  assert.equal((await status()).credentialMode, 'managed')
  assert.equal((await status()).resourceId, null)
  const resource = await host.dispatch('resource-create', { instanceId, commandId: 'create', label: 'Feishu app', value: 'fixture-resource-secret' })
  const select = commandId => host.dispatch('resource-select-feishu', { instanceId, commandId, resourceId: resource.id })
  assert.equal((await select('select-without-grant')).lastError, 'GRANT_DENIED')
  assert.deepEqual(calls, [], 'no token or source request may use an ungranted resource')
  const wrong = await host.dispatch('resource-grant', { instanceId, commandId: 'wrong-source', resourceId: resource.id,
    expectedRevision: resource.revision, scope: { role: 'main', sourceInstanceId: 'feishu:other:group:app:cli_test' }, purposes: ['source'] })
  assert.equal((await select('select-wrong-source')).lastError, 'GRANT_DENIED')
  assert.deepEqual(calls, [])
  const granted = await host.dispatch('resource-grant', { instanceId, commandId: 'source-grant', resourceId: resource.id,
    expectedRevision: wrong.revision, scope: { role: 'main', sourceInstanceId }, purposes: ['source'] })
  assert.equal((await select('select-authorized')).state, 'polling')
  for (let attempt = 0; attempt < 40 && (await status()).passes === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(calls.includes('/open-apis/im/v1/messages'), 'the poller must make an authorized source network request')
  const prior = calls.filter(path => path === '/open-apis/auth/v3/tenant_access_token/internal').length
  assert.equal(prior, 1, 'the subsequent source request uses the cached token')
  const rotated = await host.dispatch('resource-rotate', { instanceId, commandId: 'rotate-source', resourceId: resource.id,
    expectedRevision: granted.revision, value: 'fixture-rotated-secret' })
  assert.equal(rotated.status, 'committed')
  currentSecret = 'fixture-rotated-secret'
  for (let attempt = 0; attempt < 50
    && calls.filter(path => path === '/open-apis/auth/v3/tenant_access_token/internal').length === prior; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(calls.filter(path => path === '/open-apis/auth/v3/tenant_access_token/internal').length, prior + 1,
    'a rotated record must replace the cached Feishu token on the next authorized request')
  await host.dispatch('resource-revoke', { instanceId, commandId: 'revoke-source', resourceId: resource.id,
    grantId: granted.grants.at(-1).id, expectedRevision: rotated.resource.revision })
  for (let attempt = 0; attempt < 50 && (await status()).lastError !== 'GRANT_DENIED'; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await status()).lastError, 'GRANT_DENIED')
  const count = calls.length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(calls.length, count, 'a cached token cannot authorize new reads after revocation')
  await assert.rejects(host.dispatch('resource-select-feishu', { instanceId, commandId: 'select-authorized', resourceId: null }),
    { code: 'IDENTITY_CONFLICT' })
  assert.equal((await status()).resourceId, resource.id, 'a rejected selection must keep the previous reference')
  assert.doesNotMatch(JSON.stringify(await status()), /fixture-resource-secret|fixture-rotated-secret|fixture-token/u)
  await assert.rejects(host.dispatch('resource-select-feishu', { instanceId: 'another', commandId: 'other', resourceId: resource.id }),
    { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('resource-select-feishu', { instanceId, commandId: 'remote', resourceId: resource.id },
    { id: 'remote', grants: [{ instanceId, capabilities: ['read'] }] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await host.close()
  host = await core.createProductHost(native, config)
  for (let attempt = 0; attempt < 40 && (await status()).state !== 'failed'; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await status()).resourceId, resource.id, 'the selected reference persists across Host restarts')
  assert.equal((await status()).lastError, 'GRANT_DENIED')
  assert.equal(calls.length, count, 'a restart cannot fall back to another or legacy credential')
  await host.close()
  host = await core.createProductHost(native, { ...config, feishu: { ...config.feishu,
    api: { ...config.feishu.api, appSecret: 'legacy-fixture-secret' } } })
  assert.equal((await status()).credentialMode, 'legacy')
  assert.equal((await status()).lastError, 'INVALID_CONFIG')
  await assert.rejects(host.dispatch('feishu-start', { instanceId }), { code: 'INVALID_CONFIG' })
  assert.equal(calls.length, count, 'legacy Host configuration cannot bypass a persisted managed selection')
})

test('runtime outbound scope check and reply each consume the outbound grant', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-feishu-outbound-'))
  const native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Ready.') })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const calls = []
  const transport = mockTransport(calls)
  let afterLookup
  let failPost = false
  const manager = new core.ProductCredentialManager(storage, 'private', native.credentials)
  const resource = await manager.create({ instanceId: 'private', commandId: 'create', label: 'Feishu app', value: 'fixture-resource-secret' })
  let runtime, engine
  t.after(async () => { await runtime?.stop(); await engine?.shutdown(); await sessions.close(); await native.fiber.dispose();
    await storage.close(); await rm(directory, { recursive: true, force: true }) })
  runtime = new core.FeishuRuntime({ storage, instanceId: 'private', tenantKey: 'tenant', chatIds: ['group'], actorId: 'receiver',
    selfActorIds: ['ou_bot'], allowedActorIds: ['receiver'], intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1,
      timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] },
    api: { appId: 'cli_test', fetch: async (...args) => {
      if (new URL(args[0]).pathname.endsWith('/reply') && failPost) return { ok: false, status: 503 }
      const response = await transport(...args)
      if (new URL(args[0]).pathname === '/open-apis/im/v1/messages/om_request' && afterLookup) {
        const action = afterLookup; afterLookup = undefined
        await action()
      }
      return response
    }, withCredential: (purpose, consume) => manager.use({
      instanceId: 'private', resourceId: resource.id, sourceInstanceId: runtime.sourceBinding.sourceInstanceId,
      role: purpose === 'source' ? 'main' : 'router', purpose }, consume) }, intervalMs: 60000 })
  assert.equal(runtime.sourceBinding.sourceInstanceId, sourceInstanceId)
  engine = new core.Engine(storage, 'private', runtime.sourceBinding, {}, sessions)
  runtime.bind(engine)
  await engine.acquireHost()
  const source = await manager.grant({ instanceId: 'private', commandId: 'source', resourceId: resource.id,
    expectedRevision: resource.revision, scope: { role: 'main', sourceInstanceId }, purposes: ['source'] })
  await runtime.start()
  for (let attempt = 0; attempt < 40 && runtime.health().passes === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(runtime.health().passes, 1)
  const delivery = id => ({ id, instanceId: 'private', ticketId: 'ticket', purpose: 'answer', text: 'A fictional reply.',
    destination: { sourceInstanceId, actorId: 'alice', eventId: 'message:om_request', threadId: 'feishu:tenant:group:message:om_request' },
    basis: { kind: 'human-question', questionEventId: 'question', questionText: 'What?', fact: 'A fictional reply.' },
    effectId: id, effectGeneration: 'generation', sequence: 1, createdAt: Date.now(), state: 'pending' })
  const context = id => ({ idempotencyKey: `${id}:generation`, signal: new AbortController().signal })
  const before = calls.length
  assert.deepEqual(await runtime.channel.deliver(delivery('denied'), context('denied')),
    { type: 'transient', reason: 'GRANT_DENIED' })
  assert.equal(calls.length, before, 'source permission and a cached token do not authorize an outbound lookup')
  const outbound = await manager.grant({ instanceId: 'private', commandId: 'outbound', resourceId: resource.id,
    expectedRevision: source.revision, scope: { role: 'router', sourceInstanceId }, purposes: ['outbound'] })
  failPost = true
  assert.deepEqual(await runtime.channel.deliver(delivery('busy'), context('busy')), { type: 'transient', reason: 'FEISHU_HTTP_503' })
  failPost = false
  assert.deepEqual(await runtime.channel.deliver(delivery('sent'), context('sent')), { type: 'success' })
  assert.ok(calls.includes('/open-apis/im/v1/messages/om_request'))
  assert.ok(calls.includes('/open-apis/im/v1/messages/om_request/reply'))
  afterLookup = () => manager.revokeGrant({ instanceId: 'private', commandId: 'revoke-outbound', resourceId: resource.id,
    grantId: outbound.grants.at(-1).id, expectedRevision: outbound.revision })
  const posts = calls.filter(path => path.endsWith('/reply')).length
  assert.deepEqual(await runtime.channel.deliver(delivery('revoked-between-requests'), context('revoked-between-requests')),
    { type: 'transient', reason: 'GRANT_DENIED' })
  assert.equal(calls.filter(path => path.endsWith('/reply')).length, posts,
    'revocation after the outbound lookup must prevent the reply POST')
  const sent = calls.length
  assert.deepEqual(await runtime.channel.deliver(delivery('revoked'), context('revoked')),
    { type: 'transient', reason: 'GRANT_DENIED' })
  assert.equal(calls.length, sent, 'a cached token cannot authorize another outbound lookup or reply')
})
