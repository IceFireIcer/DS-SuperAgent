import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { build } from 'esbuild'
import { SqliteStorage } from '../dist/storage.js'

async function loadModule(file) {
  const entry = fileURLToPath(new URL(`../src/im-accounts/${file}.ts`, import.meta.url))
  const { outputFiles } = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'node',
    format: 'cjs', packages: 'external' })
  const module = { exports: {} }
  runInThisContext(`(function (require, module, exports) { ${outputFiles[0].text}\n })`)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}

const { ImAccounts } = await loadModule('index')
const { createAdapters } = await loadModule('adapters')
const sleep = () => delay(15)
const json = payload => Response.json(payload)

async function until(observe, label) {
  for (let attempt = 0; attempt < 260; attempt++) {
    const value = await observe()
    if (value) return value
    await sleep()
  }
  assert.fail(`Timed out: ${label}`)
}

class LocalSocket extends EventTarget {
  readyState = WebSocket.CONNECTING

  constructor(url, handler, startup) {
    super()
    this.url = new URL(url)
    this.handler = handler
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
      startup?.(this)
    })
  }

  send(payload) { this.handler(JSON.parse(payload), this) }

  push(payload) {
    queueMicrotask(() => {
      if (this.readyState === WebSocket.OPEN) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
    })
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

const telegramToken = '123456:fictional_fixture_telegram'
const telegramIdentity = { ok: true, result: { id: 123456, is_bot: true } }
const telegramUpdate = (updateId, sender, text, type = 'private') => ({
  update_id: updateId, message: { message_id: updateId, chat: { id: sender, type }, from: { id: sender, is_bot: false }, text },
})

const providers = [
  {
    platform: 'feishu', credentials: { appId: 'cli_fixture', appSecret: 'fictional-feishu', chatId: 'oc_private' },
    http(url, body) {
      if (url.pathname.endsWith('/tenant_access_token/internal')) {
        assert.equal(body.app_id, 'cli_fixture')
        return { code: 0, tenant_access_token: 'fictional-feishu-access', expire: 7200 }
      }
      if (url.pathname.endsWith('/chats/oc_private')) return { code: 0, data: { chat_mode: 'p2p' } }
      if (url.pathname.endsWith('/messages')) return { code: 0, data: { items: [{ message_id: 'm1', chat_id: 'oc_private',
        create_time: String(Date.now() + 10_000), sender: { id: 'ou_peer', id_type: 'open_id', sender_type: 'user' },
        msg_type: 'text', body: { content: '{"text":"hello"}' } }] } }
      assert.match(url.pathname, /\/m1\/reply$/u)
      assert.equal(JSON.parse(body.content).text, 'answer')
      assert.match(body.uuid, /^[a-f0-9]{32}$/u)
      return { code: 0, data: { message_id: 'feishu-receipt' } }
    },
    receipt: 'feishu-receipt',
  },
  {
    platform: 'dingtalk', credentials: { clientId: 'ding-fixture', clientSecret: 'fictional-dingtalk' },
    http(url, body, headers) {
      if (url.pathname.endsWith('/oauth2/accessToken')) return { accessToken: 'fictional-ding-access', expireIn: 7200 }
      if (url.pathname.endsWith('/gateway/connections/open')) {
        assert.deepEqual(body.subscriptions, [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }])
        return { endpoint: 'wss://fixture.dingtalk.com/connect', ticket: 'fictional-stream-ticket' }
      }
      assert.match(url.pathname, /\/robot\/oToMessages\/batchSend$/u)
      assert.equal(headers['x-acs-dingtalk-access-token'], 'fictional-ding-access')
      assert.deepEqual(body.userIds, ['staff-peer'])
      assert.equal(JSON.parse(body.msgParam).content, 'answer')
      return { processQueryKey: 'ding-receipt' }
    },
    start(socket) {
      assert.equal(socket.url.searchParams.get('ticket'), 'fictional-stream-ticket')
      socket.push({ type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'ding-event' },
        data: JSON.stringify({ conversationType: '1', msgtype: 'text', senderStaffId: 'staff-peer', conversationId: 'ding-chat',
          msgId: 'm1', text: { content: 'hello' }, sessionWebhook: 'https://outside.invalid/never-use' }) })
    },
    frame(frame, _socket, acks) { if (frame.headers?.messageId === 'ding-event') acks.push(frame.code) },
    acknowledged: 200,
    receipt: 'ding-receipt',
  },
  {
    platform: 'wecom', credentials: { botId: 'wecom-fixture', secret: 'fictional-wecom' },
    frame(frame, socket) {
      assert.equal(socket.url.hostname, 'openws.work.weixin.qq.com')
      if (frame.cmd === 'aibot_subscribe') {
        assert.equal(frame.body.bot_id, 'wecom-fixture')
        socket.push({ headers: frame.headers, errcode: 0 })
        socket.push({ cmd: 'aibot_msg_callback', body: { aibotid: 'wecom-fixture', msgid: 'm1',
          chattype: 'single', msgtype: 'text', from: { userid: 'wecom-peer' }, text: { content: 'hello' } } })
      } else {
        assert.equal(frame.cmd, 'aibot_send_msg')
        assert.equal(frame.body.chatid, 'wecom-peer')
        assert.equal(frame.body.markdown.content, 'answer')
        socket.push({ headers: frame.headers, errcode: 0 })
      }
    },
    receipt: /^[a-f0-9]{32}$/u,
  },
  {
    platform: 'qq', credentials: { appId: 'qq-fixture', clientSecret: 'fictional-qq' },
    http(url, body, headers) {
      if (url.pathname === '/app/getAppAccessToken') return { access_token: 'fictional-qq-access', expires_in: 7200 }
      assert.equal(headers.Authorization, 'QQBot fictional-qq-access')
      if (url.pathname === '/gateway') return { url: 'wss://fixture.sgroup.qq.com' }
      assert.equal(url.pathname, '/v2/users/qq-peer/messages')
      assert.equal(body.msg_id, 'm1')
      assert.equal(body.content, 'answer')
      return { id: 'qq-receipt' }
    },
    start(socket) { socket.push({ op: 10, d: { heartbeat_interval: 41_250 } }) },
    frame(frame, socket) {
      assert.equal(frame.op, 2)
      assert.equal(frame.d.token, 'QQBot fictional-qq-access')
      assert.equal(frame.d.intents, 1 << 25)
      socket.push({ op: 0, t: 'READY', d: {} })
      socket.push({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 1, d: { id: 'm1', author: { user_openid: 'qq-peer' }, content: 'hello' } })
    },
    receipt: 'qq-receipt',
  },
  {
    platform: 'wechat', credentials: { botId: 'wechat-fixture', token: 'fixture-wx', baseUrl: 'https://ilinkai.weixin.qq.com' },
    http(url, body, headers) {
      assert.equal(headers.Authorization, 'Bearer fixture-wx')
      if (url.pathname.endsWith('/getupdates')) return { ret: 0, get_updates_buf: 'wx-next', msgs: body.get_updates_buf ? [] : [{
        message_type: 1, message_id: 1, from_user_id: 'wx-peer', context_token: 'fictional-context',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      }] }
      assert.equal(url.pathname, '/ilink/bot/sendmessage')
      assert.equal(body.msg.to_user_id, 'wx-peer')
      assert.equal(body.msg.context_token, 'fictional-context')
      assert.equal(body.msg.item_list[0].text_item.text, 'answer')
      return { ret: 0 }
    },
    receipt: /^superagent-[a-f0-9]{32}$/u,
  },
  {
    platform: 'discord', credentials: { botToken: 'fictional-discord' },
    http(url, body, headers) {
      assert.equal(headers.Authorization, 'Bot fictional-discord')
      if (url.pathname.endsWith('/users/@me')) return { id: 'discord-self', bot: true }
      assert.match(url.pathname, /channels\/discord-dm\/messages$/u)
      assert.equal(body.content, 'answer')
      assert.equal(body.enforce_nonce, true)
      assert.deepEqual(body.allowed_mentions, { parse: [] })
      return { id: 'discord-receipt' }
    },
    start(socket) { socket.push({ op: 10, d: { heartbeat_interval: 41_250 } }) },
    frame(frame, socket) {
      assert.equal(frame.d.intents, 1 << 12)
      socket.push({ op: 0, t: 'READY', d: {} })
      socket.push({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: 'm1', type: 0, channel_id: 'discord-dm',
        author: { id: 'discord-peer' }, content: 'hello' } })
    },
    receipt: 'discord-receipt',
  },
  {
    platform: 'slack', credentials: { botToken: 'xoxb-fixture', appToken: 'xapp-fixture' },
    http(url, body, headers) {
      if (url.pathname.endsWith('/auth.test')) return { ok: true, team_id: 'slack-team', user_id: 'slack-self' }
      if (url.pathname.endsWith('/apps.connections.open')) {
        assert.equal(headers.Authorization, 'Bearer xapp-fixture')
        return { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=fictional' }
      }
      assert.match(url.pathname, /chat.postMessage$/u)
      assert.equal(body.channel, 'slack-dm')
      assert.equal(body.thread_ts, 'm1')
      assert.equal(body.text, 'answer')
      return { ok: true, ts: 'slack-receipt' }
    },
    start(socket) {
      socket.push({ type: 'hello' })
      socket.push({ type: 'events_api', envelope_id: 'slack-envelope', payload: { team_id: 'slack-team', event: {
        type: 'message', channel_type: 'im', channel: 'slack-dm', user: 'slack-peer', ts: 'm1', text: 'hello',
      } } })
    },
    frame(frame, _socket, acks) { acks.push(frame.envelope_id) },
    acknowledged: 'slack-envelope',
    receipt: 'slack-receipt',
  },
  {
    platform: 'telegram', credentials: { botToken: telegramToken },
    http(url, body) {
      if (url.pathname.endsWith('/getMe')) return telegramIdentity
      if (url.pathname.endsWith('/getUpdates')) return { ok: true, result: body.offset ? [] : [telegramUpdate(1, 42, 'hello')] }
      assert.equal(body.chat_id, '42')
      assert.equal(body.reply_parameters.message_id, 1)
      assert.equal(body.text, 'answer')
      return { ok: true, result: { message_id: 10 } }
    },
    receipt: '10',
  },
]

for (const provider of providers) {
  test(`${provider.platform} signs in and exchanges a direct message with its native protocol`, async () => {
    const abort = new AbortController()
    const messages = []
    const acknowledgements = []
    const httpErrors = []
    let ready = false
    let cursor
    const adapters = createAdapters({
      fetch: async (url, request) => {
        try {
          return json(provider.http(new URL(url), request.body ? JSON.parse(request.body) : null, request.headers))
        } catch (error) { httpErrors.push(error); throw error }
      },
      socket: url => new LocalSocket(url, (frame, socket) => provider.frame(frame, socket, acknowledgements), provider.start),
    })
    const connection = await adapters[provider.platform].connect(provider.credentials, abort.signal)
    const receiving = connection.receive({ ready: () => { ready = true },
      message: async message => { messages.push(message) }, cursor: async () => cursor,
      checkpoint: async next => { cursor = next } }, abort.signal)
    receiving.catch(() => {})
    try {
      const incoming = await until(() => messages[0], `${provider.platform} direct message`)
      assert.equal(ready, true)
      assert.equal(incoming.text, 'hello')
      const receipt = await connection.send(incoming, 'answer', 'stable-delivery-key', abort.signal)
      if (typeof provider.receipt === 'string') assert.equal(receipt, provider.receipt)
      else assert.match(receipt, provider.receipt)
      if (provider.acknowledged) assert.deepEqual(acknowledgements, [provider.acknowledged])
    } finally {
      abort.abort()
      await receiving.catch(() => {})
      assert.deepEqual(httpErrors, [])
    }
  })
}

async function fixture(testContext, options) {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-im-accounts-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const secrets = new Map()
  const messages = []
  const vault = {
    async create(_instanceId, value) { const key = randomUUID(); secrets.set(key, value); return key },
    async withSecret(_instanceId, key, use) { assert.ok(secrets.has(key)); return use(secrets.get(key)) },
    async ensureRevoked(_instanceId, key) { secrets.delete(key) },
  }
  const instances = []
  const create = () => {
    const instance = new ImAccounts({ ...options, instanceId: 'personal', storage, vault, onMessage: async message => { messages.push(message) } })
    instances.push(instance)
    return instance
  }
  testContext.after(async () => {
    for (const instance of instances) await instance.close()
    await storage.close()
    await rm(join(directory, 'state.sqlite'), { force: true })
    await rm(join(directory, 'state.sqlite-wal'), { force: true })
    await rm(join(directory, 'state.sqlite-shm'), { force: true })
    await rmdir(directory)
  })
  return { service: create(), create, storage, secrets, messages }
}

test('pairing expires and requires approval; only the approved sender survives restore and can receive replies', async testContext => {
  let now = Date.now()
  let nextId = 0
  const queue = []
  const sends = []
  const enqueue = (sender, text, kind) => queue.push(telegramUpdate(++nextId, sender, text, kind))
  const { service, create, storage, secrets, messages } = await fixture(testContext, {
    now: () => now,
    fetch: async (url, request) => {
      const operation = new URL(url).pathname.split('/').at(-1)
      const body = JSON.parse(request.body)
      if (operation === 'getMe') return json(telegramIdentity)
      if (operation === 'getUpdates') return json({ ok: true, result: queue.filter(update => update.update_id >= body.offset) })
      assert.equal(operation, 'sendMessage')
      sends.push(body)
      return json({ ok: true, result: { message_id: 900 } })
    },
  })
  let running = service
  const call = (operation, values = {}) => running.dispatch({ instanceId: 'personal', operation, platform: 'telegram', ...values })
  const account = async () => (await running.dispatch({ instanceId: 'personal', operation: 'list' })).accounts.find(item => item.platform === 'telegram')
  await assert.rejects(running.dispatch({ instanceId: 'another', operation: 'list' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(call('connect', { credentials: { botToken: telegramToken, endpoint: 'https://outside.invalid/' } }), { code: 'INVALID_INPUT' })
  await call('connect', { credentials: { botToken: telegramToken } })
  await until(async () => (await account()).state === 'connected', 'Telegram receiver ready')
  const expired = await call('pair-start')
  now = expired.expiresAt
  enqueue(42, `pair ${expired.code}`)
  await until(async () => (await storage.transaction('personal', tx => tx.get('product-im-account', 'telegram'))).cursor === '2', 'old pairing consumed')
  assert.equal((await account()).pairing, undefined)
  const proposal = await call('pair-start')
  enqueue(77, `pair ${proposal.code}`, 'group')
  enqueue(42, `pair ${proposal.code}`)
  enqueue(42, 'before approval')
  const candidate = await until(async () => (await account()).pairing?.proposalId && (await account()).pairing, 'pairing candidate')
  await until(async () => (await storage.transaction('personal', tx => tx.get('product-im-account', 'telegram'))).cursor === '5', 'before-approval message consumed')
  assert.equal(candidate.senderId, '42')
  assert.equal(messages.length, 0)
  await assert.rejects(call('pair-approve', { proposalId: 'old-proposal' }), { code: 'IM_PAIRING_EXPIRED' })
  await call('pair-approve', { proposalId: candidate.proposalId })
  enqueue(77, 'different sender')
  enqueue(42, 'approved input')
  const incoming = await until(() => messages[0], 'approved Telegram input')
  assert.equal(incoming.text, 'approved input')
  assert.equal(messages.length, 1)
  assert.equal(running.isPaired(incoming), true)
  const projection = JSON.stringify(await account())
  assert.equal(projection.includes(telegramToken), false)
  assert.equal(projection.includes(proposal.code), false)
  const stored = await storage.transaction('personal', tx => tx.get('product-im-account', 'telegram'))
  assert.equal(JSON.stringify(stored).includes(telegramToken), false)
  await running.close()
  running = create()
  await running.restore()
  await until(async () => (await account()).state === 'connected', 'restored Telegram receiver')
  assert.equal(running.isPaired(incoming), true)
  assert.equal(await running.send(incoming, 'accepted reply', 'stable-key', new AbortController().signal), '900')
  assert.equal(sends[0].chat_id, '42')
  await call('pair-revoke')
  assert.equal(running.isPaired(incoming), false)
  await assert.rejects(running.send(incoming, 'denied reply', 'stable-key', new AbortController().signal), { code: 'SOURCE_NOT_AUTHORIZED' })
  const replacement = await call('pair-start')
  enqueue(42, `pair ${replacement.code}`)
  const replacementId = await until(async () => (await account()).pairing?.proposalId, 'replacement pairing candidate')
  await call('pair-approve', { proposalId: replacementId })
  assert.equal(running.isPaired(incoming), false)
  enqueue(42, 'after new approval')
  const replacementInput = await until(() => messages[1], 'newly approved Telegram input')
  assert.notEqual(replacementInput.pairId, incoming.pairId)
  assert.equal(running.isPaired(replacementInput), true)
  await call('disconnect')
  assert.equal(secrets.size, 0)
})

test('WeChat renders a local QR with a deadline and only saves the credential after a confirmed PIN exchange', async testContext => {
  const handle = 'fictional-wechat-qr-secret'
  const credential = 'fictional-wechat-credential'
  const requests = []
  const { service, storage, secrets } = await fixture(testContext, {
    fetch: async (value, request) => {
      const url = new URL(value)
      requests.push(url.pathname)
      assert.equal(url.origin, 'https://ilinkai.weixin.qq.com')
      if (url.pathname.endsWith('/get_bot_qrcode')) {
        assert.equal(request.method, 'POST')
        return json({ qrcode: handle, qrcode_img_content: 'https://weixin.qq.com/x/fictional-qr-display' })
      }
      if (url.pathname.endsWith('/get_qrcode_status')) {
        assert.equal(url.searchParams.get('qrcode'), handle)
        assert.equal(request.headers.Authorization, undefined)
        if (!url.searchParams.get('verify_code')) return json({ status: 'confirmed_but_need_verifycode' })
        assert.equal(url.searchParams.get('verify_code'), '2468')
        return json({ status: 'confirmed', bot_token: credential, ilink_bot_id: 'wechat-fixture', baseurl: url.origin })
      }
      assert.equal(url.pathname, '/ilink/bot/getupdates')
      assert.equal(request.headers.Authorization, `Bearer ${credential}`)
      return json({ ret: 0, msgs: [], get_updates_buf: '' })
    },
  })
  const call = (operation, values = {}) => service.dispatch({ instanceId: 'personal', operation, platform: 'wechat', ...values })
  const account = async () => (await service.dispatch({ instanceId: 'personal', operation: 'list' })).accounts.find(item => item.platform === 'wechat')
  const login = await call('qr-start')
  assert.match(login.qrImage, /^data:image\/png;base64,iVBOR/u)
  assert.ok(login.expiresAt > Date.now() && login.expiresAt <= Date.now() + 120_000)
  assert.equal(JSON.stringify(login).includes(handle), false)
  await until(async () => (await account()).qrState === 'verify', 'WeChat verification state')
  assert.equal(secrets.size, 0)
  await call('qr-verify', { code: '2468' })
  await until(async () => (await account()).state === 'connected', 'confirmed WeChat login')
  assert.ok(requests.includes('/ilink/bot/getupdates'))
  assert.equal(secrets.size, 1)
  assert.equal(JSON.stringify(await account()).includes(credential), false)
  assert.equal(JSON.stringify(await storage.transaction('personal', tx => tx.get('product-im-account', 'wechat'))).includes(credential), false)
  await call('disconnect')
  assert.equal(secrets.size, 0)
})

test('a disconnected transport retries, while an unconfirmed send preserves an unknown result', async testContext => {
  const updates = []
  let mode = 'transient'
  let receives = 0
  const { service, messages } = await fixture(testContext, {
    fetch: async (url, request) => {
      const operation = new URL(url).pathname.split('/').at(-1)
      if (operation === 'getMe') return json(telegramIdentity)
      if (operation === 'getUpdates') {
        if (++receives === 1) return new Response(null, { status: 503 })
        const offset = JSON.parse(request.body).offset
        return json({ ok: true, result: updates.filter(update => update.update_id >= offset) })
      }
      assert.equal(operation, 'sendMessage')
      if (mode === 'transient') return new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
      if (mode === 'rejected') return new Response(null, { status: 400 })
      throw new Error('fictional provider response lost')
    },
  })
  const call = (operation, values = {}) => service.dispatch({ instanceId: 'personal', operation, platform: 'telegram', ...values })
  const account = async () => (await service.dispatch({ instanceId: 'personal', operation: 'list' })).accounts.find(item => item.platform === 'telegram')
  await call('connect', { credentials: { botToken: telegramToken } })
  await until(async () => (await account()).state === 'retrying', 'reconnect after a transport error')
  await until(async () => (await account()).state === 'connected', 'transport recovery')
  const challenge = await call('pair-start')
  updates.push(telegramUpdate(1, 42, `pair ${challenge.code}`))
  const proposalId = await until(async () => (await account()).pairing?.proposalId, 'candidate for reply test')
  await call('pair-approve', { proposalId })
  updates.push(telegramUpdate(2, 42, 'reply to this'))
  const incoming = await until(() => messages[0], 'approved conversation message')
  const send = () => service.send(incoming, 'reply', 'stable-reply', new AbortController().signal)
  await assert.rejects(send(), { code: 'IM_UNAVAILABLE', retryAfterMs: 2000 })
  mode = 'rejected'
  await assert.rejects(send(), { code: 'IM_SEND_REJECTED' })
  mode = 'lost'
  await assert.rejects(send(), { code: 'IM_SEND_UNKNOWN' })
})
