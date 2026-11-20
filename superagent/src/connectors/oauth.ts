import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { CoreError } from '../model.js'

export interface LoopbackOAuthClient {
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  scopes?: string[]
  whoami?: { url: string; field: string }
  tokenAuth?: 'body' | 'basic'
  authorizationClientIdParameter?: string
  tokenClientIdParameter?: string
  tokenClientSecretParameter?: string
  tokenRequestFormat?: 'form' | 'json'
  tokenResponsePath?: string[]
  extraAuthorizationParams?: Record<string, string>
}

export interface ConnectorOAuthStart {
  attemptId: string
  authorizationUrl: string
  kind: 'browser' | 'device'
  userCode?: string
  verificationUri?: string
  expiresAt: number
}

export interface ConnectorOAuthStatus {
  state: 'pending' | 'completed' | 'error' | 'cancelled'
  account?: string
  errorCode?: string
}

export interface ConnectorOAuthCredential {
  value: string
  account?: string
  expiresAt?: number
}

export interface ConnectorOAuthBroker {
  supports?(connectorId: string): boolean
  start(input: { connectorId: string; scopes: string[] }): Promise<ConnectorOAuthStart>
  status(attemptId: string): Promise<ConnectorOAuthStatus>
  credential(attemptId: string): Promise<ConnectorOAuthCredential>
  finish(attemptId: string): Promise<void>
  cancel(attemptId: string): Promise<void>
  close(): Promise<void>
}

export const HOST_CONNECTOR_OAUTH_CALLBACK_URI = 'http://127.0.0.1:38517/callback'

interface TokenPayload {
  value: string
  account?: string
  expiresAt?: number
}

interface Attempt {
  id: string
  connectorId: string
  client: LoopbackOAuthClient
  state: string
  verifier: string
  redirectUri: string
  server: Server
  status: 'pending' | 'completed' | 'error' | 'cancelled'
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  exchangeStarted: boolean
  token?: TokenPayload
  account?: string
  errorCode?: string
  consumed: boolean
}

const timeoutMs = 10 * 60_000
const exchangeTimeoutMs = 20_000
const reservedAuthorizationParameters = new Set([
  'response_type', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope',
])

function httpsEndpoint(value: string, label: string): URL {
  let url: URL
  try { url = new URL(value) } catch {
    throw new CoreError('INVALID_CONFIG', `${label} must be a valid HTTPS address.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('INVALID_CONFIG', `${label} must use HTTPS without embedded credentials.`)
  }
  return url
}

function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function html(response: import('node:http').ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Connector sign-in</title>`
    + `<p style="font:16px system-ui;margin:3em;text-align:center">${message}</p>`)
}

function responseToken(body: Record<string, unknown>, now: number, responsePath: string[] = []): TokenPayload {
  let tokenBody = body
  for (const key of responsePath) {
    const next = tokenBody[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new CoreError('OAUTH_EXCHANGE_FAILED', 'The authorization server returned an invalid token response.')
    }
    tokenBody = next as Record<string, unknown>
  }
  if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) throw new CoreError('OAUTH_EXCHANGE_FAILED',
    'The authorization server did not return an access token.')
  const expiresAt = Number.isFinite(tokenBody.expires_in) ? now + Number(tokenBody.expires_in) * 1000 : undefined
  const value = JSON.stringify({ accessToken: tokenBody.access_token,
    ...(typeof tokenBody.refresh_token === 'string' && tokenBody.refresh_token ? { refreshToken: tokenBody.refresh_token } : {}),
    ...(typeof tokenBody.token_type === 'string' && tokenBody.token_type ? { tokenType: tokenBody.token_type } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }) })
  return { value, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

/**
 * Host-only browser OAuth. The authorization server redirects only to a
 * loopback listener owned by this process; codes and tokens never enter the
 * product request/response path.
 */
export class HostLoopbackOAuthBroker implements ConnectorOAuthBroker {
  private readonly clients: Record<string, LoopbackOAuthClient>
  private readonly attempts = new Map<string, Attempt>()
  private readonly attemptsByState = new Map<string, Attempt>()
  private listener: Server | undefined

  constructor(input: {
    clients: Record<string, LoopbackOAuthClient>
    fetch?: typeof globalThis.fetch
    timeoutMs?: number
  }) {
    this.clients = structuredClone(input.clients)
    this.request = input.fetch ?? globalThis.fetch
    this.lifetimeMs = input.timeoutMs ?? timeoutMs
    if (!Number.isSafeInteger(this.lifetimeMs) || this.lifetimeMs < 30_000 || this.lifetimeMs > 60 * 60_000) {
      throw new CoreError('INVALID_CONFIG', 'OAuth sign-in lifetime must be between 30 seconds and one hour.')
    }
  }

  private readonly request: typeof globalThis.fetch
  private readonly lifetimeMs: number

  supports(connectorId: string): boolean {
    return Object.hasOwn(this.clients, connectorId)
  }

  async start(input: { connectorId: string; scopes: string[] }): Promise<ConnectorOAuthStart> {
    const client = this.supports(input.connectorId) ? this.clients[input.connectorId] : undefined
    if (!client) throw new CoreError('OAUTH_CLIENT_UNAVAILABLE',
      'This connector has no Host-configured OAuth client. Use a token or configure its OAuth client.')
    httpsEndpoint(client.authorizationUrl, 'The OAuth authorization endpoint')
    httpsEndpoint(client.tokenUrl, 'The OAuth token endpoint')
    if (client.whoami) httpsEndpoint(client.whoami.url, 'The OAuth account endpoint')
    const reserved = new Set([...reservedAuthorizationParameters, client.authorizationClientIdParameter ?? 'client_id'])
    for (const [key, value] of Object.entries(client.extraAuthorizationParams ?? {})) {
      if (!key.trim() || reserved.has(key)) {
        throw new CoreError('INVALID_CONFIG', `The OAuth application cannot override ${key || 'an empty parameter'}.`)
      }
      if (typeof value !== 'string' || /[\r\n]/u.test(value)) {
        throw new CoreError('INVALID_CONFIG', 'OAuth application parameters must be single-line text.')
      }
    }
    const server = await this.startListener()
    const address = server.address()
    if (!address || typeof address === 'string' || address.port !== 38517) {
      throw new CoreError('OAUTH_LISTENER_FAILED', 'The Host OAuth callback listener is not bound to its registered loopback address.')
    }
    let attempt!: Attempt
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const attemptId = randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + this.lifetimeMs
    attempt = { id: attemptId, connectorId: input.connectorId, client, state, verifier,
      redirectUri: HOST_CONNECTOR_OAUTH_CALLBACK_URI, server,
      status: 'pending', expiresAt, exchangeStarted: false, consumed: false }
    attempt.timer = setTimeout(() => this.fail(attempt, 'OAUTH_TIMEOUT'), this.lifetimeMs)
    attempt.timer.unref()
    this.attempts.set(attemptId, attempt)
    this.attemptsByState.set(state, attempt)
    const url = new URL(client.authorizationUrl)
    const scopes = input.scopes.length > 0 ? input.scopes : client.scopes ?? []
    url.searchParams.set('response_type', 'code')
    url.searchParams.set(client.authorizationClientIdParameter ?? 'client_id', client.clientId)
    url.searchParams.set('redirect_uri', attempt.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
    for (const [key, value] of Object.entries(client.extraAuthorizationParams ?? {})) {
      url.searchParams.set(key, value)
    }
    return { attemptId, authorizationUrl: String(url), kind: 'browser', expiresAt }
  }

  private startListener(): Promise<Server> {
    if (this.listener?.listening) return Promise.resolve(this.listener)
    const listener = createServer((request, response) => {
      request.on('error', () => response.destroy())
      response.on('error', () => request.destroy())
      let url: URL
      try { url = new URL(request.url ?? '/', HOST_CONNECTOR_OAUTH_CALLBACK_URI) }
      catch {
        html(response, 400, 'The sign-in answer was not readable.')
        return
      }
      if (request.headers.host?.toLowerCase() !== '127.0.0.1:38517') {
        html(response, 404, 'Not found.')
        return
      }
      if (request.method !== 'GET' || url.pathname !== '/callback') {
        html(response, 404, 'Not found.')
        return
      }
      const state = url.searchParams.get('state') ?? ''
      const attempt = [...this.attemptsByState].find(([expected]) => safeEqual(state, expected))?.[1]
      if (!attempt) {
        html(response, 400, 'The sign-in answer did not match an active attempt.')
        return
      }
      void this.handle(attempt, url, response).catch(() => {
        if (!response.headersSent) html(response, 400, 'Sign-in did not finish. Return to the product and try again.')
        else response.destroy()
      })
    })
    listener.unref()
    return new Promise<Server>((resolve, reject) => {
      const failure = (error: NodeJS.ErrnoException) => {
        listener.close()
        reject(new CoreError('OAUTH_LISTENER_FAILED', error.code === 'EADDRINUSE'
          ? 'The Host OAuth callback port 38517 is already in use.'
          : 'The registered Host OAuth callback listener could not start.'))
      }
      listener.once('error', failure)
      listener.listen(38517, '127.0.0.1', () => {
        listener.off('error', failure)
        listener.on('error', () => {
          for (const attempt of this.attemptsByState.values()) this.fail(attempt, 'OAUTH_LISTENER_FAILED')
        })
        this.listener = listener
        resolve(listener)
      })
    })
  }

  async status(attemptId: string): Promise<ConnectorOAuthStatus> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new CoreError('NOT_FOUND', 'This OAuth attempt is unavailable.')
    return { state: attempt.status,
      ...(attempt.account === undefined ? {} : { account: attempt.account }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }) }
  }

  async credential(attemptId: string): Promise<ConnectorOAuthCredential> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new CoreError('NOT_FOUND', 'This OAuth attempt is unavailable.')
    if (attempt.consumed) throw new CoreError('OAUTH_ATTEMPT_CONSUMED', 'This OAuth result was already stored.')
    if (attempt.status !== 'completed' || !attempt.token) {
      throw new CoreError('OAUTH_INCOMPLETE', 'The OAuth attempt has not completed.')
    }
    return { value: attempt.token.value,
      ...(attempt.token.account === undefined ? {} : { account: attempt.token.account }),
      ...(attempt.token.expiresAt === undefined ? {} : { expiresAt: attempt.token.expiresAt }) }
  }

  async finish(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    attempt.consumed = true
    delete attempt.token
  }

  async cancel(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    if (attempt.timer) clearTimeout(attempt.timer)
    delete attempt.timer
    delete attempt.token
    delete attempt.errorCode
    attempt.consumed = true
    attempt.status = 'cancelled'
    this.attemptsByState.delete(attempt.state)
  }

  async close(): Promise<void> {
    await Promise.all([...this.attempts.keys()].map(attemptId => this.cancel(attemptId)))
    const listener = this.listener
    this.listener = undefined
    if (listener?.listening) await new Promise<void>(resolve => listener.close(() => resolve()))
  }

  private fail(attempt: Attempt, code: string) {
    if (attempt.timer) clearTimeout(attempt.timer)
    delete attempt.timer
    if (attempt.status === 'pending') attempt.status = 'error'
    attempt.errorCode = code
    delete attempt.token
    this.attemptsByState.delete(attempt.state)
  }

  private async handle(attempt: Attempt, url: URL,
    response: import('node:http').ServerResponse): Promise<void> {
    if (!safeEqual(url.searchParams.get('state') ?? '', attempt.state)) {
      html(response, 400, 'The sign-in answer did not match this attempt.')
      return
    }
    const denied = url.searchParams.get('error')
    if (denied) {
      this.fail(attempt, 'OAUTH_DENIED')
      html(response, 400, 'Sign-in was not authorized.')
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      this.fail(attempt, 'OAUTH_CODE_MISSING')
      html(response, 400, 'The sign-in answer had no authorization code.')
      return
    }
    if (attempt.exchangeStarted) {
      html(response, 409, 'This sign-in answer was already received.')
      return
    }
    attempt.exchangeStarted = true
    try {
      const tokens = await this.exchange(attempt, code)
      if (attempt.status === 'cancelled') return
      attempt.token = tokens
      if (tokens.account === undefined) delete attempt.account
      else attempt.account = tokens.account
      attempt.status = 'completed'
      if (attempt.timer) clearTimeout(attempt.timer)
      delete attempt.timer
      this.attemptsByState.delete(attempt.state)
      html(response, 200, 'Signed in. You can close this tab and return to the product.')
    } catch {
      this.fail(attempt, 'OAUTH_EXCHANGE_FAILED')
      html(response, 400, 'The sign-in answer could not be exchanged. Return to the product and try again.')
    }
  }

  private async exchange(attempt: Attempt, code: string): Promise<TokenPayload> {
    const client = attempt.client
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: attempt.redirectUri,
      [client.tokenClientIdParameter ?? 'client_id']: client.clientId,
      code_verifier: attempt.verifier,
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    let requestBody: string
    if (client.clientSecret) {
      if (client.tokenAuth === 'basic') {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`
      } else {
        fields[client.tokenClientSecretParameter ?? 'client_secret'] = client.clientSecret
      }
    }
    if (client.tokenRequestFormat === 'json') {
      headers['content-type'] = 'application/json'
      requestBody = JSON.stringify(fields)
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      requestBody = String(new URLSearchParams(fields))
    }
    const response = await this.request(client.tokenUrl, { method: 'POST', headers, body: requestBody,
      signal: AbortSignal.timeout(exchangeTimeoutMs) })
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
    if (!response.ok || !payload) throw new CoreError('OAUTH_EXCHANGE_FAILED', 'The OAuth token exchange failed.')
    if (typeof payload.code === 'number' && payload.code !== 0) {
      throw new CoreError('OAUTH_EXCHANGE_FAILED', 'The OAuth token exchange was refused.')
    }
    const token = responseToken(payload, Date.now(), client.tokenResponsePath)
    if (!client.whoami) return token
    try {
      const accountResponse = await this.request(client.whoami.url, { headers: {
        authorization: `Bearer ${JSON.parse(token.value).accessToken as string}`,
      }, signal: AbortSignal.timeout(exchangeTimeoutMs) })
      const account = await accountResponse.json().catch(() => undefined) as Record<string, unknown> | undefined
      const field = client.whoami.field.split('.').reduce<unknown>((value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, account)
      return { ...token, ...(typeof field === 'string' && field ? { account: field } : {}) }
    } catch {
      return token
    }
  }
}
