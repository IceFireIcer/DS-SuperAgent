import { platformError } from '../errors.js'
import {
  QQ_LIMIT,
  asRecord,
  chunkText,
  closeSocket,
  configString,
  jsonRequest,
  openSocket,
  requireField,
  socketData,
  socketOn,
  socketReady,
  stringValue,
} from '../wire.js'
import type { ImAdapter, ImAdapterEnvironment, ImChat, ImSendRequest, ImSocket } from '../types.js'

const API = 'https://api.sgroup.qq.com'
const TOKEN_API = 'https://bots.qq.com'
const INTENTS = 1 << 25

function apiBase(env: ImAdapterEnvironment): string {
  return (configString(env, 'api') ?? API).replace(/\/+$/u, '')
}

function tokenBase(env: ImAdapterEnvironment): string {
  return (configString(env, 'token') ?? TOKEN_API).replace(/\/+$/u, '')
}

async function getToken(env: ImAdapterEnvironment, fields: Readonly<Record<string, string>>) {
  const { response, body } = await jsonRequest(env, 'QQ', `${tokenBase(env)}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: requireField(fields, 'appId', 'the App ID'),
      clientSecret: requireField(fields, 'appSecret', 'the App Secret'),
    }),
  })
  if (!response.ok || typeof body.access_token !== 'string') {
    throw platformError('QQ', stringValue(body.error_reason) || stringValue(body.error) || 'refused these credentials', {
      status: response.status,
      code: 'IM_ACCOUNT_INVALID',
      permanent: response.status < 500 && response.status !== 429,
    })
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(30, Number(body.expires_in ?? 7200) - 60) * 1000,
  }
}

async function api(
  env: ImAdapterEnvironment,
  token: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const { response, body } = await jsonRequest(env, 'QQ', `${apiBase(env)}${path}`, {
    method: options.method ?? 'GET',
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (!response.ok || body.code !== undefined) {
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000
    throw platformError('QQ', stringValue(body.message) || stringValue(body.error) || `answered ${response.status}`, {
      status: response.status,
      ...(retryAfter > 0 ? { retryAfterMs: retryAfter } : {}),
    })
  }
  return body
}

export const qq: ImAdapter = {
  id: 'qq',

  async check(fields, env) {
    const auth = await getToken(env, fields)
    const me = asRecord(await api(env, auth.token, '/users/@me').catch(() => ({})))
    const appId = requireField(fields, 'appId', 'the App ID')
    return { account: { id: appId, name: stringValue(me.username) === '' ? appId : `@${stringValue(me.username)}` } }
  },

  async connect(fields, env, handlers) {
    let auth = await getToken(env, fields)
    const appId = requireField(fields, 'appId', 'the App ID')
    const gateway = asRecord(await api(env, auth.token, '/gateway'))
    const url = stringValue(gateway.url)
    if (url === '') throw platformError('QQ', 'returned no gateway URL', { code: 'IM_UNAVAILABLE', permanent: true })

    let stopped = false
    let socket: ImSocket | undefined
    let generation = 0
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let refresh: ReturnType<typeof setTimeout> | undefined
    let sequence: number | undefined
    let sessionId: string | undefined
    let reconnectCount = 0
    let ack = true
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    const lastMessage = new Map<string, { id: string; seq: number }>()
    const account = { id: appId, name: stringValue(asRecord(gateway.user).username) === '' ? appId : `@${stringValue(asRecord(gateway.user).username)}` }
    let resolveReady: (() => void) | undefined
    let rejectReady: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const readyTimer = setTimeout(() => rejectReady?.(platformError('QQ', 'gateway did not become ready', {
      code: 'IM_TIMEOUT', retryable: true,
    })), Number(env.config?.readyTimeoutMs ?? 20_000))
    readyTimer.unref?.()
    const settleReady = (error?: Error) => {
      clearTimeout(readyTimer)
      if (error === undefined) resolveReady?.()
      else rejectReady?.(error)
      resolveReady = undefined
      rejectReady = undefined
    }

    const sendPacket = (packet: Record<string, unknown>) => {
      if (socketReady(socket)) socket!.send(JSON.stringify(packet))
    }
    const token = async () => {
      if (Date.now() >= auth.expiresAt) auth = await getToken(env, fields)
      return auth.token
    }

    const scheduleHeartbeat = (interval: number) => {
      clearTimeout(heartbeat)
      ack = true
      const beat = () => {
        if (!ack) {
          closeSocket(socket, 4000, 'heartbeat lost')
          return
        }
        ack = false
        sendPacket({ op: 1, d: sequence ?? null })
        heartbeat = setTimeout(beat, interval)
        heartbeat.unref?.()
      }
      heartbeat = setTimeout(beat, interval)
      heartbeat.unref?.()
    }

    const dispatch = async (packet: Record<string, unknown>) => {
      if (packet.t === 'READY') {
        sessionId = stringValue(asRecord(packet.d).session_id)
        handlers.onStatus({ state: 'ready', account })
        settleReady()
        return
      }
      if (packet.t === 'RESUMED') {
        handlers.onStatus({ state: 'ready' })
        settleReady()
        return
      }
      const c2c = packet.t === 'C2C_MESSAGE_CREATE'
      const group = packet.t === 'GROUP_AT_MESSAGE_CREATE'
      if (!c2c && !group) return
      const data = asRecord(packet.d)
      const author = asRecord(data.author)
      const key = c2c ? stringValue(author.user_openid) || stringValue(data.channel_id) : stringValue(data.group_openid) || stringValue(data.channel_id)
      lastMessage.set(key, { id: stringValue(data.id), seq: 0 })
      const sender = c2c ? stringValue(author.user_openid) : stringValue(author.member_openid)
      await handlers.onMessage({
        chat: { key, kind: c2c ? 'direct' : 'group' },
        sender: { id: sender, name: sender },
        text: stringValue(data.content).trim(),
        mentioned: group,
        messageId: stringValue(data.id),
      })
    }

    const open = async (resume: boolean) => {
      const gen = ++generation
      const target = await openSocket(env, 'QQ', url)
      socket = target
      socketOn(target, 'message', raw => {
        if (stopped || generation !== gen) return
        const packet = asRecord(JSON.parse(String(socketData(raw))))
        if (Number.isSafeInteger(packet.s)) sequence = Number(packet.s)
        if (packet.op === 10) {
          scheduleHeartbeat(Number(asRecord(packet.d).heartbeat_interval) || 40_000)
          sendPacket(resume && sessionId
            ? { op: 6, d: { token: `QQBot ${auth.token}`, session_id: sessionId, seq: sequence ?? null } }
            : { op: 2, d: { token: `QQBot ${auth.token}`, intents: INTENTS, shard: [0, 1],
              properties: { os: process.platform, browser: 'ds-superagent', device: 'ds-superagent' } } })
        } else if (packet.op === 11) {
          ack = true
        } else if (packet.op === 1) {
          sendPacket({ op: 1, d: sequence ?? null })
        } else if (packet.op === 7) {
          closeSocket(target, 4000, 'reconnect')
        } else if (packet.op === 9) {
          if (packet.d !== true) sessionId = undefined
          closeSocket(target, 4000, 'invalid session')
        } else if (packet.op === 0) {
          void dispatch(packet).catch(error => env.log?.warn?.('qq event failed: %s', error instanceof Error ? error.message : error))
        }
      })
      socketOn(target, 'close', () => {
        clearTimeout(heartbeat)
        if (stopped || generation !== gen) return
        if (reconnectCount >= maxReconnects) {
          handlers.onStatus({ state: 'error', error: `QQ stopped after ${maxReconnects} reconnects` })
          settleReady(new Error('QQ stopped reconnecting'))
          return
        }
        reconnectCount += 1
        handlers.onStatus({ state: 'retrying' })
        reconnect = setTimeout(() => {
          if (!stopped) void open(sessionId !== undefined).catch(error => handlers.onStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) }))
        }, Math.min(30_000, 500 * (2 ** reconnectCount)))
        reconnect.unref?.()
      })
      socketOn(target, 'error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    const scheduleRefresh = () => {
      const wait = Math.max(5_000, auth.expiresAt - Date.now() - 60_000)
      refresh = setTimeout(() => {
        if (stopped) return
        void getToken(env, fields).then(next => { auth = next; scheduleRefresh() }).catch(() => scheduleRefresh())
      }, wait)
      refresh.unref?.()
    }
    scheduleRefresh()
    await open(false)
    await ready

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(request.text, QQ_LIMIT)
        const path = chat.kind === 'direct' ? `/v2/users/${encodeURIComponent(chat.key)}/messages` : `/v2/groups/${encodeURIComponent(chat.key)}/messages`
        let messageId: string | undefined
        for (const chunk of chunks) {
          const last = lastMessage.get(chat.key)
          const reply = last === undefined ? {} : { msg_id: last.id, msg_seq: ++last.seq }
          const sent = await api(env, await token(), path, {
            method: 'POST',
            body: { markdown: { content: chunk }, msg_type: 2, ...reply },
          })
          if (sent.id !== undefined) messageId = stringValue(sent.id)
        }
        return messageId === undefined ? {} : { messageId }
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(heartbeat)
        clearTimeout(reconnect)
        clearTimeout(refresh)
        settleReady(new Error('stopped'))
        closeSocket(socket)
      },
    }
  },
}
