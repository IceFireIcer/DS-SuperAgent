import { platformError } from '../errors.js'
import {
  DISCORD_LIMIT,
  asArray,
  asRecord,
  buttonRows,
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
import type {
  ImAdapter,
  ImAdapterEnvironment,
  ImChat,
  ImConnectionState,
  ImSendRequest,
  ImSocket,
} from '../types.js'

const API = 'https://discord.com/api/v10'
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

function apiBase(env: ImAdapterEnvironment): string {
  return (configString(env, 'api') ?? API).replace(/\/+$/u, '')
}

function gatewayUrl(env: ImAdapterEnvironment): string {
  return configString(env, 'gateway') ?? GATEWAY
}

function discordError(path: string, response: Response, body: Record<string, unknown>) {
  const retry = Number(body.retry_after)
  return platformError('Discord', stringValue(body.message) || `${path} answered ${response.status}`, {
    status: response.status,
    ...(Number.isFinite(retry) ? { retryAfterMs: retry * 1000 } : {}),
  })
}

async function rest(
  env: ImAdapterEnvironment,
  token: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const { response, body } = await jsonRequest(env, 'Discord', `${apiBase(env)}${path}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${token}` },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, options.signal)
  if (!response.ok) throw discordError(path, response, body)
  return body
}

async function check(env: ImAdapterEnvironment, token: string) {
  const me = await rest(env, token, '/users/@me', { method: 'GET' })
  if (me.id === undefined || me.bot !== true) {
    throw platformError('Discord', 'the token does not belong to a bot', { code: 'IM_ACCOUNT_INVALID', permanent: true })
  }
  return { id: stringValue(me.id), name: stringValue(me.username) === '' ? stringValue(me.id) : `@${stringValue(me.username)}` }
}

function normalizeGateway(base: string): string | undefined {
  try {
    const url = new URL(base)
    url.searchParams.set('v', '10')
    url.searchParams.set('encoding', 'json')
    return url.href
  } catch {
    return undefined
  }
}

export const discord: ImAdapter = {
  id: 'discord',

  async check(fields, env) {
    const token = requireField(fields, 'token', 'the Bot token')
    const account = await check(env, token)
    return { account: { id: account.id, name: account.name } }
  },

  async connect(fields, env, handlers) {
    const token = requireField(fields, 'token', 'the Bot token')
    const account = await check(env, token)
    let gateway = normalizeGateway(gatewayUrl(env))
    try {
      const discovered = await rest(env, token, '/gateway/bot', { method: 'GET' })
      gateway = normalizeGateway(stringValue(discovered.url)) ?? gateway
    } catch {
      // The configured gateway remains a valid fallback.
    }
    if (gateway === undefined) throw platformError('Discord', 'no usable gateway URL', { code: 'IM_UNAVAILABLE', permanent: true })

    let socket: ImSocket | undefined
    let stopped = false
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let sequence: number | undefined
    let sessionId: string | undefined
    let resumeUrl: string | undefined
    let ack = true
    let reconnectCount = 0
    let generation = 0
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    const readyWaiters: { resolve(): void; reject(error: Error): void }[] = []

    const settleReady = (error?: Error) => {
      const waiter = readyWaiters.shift()
      if (waiter === undefined) return
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }

    const sendPacket = (packet: Record<string, unknown>) => {
      if (socketReady(socket)) socket!.send(JSON.stringify(packet))
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
      heartbeat = setTimeout(beat, interval * Math.random())
      heartbeat.unref?.()
    }

    const messageEvent = async (data: Record<string, unknown>) => {
      if (asRecord(data.author).bot === true) return
      const direct = data.guild_id === undefined
      const mentions = asArray(data.mentions).map(asRecord)
      const mentioned = !direct && mentions.some(user => stringValue(user.id) === account.id)
      const author = asRecord(data.author)
      const text = stringValue(data.content).replaceAll(`<@${account.id}>`, '').replaceAll(`<@!${account.id}>`, '').trim()
      const title = direct ? stringValue(author.username) : ''
      await handlers.onMessage({
        chat: { key: stringValue(data.channel_id), kind: direct ? 'direct' : 'group', ...(title === '' ? {} : { title }) },
        sender: { id: stringValue(author.id), name: stringValue(author.username) },
        text,
        mentioned,
        messageId: stringValue(data.id),
      })
    }

    const interactionEvent = async (data: Record<string, unknown>) => {
      if (data.type !== 3) return
      await rest(env, token, `/interactions/${stringValue(data.id)}/${stringValue(data.token)}/callback`, {
        body: { type: 6 },
      }).catch(() => {})
      const user = asRecord(data.user ?? asRecord(data.member).user)
      await handlers.onAction({
        chat: { key: stringValue(data.channel_id ?? asRecord(data.channel).id), kind: data.guild_id === undefined ? 'direct' : 'group' },
        sender: { id: stringValue(user.id), name: stringValue(user.username) },
        text: '',
        mentioned: true,
        messageId: stringValue(asRecord(data.message).id),
        data: stringValue(asRecord(data.data).custom_id),
      })
    }

    const finishError = (error: string, state: ImConnectionState = 'error') => {
      handlers.onStatus({ state, error })
      settleReady(new Error(error))
    }

    const open = async (resume: boolean) => {
      const current = ++generation
      const target = resume && resumeUrl ? resumeUrl : gateway!
      let next: ImSocket
      try {
        next = await openSocket(env, 'Discord', target)
      } catch (error) {
        finishError(error instanceof Error ? error.message : String(error))
        return
      }
      socket = next
      socketOn(next, 'message', raw => {
        if (stopped || current !== generation) return
        let packet: Record<string, unknown>
        try {
          packet = asRecord(JSON.parse(String(socketData(raw))))
        } catch {
          return
        }
        if (Number.isSafeInteger(packet.s)) sequence = Number(packet.s)
        if (packet.op === 10) {
          scheduleHeartbeat(Number(asRecord(packet.d).heartbeat_interval) || 40_000)
          sendPacket(resume && sessionId
            ? { op: 6, d: { token, session_id: sessionId, seq: sequence ?? null } }
            : { op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: 'ds-superagent', device: 'ds-superagent' } } })
        } else if (packet.op === 11) {
          ack = true
        } else if (packet.op === 1) {
          sendPacket({ op: 1, d: sequence ?? null })
        } else if (packet.op === 7) {
          closeSocket(next, 4000, 'reconnect requested')
        } else if (packet.op === 9) {
          if (packet.d !== true) sessionId = undefined
          closeSocket(next, 4000, 'invalid session')
        } else if (packet.op === 0) {
          const event = asRecord(packet.d)
          if (packet.t === 'READY') {
            sessionId = stringValue(event.session_id)
            resumeUrl = stringValue(event.resume_gateway_url) || undefined
            reconnectCount = 0
            handlers.onStatus({ state: 'ready', account })
            settleReady()
          } else if (packet.t === 'RESUMED') {
            reconnectCount = 0
            handlers.onStatus({ state: 'ready' })
            settleReady()
          } else if (packet.t === 'MESSAGE_CREATE') {
            void messageEvent(event).catch(error => env.log?.warn?.('discord message failed: %s', error instanceof Error ? error.message : error))
          } else if (packet.t === 'INTERACTION_CREATE') {
            void interactionEvent(event).catch(error => env.log?.warn?.('discord action failed: %s', error instanceof Error ? error.message : error))
          }
        }
      })
      socketOn(next, 'close', () => {
        clearTimeout(heartbeat)
        if (stopped || current !== generation) return
        if (reconnectCount >= maxReconnects) {
          finishError(`Discord stopped after ${maxReconnects} reconnects`)
          return
        }
        reconnectCount += 1
        handlers.onStatus({ state: 'retrying' })
        reconnect = setTimeout(() => void open(sessionId !== undefined), Math.min(30_000, 500 * (2 ** reconnectCount)))
        reconnect.unref?.()
      })
      socketOn(next, 'error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    await open(false)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = readyWaiters.findIndex(waiter => waiter.reject === reject)
        if (index >= 0) readyWaiters.splice(index, 1)
        reject(platformError('Discord', 'gateway did not become ready', { code: 'IM_TIMEOUT', retryable: true }))
      }, Number(env.config?.readyTimeoutMs ?? 20_000))
      timer.unref?.()
      readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve() },
        reject: error => { clearTimeout(timer); reject(error) },
      })
    })

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(request.text, DISCORD_LIMIT)
        const buttons = buttonRows(request.buttons)
        let messageId: string | undefined
        for (const [index, content] of chunks.entries()) {
          const components = index === chunks.length - 1 && buttons.length
            ? [{ type: 1, components: buttons.map(button => ({ type: 2, style: 1, label: button.label.slice(0, 80), custom_id: button.data })) }]
            : []
          const sent = await rest(env, token, `/channels/${encodeURIComponent(chat.key)}/messages`, {
            body: { content, components },
          })
          if (sent.id !== undefined) messageId = stringValue(sent.id)
        }
        return messageId === undefined ? {} : { messageId }
      },
      async edit(chat, messageId, request) {
        const buttons = buttonRows(request.buttons)
        await rest(env, token, `/channels/${encodeURIComponent(chat.key)}/messages/${encodeURIComponent(messageId)}`, {
          method: 'PATCH',
          body: { content: chunkText(request.text, DISCORD_LIMIT)[0] ?? '',
            components: buttons.length ? [{ type: 1, components: buttons.map(button => ({ type: 2, style: 1, label: button.label.slice(0, 80), custom_id: button.data })) }] : [] },
        })
      },
      async typing(chat) {
        await rest(env, token, `/channels/${encodeURIComponent(chat.key)}/typing`).catch(() => {})
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(heartbeat)
        clearTimeout(reconnect)
        settleReady(new Error('stopped'))
        closeSocket(socket)
      },
    }
  },
}
