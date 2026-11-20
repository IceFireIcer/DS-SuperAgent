import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { createImQrMatrix, imQrSvg } from '../dsh/src/client/im-qr.js'
import jsQR from 'jsqr'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-im-contract-'))
const output = join(directory, 'im.mjs')
await build({
  entryPoints: [join(root, 'src/im/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: output,
  logLevel: 'silent',
})
const im = await import(pathToFileURL(output).href)
after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function fetchHarness(handler) {
  const calls = []
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      const call = { url, init, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) }
      calls.push(call)
      const result = await handler(url, call, calls)
      if (result === undefined) throw new Error(`Unexpected fixture request: ${url}`)
      return result
    },
  }
}

function socketHarness({ onOpen, onSend } = {}) {
  const sockets = []
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.listeners = new Map()
      sockets.push(this)
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.emit('open', {})
        onOpen?.(this)
      }, 0)
    }
    addEventListener(type, listener) {
      const held = this.listeners.get(type) ?? []
      held.push(listener)
      this.listeners.set(type, held)
    }
    on(type, listener) {
      this.addEventListener(type, listener)
    }
    send(data) {
      this.sent.push(data)
      onSend?.(this, data)
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close', { code, reason })
    }
    terminate() {
      this.close(1000, 'terminate')
    }
    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
  }
  return { WebSocket: FakeSocket, sockets }
}

function adapterEnvironment({ fetch, WebSocket, config } = {}) {
  const state = {}
  return {
    fetch,
    ...(WebSocket === undefined ? {} : { WebSocket }),
    ...(config === undefined ? {} : { config }),
    runtime: {
      get: () => state,
      set: patch => Object.assign(state, patch),
    },
    log: { warn: () => {} },
    now: Date.now,
  }
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('Telegram mock protocol accepts a token, receives an update and sends a reply', async () => {
  let polls = 0
  const request = fetchHarness(url => {
    if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 10, username: 'fixture_bot' } })
    if (url.endsWith('/getUpdates')) {
      polls += 1
      if (polls > 1) throw new Error('mock long poll interrupted')
      return json({ ok: true, result: polls === 1 ? [{
        update_id: 1,
        message: { message_id: 3, chat: { id: 20, type: 'private' }, from: { id: 'u1', first_name: 'Ada' }, text: 'hello' },
      }] : [] })
    }
    if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 4 } })
    if (url.endsWith('/sendChatAction')) return json({ ok: true, result: true })
    return undefined
  })
  const env = adapterEnvironment({ fetch: request.fetch, config: { api: 'https://telegram.fixture', pollTimeoutSeconds: 0 } })
  const checked = await im.adapters.telegram.check({ token: '123:fixture' }, env)
  assert.equal(checked.account.name, '@fixture_bot')
  let received
  const connection = await im.adapters.telegram.connect({ token: '123:fixture' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  await until(() => received !== undefined, 'Telegram message')
  assert.equal(received.chat.key, '20')
  assert.equal(received.text, 'hello')
  const sent = await connection.send(received.chat, { text: 'reply' })
  assert.equal(sent.messageId, '4')
  assert.equal(request.calls.find(call => call.url.endsWith('/sendMessage')).body.chat_id, '20')
  await connection.stop()
})

test('Discord mock protocol identifies, receives a message and sends through REST', async () => {
  const request = fetchHarness(url => {
    if (url.endsWith('/users/@me')) return json({ id: 'bot-1', username: 'fixture', bot: true })
    if (url.endsWith('/gateway/bot')) return json({ url: 'wss://discord.fixture/?v=10' })
    if (url.includes('/channels/55/messages')) return json({ id: 'm-1' })
    return undefined
  })
  const sockets = socketHarness({
    onOpen: socket => setTimeout(() => socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) }), 0),
    onSend: (socket, data) => {
      const packet = JSON.parse(String(data))
      if (packet.op !== 2) return
      socket.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 1,
        d: { session_id: 's1', user: { id: 'bot-1', username: 'fixture' } } }) })
    },
  })
  const env = adapterEnvironment({ fetch: request.fetch, WebSocket: sockets.WebSocket,
    config: { api: 'https://discord.fixture' } })
  await im.adapters.discord.check({ token: 'discord-token' }, env)
  let received
  const connection = await im.adapters.discord.connect({ token: 'discord-token' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  sockets.sockets[0].emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2,
    d: { id: 'm-1', channel_id: '55', guild_id: 'g1', content: '<@bot-1> hello', author: { id: 'u1', username: 'Ada' },
      mentions: [{ id: 'bot-1' }] } }) })
  await until(() => received !== undefined, 'Discord message')
  assert.equal(received.mentioned, true)
  const sent = await connection.send({ key: '55', kind: 'group' }, { text: 'reply' })
  assert.equal(sent.messageId, 'm-1')
  await connection.stop()
})

test('Slack mock protocol acks Socket Mode events and posts a reply', async () => {
  const request = fetchHarness(url => {
    if (url.endsWith('/auth.test')) return json({ ok: true, user_id: 'U-BOT', user: 'fixture' })
    if (url.endsWith('/apps.connections.open')) return json({ ok: true, url: 'wss://slack.fixture/socket' })
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: '171.1' })
    return undefined
  })
  const sockets = socketHarness({
    onOpen: socket => setTimeout(() => socket.emit('message', { data: JSON.stringify({ type: 'hello' }) }), 0),
  })
  const env = adapterEnvironment({ fetch: request.fetch, WebSocket: sockets.WebSocket,
    config: { api: 'https://slack.fixture' } })
  await im.adapters.slack.check({ appToken: 'xapp-fixture', botToken: 'xoxb-fixture' }, env)
  let received
  const connection = await im.adapters.slack.connect({ appToken: 'xapp-fixture', botToken: 'xoxb-fixture' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  const socket = sockets.sockets[0]
  socket.emit('message', { data: JSON.stringify({ type: 'events_api', envelope_id: 'env-1',
    payload: { type: 'event_callback', event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '170.1' } } }) })
  await until(() => received !== undefined, 'Slack message')
  assert.equal(JSON.parse(socket.sent.at(-1)).envelope_id, 'env-1')
  const sent = await connection.send({ key: 'D1', kind: 'direct' }, { text: 'reply' })
  assert.equal(sent.messageId, '171.1')
  await connection.stop()
})

test('Feishu mock protocol decodes a long-connection event and sends through OpenAPI', async () => {
  const request = fetchHarness(url => {
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
    }
    if (url.endsWith('/open-apis/bot/v3/info')) return json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Fixture' } })
    if (url.endsWith('/callback/ws/endpoint')) return json({ code: 0, data: { URL: 'wss://feishu.fixture/ws?service_id=1' } })
    if (url.includes('/open-apis/im/v1/messages')) return json({ code: 0, data: { message_id: 'om_reply' } })
    return undefined
  })
  const sockets = socketHarness()
  const env = adapterEnvironment({ fetch: request.fetch, WebSocket: sockets.WebSocket,
    config: { api: 'https://feishu.fixture' } })
  const fields = { domain: 'feishu', appId: 'app', appSecret: 'secret' }
  await im.adapters.feishu.check(fields, env)
  let received
  const connection = await im.adapters.feishu.connect(fields, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  const payload = new TextEncoder().encode(JSON.stringify({ header: { event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
        content: JSON.stringify({ text: 'hello' }) } } }))
  const frame = im.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'om_1' }], payload })
  sockets.sockets[0].emit('message', { data: frame })
  await until(() => received !== undefined, 'Feishu message')
  assert.equal(received.sender.id, 'ou_user')
  const sent = await connection.send({ key: 'oc_1', kind: 'direct' }, { text: 'reply' })
  assert.equal(sent.messageId, 'om_reply')
  assert.deepEqual(im.decodeFrame(frame).headers[0], { key: 'type', value: 'event' })
  await connection.stop()
})

test('DingTalk mock protocol ACKs a stream callback and uses its session webhook', async () => {
  const request = fetchHarness(url => {
    if (url.includes('/gettoken?')) return json({ errcode: 0, access_token: 'ding-token', expires_in: 7200 })
    if (url.endsWith('/v1.0/gateway/connections/open')) return json({ endpoint: 'wss://dingtalk.fixture/ws', ticket: 'ticket-1' })
    if (url.startsWith('https://hook.fixture/')) return json({ errcode: 0, processQueryKey: 'dq-1' })
    return undefined
  })
  const sockets = socketHarness()
  const env = adapterEnvironment({ fetch: request.fetch, WebSocket: sockets.WebSocket,
    config: { gateway: 'https://dingtalk.fixture', oapi: 'https://dingtalk.fixture' } })
  await im.adapters.dingtalk.check({ clientId: 'client', clientSecret: 'secret' }, env)
  let received
  const connection = await im.adapters.dingtalk.connect({ clientId: 'client', clientSecret: 'secret' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  sockets.sockets[0].emit('message', { data: JSON.stringify({ type: 'CALLBACK', headers: { messageId: 'h1' },
    data: JSON.stringify({ conversationType: '1', senderStaffId: 'u1', senderNick: 'Ada', msgId: 'dm1',
      text: { content: 'hello' }, sessionWebhook: 'https://hook.fixture/reply' }) }) })
  await until(() => received !== undefined, 'DingTalk message')
  assert.equal(JSON.parse(sockets.sockets[0].sent[0]).code, 200)
  const sent = await connection.send({ key: 'u1', kind: 'direct' }, { text: 'reply' })
  assert.equal(sent.messageId, 'dq-1')
  await connection.stop()
})

test('WeCom mock protocol subscribes, receives a callback and replies on its request id', async () => {
  const sockets = socketHarness({
    onSend: (socket, data) => {
      const packet = JSON.parse(String(data))
      if (packet.cmd === 'aibot_subscribe') {
        queueMicrotask(() => socket.emit('message', { data: JSON.stringify({ errcode: 0, headers: { req_id: packet.headers.req_id } }) }))
      }
    },
  })
  const env = adapterEnvironment({ fetch: async () => json({}), WebSocket: sockets.WebSocket,
    config: { gateway: 'wss://wecom.fixture' } })
  await im.adapters.wecom.check({ botId: 'bot', secret: 'secret' }, env)
  let received
  const connection = await im.adapters.wecom.connect({ botId: 'bot', secret: 'secret' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  sockets.sockets.at(-1).emit('message', { data: JSON.stringify({ cmd: 'aibot_msg_callback',
    headers: { req_id: 'callback-1' }, body: { msgid: 'wm1', chattype: 'single', from: { userid: 'u1', name: 'Ada' },
      text: { content: 'hello' }, msgtype: 'text' } }) })
  await until(() => received !== undefined, 'WeCom message')
  await connection.send({ key: 'u1', kind: 'direct' }, { text: 'reply' })
  const reply = sockets.sockets.at(-1).sent.map(data => JSON.parse(String(data))).find(packet => packet.cmd === 'aibot_respond_msg')
  assert.equal(reply.headers.req_id, 'callback-1')
  await connection.stop()
})

test('QQ mock protocol identifies, receives a C2C message and sends a passive reply', async () => {
  const request = fetchHarness(url => {
    if (url.endsWith('/app/getAppAccessToken')) return json({ access_token: 'qq-token', expires_in: 7200 })
    if (url.endsWith('/users/@me')) return json({ username: 'fixture' })
    if (url.endsWith('/gateway')) return json({ url: 'wss://qq.fixture/ws' })
    if (url.includes('/v2/users/u1/messages')) return json({ id: 'qm1' })
    return undefined
  })
  const sockets = socketHarness({
    onOpen: socket => setTimeout(() => socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) }), 0),
    onSend: (socket, data) => {
      const packet = JSON.parse(String(data))
      if (packet.op !== 2) return
      socket.emit('message', { data: JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 's1', user: { username: 'fixture' } } }) })
    },
  })
  const env = adapterEnvironment({ fetch: request.fetch, WebSocket: sockets.WebSocket,
    config: { api: 'https://qq.fixture', token: 'https://qq.fixture' } })
  await im.adapters.qq.check({ appId: 'app', appSecret: 'secret' }, env)
  let received
  const connection = await im.adapters.qq.connect({ appId: 'app', appSecret: 'secret' }, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  sockets.sockets[0].emit('message', { data: JSON.stringify({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-1', content: 'hello', author: { user_openid: 'u1' } } }) })
  await until(() => received !== undefined, 'QQ message')
  const sent = await connection.send({ key: 'u1', kind: 'direct' }, { text: 'reply' })
  assert.equal(sent.messageId, 'qm1')
  const posted = request.calls.find(call => call.url.includes('/v2/users/u1/messages'))
  assert.equal(posted.body.msg_id, 'msg-1')
  await connection.stop()
})

test('WeChat mock protocol exposes QR login, polls a message and sends with its context token', async () => {
  let messagePolls = 0
  const request = fetchHarness(url => {
    if (url.includes('/get_bot_qrcode')) return json({ qrcode: 'qr-fixture', qrcode_img_content: 'weixin://qr-fixture' })
    if (url.includes('/get_qrcode_status')) return json({ status: 'confirmed', bot_token: 'wx-token',
      ilink_bot_id: 'bot@im.bot', ilink_user_id: 'owner', baseurl: 'https://weixin.fixture' })
    if (url.includes('/msg/notifystart')) return json({ ret: 0 })
    if (url.includes('/getupdates')) {
      messagePolls += 1
      if (messagePolls > 1) throw new Error('mock long poll interrupted')
      return json(messagePolls === 1
        ? { ret: 0, get_updates_buf: 'cursor-1', msgs: [{ from_user_id: 'u1', client_id: 'wm1', context_token: 'ctx-1',
          item_list: [{ type: 1, text_item: { text: 'hello' } }] }] }
        : { ret: 0, get_updates_buf: 'cursor-1', msgs: [] })
    }
    if (url.includes('/sendmessage')) return json({ ret: 0 })
    return undefined
  })
  const env = adapterEnvironment({ fetch: request.fetch, config: { api: 'https://weixin.fixture' } })
  const login = await im.adapters.weixin.login.start(env)
  assert.equal(login.qr, 'weixin://qr-fixture')
  const confirmed = await im.adapters.weixin.login.wait(login.state, env)
  assert.equal(confirmed.status, 'done')
  const fields = confirmed.connection.fields
  let received
  const connection = await im.adapters.weixin.connect(fields, env, {
    onMessage: async message => { received = message },
    onAction: async () => {},
    onStatus: () => {},
  })
  await until(() => received !== undefined, 'WeChat message')
  const sent = await connection.send({ key: 'u1', kind: 'direct' }, { text: 'reply' })
  assert.match(sent.messageId, /^ds-superagent-/)
  const posted = request.calls.find(call => call.url.includes('/sendmessage'))
  assert.equal(posted.body.msg.context_token, 'ctx-1')
  await connection.stop()
})

function fakeAdapter({ check, send, login } = {}) {
  const state = { handlers: undefined, sends: 0, checks: 0, stops: 0, waits: 0 }
  const adapter = {
    id: 'telegram',
    async check(fields) {
      state.checks += 1
      if (check) return check(fields, state)
      return { account: { id: 'bot-1', name: 'Fixture bot' } }
    },
    async connect(_fields, env, handlers) {
      state.handlers = handlers
      state.runtime = env.runtime
      handlers.onStatus({ state: 'ready', account: { id: 'bot-1', name: 'Fixture bot' } })
      return {
        async send(chat, request) {
          state.sends += 1
          if (send) return send(chat, request, state)
          return { messageId: `sent-${state.sends}` }
        },
        stop() { state.stops += 1 },
      }
    },
  }
  if (login) adapter.login = {
    async start(env) { return login.start(env, state) },
    async wait(value, env) { state.waits += 1; return login.wait(value, env, state) },
  }
  return { adapter, state }
}

function serviceFor(adapter, overrides = {}) {
  let now = 1_000_000
  let sequence = 0
  return {
    service: im.createImService({
      instanceId: 'private',
      adapters: [adapter],
      now: () => now,
      createId: () => String(++sequence),
      sleep: async () => {},
      retryDelaysMs: [0],
      maxAttempts: 3,
      ...overrides,
    }),
    advance(ms) { now += ms },
    now: () => now,
  }
}

async function addFake(service) {
  return await service.save({
    instanceId: 'private',
    op: 'add',
    platform: 'telegram',
    fields: { token: 'telegram-secret-token' },
  })
}

test('pairing requests expire and never enter Main without approval', async () => {
  const { adapter, state } = fakeAdapter()
  const accepted = []
  const clock = serviceFor(adapter, { pairingTtlMs: 30_000, main: { accept: async event => { accepted.push(event); return { status: 'recorded', eventId: 'event-1' } } } })
  const connection = await addFake(clock.service)
  await state.handlers.onMessage({
    chat: { key: 'u1', kind: 'direct' }, sender: { id: 'u1', name: 'Ada' },
    text: 'hello', mentioned: false, messageId: 'm1',
  })
  const registry = clock.service.registry('private')
  assert.equal(registry.connections[0].pairRequests.length, 1)
  assert.equal(accepted.length, 0)
  clock.advance(30_001)
  await assert.rejects(clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'pair-expired', id: connection.id, op: 'pair', senderId: 'u1', allow: true,
  }), error => error.code === 'IM_PAIRING_EXPIRED')
  assert.equal(accepted.length, 0)
})

test('a paired IM message enters the Main source path with no credential fields', async () => {
  const { adapter, state } = fakeAdapter()
  const accepted = []
  const clock = serviceFor(adapter, {
    main: { accept: async event => { accepted.push(event); return { status: 'recorded', eventId: 'event-1' } } },
  })
  const connection = await addFake(clock.service)
  await state.handlers.onMessage({
    chat: { key: 'u1', kind: 'direct' }, sender: { id: 'u1', name: 'Ada' },
    text: 'first request', mentioned: false, messageId: 'm1',
  })
  await clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'pair-1', id: connection.id, op: 'pair', senderId: 'u1', allow: true,
  })
  await state.handlers.onMessage({
    chat: { key: 'u1', kind: 'direct' }, sender: { id: 'u1', name: 'Ada' },
    text: 'please handle this', mentioned: false, messageId: 'm2',
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].platform, 'telegram')
  assert.equal(accepted[0].sourceInstanceId, im.imHostSourceBinding().sourceInstanceId)
  assert.equal(accepted[0].addressing, 'direct')
  assert.match(accepted[0].threadId, /^im:telegram:/u)
  assert.equal(accepted[0].text, 'please handle this')
  const serialized = JSON.stringify(clock.service.registry('private'))
  assert.doesNotMatch(serialized, /telegram-secret-token/u)
  assert.equal(clock.service.registry('private').connections[0].secretFields[0], 'token')
})

test('sends retry a bounded number of times and retain a failed job for manual retry', async () => {
  let fail = true
  const { adapter, state } = fakeAdapter({
    send: () => {
      if (fail) throw new im.ImServiceError('rate limited', { code: 'IM_RATE_LIMITED', retryable: true, retryAfterMs: 0 })
      return { messageId: 'sent-after-retry' }
    },
  })
  const clock = serviceFor(adapter)
  const connection = await addFake(clock.service)
  await state.handlers.onMessage({
    chat: { key: 'u1', kind: 'direct' }, sender: { id: 'u1', name: 'Ada' },
    text: 'hello', mentioned: false, messageId: 'm1',
  })
  await clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'pair-1', id: connection.id, op: 'pair', senderId: 'u1', allow: true,
  })
  const failed = await clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'send-1', id: connection.id, op: 'send', chatKey: 'u1', body: { text: 'reply' },
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 3)
  assert.equal(state.sends, 3)
  fail = false
  const retried = await clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'retry-1', id: connection.id, op: 'retry',
  })
  assert.deepEqual([retried.sent, retried.failed, retried.remaining.length], [1, 0, 0])
})

test('login state and QR payload have a TTL and completion never returns credentials', async () => {
  const { adapter, state } = fakeAdapter({
    login: {
      async start() { return { qr: 'weixin://fixture', state: { qrcode: 'q1' } } },
      async wait() {
        return { status: 'done', connection: {
          fields: { token: 'never-return-this-token' },
          account: { id: 'bot', name: 'WeChat' },
        }, owner: { id: 'owner', name: 'Owner' } }
      },
    },
  })
  adapter.id = 'weixin'
  const clock = serviceFor(adapter, { loginTtlMs: 30_000 })
  const started = await clock.service.dispatch('im-login', {
    instanceId: 'private', commandId: 'login-1', op: 'start', platform: 'weixin',
  })
  assert.equal(started.status, 'waiting')
  assert.equal(started.expiresAt, clock.now() + 30_000)
  assert.equal(JSON.stringify(started).includes('qrcode'), false)
  clock.advance(30_001)
  const waited = await clock.service.dispatch('im-login', {
    instanceId: 'private', commandId: 'login-wait-1', op: 'wait', loginId: started.loginId,
  })
  assert.equal(waited.status, 'expired')
  assert.equal(state.waits, 0)
})

test('credential failures and platform errors are redacted before they reach the UI', async () => {
  const secret = 'super-secret-token'
  const { adapter } = fakeAdapter({
    check: () => {
      throw new Error(`bad ${secret} at https://api.example/bot${secret}/getMe Authorization: Bearer ${secret}`)
    },
  })
  const clock = serviceFor(adapter)
  await assert.rejects(clock.service.save({
    instanceId: 'private', op: 'add', platform: 'telegram', fields: { token: secret },
  }), error => {
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'))
    assert.match(error.message, /\*\*\*/u)
    return true
  })
})

test('updating to a rejected secret redacts the new value too', async () => {
  const oldSecret = 'old-secret-token'
  const nextSecret = 'new-secret-token'
  const { adapter } = fakeAdapter({
    check: fields => {
      if (fields.token === nextSecret) throw new Error(`rejected ${nextSecret}`)
      return { account: { id: 'bot-1', name: 'Fixture bot' } }
    },
  })
  const clock = serviceFor(adapter)
  const connection = await clock.service.save({
    instanceId: 'private', op: 'add', platform: 'telegram', fields: { token: oldSecret },
  })
  await assert.rejects(clock.service.save({
    instanceId: 'private', op: 'update', id: connection.id, fields: { token: nextSecret },
  }), error => {
    assert.doesNotMatch(error.message, new RegExp(nextSecret, 'u'))
    assert.match(error.message, /\*\*\*/u)
    return true
  })
})

test('disabling while a connection is starting cannot publish the late transport', async () => {
  let release
  let stops = 0
  const adapter = {
    id: 'telegram',
    async check() { return { account: { id: 'bot-1', name: 'Fixture bot' } } },
    async connect(_fields, _env, handlers) {
      handlers.onStatus({ state: 'connecting' })
      await new Promise(resolve => { release = resolve })
      handlers.onStatus({ state: 'ready' })
      return {
        async send() { return { messageId: 'late' } },
        stop() { stops += 1 },
      }
    },
  }
  const clock = serviceFor(adapter)
  const connection = await clock.service.save({
    instanceId: 'private', op: 'add', platform: 'telegram', fields: { token: 'starting-secret' }, enabled: false,
  })
  const enabling = clock.service.save({ instanceId: 'private', op: 'update', id: connection.id, enabled: true })
  await until(() => release !== undefined, 'the pending connection')
  await clock.service.save({ instanceId: 'private', op: 'update', id: connection.id, enabled: false })
  release()
  await enabling
  const current = clock.service.registry('private').connections[0]
  assert.equal(current.enabled, false)
  assert.equal(current.state, 'off')
  assert.equal(stops, 1)
})

test('manual retry replaces a terminal transport before reconnecting', async () => {
  let handlers
  let connects = 0
  let stops = 0
  const adapter = {
    id: 'telegram',
    async check() { return { account: { id: 'bot-1', name: 'Fixture bot' } } },
    async connect(_fields, _env, next) {
      connects += 1
      handlers = next
      next.onStatus({ state: 'ready', account: { id: 'bot-1', name: 'Fixture bot' } })
      return {
        async send() { return { messageId: `sent-${connects}` } },
        stop() { stops += 1 },
      }
    },
  }
  const clock = serviceFor(adapter)
  const connection = await clock.service.save({
    instanceId: 'private', op: 'add', platform: 'telegram', fields: { token: 'retry-secret' },
  })
  handlers.onStatus({ state: 'error', error: 'offline' })
  assert.equal(clock.service.registry('private').connections[0].state, 'error')
  await clock.service.dispatch('im-pair', {
    instanceId: 'private', commandId: 'retry-terminal', id: connection.id, op: 'retry',
  })
  assert.equal(connects, 2)
  assert.equal(stops, 1)
  assert.equal(clock.service.registry('private').connections[0].state, 'ready')
})

class MemoryCredentialRecords {
  records = new Map()
  async readRecord(key) { return this.records.get(key) }
  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, structuredClone(next))
    return next
  }
  async deleteRecord(key) { this.records.delete(key) }
}

test('DSH credential storage keeps IM secrets out of metadata and restores connections', async () => {
  const records = new MemoryCredentialRecords()
  const { CredentialImPersistence } = im
  const persistence = new CredentialImPersistence(records, 'private')
  const stored = {
    version: 1,
    id: 'im-1',
    platform: 'telegram',
    fields: { token: 'fixture-im-secret-token' },
    runtime: { offset: 5, contextTokens: { user: 'ephemeral-context-token' } },
    account: { id: 'bot-1', name: 'Fixture' },
    enabled: true,
    paired: [{ id: 'user-1', name: 'Ada', pairedAt: 100 }],
    pairRequests: [],
    chats: [{ key: 'user-1', kind: 'direct', lastMessageAt: 200 }],
    failedSends: [],
    createdAt: 100,
    updatedAt: 200,
  }
  await persistence.save(stored)
  const grantRecord = [...records.records.values()].find(record => record.kind === 'grant'
    && JSON.stringify(record.payload).includes('im-1'))
  assert.ok(grantRecord)
  assert.doesNotMatch(JSON.stringify(grantRecord), /fixture-im-secret-token/u)
  assert.ok([...records.records.values()].some(record => record.kind === 'api-key'
    && record.key.includes('fixture-im-secret-token')))
  assert.ok([...records.records.values()].some(record => record.kind === 'api-key'
    && record.key.includes('ephemeral-context-token')))
  const restored = await persistence.load()
  assert.equal(restored.length, 1)
  assert.equal(restored[0].fields.token, 'fixture-im-secret-token')
  assert.equal(restored[0].runtime.contextTokens.user, 'ephemeral-context-token')
  assert.equal(restored[0].paired[0].id, 'user-1')
})

test('per-connection IM cursor and context tokens survive service restart', async () => {
  const persistence = new im.MemoryImPersistence()
  const first = serviceFor(fakeAdapter().adapter, { persistence })
  const connection = await addFake(first.service)
  await first.service.dispose()

  const restoredAdapter = fakeAdapter()
  const restored = serviceFor(restoredAdapter.adapter, { persistence })
  await restored.service.startAll('private')
  restoredAdapter.state.runtime.set({ cursor: 'native-cursor-4', contextTokens: { user: 'wechat-context-value' } })
  await restored.service.dispose()

  const restartedAdapter = fakeAdapter()
  const restarted = serviceFor(restartedAdapter.adapter, { persistence })
  await restarted.service.startAll('private')
  assert.equal(restartedAdapter.state.runtime.get().cursor, 'native-cursor-4')
  assert.equal(restartedAdapter.state.runtime.get().contextTokens.user, 'wechat-context-value')
  assert.equal(restarted.service.registry('private').connections[0].id, connection.id)
  await restarted.service.dispose()
})

test('paired input reaches Engine Main and its Outbox reply is sent once across an IM Host restart',
  { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-im-engine-'))
    const turns = []
    const sent = []
    const records = new MemoryCredentialRecords()
    const core = await import('../dist/index.js')
    const { Engine, NativeSessions } = core
    const { imHostSourceBinding, createImHost, LocalEnvironment } = { ...im, ...core }
    let storage
    let native
    let sessions
    let engine
    let host
    t.after(async () => {
      await host?.close()
      await engine?.effects.stop()
      await engine?.shutdown()
      await sessions?.close()
      await native?.fiber.dispose()
      await storage?.close()
      await rm(directory, { recursive: true, force: true })
    })

    native = await nativeContext(join(directory, 'sessions'), function* (options) {
      turns.push(options.model)
      yield* textResponse('Main handled the paired IM request.')
    })
    storage = await SqliteStorage.open(join(directory, 'engine.sqlite'))
    const workspace = join(directory, 'workspace')
    await (await import('node:fs/promises')).mkdir(workspace)
    const environment = await LocalEnvironment.open({ instanceId: 'private', id: 'workspace', root: workspace,
      allowedActorIds: ['im-receiver'], permissions: ['read', 'write'], commands: {} })
    sessions = new NativeSessions(native, {
      main: { provider: 'mock', model: 'main' },
      router: { provider: 'mock', model: 'router' },
      worker: { provider: 'mock', model: 'worker' },
    })
    const mock = fakeAdapter({ send: async (chat, request, state) => {
      sent.push({ chat, request })
      return { messageId: `out-${state.sends}` }
    } })
    const hostOptions = { instanceId: 'private', credentialRecords: records, adapters: [mock.adapter],
      pairingTtlMs: 60_000, maxAttempts: 1, retryDelaysMs: [0] }
    host = createImHost(hostOptions)
    engine = new Engine(storage, 'private', imHostSourceBinding(), {}, sessions, [environment], {}, {}, {},
      { channel: host.deliveryChannel })
    await engine.acquireHost({ initializeMain: true })
    host.bindEngine(engine)
    await host.start()

    const connection = await host.dispatch('im-save', {
      instanceId: 'private', commandId: 'im-add-one', op: 'add', platform: 'telegram', fields: { token: 'mock-token' },
    })
    await mock.state.handlers.onMessage({ chat: { key: 'native-chat', kind: 'direct' },
      sender: { id: 'native-user', name: 'Ada' }, text: 'Pair me', mentioned: false, messageId: 'pair-msg' })
    await host.dispatch('im-pair', {
      instanceId: 'private', commandId: 'im-pair-one', id: connection.id, op: 'pair', senderId: 'native-user', allow: true,
    })
    await mock.state.handlers.onMessage({ chat: { key: 'native-chat', kind: 'direct' },
      sender: { id: 'native-user', name: 'Ada' }, text: 'Please handle this.', mentioned: false, messageId: 'request-msg' })

    let sources
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await engine.effects.drain()
      sources = await engine.getMainSources({ instanceId: 'private' })
      if (sources.items.some(item => item.deliveries.some(delivery => delivery.state === 'sent'))) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(sources.items.length, 1)
    const source = sources.items[0]
    assert.equal(source.state, 'presented')
    assert.equal(source.sourceInstanceId, 'im')
    assert.match(source.threadId, /^im:telegram:/u)
    assert.equal(source.authorId, im.imRequesterId('telegram', connection.id, 'native-user'))
    assert.equal(source.deliveries[0]?.state, 'sent')
    assert.equal((await engine.listTickets()).items.length, 0)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chat.key, 'native-chat')
    assert.equal(sent[0].request.text, 'Main handled the paired IM request.')
    assert.ok(turns.includes('main'))

    const reply = await storage.transaction('private', tx => tx.get('main-source-reply', `main-source-reply:${source.id}`))
    assert.ok(reply, 'the Outbox must have a durable Main reply')
    const replyContext = { idempotencyKey: JSON.stringify([reply.effectId, reply.effectGeneration]), signal: new AbortController().signal }
    await host.close()
    host = createImHost(hostOptions)
    host.bindEngine(engine)
    await host.start()
    assert.deepEqual(await host.deliveryChannel.reconcileSourceReply(reply, replyContext), { type: 'success' })
    assert.deepEqual(await host.deliveryChannel.deliverSourceReply(reply, replyContext), { type: 'success' })
    assert.equal(sent.length, 1, 'the persisted receipt prevents a duplicate send after restart')

    await engine.setProcessingPaused({ commandId: 'pause-im-before-send', paused: true })
    const pausedDelivery = await host.deliveryChannel.deliverSourceReply({ ...reply, id: `${reply.id}:paused` },
      { ...replyContext, idempotencyKey: 'engine-main-source-reply-paused' })
    assert.deepEqual(pausedDelivery, { type: 'transient', reason: 'PROCESSING_PAUSED' })
    assert.equal(sent.length, 1, 'Engine pause prevents new IM delivery')
    await engine.setProcessingPaused({ commandId: 'unpause-im-after-test', paused: false })

    await host.dispatch('im-pair', {
      instanceId: 'private', commandId: 'im-unpair-one', id: connection.id, op: 'unpair', senderId: 'native-user',
    })
    const revokedDelivery = await host.deliveryChannel.deliverSourceReply({ ...reply, id: `${reply.id}:revoked` },
      { ...replyContext, idempotencyKey: 'engine-main-source-reply-revoked' })
    assert.deepEqual(revokedDelivery, { type: 'permanent', reason: 'IM_PAIRING_REVOKED' })
    assert.equal(sent.length, 1, 'unpaired requesters cannot receive delayed Main output')

    const registryJson = JSON.stringify(await host.service.registry('private'))
    assert.doesNotMatch(registryJson, /mock-token/u)
    assert.ok([...records.records.values()].some(record => record.kind === 'api-key' && record.key.includes('mock-token')))
  })

test('IM thread and requester identities remain bounded with platform-sized native IDs', () => {
  const route = {
    platform: 'telegram',
    accountId: 'account:part/'.repeat(8),
    connectionId: 'connection-id/'.repeat(8),
    chatKind: 'group',
    chatKey: 'chat/id:one/'.repeat(8),
  }
  const threadId = im.imThreadId(route)
  assert.ok(Buffer.byteLength(threadId) < 512)
  assert.deepEqual(im.parseImThread(threadId), route)
  assert.match(im.imRequesterId('telegram', 'connection-id', 'native-user'), /^im:telegram:[a-f0-9]{64}$/u)
  assert.equal(im.parseImThread(`im:telegram:${'a'.repeat(510)}`), undefined)
  assert.ok(Buffer.byteLength(im.imRequesterId('telegram', 'a'.repeat(112), '界'.repeat(37))) < 128)
  assert.throws(() => im.imThreadId({ ...route, chatKey: 'x'.repeat(113) }), /1 to 112 UTF-8 bytes/u)
})

test('WeChat pairing URI renders as a QR matrix, not plain text', () => {
  const payload = 'weixin://fixture/scan?code=ABCDEFG123456'
  const matrix = createImQrMatrix(payload)
  assert.equal(matrix.length, 29)
  assert.ok(matrix.every(row => row.length === matrix.length))
  assert.ok(matrix[0].slice(0, 7).every(Boolean))
  assert.match(imQrSvg(payload), /<svg[\s\S]*<path d="M/u)
  const scale = 4, quiet = 4
  const size = (matrix.length + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(size * size * 4)
  pixels.fill(255)
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix.length; column += 1) {
      if (!matrix[row][column]) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = ((((row + quiet) * scale) + dy) * size + ((column + quiet) * scale) + dx) * 4
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
          pixels[offset + 3] = 255
        }
      }
    }
  }
  assert.equal(jsQR(pixels, size, size)?.data, payload)
  assert.throws(() => createImQrMatrix('x'.repeat(272)), /271-byte limit/u)
})

test('endpoint whitelist accepts only the four IM methods and rejects unknown payload fields', async () => {
  const { adapter } = fakeAdapter()
  const clock = serviceFor(adapter)
  assert.deepEqual(im.IM_ENDPOINTS, ['im-registry', 'im-save', 'im-pair', 'im-login'])
  const registry = await clock.service.dispatch('im-registry', { instanceId: 'private' })
  assert.equal(registry.platforms.length, 8)
  await assert.rejects(clock.service.dispatch('im-save', {
    instanceId: 'private', commandId: 'bad-field', op: 'add', platform: 'telegram', fields: { token: 'secret' }, token: 'leak',
  }), error => error.code === 'IM_INVALID_INPUT')
  await assert.rejects(clock.service.dispatch('im-nope', { instanceId: 'private' }),
    error => error.code === 'IM_ENDPOINT_UNSUPPORTED')
})
