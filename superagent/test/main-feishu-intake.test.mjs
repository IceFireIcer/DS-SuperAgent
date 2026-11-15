import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { lastUserText } from './input-support.mjs'

test('an addressed Feishu request enters Main while discussion and bot messages do not', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-main-feishu-'))
  const turns = []
  let storage, native, sessions, engine, environment
  t.after(async () => {
    await engine?.effects.stop()
    await engine?.shutdown()
    await sessions?.close()
    await native?.fiber.dispose()
    await environment?.close()
    await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    turns.push(lastUserText(options))
    yield* textResponse('Main read the Feishu request.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['bot'], permissions: ['read', 'write'], commands: {} })
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { kind: 'feishu', sourceInstanceId: 'feishu:tenant:group', actorId: 'bot',
    allowedActorIds: ['bot'], allowedThreadPrefixes: ['feishu:tenant:'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } }, {}, sessions, [environment])
  await engine.openMain({ instanceId: 'private' })
  const source = new core.FeishuSource(storage, 'private', engine, { tenantKey: 'tenant', chatIds: ['group'],
    selfActorIds: ['bot'], mainIntake: true })
  const event = (eventId, messageId, overrides = {}) => ({ eventId, cursor: eventId, tenantKey: 'tenant', chatId: 'group',
    chatType: 'group', messageId, senderId: 'alice', senderKind: 'human', text: 'Please handle this request.',
    createTime: '1700000000000', updateTime: '1700000000000', mentionIds: ['bot'], ...overrides })
  const receipt = await source.receive(event('1', 'om_request'))
  assert.equal(receipt.status, 'recorded')
  assert.equal((await engine.listTickets()).items.length, 0)
  assert.equal((await engine.getMainSources({ instanceId: 'private' })).items.length, 1)
  assert.equal((await engine.getMainSources({ instanceId: 'private' })).items[0].threadId,
    'feishu:tenant:group:message:om_request')
  assert.equal((await source.receive(event('1', 'om_request'))).reason, 'SOURCE_REPLAY')
  await source.receive(event('2', 'om_ambient', { mentionIds: [] }))
  await source.receive(event('3', 'om_bot', { senderId: 'bot', senderKind: 'bot' }))
  await source.receive(event('4', 'om_other', { senderId: 'bob' }))
  assert.equal((await engine.getMainSources({ instanceId: 'private' })).items.length, 1)
  for (let index = 0; index < 8; index++) await engine.effects.drain()
  const page = await engine.getRecentMainConversation({ instanceId: 'private', limit: 20 })
  assert.equal(page.sources.length, 1)
  assert.equal(page.messages.find(message => message.source?.eventId === receipt.eventId)?.source.kind, 'feishu',
    JSON.stringify({ messages: page.messages, sources: page.sources, turns }))
  assert.match(turns[0], /^\[Feishu request\]/u)
  assert.equal((await engine.listTickets()).items.length, 0, 'Main text must not create a Router Ticket')
})

test('the Feishu runtime polls a native discussion into the same Main and stops cleanly', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-main-feishu-runtime-'))
  let storage, native, sessions, runtime, engine, environment
  t.after(async () => {
    await runtime?.stop()
    await engine?.effects.stop()
    await engine?.shutdown()
    await sessions?.close()
    await native?.fiber.dispose()
    await environment?.close()
    await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Main received the group request.') })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['receiver'], permissions: ['read', 'write'], commands: {} })
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const json = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) })
  const fetch = async url => {
    const path = new URL(url).pathname
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'fictional-token', expire: 7200 }) }
    }
    if (path === '/open-apis/tenant/v2/tenant/query') return json({ tenant: { tenant_key: 'tenant' } })
    if (path === '/open-apis/im/v1/chats/group') return json({ chat_mode: 'group' })
    if (path === '/open-apis/im/v1/chats/group/members') return json({ items: [{ member_id: 'alice', member_id_type: 'open_id' }], has_more: false })
    if (path === '/open-apis/im/v1/messages') return json({ items: [{ message_id: 'om_request', chat_id: 'group', msg_type: 'text',
      create_time: '1700000000000', update_time: '1700000000000', sender: { id: 'alice', id_type: 'open_id', sender_type: 'user' },
      mentions: [{ id: 'ou_bot' }], body: { content: '{"text":"Please investigate this."}' } }], has_more: false })
    throw new Error(`Unexpected Feishu fixture request: ${path}`)
  }
  runtime = new core.FeishuRuntime({ storage, instanceId: 'private', tenantKey: 'tenant', chatIds: ['group'],
    actorId: 'receiver', selfActorIds: ['ou_bot'], allowedActorIds: ['receiver'], mainIntake: true,
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] },
    api: { appId: 'cli_test', appSecret: 'fictional-secret', fetch }, intervalMs: 1000 })
  engine = new core.Engine(storage, 'private', runtime.sourceBinding, {}, sessions, [environment], {}, {}, {}, { channel: runtime.channel })
  runtime.bind(engine)
  await engine.openMain({ instanceId: 'private' })
  engine.effects.start()
  await runtime.start()
  for (let attempt = 0; attempt < 40 && (await engine.getMainSources({ instanceId: 'private' })).items.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const page = await engine.getMainSources({ instanceId: 'private' })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].threadId, 'feishu:tenant:group:message:om_request')
  assert.equal(page.items[0].authorId, 'alice')
  assert.equal((await engine.listTickets()).items.length, 0)
  assert.ok(runtime.health().passes >= 1)
  await runtime.stop()
  assert.equal(runtime.health().state, 'stopped')
})
