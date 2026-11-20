import { platformError } from '../errors.js'
import {
  DINGTALK_LIMIT,
  asRecord,
  chunkText,
  closeSocket,
  configString,
  jsonRequest,
  openSocket,
  requireField,
  safeJson,
  socketData,
  socketOn,
  socketReady,
  stringValue,
} from '../wire.js'
import type { ImAdapter, ImAdapterEnvironment, ImChat, ImSendRequest, ImSocket } from '../types.js'

const GATEWAY = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'

function gatewayBase(env: ImAdapterEnvironment): string {
  return (configString(env, 'gateway') ?? configString(env, 'api') ?? GATEWAY).replace(/\/+$/u, '')
}

function oapiBase(env: ImAdapterEnvironment): string {
  return (configString(env, 'oapi') ?? configString(env, 'api') ?? OAPI).replace(/\/+$/u, '')
}

async function appToken(env: ImAdapterEnvironment, fields: Readonly<Record<string, string>>) {
  const clientId = requireField(fields, 'clientId', 'the Client ID')
  const clientSecret = requireField(fields, 'clientSecret', 'the Client Secret')
  const url = `${oapiBase(env)}/gettoken?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`
  const { response, body } = await jsonRequest(env, 'DingTalk', url, { method: 'GET' })
  if (!response.ok || Number(body.errcode) !== 0 || typeof body.access_token !== 'string') {
    throw platformError('DingTalk', stringValue(body.errmsg) || 'refused these credentials', {
      status: response.status,
      code: 'IM_ACCOUNT_INVALID',
      permanent: response.status < 500 && response.status !== 429,
    })
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 7200) - 30) * 1000,
  }
}

async function robot(env: ImAdapterEnvironment, token: string, path: string, body: Record<string, unknown>) {
  const { response, body: answer } = await jsonRequest(env, 'DingTalk', `${gatewayBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw platformError('DingTalk', stringValue(answer.message) || stringValue(answer.errmsg) || `answered ${response.status}`, {
      status: response.status,
    })
  }
  return answer
}

export const dingtalk: ImAdapter = {
  id: 'dingtalk',

  async check(fields, env) {
    await appToken(env, fields)
    const id = requireField(fields, 'clientId', 'the Client ID')
    return { account: { id, name: id } }
  },

  async connect(fields, env, handlers) {
    const clientId = requireField(fields, 'clientId', 'the Client ID')
    const clientSecret = requireField(fields, 'clientSecret', 'the Client Secret')
    let auth = await appToken(env, fields)
    const token = async () => {
      if (Date.now() >= auth.expiresAt) auth = await appToken(env, fields)
      return auth.token
    }
    let stopped = false
    let socket: ImSocket | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    let reconnectCount = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    const webhooks = new Map<string, { url: string; until: number }>()
    const account = { id: clientId, name: clientId }

    const sendFrame = (packet: Record<string, unknown>) => {
      if (socketReady(socket)) socket!.send(JSON.stringify(packet))
    }

    const ack = (headers: Record<string, unknown>, data: Record<string, unknown> = { ok: true }) => {
      sendFrame({
        specVersion: '1.0',
        code: 200,
        headers: { appType: 'STREAM', clientId, messageId: stringValue(headers.messageId), time: String(Date.now()) },
        message: 'OK',
        data: JSON.stringify(data),
      })
    }

    const deliver = async (headers: Record<string, unknown>, raw: string) => {
      const data = safeJson(raw)
      if (data.text === undefined && data.msgtype !== 'text' && data.msgtype !== 'richText') {
        ack(headers)
        return
      }
      const direct = data.conversationType === '1'
      const sender = stringValue(data.senderStaffId) || stringValue(data.senderId)
      const key = direct ? sender : stringValue(data.conversationId)
      if (data.sessionWebhook !== undefined) {
        webhooks.set(key, { url: stringValue(data.sessionWebhook), until: Date.now() + 20 * 60_000 })
      }
      ack(headers)
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group' },
        sender: { id: sender, name: stringValue(data.senderNick) || sender },
        text: stringValue(asRecord(data.text).content).trim(),
        mentioned: !direct && data.isInAtList === true,
        messageId: stringValue(data.msgId),
      })
    }

    const open = async () => {
      const gen = ++generation
      const { response, body } = await jsonRequest(env, 'DingTalk', `${gatewayBase(env)}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          ua: 'ds-superagent',
          subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
        }),
      })
      const endpoint = stringValue(body.endpoint)
      const ticket = stringValue(body.ticket)
      if (!response.ok || endpoint === '') {
        throw platformError('DingTalk', stringValue(body.message) || stringValue(body.error) || 'refused the connection', {
          status: response.status,
        })
      }
      const target = await openSocket(env, 'DingTalk', `${endpoint}?ticket=${encodeURIComponent(ticket)}`)
      socket = target
      const touch = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => closeSocket(target, 4001, 'idle'), Number(env.config?.idleTimeoutMs ?? 10 * 60_000))
        idleTimer.unref?.()
      }
      socketOn(target, 'message', raw => {
        if (stopped || generation !== gen) return
        touch()
        const packet = safeJson(socketData(raw))
        const headers = asRecord(packet.headers)
        if (packet.type === 'SYSTEM') {
          if (headers.topic === 'disconnect') {
            sendFrame({ code: 200, headers, message: 'OK', data: packet.data })
            closeSocket(target, 4001, 'reconnect')
          } else if (headers.topic === 'ping' || headers.eventType === 'ping' || stringValue(packet.data).includes('ping')) {
            sendFrame({ code: 200, headers, message: 'OK', data: packet.data })
          }
          return
        }
        if (packet.type === 'CALLBACK' || packet.type === 'EVENT') {
          void deliver(headers, stringValue(packet.data) || '{}')
            .catch(error => env.log?.warn?.('dingtalk message failed: %s', error instanceof Error ? error.message : error))
        }
      })
      socketOn(target, 'close', () => {
        if (stopped || generation !== gen) return
        clearTimeout(idleTimer)
        if (reconnectCount >= maxReconnects) {
          handlers.onStatus({ state: 'error', error: `DingTalk stopped after ${maxReconnects} reconnects` })
          return
        }
        reconnectCount += 1
        handlers.onStatus({ state: 'retrying' })
        reconnect = setTimeout(() => {
          if (!stopped) void open().catch(error => handlers.onStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) }))
        }, Math.min(30_000, 500 * (2 ** reconnectCount)))
        reconnect.unref?.()
      })
      socketOn(target, 'error', () => {})
      reconnectCount = 0
      touch()
      handlers.onStatus({ state: 'ready', account })
    }

    handlers.onStatus({ state: 'connecting' })
    await open()

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(request.text, DINGTALK_LIMIT)
        let messageId: string | undefined
        for (const chunk of chunks) {
          const hook = webhooks.get(chat.key)
          if (hook !== undefined && hook.until > Date.now()) {
            const { response, body } = await jsonRequest(env, 'DingTalk', hook.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ msgtype: 'markdown', markdown: { title: chunk.slice(0, 30), text: chunk } }),
            })
            if (!response.ok || Number(body.errcode) !== 0) {
              throw platformError('DingTalk', stringValue(body.errmsg) || 'refused the reply', { status: response.status })
            }
            if (body.processQueryKey !== undefined) messageId = stringValue(body.processQueryKey)
            continue
          }
          const path = chat.kind === 'direct' ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send'
          const body = chat.kind === 'direct'
            ? { robotCode: clientId, userIds: [chat.key], msgKey: 'sampleMarkdown',
              msgParam: JSON.stringify({ title: chunk.slice(0, 30), text: chunk }) }
            : { robotCode: clientId, openConversationId: chat.key, msgKey: 'sampleMarkdown',
              msgParam: JSON.stringify({ title: chunk.slice(0, 30), text: chunk }) }
          const answer = await robot(env, await token(), path, body)
          if (answer.processQueryKey !== undefined) messageId = stringValue(answer.processQueryKey)
        }
        return messageId === undefined ? {} : { messageId }
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(reconnect)
        clearTimeout(idleTimer)
        closeSocket(socket)
      },
    }
  },
}
