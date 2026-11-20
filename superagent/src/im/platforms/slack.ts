import { platformError } from '../errors.js'
import {
  SLACK_LIMIT,
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
import type { ImAdapter, ImAdapterEnvironment, ImChat, ImSendRequest, ImSocket } from '../types.js'

const API = 'https://slack.com/api/'

function apiBase(env: ImAdapterEnvironment): string {
  return `${(configString(env, 'api') ?? API).replace(/\/+$/u, '')}/`
}

function slackError(body: Record<string, unknown>, status = 200) {
  const failure = stringValue(body.error).replaceAll('_', ' ')
  return platformError('Slack', failure || `answered ${status}`, {
    status,
    permanent: !['rate_limited', 'fatal_error', 'internal_error'].includes(stringValue(body.error)),
  })
}

async function call(
  env: ImAdapterEnvironment,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { response, body } = await jsonRequest(env, 'Slack', `${apiBase(env)}${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  }, signal)
  if (response.status === 429) {
    throw platformError('Slack', 'rate limited the request', {
      status: 429,
      retryAfterMs: Number(response.headers.get('retry-after') ?? 1) * 1000,
    })
  }
  if (!response.ok || body.ok !== true) throw slackError(body, response.status)
  return body
}

function toMrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/gu)
    .map((part, index) => index % 2 === 1 ? part : part
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '<$2|$1>')
      .replace(/\*\*([^*]+)\*\*/gu, '*$1*')
      .replace(/(^|\s)\*([^*\n]+)\*/gu, '$1_$2_'))
    .join('')
}

function blocks(text: string, buttons: { label: string; data: string }[]) {
  const result: Record<string, unknown>[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
  if (buttons.length) {
    result.push({
      type: 'actions',
      elements: buttons.map((button, index) => ({
        type: 'button',
        action_id: `b${index}`,
        text: { type: 'plain_text', text: button.label.slice(0, 75) },
        value: button.data,
      })),
    })
  }
  return result
}

export const slack: ImAdapter = {
  id: 'slack',

  async check(fields, env) {
    const token = requireField(fields, 'botToken', 'the Bot token')
    const me = await call(env, token, 'auth.test')
    if (me.user_id === undefined) {
      throw platformError('Slack', 'the credentials do not belong to a bot', { code: 'IM_ACCOUNT_INVALID', permanent: true })
    }
    return { account: { id: stringValue(me.user_id), name: stringValue(me.user) === '' ? stringValue(me.user_id) : `@${stringValue(me.user)}` } }
  },

  async connect(fields, env, handlers) {
    const appToken = requireField(fields, 'appToken', 'the App token')
    const botToken = requireField(fields, 'botToken', 'the Bot token')
    const me = await call(env, botToken, 'auth.test')
    const account = { id: stringValue(me.user_id), name: stringValue(me.user) === '' ? stringValue(me.user_id) : `@${stringValue(me.user)}` }
    if (account.id === '') throw platformError('Slack', 'the credentials do not identify a bot', { code: 'IM_ACCOUNT_INVALID', permanent: true })

    let socket: ImSocket | undefined
    let stopped = false
    let generation = 0
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let reconnectCount = 0
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    let resolveReady: (() => void) | undefined
    let rejectReady: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const readyTimer = setTimeout(() => rejectReady?.(platformError('Slack', 'socket did not become ready', {
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

    const event = async (payload: Record<string, unknown>) => {
      if (payload.bot_id !== undefined || payload.subtype !== undefined && payload.subtype !== 'file_share') return
      const direct = payload.type === 'message' && payload.channel_type === 'im'
      const mentioned = payload.type === 'app_mention'
      if (!direct && !mentioned) return
      const text = stringValue(payload.text).replaceAll(`<@${account.id}>`, '').trim()
      await handlers.onMessage({
        chat: { key: stringValue(payload.channel), kind: direct ? 'direct' : 'group' },
        sender: { id: stringValue(payload.user), name: stringValue(payload.user) },
        text,
        mentioned,
        messageId: stringValue(payload.ts),
      })
    }

    const interactive = async (payload: Record<string, unknown>) => {
      if (payload.type !== 'block_actions') return
      const action = asRecord(asArray(payload.actions)[0])
      const user = asRecord(payload.user)
      await handlers.onAction({
        chat: { key: stringValue(asRecord(payload.channel).id), kind: 'direct' },
        sender: { id: stringValue(user.id), name: stringValue(user.name) || stringValue(user.id) },
        text: '',
        mentioned: true,
        messageId: stringValue(asRecord(payload.message).ts),
        data: stringValue(action.value) || stringValue(action.action_id),
      })
    }

    const open = async () => {
      const current = ++generation
      const { response, body } = await jsonRequest(env, 'Slack', `${apiBase(env)}apps.connections.open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${appToken}` },
      })
      if (response.status === 429) {
        throw platformError('Slack', 'rate limited the connection', {
          status: 429,
          retryAfterMs: Number(response.headers.get('retry-after') ?? 1) * 1000,
        })
      }
      if (!response.ok || body.ok !== true) throw slackError(body, response.status)
      const url = stringValue(body.url)
      if (url === '') throw platformError('Slack', 'returned no socket URL', { code: 'IM_UNAVAILABLE', permanent: true })
      const next = await openSocket(env, 'Slack', url)
      socket = next
      socketOn(next, 'message', raw => {
        if (stopped || current !== generation) return
        let packet: Record<string, unknown>
        try {
          packet = asRecord(JSON.parse(String(socketData(raw))))
        } catch {
          return
        }
        if (packet.type === 'hello') {
          reconnectCount = 0
          handlers.onStatus({ state: 'ready', account })
          settleReady()
          return
        }
        if (packet.envelope_id !== undefined && socketReady(next)) {
          next.send(JSON.stringify({ envelope_id: packet.envelope_id }))
        }
        if (packet.type === 'disconnect') {
          closeSocket(next, 4000, 'disconnect')
          return
        }
        const payload = asRecord(packet.payload)
        if (packet.type === 'events_api' && payload.type === 'event_callback') {
          void event(asRecord(payload.event)).catch(error => env.log?.warn?.('slack event failed: %s', error instanceof Error ? error.message : error))
        } else if (packet.type === 'interactive') {
          void interactive(payload).catch(error => env.log?.warn?.('slack action failed: %s', error instanceof Error ? error.message : error))
        }
      })
      socketOn(next, 'close', () => {
        if (stopped || current !== generation) return
        if (reconnectCount >= maxReconnects) {
          handlers.onStatus({ state: 'error', error: `Slack stopped after ${maxReconnects} reconnects` })
          settleReady(new Error('Slack stopped reconnecting'))
          return
        }
        reconnectCount += 1
        handlers.onStatus({ state: 'retrying' })
        reconnect = setTimeout(() => {
          if (stopped) return
          void open().catch(error => {
            handlers.onStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) })
          })
        }, Math.min(30_000, 500 * (2 ** reconnectCount)))
        reconnect.unref?.()
      })
      socketOn(next, 'error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    await open()
    await ready

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(request.text, SLACK_LIMIT)
        const buttons = buttonRows(request.buttons)
        let messageId: string | undefined
        for (const [index, chunk] of chunks.entries()) {
          const mrkdwn = toMrkdwn(chunk)
          const sent = await call(env, botToken, 'chat.postMessage', {
            channel: chat.key,
            text: chunk,
            blocks: blocks(mrkdwn, index === chunks.length - 1 ? buttons : []),
          })
          if (sent.ts !== undefined) messageId = stringValue(sent.ts)
        }
        return messageId === undefined ? {} : { messageId }
      },
      async edit(chat, messageId, request) {
        const text = toMrkdwn(chunkText(request.text, SLACK_LIMIT)[0] ?? '')
        await call(env, botToken, 'chat.update', {
          channel: chat.key,
          ts: messageId,
          text,
          blocks: blocks(text, buttonRows(request.buttons)),
        })
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(reconnect)
        settleReady(new Error('stopped'))
        closeSocket(socket)
      },
    }
  },
}
