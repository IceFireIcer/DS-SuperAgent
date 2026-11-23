import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreError } from '../model.js'
import type { ImTransport, NativeImMessage } from './types.js'

export class ImFailure extends CoreError {
  constructor(code: 'IM_AUTH_FAILED' | 'IM_UNAVAILABLE' | 'IM_SEND_UNKNOWN' | 'IM_SEND_REJECTED',
    public readonly retryAfterMs?: number) {
    super(code, {
      IM_AUTH_FAILED: 'The messaging provider rejected the login.',
      IM_UNAVAILABLE: 'The messaging provider is unavailable.',
      IM_SEND_UNKNOWN: 'The messaging provider did not confirm the reply.',
      IM_SEND_REJECTED: 'The messaging provider rejected the reply.',
    }[code])
  }
}

export type Json = Record<string, unknown>
export const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
export const str = (value: unknown): string => typeof value === 'string' ? value : ''
export const id = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : str(value)
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
export const pause = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal, ref: false })
export const clip = (text: string, length: number) => [...text].slice(0, length).join('')

export function hasControls(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

export function required(value: unknown): string {
  const result = id(value)
  if (!result || result.length > 256 || hasControls(result)) throw new ImFailure('IM_UNAVAILABLE')
  return result
}

export function message(senderId: unknown, conversationId: unknown, messageId: unknown, text: unknown): NativeImMessage | undefined {
  try {
    const content = str(text)
    if (!content.trim() || Buffer.byteLength(content) > 32_768) return undefined
    return { senderId: required(senderId), conversationId: required(conversationId), messageId: required(messageId), text: content }
  } catch { return undefined }
}

export function socketUrl(value: unknown, allowed: (host: string) => boolean) {
  try {
    const url = new URL(str(value))
    if (url.protocol === 'wss:' && !url.username && !url.password && !url.port && !url.hash && allowed(url.hostname)) return url
  } catch { }
  throw new ImFailure('IM_UNAVAILABLE')
}

export interface JsonRequest {
  signal: AbortSignal
  timeout?: number
  headers?: Record<string, string>
  body?: Json
  sending?: boolean
}

export async function request(transport: ImTransport, url: string, options: JsonRequest): Promise<Json> {
  const { signal, timeout = 15_000, headers = {}, body, sending = false } = options
  signal.throwIfAborted()
  let response: Response
  try {
    response = await (transport.fetch ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch { throw new ImFailure(sending ? 'IM_SEND_UNKNOWN' : 'IM_UNAVAILABLE') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) throw new ImFailure(sending ? 'IM_SEND_REJECTED' : 'IM_AUTH_FAILED')
    if (response.status === 429) {
      const retryMs = Number(response.headers.get('retry-after')) * 1000
      throw new ImFailure('IM_UNAVAILABLE', Math.max(1_000, Math.min(retryMs || 5_000, 300_000)))
    }
    if (sending && response.status < 500) throw new ImFailure('IM_SEND_REJECTED')
    throw new ImFailure(sending ? 'IM_SEND_UNKNOWN' : 'IM_UNAVAILABLE')
  }
  try {
    const bodyStream = response.body
    if (!bodyStream) throw new Error()
    const reader = bodyStream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error() }
      chunks.push(part.value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return object(parsed)
  } catch { throw new ImFailure(sending ? 'IM_SEND_UNKNOWN' : 'IM_UNAVAILABLE') }
}

type FrameHandler = (value: Json, socket: ImSocket) => Promise<void> | void

export class ImSocket {
  private readonly raw: WebSocket
  private readonly lifetime = new AbortController()
  readonly signal: AbortSignal
  readonly opened: Promise<void>
  readonly done: Promise<void>
  private rejectDone: (error: unknown) => void = () => {}
  private readonly openedAt: NodeJS.Timeout

  constructor(transport: ImTransport, url: URL, signal: AbortSignal, handler: FrameHandler) {
    signal.throwIfAborted()
    this.signal = this.lifetime.signal
    this.raw = (transport.socket ?? (value => new WebSocket(value)))(url.toString())
    this.done = new Promise((_, reject) => { this.rejectDone = reject })
    this.done.catch(() => {})
    this.opened = new Promise<void>((resolve, reject) => {
      this.raw.addEventListener('open', () => resolve(), { once: true })
      void this.done.catch(reject)
    })
    this.opened.catch(() => {})
    this.openedAt = setTimeout(() => this.end(), 15_000)
    this.openedAt.unref()
    this.raw.addEventListener('close', () => this.end())
    this.raw.addEventListener('error', () => this.end())
    const abort = () => this.end()
    signal.addEventListener('abort', abort, { once: true })
    void this.done.catch(() => signal.removeEventListener('abort', abort))
    let queue = Promise.resolve()
    let pending = 0
    this.raw.addEventListener('message', (event: MessageEvent) => {
      if (this.signal.aborted) return
      if (++pending > 100) return this.end()
      queue = queue.then(async () => {
        this.signal.throwIfAborted()
        if (typeof event.data !== 'string' || event.data.length > 524_288) throw new ImFailure('IM_UNAVAILABLE')
        await handler(object(JSON.parse(event.data)), this)
      }).catch(error => this.end(error)).finally(() => { pending-- })
    })
  }

  ready() { clearTimeout(this.openedAt) }

  send(value: Json) {
    this.signal.throwIfAborted()
    if (this.raw.readyState !== WebSocket.OPEN) throw new ImFailure('IM_UNAVAILABLE')
    this.raw.send(JSON.stringify(value))
  }

  end(error: unknown = new ImFailure('IM_UNAVAILABLE')) {
    if (this.signal.aborted) return
    clearTimeout(this.openedAt)
    this.lifetime.abort()
    try { this.raw.close() } catch { }
    this.rejectDone(error instanceof CoreError ? error : new ImFailure('IM_UNAVAILABLE'))
  }
}
