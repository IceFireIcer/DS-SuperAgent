export interface ImErrorOptions {
  code?: string
  status?: number
  permanent?: boolean
  retryable?: boolean
  retryAfterMs?: number
  cause?: unknown
}

export class ImServiceError extends Error {
  readonly code: string
  readonly status?: number
  readonly permanent: boolean
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(message: string, options: ImErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ImServiceError'
    this.code = options.code ?? 'IM_ERROR'
    this.permanent = options.permanent ?? false
    this.retryable = options.retryable ?? !this.permanent
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

export function platformError(label: string, message: string, options: ImErrorOptions = {}) {
  const status = options.status
  const permanent = options.permanent ?? (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)
  const retryable = options.retryable ?? !permanent
  return new ImServiceError(`${label}: ${message}`, { code: options.code ?? 'IM_PLATFORM_ERROR', ...options,
    permanent, retryable })
}

export function networkError(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return platformError(label, message || 'network request failed', { retryable: true, code: 'IM_NETWORK' })
}

const secretPatterns: [RegExp, string][] = [
  [/(authorization\s*["']?\s*[:=]\s*["']?(?:Bearer|Bot|QQBot)\s+)[^\s"',;}]+/giu, '$1***'],
  [/(xox[baprs]-)[A-Za-z0-9-]{8,}/gu, '$1***'],
  [/(\/bot)[^/\s?#]+/gu, '$1***'],
  [/([?&](?:token|access_token|appsecret|app_secret|clientsecret|client_secret|secret|ticket)=)[^&\s]+/giu, '$1***'],
  [/("(?:token|access_token|tenant_access_token|appSecret|app_secret|clientSecret|client_secret|secret|password|ticket)"\s*:\s*")[^"]*(")/giu, '$1***$2'],
]

export function redactSecretText(value: unknown, secretValues: Iterable<string> = []): string {
  let text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '')
  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret === '') continue
    for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join('***')
  }
  for (const [pattern, replacement] of secretPatterns) text = text.replace(pattern, replacement)
  return text
}

export function safeMessage(error: unknown, secretValues: Iterable<string> = []): string {
  return redactSecretText(error instanceof Error ? error.message : error, secretValues).slice(0, 1000)
}

export function safeError(error: unknown, secretValues: Iterable<string> = []): ImServiceError {
  if (error instanceof ImServiceError) {
    return new ImServiceError(redactSecretText(error.message, secretValues), {
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      permanent: error.permanent,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      cause: error.cause,
    })
  }
  return new ImServiceError(safeMessage(error, secretValues), {
    code: 'IM_INTERNAL',
    retryable: true,
    cause: error,
  })
}

export function retryable(error: unknown): boolean {
  return error instanceof ImServiceError ? error.retryable : true
}

export function retryDelay(error: unknown, fallback: number): number {
  return error instanceof ImServiceError && error.retryAfterMs !== undefined ? error.retryAfterMs : fallback
}
