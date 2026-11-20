import { CoreError, identifier } from '../model.js'
import { ProductCredentialManager } from '../product-credential-manager.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import type { Storage } from '../storage.js'
import { createConnectorMailProducts, type ConnectorMailDispatchContext, type ConnectorMailProducts,
  type ConnectorMailProductsOptions } from './dispatcher.js'
import { HostConnectorImportAdapter, standardConnectorImportFiles, type HostConnectorImportFile } from './import-host.js'
import type { ConnectorCredentialPort } from './credentials.js'
import { HostLoopbackOAuthBroker, type ConnectorOAuthBroker, type LoopbackOAuthClient } from './oauth.js'
import type { ConnectorImportAdapter, ConnectorVerifier } from './service.js'
import type { ConnectorStateStore } from './store.js'
import type { ProductMailTransport } from '../product-mail/service.js'
import { loadHostMailTransport } from '../product-mail/host-transport.js'

export interface HostConnectorMailContext {
  /** The Host's public DSH credential record seam (`ctx.credentials`). */
  credentials?: ProductCredentialRecords
}

export interface HostOAuthAppConfig {
  clientId: string
  clientSecret?: string
  scopes?: string[]
  authorizationUrl?: string
  tokenUrl?: string
  whoami?: { url: string; field: string }
  tokenAuth?: 'body' | 'basic'
  authorizationClientIdParameter?: string
  tokenClientIdParameter?: string
  tokenClientSecretParameter?: string
  tokenRequestFormat?: 'form' | 'json'
  tokenResponsePath?: string[]
  extraAuthorizationParams?: Record<string, string>
}

interface OAuthProviderDefaults {
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  whoami: { url: string; field: string }
  tokenAuth: 'body' | 'basic'
  authorizationClientIdParameter?: string
  tokenClientIdParameter?: string
  tokenClientSecretParameter?: string
  tokenRequestFormat?: 'form' | 'json'
  tokenResponsePath?: string[]
}

const GITHUB_OAUTH: OAuthProviderDefaults = {
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['repo', 'read:org'],
  whoami: { url: 'https://api.github.com/user', field: 'login' },
  tokenAuth: 'body' as const,
}

const FEISHU_OAUTH: OAuthProviderDefaults = {
  authorizationUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  scopes: [] as string[],
  whoami: { url: 'https://open.feishu.cn/open-apis/authen/v1/user_info', field: 'data.name' },
  tokenAuth: 'body' as const,
  authorizationClientIdParameter: 'app_id',
  tokenClientIdParameter: 'app_id',
  tokenClientSecretParameter: 'app_secret',
  tokenRequestFormat: 'json' as const,
  tokenResponsePath: ['data'],
}

function oauthClient(app: HostOAuthAppConfig, defaults: OAuthProviderDefaults): LoopbackOAuthClient {
  const clientId = app.clientId.trim()
  if (!clientId) throw new CoreError('INVALID_CONFIG', 'A registered OAuth application needs a client ID.')
  if (!app.clientSecret?.trim()) throw new CoreError('INVALID_CONFIG',
    'OAuth application secrets must be configured on the Host, not entered in product requests.')
  const whoami = app.whoami ?? defaults.whoami
  const tokenAuth = app.tokenAuth ?? defaults.tokenAuth
  return {
    clientId,
    authorizationUrl: app.authorizationUrl ?? defaults.authorizationUrl,
    tokenUrl: app.tokenUrl ?? defaults.tokenUrl,
    ...(app.clientSecret === undefined ? {} : { clientSecret: app.clientSecret }),
    scopes: [...(app.scopes ?? defaults.scopes ?? [])],
    ...(whoami === undefined ? {} : { whoami }),
    ...(tokenAuth === undefined ? {} : { tokenAuth }),
    authorizationClientIdParameter: app.authorizationClientIdParameter ?? defaults.authorizationClientIdParameter ?? 'client_id',
    tokenClientIdParameter: app.tokenClientIdParameter ?? defaults.tokenClientIdParameter ?? 'client_id',
    tokenClientSecretParameter: app.tokenClientSecretParameter ?? defaults.tokenClientSecretParameter ?? 'client_secret',
    tokenRequestFormat: app.tokenRequestFormat ?? defaults.tokenRequestFormat ?? 'form',
    tokenResponsePath: [...(app.tokenResponsePath ?? defaults.tokenResponsePath ?? [])],
    ...(app.extraAuthorizationParams === undefined ? {}
      : { extraAuthorizationParams: { ...app.extraAuthorizationParams } }),
  }
}

/** Reads OAuth registrations only from Host configuration/environment, never request payloads. */
export function connectorOAuthAppsFromEnvironment(environment: NodeJS.ProcessEnv = process.env):
Partial<Record<'github' | 'feishu', HostOAuthAppConfig>> {
  const apps: Partial<Record<'github' | 'feishu', HostOAuthAppConfig>> = {}
  const githubClientId = environment.DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_ID?.trim()
  const githubClientSecret = environment.DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_SECRET
  if (githubClientId && githubClientSecret?.trim()) apps.github = { clientId: githubClientId, clientSecret: githubClientSecret }
  const feishuClientId = environment.DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_ID?.trim()
  const feishuClientSecret = environment.DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_SECRET
  if (feishuClientId && feishuClientSecret?.trim()) apps.feishu = { clientId: feishuClientId, clientSecret: feishuClientSecret }
  return apps
}

/** Registered GitHub/Feishu applications become Host-local callback clients only. */
export function createHostConnectorOAuthBroker(input: {
  apps?: Partial<Record<'github' | 'feishu', HostOAuthAppConfig>>
  fetch?: typeof globalThis.fetch
} = {}): HostLoopbackOAuthBroker | undefined {
  const clients: Record<string, LoopbackOAuthClient> = {}
  if (input.apps?.github) clients.github = oauthClient(input.apps.github, GITHUB_OAUTH)
  if (input.apps?.feishu) clients.feishu = oauthClient(input.apps.feishu, FEISHU_OAUTH)
  if (Object.keys(clients).length === 0) return undefined
  return new HostLoopbackOAuthBroker({ clients, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) })
}

/** Verifies a GitHub token without projecting it or the upstream response. */
export function createGitHubTokenVerifier(input: {
  fetch?: typeof globalThis.fetch
  api?: string
} = {}): ConnectorVerifier {
  const request = input.fetch ?? globalThis.fetch
  const api = (input.api ?? 'https://api.github.com').replace(/\/$/u, '')
  return {
    async verify({ connectorId, value }) {
      if (connectorId !== 'github') return {}
      let response: Response
      try {
        response = await request(`${api}/user`, { headers: {
          authorization: `Bearer ${value}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'ds-superagent',
        }, signal: AbortSignal.timeout(15_000) })
      } catch {
        throw new CoreError('CONNECTOR_AUTH_FAILED', 'GitHub could not be reached to verify this token.')
      }
      if (response.status === 401 || response.status === 403) {
        throw new CoreError('CONNECTOR_AUTH_FAILED', 'GitHub refused this token.')
      }
      if (!response.ok) throw new CoreError('CONNECTOR_AUTH_FAILED',
        `GitHub answered ${response.status} while verifying this token.`)
      const body = await response.json().catch(() => undefined) as { login?: unknown } | undefined
      if (typeof body?.login !== 'string' || !body.login) {
        throw new CoreError('CONNECTOR_AUTH_FAILED', 'GitHub did not identify the token owner.')
      }
      return { account: body.login }
    },
  }
}

export interface HostConnectorMailOptions {
  instanceId: string
  actorId: string
  context: HostConnectorMailContext
  /** Reuse the Host's ProductCredentialManager when it already exists. */
  credentials?: ConnectorCredentialPort
  /** Needed only when credentials is omitted; the factory creates ProductCredentialManager. */
  storage?: Storage
  oauthBroker?: ConnectorOAuthBroker
  oauthApps?: Partial<Record<'github' | 'feishu', HostOAuthAppConfig>>
  oauthFetch?: typeof globalThis.fetch
  imports?: ConnectorImportAdapter | null
  importFiles?: readonly HostConnectorImportFile[]
  mailTransport?: ProductMailTransport
  verifier?: ConnectorVerifier
  store?: ConnectorStateStore
  now?: () => number
}

export interface HostConnectorMailProducts extends ConnectorMailProducts {
  metadata: {
    credentials: 'reused' | 'created'
    oauthProviders: string[]
    import: 'configured' | 'unavailable'
    mail: 'configured' | 'unavailable'
  }
}

/**
 * Production Host assembly. Missing optional providers do not crash Main: the
 * relevant endpoints return UNAVAILABLE/MAIL_TRANSPORT_UNAVAILABLE instead.
 * Missing DSH credential records or a credential manager is an assembly error.
 */
export function createHostConnectorMailProducts(options: HostConnectorMailOptions): HostConnectorMailProducts {
  identifier(options.instanceId, 'instanceId'); identifier(options.actorId, 'actorId')
  const records = options.context.credentials
  if (!records) throw new CoreError('CREDENTIAL_STORE_UNAVAILABLE',
    'This Host has no DSH credential record service; connector and mailbox secrets stay disabled.')
  const credentials = options.credentials ?? (options.storage
    ? new ProductCredentialManager(options.storage, options.instanceId, records)
    : undefined)
  if (!credentials) throw new CoreError('CREDENTIAL_SERVICE_UNAVAILABLE',
    'The Host must provide ProductCredentialManager or its business Storage.')
  const oauthApps = options.oauthApps ?? connectorOAuthAppsFromEnvironment()
  const oauth = options.oauthBroker ?? createHostConnectorOAuthBroker({
    apps: oauthApps,
    ...(options.oauthFetch === undefined ? {} : { fetch: options.oauthFetch }),
  })
  const imports = options.imports === null ? undefined : options.imports
    ?? new HostConnectorImportAdapter({ files: options.importFiles ?? standardConnectorImportFiles() })
  const verifier = options.verifier ?? createGitHubTokenVerifier(
    options.oauthFetch === undefined ? {} : { fetch: options.oauthFetch })
  const productsOptions: ConnectorMailProductsOptions = { instanceId: options.instanceId,
    actorId: options.actorId, records, credentials, verifier,
    ...(oauth === undefined ? {} : { oauth }), ...(imports === undefined ? {} : { imports }),
    ...(options.mailTransport === undefined ? {} : { mailTransport: options.mailTransport }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }) }
  const products = createConnectorMailProducts(productsOptions)
  return {
    ...products,
    metadata: {
      credentials: options.credentials ? 'reused' : 'created',
      oauthProviders: Object.entries(oauthApps).filter(([, app]) => app !== undefined)
        .map(([id]) => id),
      import: imports ? 'configured' : 'unavailable',
      mail: options.mailTransport ? 'configured' : 'unavailable',
    },
  }
}

/** Loads optional Host mail dependencies and binds them only if all are available. */
export async function createConfiguredHostConnectorMailProducts(options: HostConnectorMailOptions):
Promise<HostConnectorMailProducts> {
  const mailTransport = options.mailTransport ?? await loadHostMailTransport()
  return createHostConnectorMailProducts({ ...options, ...(mailTransport ? { mailTransport } : {}) })
}

/** Maps the existing ProductHost client identity to #141's read/command split. */
export function connectorMailDispatchContext(client:
  { grants?: Array<{ instanceId: string; capabilities?: readonly string[] }> } | undefined,
instanceId: string): ConnectorMailDispatchContext {
  if (!client) return { local: true }
  const grant = client.grants?.find(item => item.instanceId === instanceId)
  return { local: false, capabilities: [...(grant?.capabilities ?? [])] }
}
