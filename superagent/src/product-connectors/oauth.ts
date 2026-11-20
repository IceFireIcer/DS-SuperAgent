import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CoreError } from '../model.js'
import type { ConnectorProvider, RepositoryAccess } from './protocol.js'

const callbackPath = '/superagent/oauth/callback'
const openPath = '/superagent/oauth/open/'
const defaultPort = 53682
const defaultTtl = 5 * 60_000

const providers = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    exchange: 'https://github.com/login/oauth/access_token',
    verify: 'https://api.github.com/user',
  },
  feishu: {
    authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    exchange: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    verify: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
  },
} as const

export interface OAuthGrant {
  accessToken: string
  expiresAt: number | null
  binding: VerifiedConnectorBinding | null
}

export type ConnectorBinding = { provider: 'github'; owner: string; repo: string; access: RepositoryAccess }
  | { provider: 'feishu'; appId: string; tenantKey: string }

export type VerifiedConnectorBinding = ConnectorBinding

interface OAuthStart {
  provider: ConnectorProvider
  clientId: string
  clientSecret: string
  binding: ConnectorBinding | null
  authorized(grant: OAuthGrant, signal: AbortSignal): Promise<void>
}

type LoginState = 'pending' | 'authorized' | 'failed' | 'expired' | 'cancelled'

interface Login {
  loginId: string
  provider: ConnectorProvider
  state: LoginState
  expiresAt: number
  error?: string
  openUrl?: string
}

interface Pending {
  login: Login
  server: Server
  timer: NodeJS.Timeout
  controller: AbortController
  request: OAuthStart
  verifier: string
  state: string
  callbackUsed: boolean
  port: number
}

export interface OAuthOptions {
  fetch?: typeof fetch
  port?: number
  ttlMs?: number
}

function callbackUri(port: number) {
  return `http://127.0.0.1:${port}${callbackPath}`
}

function sameState(actual: string, expected: string) {
  const candidate = Buffer.from(actual)
  const value = Buffer.from(expected)
  return candidate.length === value.length && timingSafeEqual(candidate, value)
}

function responseHeaders(response: ServerResponse) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('content-type', 'text/plain; charset=utf-8')
}

function respond(response: ServerResponse, status: number, message: string) {
  response.statusCode = status
  response.end(message)
}

async function responseObject(response: Response) {
  if (!response.ok || !response.body) throw new Error('OAuth request failed.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 64 * 1024) throw new Error('OAuth response exceeded the limit.')
      chunks.push(Buffer.from(value))
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OAuth response.')
    return parsed as Record<string, unknown>
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function verifyConnectorToken(provider: ConnectorProvider, accessToken: string, fetcher: typeof fetch, signal: AbortSignal,
  binding: ConnectorBinding | null) {
  if (!/^[!-~]{1,4096}$/u.test(accessToken)) throw new Error('Invalid OAuth credential.')
  const headers = { 'accept': 'application/json', 'authorization': `Bearer ${accessToken}`, 'user-agent': 'DS-SuperAgent' }
  const data = await responseObject(await fetcher(providers[provider].verify, { method: 'GET', redirect: 'error', signal,
    headers }))
  if (provider === 'github') {
    if (typeof data.login !== 'string' || !data.login) throw new Error('GitHub did not identify this account.')
    if (binding?.provider === 'github') {
      const { owner, repo, access } = binding
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      const repository = await responseObject(await fetcher(url, { method: 'GET', redirect: 'error', signal, headers }))
      if (typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
        || typeof repository.private !== 'boolean' || access === 'public' && (repository.private || repository.visibility === 'internal')) {
        throw new CoreError('CONNECTOR_SCOPE_DENIED', 'The GitHub credential does not cover the configured repository and access setting.')
      }
    }
  } else {
    const identity = data.data as { open_id?: unknown; tenant_key?: unknown } | undefined
    if (data.code !== 0 || typeof identity?.open_id !== 'string' || !identity.open_id) throw new Error('Feishu did not identify this account.')
    if (binding?.provider === 'feishu' && identity.tenant_key !== binding.tenantKey) {
      throw new CoreError('CONNECTOR_SCOPE_DENIED', 'The Feishu account does not belong to the configured tenant.')
    }
  }
  return binding
}

export class ConnectorOAuth {
  private readonly port: number
  private readonly ttlMs: number
  private readonly fetcher: typeof fetch
  private readonly logins = new Map<string, Login>()
  private pending: Pending | undefined
  private opening = false
  private closed = false

  constructor(options: OAuthOptions = {}) {
    this.port = options.port ?? defaultPort
    this.ttlMs = options.ttlMs ?? defaultTtl
    this.fetcher = options.fetch ?? globalThis.fetch
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535
      || !Number.isInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > defaultTtl) {
      throw new CoreError('INVALID_CONFIG', 'Check the Host OAuth listener settings.')
    }
  }

  get redirectUri() { return callbackUri(this.port) }

  current() {
    const pending = this.pending
    if (!pending) return null
    if (!pending.callbackUsed && Date.now() >= pending.login.expiresAt) {
      this.finish('expired')
      return null
    }
    return this.view(pending.login, !pending.callbackUsed)
  }

  async start(request: OAuthStart) {
    if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The product Host is closed.')
    if (this.opening || this.pending) throw new CoreError('CONNECTOR_OAUTH_BUSY', 'Finish or cancel the current authorization first.')
    this.opening = true
    const login: Login = { loginId: randomUUID(), provider: request.provider, state: 'pending', expiresAt: Date.now() + this.ttlMs }
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, (incoming, response) => {
      void this.receive(incoming, response).catch(() => {
        if (!response.headersSent) respond(response, 500, 'Authorization could not finish. Return to DS SuperAgent.')
        else response.end()
      })
    })
    server.maxConnections = 12
    server.keepAliveTimeout = 1000
    try {
      await new Promise<void>((resolve, reject) => {
        const error = () => reject(new CoreError('CONNECTOR_OAUTH_UNAVAILABLE', 'The local OAuth callback port is unavailable.'))
        server.once('error', error)
        server.listen(this.port, '127.0.0.1', () => {
          server.off('error', error)
          resolve()
        })
      })
      if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The product Host is closed.')
      const port = (server.address() as AddressInfo).port
      login.openUrl = `http://127.0.0.1:${port}${openPath}${login.loginId}`
      const timer = setTimeout(() => this.finish('expired'), Math.max(1, login.expiresAt - Date.now()))
      timer.unref()
      server.unref()
      server.on('error', () => this.finish('failed', 'CONNECTOR_OAUTH_UNAVAILABLE'))
      this.pending = { login, request, server, port, timer, controller: new AbortController(), callbackUsed: false,
        verifier: randomBytes(32).toString('base64url'), state: randomBytes(32).toString('base64url') }
      this.logins.set(login.loginId, login)
      while (this.logins.size > 16) this.logins.delete(this.logins.keys().next().value!)
      return this.view(login, true)
    } catch (error) {
      server.close()
      throw error
    } finally {
      this.opening = false
    }
  }

  status(provider: ConnectorProvider, loginId: string) {
    const login = this.logins.get(loginId)
    if (!login || login.provider !== provider) throw new CoreError('CONNECTOR_LOGIN_NOT_FOUND', 'Start a new authorization on this Host.')
    if (this.pending?.login === login && !this.pending.callbackUsed && Date.now() >= login.expiresAt) this.finish('expired')
    return this.view(login)
  }

  cancel(provider: ConnectorProvider, loginId: string) {
    const result = this.status(provider, loginId)
    if (this.pending?.login.loginId === loginId) {
      if (this.pending.callbackUsed) throw new CoreError('CONNECTOR_OAUTH_BUSY', 'The Host is finishing this authorization.')
      this.finish('cancelled')
    }
    return result.state === 'pending' ? this.status(provider, loginId) : result
  }

  close() {
    this.closed = true
    this.finish('cancelled')
  }

  private view({ openUrl, ...login }: Login, includeLink = false) {
    return { ...login, ...(includeLink && login.state === 'pending' && openUrl ? { openUrl } : {}) }
  }

  private finish(state: Exclude<LoginState, 'pending'>, error?: string) {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.login.state = state
    if (error) pending.login.error = error
    delete pending.login.openUrl
    clearTimeout(pending.timer)
    pending.controller.abort()
    pending.server.close()
  }

  private async receive(request: IncomingMessage, response: ServerResponse) {
    responseHeaders(response)
    const pending = this.pending
    if (!pending || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== `127.0.0.1:${pending.port}`
      || request.method !== 'GET' || request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-forwarded-host']
      || request.headers['sec-fetch-dest'] && request.headers['sec-fetch-dest'] !== 'document'
      || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      return respond(response, 403, 'This authorization request is unavailable.')
    }
    if (!pending.callbackUsed && Date.now() >= pending.login.expiresAt) {
      this.finish('expired')
      return respond(response, 410, 'Authorization expired. Return to DS SuperAgent to try again.')
    }
    const url = new URL(request.url, callbackUri(pending.port))
    const { provider, clientId } = pending.request
    const authorize = new URL(providers[provider].authorize)
    if (url.pathname === `${openPath}${pending.login.loginId}` && !url.search && !pending.callbackUsed && !request.headers.origin) {
      const binding = pending.request.binding
      const scope = binding?.provider === 'github' ? binding.access === 'private' ? 'repo' : 'public_repo' : 'read:user'
      authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUri(pending.port), response_type: 'code',
        state: pending.state, code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
        code_challenge_method: 'S256', ...(provider === 'github' ? { scope } : {}) }).toString()
      response.setHeader('location', authorize.href)
      return respond(response, 302, 'Opening the authorization provider.')
    }
    const state = url.searchParams.getAll('state')
    const code = url.searchParams.getAll('code')
    const error = url.searchParams.getAll('error')
    const fromProvider = !request.headers.origin || request.headers.origin === authorize.origin
    if (url.pathname !== callbackPath || !fromProvider || pending.callbackUsed || state.length !== 1
      || !sameState(state[0]!, pending.state) || !(code.length === 1 && error.length === 0 && /^[!-~]{1,4096}$/u.test(code[0]!)
        || error.length === 1 && code.length === 0)) {
      return respond(response, 400, 'This authorization response could not be verified.')
    }
    pending.callbackUsed = true
    clearTimeout(pending.timer)
    if (error.length) {
      this.finish('failed', 'CONNECTOR_OAUTH_DENIED')
      return respond(response, 400, 'Authorization was declined. You can close this tab.')
    }
    const signal = AbortSignal.any([pending.controller.signal, AbortSignal.timeout(15_000)])
    try {
      const grant = await this.exchange(pending, code[0]!, signal)
      signal.throwIfAborted()
      await pending.request.authorized(grant, signal)
      if (this.pending === pending) this.finish('authorized')
      return respond(response, 200, 'Authorization complete. You can close this tab.')
    } catch (failure) {
      const code = failure instanceof CoreError && ['CONFIG_REVISION_CONFLICT', 'CONNECTOR_SCOPE_DENIED'].includes(failure.code)
        ? failure.code : 'CONNECTOR_OAUTH_FAILED'
      if (this.pending === pending) this.finish('failed', code)
      return respond(response, 400, 'Authorization could not finish. Return to DS SuperAgent to try again.')
    }
  }

  private async exchange(pending: Pending, code: string, signal: AbortSignal): Promise<OAuthGrant> {
    const { provider, clientId, clientSecret, binding } = pending.request
    const content = { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: callbackUri(pending.port), code_verifier: pending.verifier }
    const github = provider === 'github'
    const data = await responseObject(await this.fetcher(providers[provider].exchange, { method: 'POST', redirect: 'error', signal,
      headers: { 'accept': 'application/json', 'content-type': github ? 'application/x-www-form-urlencoded' : 'application/json',
        'user-agent': 'DS-SuperAgent' }, body: github ? new URLSearchParams(content) : JSON.stringify(content) }))
    if (!github && data.code !== 0 || data.error || typeof data.access_token !== 'string') throw new Error('OAuth exchange was refused.')
    if (binding?.provider === 'github') {
      const scopes = typeof data.scope === 'string' ? data.scope.split(/[,\s]+/u) : []
      const allowed = binding.access === 'private' ? scopes.includes('repo') : scopes.includes('public_repo') && !scopes.includes('repo')
      if (!allowed) throw new CoreError('CONNECTOR_SCOPE_DENIED', 'The GitHub authorization scope does not match the configured access.')
    }
    const verified = await verifyConnectorToken(provider, data.access_token, this.fetcher, signal, binding)
    const lifetime = data.expires_in
    if ((!github || lifetime !== undefined) && (typeof lifetime !== 'number' || !Number.isSafeInteger(lifetime)
      || lifetime < 1 || lifetime > 365 * 24 * 60 * 60)) throw new Error('Invalid OAuth credential lifetime.')
    const expiresAt = typeof lifetime === 'number' ? Date.now() + lifetime * 1000 : null
    return { accessToken: data.access_token, expiresAt, binding: verified }
  }
}
