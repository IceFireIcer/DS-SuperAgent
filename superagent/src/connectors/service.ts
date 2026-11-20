import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { CoreError, identifier } from '../model.js'
import type { CredentialPurpose, CredentialResourceView } from '../resource-credentials.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import { CONNECTOR_CATALOG, connectorEntry, customConnectorId,
  type ConnectorAuthKind, type ConnectorCatalogEntry } from './catalog.js'
import { deleteProductCredential, grantFor, saveProductCredential,
  type ConnectorCredentialPort } from './credentials.js'
import type { ConnectorOAuthBroker, ConnectorOAuthStatus } from './oauth.js'
import { CommandJournal, createCredentialRecordStateStore, type ConnectorStateStore } from './store.js'
import { assertNonToolTarget, normalizeTarget, targetFingerprint, targetKey, type ProductTarget } from './target.js'

export interface ConnectorRegistration {
  name: string
  category: string
  about: string
  remoteUrl?: string
  command?: string
  args?: string[]
  readOnly: boolean
  auth: { kind: ConnectorAuthKind; token?: boolean; scopes?: string[]; keyUrl?: string }
  secretRefs?: Array<{ slot: string; resourceId: string; grantId?: string }>
}

interface ConnectorBindingRecord {
  instanceId: string
  actorId: string
  connectorId: string
  target: ProductTarget
  custom: boolean
  registration: ConnectorRegistration
  credential?: {
    kind: 'token' | 'oauth' | 'linked'
    resourceId: string
    grantId?: string
    purpose: CredentialPurpose
    account?: string
    expiresAt?: number
  }
  errorCode?: string
  revision: number
  createdAt: number
  updatedAt: number
}

interface ConnectorOAuthAttemptRecord {
  id: string
  instanceId: string
  actorId: string
  connectorId: string
  target: ProductTarget
  status: 'pending' | 'completed' | 'error' | 'cancelled'
  authorizationUrl: string
  kind: 'browser' | 'device'
  userCode?: string
  verificationUri?: string
  expiresAt: number
  resourceId?: string
  account?: string
  errorCode?: string
  createdAt: number
  updatedAt: number
}

export interface ConnectorVerifier {
  verify(input: { connectorId: string; value: string; target: ProductTarget }): Promise<{ account?: string }>
}

export interface ConnectorImportCandidate {
  id: string
  name: string
  source: string
  transport: 'http' | 'stdio'
  envNames: string[]
  headerNames: string[]
}

export interface ConnectorImportConfig {
  id?: string
  name: string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface ConnectorImportAdapter {
  scan(): Promise<ConnectorImportCandidate[]>
  read(sourceId: string): Promise<ConnectorImportConfig>
}

export interface ConnectorSettingsView {
  id: string
  name: string
  category: string
  about: string
  custom: boolean
  auth: ConnectorRegistration['auth']
  status: 'off' | 'configured' | 'needs-authorization' | 'pending' | 'ready' | 'error'
  readOnly: boolean
  revision: number
  account?: string
  credentialKind?: 'token' | 'oauth' | 'linked'
  authorizationAvailable?: boolean
  secretCount: number
  errorCode?: string
  pending?: {
    attemptId: string
    authorizationUrl: string
    kind: 'browser' | 'device'
    userCode?: string
    verificationUri?: string
    expiresAt: number
  }
}

export interface ConnectorOAuthView {
  attemptId: string
  connectorId: string
  state: 'pending' | 'completed' | 'error' | 'cancelled'
  kind: 'browser' | 'device'
  authorizationUrl: string
  userCode?: string
  verificationUri?: string
  expiresAt: number
  account?: string
  errorCode?: string
}

export interface ConnectorListResult {
  items: ConnectorSettingsView[]
  target: ProductTarget
}

export interface ConnectorServiceOptions {
  instanceId: string
  actorId: string
  records: ProductCredentialRecords
  credentials: ConnectorCredentialPort
  oauth?: ConnectorOAuthBroker
  imports?: ConnectorImportAdapter
  verifier?: ConnectorVerifier
  store?: ConnectorStateStore
  catalog?: readonly ConnectorCatalogEntry[]
  now?: () => number
}

const bindingCollection = 'connector-binding'
const attemptCollection = 'connector-oauth-attempt'
const commandCollection = 'connector-command'
const bindingIndex = (actorId: string, target: ProductTarget) => targetKey(actorId, target)
const attemptIndex = (actorId: string, target: ProductTarget) => `oauth:${targetKey(actorId, target)}`
const bindingId = (actorId: string, connectorId: string, target: ProductTarget) =>
  `${connectorId}:${targetFingerprint(target)}:${targetKey(actorId, target)}`

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /\0/u.test(value)) {
    throw new CoreError('INVALID_INPUT', `${label} must be nonempty text of at most ${max} bytes.`)
  }
  return value.trim()
}

function secretValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\r\n]/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'Enter one nonempty credential without line breaks.')
  }
  return value
}

function customId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'Connector IDs use lowercase letters, digits, and hyphens.')
  }
  return value
}

function secureAddress(value: unknown): string {
  const raw = text(value, 'Connector address', 2048)
  let url: URL
  try { url = new URL(raw) } catch { throw new CoreError('INVALID_INPUT', 'Enter a valid connector address.') }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const loopback = hostname === 'localhost'
    || isIP(hostname) === 4 && hostname.startsWith('127.')
    || isIP(hostname) === 6 && hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CoreError('INVALID_INPUT', 'Connector addresses must use https; loopback HTTP is allowed for local servers.')
  }
  if (url.username || url.password) throw new CoreError('INVALID_INPUT', 'Put connector credentials in the credential vault, not the address.')
  return url.toString()
}

function args(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string'
    || Buffer.byteLength(item) > 2048 || /\0/u.test(item))) {
    throw new CoreError('INVALID_INPUT', 'Connector arguments must be up to 64 plain strings.')
  }
  return [...value]
}

function registrationOf(entry: ConnectorCatalogEntry, readOnly = false): ConnectorRegistration {
  return { name: entry.name, category: entry.category, about: entry.about, ...(entry.remoteUrl ? { remoteUrl: entry.remoteUrl } : {}),
    readOnly, auth: structuredClone(entry.auth) }
}

function purposeOf(entry: ConnectorRegistration, catalog?: ConnectorCatalogEntry): CredentialPurpose {
  return catalog?.purpose ?? 'tool'
}

function requestCommandId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)}`
}

function matchesGrant(resource: CredentialResourceView, target: ProductTarget, purpose: CredentialPurpose) {
  return grantFor(resource, target, purpose)
}

export class ConnectorService {
  private readonly instanceId: string
  private readonly actorId: string
  private readonly records: ProductCredentialRecords
  private readonly credentials: ConnectorCredentialPort
  private readonly oauth: ConnectorOAuthBroker | undefined
  private readonly imports: ConnectorImportAdapter | undefined
  private readonly verifier: ConnectorVerifier | undefined
  private readonly store: ConnectorStateStore
  private readonly catalog: readonly ConnectorCatalogEntry[]
  private readonly now: () => number
  private readonly journal: CommandJournal
  private readonly oauthFlights = new Map<string, Promise<ConnectorOAuthView>>()

  constructor(options: ConnectorServiceOptions) {
    identifier(options.instanceId, 'instanceId'); identifier(options.actorId, 'actorId')
    this.instanceId = options.instanceId
    this.actorId = options.actorId
    this.records = options.records
    this.credentials = options.credentials
    this.oauth = options.oauth
    this.imports = options.imports
    this.verifier = options.verifier
    this.store = options.store ?? createCredentialRecordStateStore(options.records, options.instanceId)
    this.catalog = options.catalog ?? CONNECTOR_CATALOG
    this.now = options.now ?? Date.now
    this.journal = new CommandJournal(this.store, commandCollection)
  }

  private entry(id: string): ConnectorCatalogEntry | undefined {
    return this.catalog.find(entry => entry.id === id) ?? connectorEntry(id)
  }

  private async binding(connectorId: string, target: ProductTarget): Promise<ConnectorBindingRecord | undefined> {
    return this.store.read<ConnectorBindingRecord>(bindingCollection, bindingId(this.actorId, connectorId, target))
  }

  private async bindings(target: ProductTarget): Promise<ConnectorBindingRecord[]> {
    const items = await this.store.entries<ConnectorBindingRecord>(bindingCollection, bindingIndex(this.actorId, target))
    return items.filter(item => item.value.actorId === this.actorId && item.value.instanceId === this.instanceId).map(item => item.value)
  }

  private async attempts(target: ProductTarget): Promise<ConnectorOAuthAttemptRecord[]> {
    const items = await this.store.entries<ConnectorOAuthAttemptRecord>(attemptCollection, attemptIndex(this.actorId, target))
    return items.filter(item => item.value.actorId === this.actorId && item.value.instanceId === this.instanceId).map(item => item.value)
  }

  private async resourceState(binding: ConnectorBindingRecord | undefined,
    target: ProductTarget, purpose: CredentialPurpose): Promise<'ready' | 'needs-authorization'> {
    if (!binding?.credential) return 'needs-authorization'
    const resource = await this.credentials.get({ instanceId: this.instanceId, resourceId: binding.credential.resourceId })
    return resource?.status === 'active' && matchesGrant(resource, target, purpose)
      ? 'ready' : 'needs-authorization'
  }

  private async view(entry: ConnectorCatalogEntry, binding: ConnectorBindingRecord | undefined,
    attempt: ConnectorOAuthAttemptRecord | undefined): Promise<ConnectorSettingsView> {
    const target = binding?.target ?? attempt?.target ?? { role: 'main' as const }
    const purpose = purposeOf(binding?.registration ?? registrationOf(entry), entry)
    const state = await this.resourceState(binding, target, purpose)
    let status: ConnectorSettingsView['status'] = binding ? state : 'off'
    if (attempt?.status === 'pending') status = 'pending'
    else if (attempt?.status === 'error' && status !== 'ready') status = 'error'
    else if (binding && !binding.credential) {
      status = binding.registration.auth.kind === 'none' || (binding.registration.secretRefs?.length ?? 0) > 0
        ? 'configured' : 'needs-authorization'
    }
    if (binding?.errorCode) status = 'error'
    return {
      id: entry.id,
      name: binding?.registration.name ?? entry.name,
      category: binding?.registration.category ?? entry.category,
      about: binding?.registration.about ?? entry.about,
      custom: binding?.custom ?? false,
      auth: structuredClone(binding?.registration.auth ?? entry.auth),
      status,
      readOnly: binding?.registration.readOnly ?? false,
      revision: binding?.revision ?? 0,
      secretCount: binding?.registration.secretRefs?.length ?? 0,
      ...(binding?.credential?.account === undefined ? {} : { account: binding.credential.account }),
      ...(binding?.credential?.kind === undefined ? {} : { credentialKind: binding.credential.kind }),
      ...(entry.auth.kind === 'oauth' ? { authorizationAvailable: this.oauth !== undefined
        && (this.oauth.supports?.(entry.id) ?? true) } : {}),
      ...(binding?.errorCode !== undefined ? { errorCode: binding.errorCode }
        : attempt?.errorCode !== undefined ? { errorCode: attempt.errorCode } : {}),
      ...(attempt?.status === 'pending' ? { pending: {
        attemptId: attempt.id,
        authorizationUrl: attempt.authorizationUrl,
        kind: attempt.kind,
        ...(attempt.userCode === undefined ? {} : { userCode: attempt.userCode }),
        ...(attempt.verificationUri === undefined ? {} : { verificationUri: attempt.verificationUri }),
        expiresAt: attempt.expiresAt,
      } } : {}),
    }
  }

  async list(input: { target: unknown }): Promise<ConnectorListResult> {
    const target = normalizeTarget(input.target)
    const [bindings, attempts] = await Promise.all([this.bindings(target), this.attempts(target)])
    const byId = new Map(bindings.map(binding => [binding.connectorId, binding]))
    const attemptById = new Map(attempts.map(attempt => [attempt.connectorId, attempt]))
    const ids = new Set<string>()
    const items: ConnectorSettingsView[] = []
    for (const entry of this.catalog) {
      ids.add(entry.id)
      items.push(await this.view(entry, byId.get(entry.id), attemptById.get(entry.id)))
    }
    for (const binding of bindings) {
      if (ids.has(binding.connectorId)) continue
      ids.add(binding.connectorId)
      const entry: ConnectorCatalogEntry = { id: binding.connectorId, name: binding.registration.name,
        category: binding.registration.category, about: binding.registration.about,
        ...(binding.registration.remoteUrl === undefined ? {} : { remoteUrl: binding.registration.remoteUrl }),
        auth: structuredClone(binding.registration.auth) }
      items.push(await this.view(entry, binding, attemptById.get(binding.connectorId)))
    }
    return { items, target }
  }

  async save(input: { commandId: string; connectorId?: string; name?: string; url?: string; command?: string;
    args?: string[]; readOnly?: boolean; target: unknown }): Promise<ConnectorSettingsView> {
    const target = normalizeTarget(input.target)
    if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') {
      throw new CoreError('INVALID_INPUT', 'Choose whether this connector is read-only.')
    }
    return this.journal.run(input.commandId, ['save', target, input.connectorId, input.name, input.url,
      input.command, input.args, input.readOnly], async () => {
      const existingById = input.connectorId === undefined ? undefined : await this.binding(customId(input.connectorId), target)
      const catalog = input.connectorId === undefined ? undefined : this.entry(input.connectorId)
      let connectorId: string
      if (catalog) {
        if (input.name !== undefined || input.url !== undefined || input.command !== undefined || input.args !== undefined) {
          throw new CoreError('INVALID_INPUT', 'Catalog connector identity and address are fixed; only its read-only setting can change.')
        }
        connectorId = catalog.id
      } else if (input.connectorId !== undefined) {
        connectorId = customId(input.connectorId)
        if (existingById === undefined && this.entry(connectorId)) {
          throw new CoreError('INVALID_INPUT', 'This connector ID belongs to the catalog.')
        }
      } else {
        const name = text(input.name, 'Connector name', 128)
        const taken = new Set([...this.catalog.map(entry => entry.id), ...(await this.bindings(target)).map(binding => binding.connectorId)])
        connectorId = customConnectorId(name, taken)
      }
      const existing = existingById ?? await this.binding(connectorId, target)
      let registration: ConnectorRegistration
      if (catalog) {
        registration = { ...registrationOf(catalog, input.readOnly ?? existing?.registration.readOnly ?? false),
          ...(existing?.registration.secretRefs ? { secretRefs: structuredClone(existing.registration.secretRefs) } : {}) }
      } else {
        const name = text(input.name ?? existing?.registration.name, 'Connector name', 128)
        const url = input.url === undefined ? existing?.registration.remoteUrl : secureAddress(input.url)
        const command = input.command === undefined ? existing?.registration.command
          : text(input.command, 'Connector command', 2048)
        const commandArgs = args(input.args) ?? existing?.registration.args
        if (url !== undefined && command !== undefined) {
          throw new CoreError('INVALID_INPUT', 'Choose either a connector address or a local command.')
        }
        if (url === undefined && command === undefined) {
          throw new CoreError('INVALID_INPUT', 'A custom connector needs an address or a command.')
        }
        if (commandArgs !== undefined && command === undefined) {
          throw new CoreError('INVALID_INPUT', 'Connector arguments need a command.')
        }
        registration = {
          name,
          category: existing?.registration.category ?? 'custom',
          about: existing?.registration.about ?? 'A custom MCP connector',
          ...(url === undefined ? {} : { remoteUrl: url }),
          ...(command === undefined ? {} : { command }),
          ...(commandArgs === undefined ? {} : { args: commandArgs }),
          readOnly: input.readOnly ?? existing?.registration.readOnly ?? false,
          auth: structuredClone(existing?.registration.auth ?? { kind: 'token' }),
          ...(existing?.registration.secretRefs ? { secretRefs: structuredClone(existing.registration.secretRefs) } : {}),
        }
      }
      const now = this.now()
      const record: ConnectorBindingRecord = { instanceId: this.instanceId, actorId: this.actorId, connectorId,
        target, custom: catalog === undefined, registration,
        ...(existing?.credential ? { credential: structuredClone(existing.credential) } : {}),
        ...(existing?.errorCode ? { errorCode: existing.errorCode } : {}),
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now }
      await this.store.write(bindingCollection, bindingId(this.actorId, connectorId, target), record, bindingIndex(this.actorId, target))
      return this.view(catalog ?? { id: connectorId, name: registration.name, category: registration.category,
        about: registration.about, ...(registration.remoteUrl === undefined ? {} : { remoteUrl: registration.remoteUrl }),
        auth: registration.auth }, record, undefined)
    })
  }

  async tokenSave(input: { commandId: string; connectorId: string; label?: string; value: string;
    target: unknown }): Promise<ConnectorSettingsView> {
    const target = normalizeTarget(input.target)
    const connectorId = customId(input.connectorId)
    const value = secretValue(input.value)
    return this.journal.run(input.commandId, ['token-save', connectorId, target, input.label, input.value], async () => {
      const [existing, catalog] = await Promise.all([this.binding(connectorId, target), Promise.resolve(this.entry(connectorId))])
      if (!catalog && !existing) throw new CoreError('NOT_FOUND', 'This custom connector is not registered.')
      const auth = catalog?.auth ?? existing!.registration.auth
      if (catalog && !(auth.kind === 'token' || auth.kind === 'oauth' && auth.token === true)) {
        throw new CoreError('CONNECTOR_AUTH_UNSUPPORTED', 'This connector does not accept a token; use its credential binding or OAuth flow.')
      }
      const registration = existing ? structuredClone(existing.registration) : registrationOf(catalog!)
      if (!catalog && registration.auth.kind === 'none') registration.auth = { kind: 'token' }
      const purpose = purposeOf(registration, catalog)
      const account = this.verifier ? (await this.verifier.verify({ connectorId, value, target })).account : undefined
      const saved = await saveProductCredential({ credentials: this.credentials, instanceId: this.instanceId,
        commandId: `connector:${connectorId}:${input.commandId}`, label: input.label?.trim() || `Connector: ${registration.name}`,
        value, target, purpose,
        ...(existing?.credential && existing.credential.kind !== 'linked' ? { existing: {
          resourceId: existing.credential.resourceId,
          ...(existing.credential.grantId === undefined ? {} : { grantId: existing.credential.grantId }),
        } } : {}) })
      const now = this.now()
      const record: ConnectorBindingRecord = { instanceId: this.instanceId, actorId: this.actorId, connectorId,
        target, custom: existing?.custom ?? catalog === undefined, registration,
        credential: { kind: 'token', resourceId: saved.resourceId,
          ...(saved.grantId === undefined ? {} : { grantId: saved.grantId }), purpose,
          ...(account === undefined ? {} : { account }) },
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now }
      await this.store.write(bindingCollection, bindingId(this.actorId, connectorId, target), record, bindingIndex(this.actorId, target))
      return this.view(catalog ?? { id: connectorId, name: registration.name, category: registration.category,
        about: registration.about, ...(registration.remoteUrl === undefined ? {} : { remoteUrl: registration.remoteUrl }),
        auth: registration.auth }, record, undefined)
    })
  }

  async bindCredential(input: { commandId: string; connectorId: string; resourceId: string;
    target: unknown }): Promise<ConnectorSettingsView> {
    const target = normalizeTarget(input.target)
    const connectorId = customId(input.connectorId)
    identifier(input.resourceId, 'resourceId')
    return this.journal.run(input.commandId, ['bind', connectorId, target, input.resourceId], async () => {
      const [existing, catalog] = await Promise.all([this.binding(connectorId, target), Promise.resolve(this.entry(connectorId))])
      if (!catalog && !existing) throw new CoreError('NOT_FOUND', 'This custom connector is not registered.')
      const registration = existing?.registration ?? registrationOf(catalog!)
      const purpose = purposeOf(registration, catalog)
      const resource = await this.credentials.get({ instanceId: this.instanceId, resourceId: input.resourceId })
      if (resource?.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'Select an active credential resource.')
      const grant = matchesGrant(resource, target, purpose)
      if (!grant) throw new CoreError('GRANT_DENIED', 'Grant the selected credential resource to this exact target first.')
      const now = this.now()
      const record: ConnectorBindingRecord = { instanceId: this.instanceId, actorId: this.actorId, connectorId,
        target, custom: existing?.custom ?? catalog === undefined, registration,
        credential: { kind: 'linked', resourceId: resource.id, grantId: grant.id, purpose },
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now }
      await this.store.write(bindingCollection, bindingId(this.actorId, connectorId, target), record, bindingIndex(this.actorId, target))
      return this.view(catalog ?? { id: connectorId, name: registration.name, category: registration.category,
        about: registration.about, ...(registration.remoteUrl === undefined ? {} : { remoteUrl: registration.remoteUrl }),
        auth: registration.auth }, record, undefined)
    })
  }

  async oauthStart(input: { commandId: string; connectorId: string; target: unknown }): Promise<ConnectorOAuthView> {
    const target = normalizeTarget(input.target)
    const connectorId = customId(input.connectorId)
    const catalog = this.entry(connectorId)
    if (!catalog || catalog.auth.kind !== 'oauth') {
      throw new CoreError('CONNECTOR_AUTH_UNSUPPORTED', 'This connector has no OAuth authorization flow.')
    }
    assertNonToolTarget(target, catalog.purpose ?? 'tool')
    if (!this.oauth || this.oauth.supports?.(connectorId) === false) {
      throw new CoreError('OAUTH_CLIENT_UNAVAILABLE', 'The registered OAuth client is not configured on this Host.')
    }
    const attemptId = await this.journal.run(input.commandId, ['oauth-start', connectorId, target], async () => {
      const started = await this.oauth!.start({ connectorId, scopes: catalog.auth.scopes ?? [] })
      const now = this.now()
      const attempt: ConnectorOAuthAttemptRecord = { id: started.attemptId, instanceId: this.instanceId,
        actorId: this.actorId, connectorId, target, status: 'pending', authorizationUrl: started.authorizationUrl,
        kind: started.kind, ...(started.userCode === undefined ? {} : { userCode: started.userCode }),
        ...(started.verificationUri === undefined ? {} : { verificationUri: started.verificationUri }),
        expiresAt: started.expiresAt, createdAt: now, updatedAt: now }
      await this.store.write(attemptCollection, attempt.id, attempt, attemptIndex(this.actorId, target))
      return attempt.id
    })
    const attempt = await this.store.read<ConnectorOAuthAttemptRecord>(attemptCollection, attemptId)
    if (!attempt) throw new CoreError('INCOMPLETE_STATE', 'The OAuth attempt was not saved.')
    return this.attemptView(attempt)
  }

  async oauthStatus(input: { attemptId: string; observeOnly?: boolean }): Promise<ConnectorOAuthView> {
    identifier(input.attemptId, 'attemptId')
    const attempt = await this.store.read<ConnectorOAuthAttemptRecord>(attemptCollection, input.attemptId)
    if (!attempt) throw new CoreError('NOT_FOUND', 'This OAuth attempt is unavailable.')
    if (attempt.actorId !== this.actorId || attempt.instanceId !== this.instanceId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This OAuth attempt belongs to another actor.')
    }
    if (input.observeOnly) return this.attemptView(attempt)
    if (attempt.status === 'pending' && this.oauth) {
      if (this.now() >= attempt.expiresAt) {
        await this.oauth.cancel(attempt.id).catch(() => {})
        const expired: ConnectorOAuthAttemptRecord = { ...attempt, status: 'error', errorCode: 'OAUTH_TIMEOUT',
          updatedAt: this.now() }
        await this.store.write(attemptCollection, attempt.id, expired)
        return this.attemptView(expired)
      }
      let status: ConnectorOAuthStatus
      try { status = await this.oauth.status(attempt.id) }
      catch { throw new CoreError('OAUTH_STATUS_FAILED', 'The OAuth status could not be read. Keep this attempt and try again.') }
      if (status.state === 'error' || status.state === 'cancelled') {
        const next: ConnectorOAuthAttemptRecord = { ...attempt, status: status.state === 'cancelled' ? 'cancelled' : 'error',
          ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }), updatedAt: this.now() }
        await this.store.write(attemptCollection, attempt.id, next)
        return this.attemptView(next)
      }
      if (status.state === 'completed') return this.finalizeOAuth(attempt)
    }
    return this.attemptView(attempt)
  }

  async oauthCancel(input: { commandId: string; attemptId: string }): Promise<ConnectorOAuthView> {
    identifier(input.attemptId, 'attemptId')
    return this.journal.run(input.commandId, ['oauth-cancel', input.attemptId], async () => {
      const attempt = await this.store.read<ConnectorOAuthAttemptRecord>(attemptCollection, input.attemptId)
      if (!attempt) throw new CoreError('NOT_FOUND', 'This OAuth attempt is unavailable.')
      if (attempt.actorId !== this.actorId || attempt.instanceId !== this.instanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This OAuth attempt belongs to another actor.')
      }
      await this.oauth?.cancel(attempt.id).catch(() => {})
      const next: ConnectorOAuthAttemptRecord = { ...attempt, status: 'cancelled', updatedAt: this.now() }
      await this.store.write(attemptCollection, attempt.id, next)
      return this.attemptView(next)
    })
  }

  private finalizeOAuth(attempt: ConnectorOAuthAttemptRecord): Promise<ConnectorOAuthView> {
    const active = this.oauthFlights.get(attempt.id)
    if (active) return active
    const flight = this.finalizeOAuthOne(attempt)
    this.oauthFlights.set(attempt.id, flight)
    return flight.finally(() => { if (this.oauthFlights.get(attempt.id) === flight) this.oauthFlights.delete(attempt.id) })
  }

  private async finalizeOAuthOne(attempt: ConnectorOAuthAttemptRecord): Promise<ConnectorOAuthView> {
    if (attempt.resourceId) return this.attemptView(attempt)
    if (!this.oauth) throw new CoreError('CONNECTOR_OAUTH_UNAVAILABLE', 'OAuth is not connected in this Host.')
    const catalog = this.entry(attempt.connectorId)
    if (!catalog) throw new CoreError('NOT_FOUND', 'The OAuth connector is no longer registered.')
    const secret = await this.oauth.credential(attempt.id)
    const existing = await this.binding(attempt.connectorId, attempt.target)
    const registration = existing?.registration ?? registrationOf(catalog)
    const purpose = purposeOf(registration, catalog)
    const saved = await saveProductCredential({ credentials: this.credentials, instanceId: this.instanceId,
      commandId: requestCommandId('oauth', [attempt.id]),
      label: `Connector: ${registration.name}`, value: secret.value, target: attempt.target, purpose,
      ...(existing?.credential && existing.credential.kind !== 'linked' ? { existing: {
        resourceId: existing.credential.resourceId,
        ...(existing.credential.grantId === undefined ? {} : { grantId: existing.credential.grantId }),
      } } : {}) })
    const now = this.now()
    const binding: ConnectorBindingRecord = { instanceId: this.instanceId, actorId: this.actorId,
      connectorId: attempt.connectorId, target: attempt.target, custom: existing?.custom ?? false, registration,
      credential: { kind: 'oauth', resourceId: saved.resourceId,
        ...(saved.grantId === undefined ? {} : { grantId: saved.grantId }), purpose,
        ...(secret.account === undefined ? {} : { account: secret.account }),
        ...(secret.expiresAt === undefined ? {} : { expiresAt: secret.expiresAt }) },
      revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now }
    await this.store.write(bindingCollection, bindingId(this.actorId, binding.connectorId, binding.target), binding,
      bindingIndex(this.actorId, attempt.target))
    const completed: ConnectorOAuthAttemptRecord = { ...attempt, status: 'completed',
      resourceId: saved.resourceId, ...(secret.account === undefined ? {} : { account: secret.account }),
      updatedAt: now }
    await this.store.write(attemptCollection, completed.id, completed)
    await this.oauth.finish(attempt.id).catch(() => {})
    return this.attemptView(completed)
  }

  private attemptView(attempt: ConnectorOAuthAttemptRecord): ConnectorOAuthView {
    return { attemptId: attempt.id, connectorId: attempt.connectorId, state: attempt.status,
      kind: attempt.kind, authorizationUrl: attempt.authorizationUrl, expiresAt: attempt.expiresAt,
      ...(attempt.userCode === undefined ? {} : { userCode: attempt.userCode }),
      ...(attempt.verificationUri === undefined ? {} : { verificationUri: attempt.verificationUri }),
      ...(attempt.account === undefined ? {} : { account: attempt.account }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }) }
  }

  async importScan(): Promise<ConnectorImportCandidate[]> {
    if (!this.imports) throw new CoreError('CONNECTOR_IMPORT_UNAVAILABLE',
      'Connector import is not connected in this Host.')
    const sources = await this.imports.scan()
    if (!Array.isArray(sources) || sources.length > 100) throw new CoreError('CONNECTOR_IMPORT_INVALID',
      'The connector import source returned an invalid list.')
    return sources.map(source => ({ id: text(source.id, 'Import source ID', 256), name: text(source.name, 'Import name', 128),
      source: text(source.source, 'Import source', 256), transport: source.transport === 'stdio' ? 'stdio' : 'http',
      envNames: Array.isArray(source.envNames) ? source.envNames.slice(0, 64).map(name => text(name, 'Env name', 128)) : [],
      headerNames: Array.isArray(source.headerNames) ? source.headerNames.slice(0, 64).map(name => text(name, 'Header name', 128)) : [] }))
  }

  async importCommit(input: { commandId: string; sourceId: string; name?: string; target: unknown }): Promise<ConnectorSettingsView> {
    if (!this.imports) throw new CoreError('CONNECTOR_IMPORT_UNAVAILABLE',
      'Connector import is not connected in this Host.')
    const target = normalizeTarget(input.target)
    identifier(input.sourceId, 'sourceId')
    return this.journal.run(input.commandId, ['import', input.sourceId, input.name, target], async () => {
      let config: ConnectorImportConfig
      try { config = await this.imports!.read(input.sourceId) }
      catch { throw new CoreError('CONNECTOR_IMPORT_FAILED', 'The selected connector configuration could not be read.') }
      const name = text(input.name ?? config.name, 'Connector name', 128)
      const taken = new Set([...this.catalog.map(entry => entry.id), ...(await this.bindings(target)).map(binding => binding.connectorId)])
      const connectorId = config.id === undefined ? customConnectorId(name, taken) : customId(config.id)
      if (this.entry(connectorId)) throw new CoreError('IDENTITY_CONFLICT', 'The imported connector ID belongs to the catalog.')
      const url = config.url === undefined ? undefined : secureAddress(config.url)
      const command = config.command === undefined ? undefined : text(config.command, 'Connector command', 2048)
      const commandArgs = args(config.args)
      if (url !== undefined && command !== undefined) throw new CoreError('CONNECTOR_IMPORT_INVALID',
        'The imported connector has both an address and a command.')
      if (url === undefined && command === undefined) throw new CoreError('CONNECTOR_IMPORT_INVALID',
        'The imported connector has neither an address nor a command.')
      if (commandArgs !== undefined && command === undefined) throw new CoreError('CONNECTOR_IMPORT_INVALID',
        'The imported connector has arguments without a command.')
      const slots: Array<{ slot: string; value: string }> = []
      for (const [name, value] of Object.entries(config.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new CoreError('CONNECTOR_IMPORT_INVALID', 'An imported environment name is invalid.')
        slots.push({ slot: `env:${name}`, value: text(value, `Imported ${name}`, 16384) })
      }
      for (const [name, value] of Object.entries(config.headers ?? {})) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw new CoreError('CONNECTOR_IMPORT_INVALID', 'An imported header name is invalid.')
        slots.push({ slot: `header:${name}`, value: text(value, `Imported header ${name}`, 16384) })
      }
      if (slots.length > 64) throw new CoreError('CONNECTOR_IMPORT_INVALID', 'An imported connector has too many secrets.')
      const secretRefs: NonNullable<ConnectorRegistration['secretRefs']> = []
      const created: string[] = []
      try {
        for (const slot of slots) {
          const saved = await saveProductCredential({ credentials: this.credentials, instanceId: this.instanceId,
            commandId: requestCommandId('import', [input.sourceId, slot.slot]), label: `${name}: ${slot.slot}`,
            value: slot.value, target, purpose: 'tool' })
          created.push(saved.resourceId)
          secretRefs.push({ slot: slot.slot, resourceId: saved.resourceId,
            ...(saved.grantId === undefined ? {} : { grantId: saved.grantId }) })
        }
      } catch (error) {
        await Promise.all(created.map(resourceId => deleteProductCredential(this.credentials, this.instanceId,
          requestCommandId('import-cleanup', [input.sourceId, resourceId]), resourceId).catch(() => {})))
        throw error
      }
      const existing = await this.binding(connectorId, target)
      const registration: ConnectorRegistration = { name, category: 'custom',
        about: 'Imported from an MCP client configuration',
        ...(url === undefined ? {} : { remoteUrl: url }),
        ...(command === undefined ? {} : { command }),
        ...(commandArgs === undefined ? {} : { args: commandArgs }),
        readOnly: false, auth: secretRefs.length > 0 ? { kind: 'token' } : { kind: 'none' },
        ...(secretRefs.length === 0 ? {} : { secretRefs }) }
      const now = this.now()
      const record: ConnectorBindingRecord = { instanceId: this.instanceId, actorId: this.actorId, connectorId,
        target, custom: true, registration, revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now, updatedAt: now }
      await this.store.write(bindingCollection, bindingId(this.actorId, connectorId, target), record, bindingIndex(this.actorId, target))
      const currentRefs = new Set(secretRefs.map(ref => ref.resourceId))
      await Promise.all((existing?.registration.secretRefs ?? []).filter(ref => !currentRefs.has(ref.resourceId))
        .map(ref => deleteProductCredential(this.credentials, this.instanceId,
          requestCommandId('import-replace', [connectorId, ref.resourceId]), ref.resourceId).catch(() => {})))
      return this.view({ id: connectorId, name, category: 'custom', about: registration.about,
        ...(url === undefined ? {} : { remoteUrl: url }), auth: registration.auth }, record, undefined)
    })
  }

  async disconnect(input: { commandId: string; connectorId: string; target: unknown }): Promise<ConnectorSettingsView> {
    const target = normalizeTarget(input.target)
    const connectorId = customId(input.connectorId)
    return this.journal.run(input.commandId, ['disconnect', connectorId, target], async () => {
      const [existing, catalog] = await Promise.all([this.binding(connectorId, target), Promise.resolve(this.entry(connectorId))])
      if (!existing) {
        if (!catalog) throw new CoreError('NOT_FOUND', 'The connector is not registered.')
        return this.view(catalog, undefined, undefined)
      }
      if (!existing.credential && (existing.registration.secretRefs?.length ?? 0) === 0) {
        const entry = catalog ?? { id: connectorId, name: existing.registration.name,
          category: existing.registration.category, about: existing.registration.about,
          ...(existing.registration.remoteUrl === undefined ? {} : { remoteUrl: existing.registration.remoteUrl }),
          auth: existing.registration.auth }
        await this.store.delete(bindingCollection, bindingId(this.actorId, connectorId, target),
          bindingIndex(this.actorId, target))
        return this.view(entry, undefined, undefined)
      }
      if (existing.credential && existing.credential.kind !== 'linked') {
        await deleteProductCredential(this.credentials, this.instanceId,
          requestCommandId('disconnect', [connectorId, existing.credential.resourceId]), existing.credential.resourceId)
      }
      const { credential: _credential, errorCode: _errorCode, ...rest } = existing
      const next: ConnectorBindingRecord = { ...rest, revision: existing.revision + 1, updatedAt: this.now() }
      await this.store.write(bindingCollection, bindingId(this.actorId, connectorId, target), next, bindingIndex(this.actorId, target))
      const entry = catalog ?? { id: connectorId, name: next.registration.name, category: next.registration.category,
        about: next.registration.about, ...(next.registration.remoteUrl === undefined ? {} : { remoteUrl: next.registration.remoteUrl }),
        auth: next.registration.auth }
      return this.view(entry, next, undefined)
    })
  }

  async remove(input: { commandId: string; connectorId: string; target: unknown }): Promise<{ connectorId: string; removed: true }> {
    const target = normalizeTarget(input.target)
    const connectorId = customId(input.connectorId)
    return this.journal.run(input.commandId, ['remove', connectorId, target], async () => {
      const existing = await this.binding(connectorId, target)
      if (!existing) throw new CoreError('NOT_FOUND', 'The custom connector is unavailable.')
      if (!existing.custom || this.entry(connectorId)) throw new CoreError('INVALID_INPUT', 'Catalog connectors cannot be removed.')
      if (existing.credential && existing.credential.kind !== 'linked') {
        await deleteProductCredential(this.credentials, this.instanceId,
          requestCommandId('remove', [connectorId, existing.credential.resourceId]), existing.credential.resourceId)
      }
      for (const ref of existing.registration.secretRefs ?? []) {
        await deleteProductCredential(this.credentials, this.instanceId,
          requestCommandId('remove-import', [connectorId, ref.resourceId]), ref.resourceId).catch(() => {})
      }
      for (const attempt of await this.attempts(target)) {
        if (attempt.connectorId !== connectorId) continue
        if (attempt.status === 'pending') await this.oauth?.cancel(attempt.id).catch(() => {})
        await this.store.delete(attemptCollection, attempt.id, attemptIndex(this.actorId, target))
      }
      await this.store.delete(bindingCollection, bindingId(this.actorId, connectorId, target), bindingIndex(this.actorId, target))
      return { connectorId, removed: true as const }
    })
  }

  close(): Promise<void> {
    return this.oauth?.close() ?? Promise.resolve()
  }
}

export function createConnectorService(options: ConnectorServiceOptions): ConnectorService {
  return new ConnectorService(options)
}
