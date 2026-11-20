import { networkError, platformError, type ImErrorOptions } from './errors.js'
import type { ImAdapterEnvironment, ImButton, ImSocket, ImSocketConstructor } from './types.js'

export const TELEGRAM_LIMIT = 4096
export const DISCORD_LIMIT = 2000
export const SLACK_LIMIT = 4000
export const FEISHU_LIMIT = 4000
export const DINGTALK_LIMIT = 5000
export const WECOM_LIMIT = 4000
export const QQ_LIMIT = 2000
export const WEIXIN_LIMIT = 1800

export function field(fields: Readonly<Record<string, string>>, key: string): string {
  return String(fields[key] ?? '').trim()
}

export function requireField(fields: Readonly<Record<string, string>>, key: string, label = key): string {
  const value = field(fields, key)
  if (value === '') throw platformError('IM', `Paste ${label} first`, { code: 'IM_MISSING_CREDENTIAL', permanent: true })
  return value
}

export function configString(env: ImAdapterEnvironment, key: string): string | undefined {
  const value = env.config?.[key]
  return value === undefined ? undefined : String(value)
}

export function configNumber(env: ImAdapterEnvironment, key: string): number | undefined {
  const value = Number(env.config?.[key])
  return Number.isFinite(value) ? value : undefined
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}))
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

export function responseError(label: string, response: Response, body: Record<string, unknown>, options: ImErrorOptions = {}) {
  const reason = body.message ?? body.msg ?? body.errmsg ?? body.description ?? body.error ?? `HTTP ${response.status}`
  const retryAfter = Number(response.headers.get('retry-after'))
  return platformError(label, String(reason), {
    code: options.code ?? 'IM_HTTP',
    status: response.status,
    ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
    ...options,
  })
}

export async function jsonRequest(
  env: ImAdapterEnvironment,
  label: string,
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await env.fetch(url, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted) throw platformError(label, 'stopped', { code: 'IM_STOPPED', permanent: true })
    throw networkError(label, error)
  }
  const body = await readJson(response)
  return { response, body }
}

export function socketFrom(env: ImAdapterEnvironment): ImSocketConstructor {
  const Constructor = env.WebSocket ?? (globalThis as { WebSocket?: ImSocketConstructor }).WebSocket
  if (Constructor === undefined) {
    throw platformError('IM', 'WebSocket is unavailable', { code: 'IM_UNAVAILABLE', permanent: true })
  }
  return Constructor
}

export function socketOn(socket: ImSocket, type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, event => listener(event))
    return
  }
  if (typeof socket.on === 'function') socket.on(type, listener)
}

export function socketData(event: unknown): unknown {
  return event !== null && typeof event === 'object' && 'data' in event ? (event as { data?: unknown }).data : event
}

export function socketErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message)
  return String(error ?? 'socket error')
}

export async function openSocket(env: ImAdapterEnvironment, label: string, url: string, timeoutMs = 20_000): Promise<ImSocket> {
  const Constructor = socketFrom(env)
  let socket: ImSocket
  try {
    socket = new Constructor(url)
  } catch (error) {
    throw networkError(`${label} WebSocket`, error)
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => finish(platformError(label, 'socket opening timed out', {
      code: 'IM_TIMEOUT', retryable: true,
    })), timeoutMs)
    timer.unref?.()
    socketOn(socket, 'open', () => finish())
    socketOn(socket, 'error', error => finish(networkError(`${label} WebSocket`, error instanceof Error ? error : socketErrorText(error))))
  })
  return socket
}

export function closeSocket(socket: ImSocket | undefined, code = 1000, reason = 'stop'): void {
  if (socket === undefined) return
  try {
    if (typeof socket.terminate === 'function') socket.terminate()
    else socket.close(code, reason)
  } catch {
    // The transport may already be closed.
  }
}

export function chunkText(text: unknown, limit: number): string[] {
  let rest = String(text ?? '').replace(/\r\n?/gu, '\n').trim()
  if (rest === '') return []
  const chunks: string[] = []
  while (rest.length > limit) {
    let cut = limit
    const newline = rest.lastIndexOf('\n', limit)
    if (newline > limit / 2) cut = newline
    else {
      const space = rest.lastIndexOf(' ', limit)
      if (space > limit / 2) cut = space
    }
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

export function buttonRows(buttons: ImButton[] | undefined, limit = 5): ImButton[] {
  return (buttons ?? []).slice(0, limit).map(button => ({
    label: String(button.label).slice(0, 100),
    data: String(button.data),
  }))
}

export function safeJson(text: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(text ?? '{}'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function nowOf(env: ImAdapterEnvironment): number {
  return env.now?.() ?? Date.now()
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function socketReady(socket: ImSocket | undefined): boolean {
  return socket?.readyState === 1
}
