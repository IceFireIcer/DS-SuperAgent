import { platformError } from '../errors.js'
import {
  FEISHU_LIMIT,
  asArray,
  asRecord,
  buttonRows,
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

interface FeishuFrame {
  SeqID?: number
  LogID?: number
  service?: number
  method?: number
  headers: { key: string; value: string }[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  LogIDNew?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function uvarint(value: number | bigint): number[] {
  let remaining = BigInt(value)
  const out: number[] = []
  while (remaining > 127n) {
    out.push(Number(remaining & 127n) | 128)
    remaining >>= 7n
  }
  out.push(Number(remaining))
  return out
}

function protoField(number: number, wire: 0 | 2, value: number | bigint | string | Uint8Array): number[] {
  const tag = uvarint((number << 3) | wire)
  if (wire === 0) return [...tag, ...uvarint(value as number | bigint)]
  const bytes = typeof value === 'string' ? encoder.encode(value) : value instanceof Uint8Array ? value : encoder.encode(String(value))
  return [...tag, ...uvarint(bytes.length), ...bytes]
}

function readVarint(bytes: Uint8Array, cursor: { at: number }): bigint {
  let value = 0n
  let shift = 0n
  while (cursor.at < bytes.length) {
    const byte = bytes[cursor.at]!
    cursor.at += 1
    value |= BigInt(byte & 127) << shift
    if ((byte & 128) === 0) return value
    shift += 7n
  }
  return value
}

function readBytes(bytes: Uint8Array, cursor: { at: number }): Uint8Array {
  const length = Number(readVarint(bytes, cursor))
  const end = cursor.at + length
  const value = bytes.subarray(cursor.at, end)
  cursor.at = end
  return value
}

function decodeHeader(bytes: Uint8Array): { key: string; value: string } {
  const cursor = { at: 0 }
  let key = ''
  let value = ''
  while (cursor.at < bytes.length) {
    const tag = Number(readVarint(bytes, cursor))
    const wire = tag & 7
    const number = tag >> 3
    if (wire === 2) {
      const part = readBytes(bytes, cursor)
      if (number === 1) key = decoder.decode(part)
      else if (number === 2) value = decoder.decode(part)
    } else if (wire === 0) readVarint(bytes, cursor)
    else break
  }
  return { key, value }
}

export function encodeFrame(frame: FeishuFrame): Uint8Array {
  const out: number[] = []
  if (frame.SeqID !== undefined) out.push(...protoField(1, 0, frame.SeqID))
  if (frame.LogID !== undefined) out.push(...protoField(2, 0, frame.LogID))
  if (frame.service !== undefined) out.push(...protoField(3, 0, frame.service))
  if (frame.method !== undefined) out.push(...protoField(4, 0, frame.method))
  for (const header of frame.headers) {
    out.push(...protoField(5, 2, Uint8Array.from([
      ...protoField(1, 2, header.key),
      ...protoField(2, 2, header.value),
    ])))
  }
  if (frame.payloadEncoding !== undefined) out.push(...protoField(6, 2, frame.payloadEncoding))
  if (frame.payloadType !== undefined) out.push(...protoField(7, 2, frame.payloadType))
  if (frame.payload !== undefined) out.push(...protoField(8, 2, frame.payload))
  if (frame.LogIDNew !== undefined) out.push(...protoField(9, 2, frame.LogIDNew))
  return Uint8Array.from(out)
}

export function decodeFrame(bytes: Uint8Array): FeishuFrame {
  const cursor = { at: 0 }
  const frame: FeishuFrame = { headers: [] }
  while (cursor.at < bytes.length) {
    const tag = Number(readVarint(bytes, cursor))
    const number = tag >> 3
    const wire = tag & 7
    if (wire === 0) {
      const value = Number(readVarint(bytes, cursor))
      if (number === 1) frame.SeqID = value
      else if (number === 2) frame.LogID = value
      else if (number === 3) frame.service = value
      else if (number === 4) frame.method = value
    } else if (wire === 2) {
      const value = readBytes(bytes, cursor)
      if (number === 5) frame.headers.push(decodeHeader(value))
      else if (number === 6) frame.payloadEncoding = decoder.decode(value)
      else if (number === 7) frame.payloadType = decoder.decode(value)
      else if (number === 8) frame.payload = value.slice()
      else if (number === 9) frame.LogIDNew = decoder.decode(value)
    } else {
      break
    }
  }
  return frame
}

function apiBase(env: ImAdapterEnvironment, fields: Readonly<Record<string, string>>): string {
  const configured = configString(env, 'api')
  if (configured !== undefined) return configured.replace(/\/+$/u, '')
  return fields.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

async function tokenFor(
  env: ImAdapterEnvironment,
  fields: Readonly<Record<string, string>>,
): Promise<{ token: string; expiresAt: number }> {
  const { response, body } = await jsonRequest(env, 'Feishu', `${apiBase(env, fields)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: requireField(fields, 'appId', 'the App ID'), app_secret: requireField(fields, 'appSecret', 'the App Secret') }),
  })
  if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== 'string') {
    throw platformError('Feishu', stringValue(body.msg) || 'refused these credentials', {
      status: response.status,
      code: 'IM_ACCOUNT_INVALID',
    })
  }
  return {
    token: body.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expire ?? 7200)) * 1000,
  }
}

async function api(
  env: ImAdapterEnvironment,
  fields: Readonly<Record<string, string>>,
  token: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const { response, body } = await jsonRequest(env, 'Feishu', `${apiBase(env, fields)}${path}`, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, options.signal)
  if (!response.ok || body.code !== undefined && body.code !== 0) {
    throw platformError('Feishu', stringValue(body.msg) || `answered ${response.status}`, { status: response.status })
  }
  return body
}

function frameType(frame: FeishuFrame): string {
  return frame.headers.find(header => header.key === 'type')?.value ?? ''
}

function header(frame: FeishuFrame, key: string): string {
  return frame.headers.find(item => item.key === key)?.value ?? ''
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return encoder.encode(String(value ?? ''))
}

export const feishu: ImAdapter = {
  id: 'feishu',

  async check(fields, env) {
    const { token } = await tokenFor(env, fields)
    const body = await api(env, fields, token, '/open-apis/bot/v3/info')
    const bot = asRecord(body.bot ?? body)
    return {
      account: {
        id: stringValue(bot.open_id) || stringValue(bot.app_id) || stringValue(fields.appId),
        name: stringValue(bot.app_name) || stringValue(fields.appId),
      },
    }
  },

  async connect(fields, env, handlers) {
    let currentToken = await tokenFor(env, fields)
    const bot = await api(env, fields, currentToken.token, '/open-apis/bot/v3/info').catch(() => ({}))
    const botBody = asRecord(asRecord(bot).bot ?? bot)
    const account = {
      id: stringValue(botBody.open_id) || stringValue(fields.appId),
      name: stringValue(botBody.app_name) || stringValue(fields.appId),
    }
    let stopped = false
    let socket: ImSocket | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    let reconnectCount = 0
    let pingEvery = 90_000
    let service = 0
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    const parts = new Map<string, { received: Map<number, Uint8Array>; sum: number }>()
    const token = async () => {
      if (Date.now() >= currentToken.expiresAt - 30_000) currentToken = await tokenFor(env, fields)
      return currentToken.token
    }

    const ack = (target: ImSocket, frame: FeishuFrame) => {
      if (!socketReady(target)) return
      target.send(encodeFrame({
        ...frame,
        headers: [...frame.headers.filter(item => item.key !== 'biz_rt'), { key: 'biz_rt', value: '0' }],
        payload: encoder.encode(JSON.stringify({ code: 200, headers: {}, data: '' })),
        payloadType: 'json',
      }))
    }

    const dispatch = async (type: string, payload: Uint8Array) => {
      const root = JSON.parse(decoder.decode(payload)) as Record<string, unknown>
      const headerValue = asRecord(root.header)
      if (type === 'event' && headerValue.event_type === 'im.message.receive_v1') {
        const event = asRecord(root.event)
        const message = asRecord(event.message)
        const content = safeJson(message.content)
        const direct = message.chat_type === 'p2p'
        const mentions = asArray(message.mentions).map(asRecord)
        const mentioned = !direct && mentions.some(mention => {
          const id = asRecord(mention.id)
          return stringValue(id.open_id) === account.id
        })
        const sender = asRecord(asRecord(event.sender).sender_id)
        await handlers.onMessage({
          chat: { key: stringValue(message.chat_id), kind: direct ? 'direct' : 'group', title: stringValue(message.chat_id) },
          sender: { id: stringValue(sender.open_id) || stringValue(sender.user_id), name: stringValue(sender.open_id) || stringValue(sender.user_id) },
          text: stringValue(content.text).replace(/@_user_\d+/gu, '').trim(),
          mentioned,
          messageId: stringValue(message.message_id),
        })
      } else if (type === 'card' || headerValue.event_type === 'card.action.trigger') {
        const event = asRecord(root.event)
        const action = asRecord(event.action ?? asArray(event.actions)[0])
        const data = asRecord(action.value ?? action.action_data)
        await handlers.onAction({
          chat: { key: stringValue(asRecord(event.context).open_chat_id) || stringValue(asRecord(event.message).chat_id), kind: 'direct' },
          sender: { id: stringValue(asRecord(event.operator).open_id) || stringValue(event.user_id), name: '' },
          text: '',
          mentioned: true,
          messageId: stringValue(event.message_id) || stringValue(asRecord(event.context).open_message_id),
          data: stringValue(data.v) || JSON.stringify(action.value ?? action.action_data ?? ''),
        })
      }
    }

    const schedulePing = (target: ImSocket, gen: number) => {
      clearTimeout(pingTimer)
      pingTimer = setTimeout(() => {
        if (stopped || generation !== gen || !socketReady(target)) return
        target.send(encodeFrame({
          SeqID: 0,
          LogID: 0,
          service,
          method: 0,
          headers: [{ key: 'type', value: 'ping' }],
        }))
        schedulePing(target, gen)
      }, pingEvery)
      pingTimer.unref?.()
    }

    const open = async (): Promise<void> => {
      const gen = ++generation
      const { response, body } = await jsonRequest(env, 'Feishu', `${apiBase(env, fields)}/callback/ws/endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ AppID: fields.appId, AppSecret: fields.appSecret }),
      })
      const data = asRecord(body.data)
      const url = stringValue(data.URL)
      if (!response.ok || url === '' || body.code !== undefined && body.code !== 0) {
        throw platformError('Feishu', stringValue(body.msg) || 'returned no socket URL', {
          status: response.status,
          code: 'IM_UNAVAILABLE',
          permanent: response.ok || response.status < 500 && response.status !== 429,
        })
      }
      pingEvery = Math.max(1000, Number(asRecord(data.ClientConfig).PingInterval ?? 90)) * 1000
      service = Number(new URL(url).searchParams.get('service_id') ?? 0) || 0
      const target = await openSocket(env, 'Feishu', url)
      socket = target
      socketOn(target, 'message', raw => {
        if (stopped || generation !== gen) return
        let frame: FeishuFrame
        try {
          frame = decodeFrame(asBytes(socketData(raw)))
        } catch {
          return
        }
        const type = frameType(frame)
        if (frame.method === 0 && type === 'ping') {
          if (socketReady(target)) target.send(encodeFrame({
            ...frame,
            headers: frame.headers.map(item => item.key === 'type' ? { key: 'type', value: 'pong' } : item),
            payload: encoder.encode('pong'),
          }))
          return
        }
        if (frame.method === 0 && type === 'pong') return
        if (frame.method === 1 && type === 'reconnect') {
          closeSocket(target, 4001, 'reconnect')
          return
        }
        if (frame.method !== 1 || frame.payload === undefined) return
        const messageId = header(frame, 'message_id')
        const sum = Number(header(frame, 'sum') || 1)
        const seq = Number(header(frame, 'seq') || 1)
        ack(target, frame)
        if (sum > 1) {
          const held = parts.get(messageId) ?? { received: new Map<number, Uint8Array>(), sum }
          held.received.set(seq, frame.payload)
          parts.set(messageId, held)
          if (held.received.size < sum) return
          const joined = new Uint8Array([...held.received.entries()].sort((a, b) => a[0] - b[0])
            .flatMap(([, value]) => [...value]))
          parts.delete(messageId)
          frame.payload = joined
        }
        if (type === 'event' || type === 'card') {
          void dispatch(type, frame.payload).catch(error => env.log?.warn?.('feishu event failed: %s', error instanceof Error ? error.message : error))
        }
      })
      socketOn(target, 'close', () => {
        if (stopped || generation !== gen) return
        if (reconnectCount >= maxReconnects) {
          handlers.onStatus({ state: 'error', error: `Feishu stopped after ${maxReconnects} reconnects` })
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
      handlers.onStatus({ state: 'ready', account })
      schedulePing(target, gen)
    }

    handlers.onStatus({ state: 'connecting' })
    await open()

    const card = (text: string, buttons: { label: string; data: string }[]) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
          ...(buttons.length ? [{
            tag: 'action',
            actions: buttons.map(button => ({
              tag: 'button',
              type: 'primary',
              text: { tag: 'plain_text', content: button.label.slice(0, 20) },
              value: { v: button.data },
            })),
          }] : []),
        ],
      },
    })

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(request.text, FEISHU_LIMIT)
        const buttons = buttonRows(request.buttons)
        let messageId: string | undefined
        for (const [index, chunk] of chunks.entries()) {
          const interactive = index === chunks.length - 1 && buttons.length > 0
          const body = await api(env, fields, await token(), '/open-apis/im/v1/messages?receive_id_type=chat_id', {
            method: 'POST',
            body: {
              receive_id: chat.key,
              msg_type: interactive ? 'interactive' : 'text',
              content: interactive ? card(chunk, buttons) : JSON.stringify({ text: chunk }),
            },
          })
          const id = stringValue(asRecord(body.data).message_id)
          if (id !== '') messageId = id
        }
        return messageId === undefined ? {} : { messageId }
      },
      async edit(_chat, messageId, request) {
        await api(env, fields, await token(), `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
          method: 'PATCH',
          body: { msg_type: 'interactive', content: card(chunkText(request.text, FEISHU_LIMIT)[0] ?? '', buttonRows(request.buttons)) },
        })
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(reconnect)
        clearTimeout(pingTimer)
        closeSocket(socket)
      },
    }
  },
}
