import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { completedToolCount, lastUserText } from './input-support.mjs'

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
  await runtime.start()
  for (let attempt = 0; attempt < 40 && runtime.health().passes === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(runtime.health().passes >= 1)
  assert.equal((await engine.getMainSources({ instanceId: 'private' })).items.length, 1,
    'reconnecting the same native source does not duplicate its Main handoff')
  await runtime.stop()
})

test('Main delegates a Feishu discussion and the original thread receives the bounded result', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-main-feishu-delivery-'))
  let storage, native, sessions, desktop, feishu, environment
  const replies = []
  t.after(async () => {
    await desktop?.effects.stop()
    await feishu?.effects.stop()
    await desktop?.shutdown()
    await feishu?.shutdown()
    await sessions?.close()
    await native?.fiber.dispose()
    await environment?.close()
    await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).includes('[Feishu request]') && completed === 0) {
        yield* toolResponse('delegate_work', { items: [{ goal: 'Verify the requested result.',
          constraints: 'Use only the source discussion.', acceptanceCriteria: 'Read back the result.' }] })
      } else yield* textResponse('Main recorded the request privately.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (completed === 0 && lastUserText(options).includes('Need approval')) {
      yield* toolResponse('ask_human', { question: 'May this work continue?', options: 'Yes\nNo' })
    } else if (completed === 0) yield* toolResponse('write_file', { path: 'result.txt', text: 'Verified in the authorized workspace.' })
    else if (completed === 1) yield* toolResponse('read_file', { path: 'result.txt' })
    else if (completed === 2) yield* toolResponse('report_ready', { result: 'Verified result.', evidence: 'Read back result.txt.', artifacts: 'result.txt' })
    else yield* textResponse('Work finished.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['desktop-owner'], permissions: ['read', 'write'], commands: {} })
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const channel = new core.FeishuDeliveryChannel({ replyMessage: async request => {
    replies.push(request)
    return { messageId: `reply-${replies.length}` }
  } })
  desktop = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner',
    allowedActorIds: ['desktop-owner'] }, {}, sessions, [environment], {}, {}, {}, { channel })
  feishu = new core.Engine(storage, 'private', { kind: 'feishu', sourceInstanceId: 'feishu:tenant:group', actorId: 'receiver',
    allowedActorIds: ['receiver'], allowedThreadPrefixes: ['feishu:tenant:'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } }, {}, sessions)
  await desktop.openMain({ instanceId: 'private' })
  const source = new core.FeishuSource(storage, 'private', feishu, { tenantKey: 'tenant', chatIds: ['group'],
    selfActorIds: ['ou_bot'], mainIntake: true })
  const request = await source.receive({ eventId: 'feishu-work', cursor: '1', tenantKey: 'tenant', chatId: 'group',
    chatType: 'group', messageId: 'om_work', senderId: 'alice', senderKind: 'human', text: 'Please do this one job.',
    mentionIds: ['ou_bot'], createTime: '1700000000000', updateTime: '1700000000000' })
  assert.equal(request.status, 'recorded')
  for (let index = 0; index < 14; index++) await desktop.effects.drain()
  const sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.equal(sources.items.length, 1)
  assert.equal(sources.items[0].state, 'delegated')
  assert.equal((await desktop.listTickets()).items.length, 1,
    JSON.stringify({ sources, effects: await desktop.effects.list(), page: await desktop.getRecentMainConversation({ instanceId: 'private' }) }))
  assert.deepEqual(replies.map(reply => reply.messageId), ['om_work', 'om_work'])
  assert.equal(replies.some(reply => reply.text.includes('Main recorded the request privately.')), false)
  assert.deepEqual(sources.items[0].deliveries.map(delivery => [delivery.purpose, delivery.state, delivery.destination.eventId]),
    [['result', 'sent', 'message:om_work'], ['acknowledgement', 'sent', 'message:om_work']])
  await source.receive({ eventId: 'feishu-follow', cursor: '2', tenantKey: 'tenant', chatId: 'group',
    chatType: 'group', rootId: 'om_work', messageId: 'om_follow', senderId: 'alice', senderKind: 'human',
    text: 'Need approval before continuing.', createTime: '1700000001000', updateTime: '1700000001000' })
  assert.equal((await desktop.getMainSources({ instanceId: 'private' })).items.length, 1,
    'an authorized follow-up in the owned discussion does not create a second Main request')
  assert.equal((await desktop.listTickets()).items.length, 1)
  for (let index = 0; index < 8; index++) await desktop.effects.drain()
  const ticketId = (await desktop.listTickets()).items[0].ticket.id
  const waiting = await desktop.conversation(ticketId)
  assert.equal(waiting.status, 'waiting-human')
  assert.equal(waiting.attention.destination.actorId, 'alice')
  await source.receive({ eventId: 'feishu-other-answer', cursor: '3', tenantKey: 'tenant', chatId: 'group',
    chatType: 'group', rootId: 'om_work', messageId: 'om_other_answer', senderId: 'bob', senderKind: 'human',
    text: 'Yes', createTime: '1700000002000', updateTime: '1700000002000' })
  assert.equal((await desktop.conversation(ticketId)).attention.status, 'waiting')
  await source.receive({ eventId: 'feishu-owner-answer', cursor: '4', tenantKey: 'tenant', chatId: 'group',
    chatType: 'group', rootId: 'om_work', messageId: 'om_owner_answer', senderId: 'alice', senderKind: 'human',
    text: 'Yes', createTime: '1700000003000', updateTime: '1700000003000' })
  for (let index = 0; index < 8; index++) await desktop.effects.drain()
  const answered = await desktop.conversation(ticketId)
  assert.equal(answered.attention.answeredBy, 'alice')
  assert.equal((await desktop.getMainSources({ instanceId: 'private' })).items.length, 1)
})
