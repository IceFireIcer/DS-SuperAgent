import { createHash, randomUUID } from 'node:crypto'
import type { ClientIdentity } from '../client-access.js'
import { canonicalJson, commandTransaction } from '../commands.js'
import { CoreError } from '../model.js'
import type { CredentialImportAdapter } from '../product-credential-imports.js'
import { ProductCredentialVault, assertCredentialValue, type ProductCredentialRecords } from '../product-credential-vault.js'
import type { AsyncTx, Storage } from '../storage.js'
import { publicMailboxTransport, type MailboxTransport, type ReceivedMail } from './mail-transport.js'
import { ConnectorOAuth, verifyConnectorToken, type ConnectorBinding, type OAuthOptions } from './oauth.js'
import { connectorFields, displayText, inputId, mainScope, providerId, revision, strictFields, textValue,
  type ConnectorAuthorizationRequest, type ConnectorProvider, type ConnectorSourceBindings, type ConnectorView,
  type MailboxAccount, type MailboxMessage, type MailboxRule, type RepositoryAccess } from './protocol.js'

export { connectorFields }
export type { ConnectorAuthorizationRequest, ConnectorSourceBindings }

export interface ProductConnectorOptions {
  oauth?: OAuthOptions
  mailbox?: MailboxTransport
}

export interface ProductConnectorHostOptions extends ProductConnectorOptions {
  storage: Storage
  instanceId: string
  records?: ProductCredentialRecords
  importAdapter?: CredentialImportAdapter
  sources?: ConnectorSourceBindings
}

interface StoredConnector {
  revision: number
  clientId: string | null
  clientSecretReference: string | null
  repositoryAccess?: RepositoryAccess
  grant: { reference: string; method: 'oauth' | 'imported'; authorizedAt: number; expiresAt: number | null; binding?: ConnectorBinding | null } | null
}

interface StoredAccount extends MailboxAccount { reference: string }
interface ConnectorState {
  connectors: Record<ConnectorProvider, StoredConnector>
  accounts: StoredAccount[]
  rules: MailboxRule[]
}

interface CommandReceipt<Result> { fingerprint: string; result: Result; secretReference?: string }
interface ReplyReceipt { fingerprint: string; status: 'unknown' | 'sent' }
interface ReplyTarget { accountId: string; revision: number; messageId: string; to: string; subject: string; expiresAt: number }

const emptyConnector = (): StoredConnector => ({ revision: 0, clientId: null, clientSecretReference: null, grant: null })
const emptyState = (): ConnectorState => ({ connectors: { github: emptyConnector(), feishu: emptyConnector() }, accounts: [], rules: [] })
const accountView = ({ reference: _reference, ...view }: StoredAccount): MailboxAccount => view
const stateId = 'main'
const stateKind = 'product-connectors-state'
const commandKind = 'product-connectors-command'
const replyKind = 'product-mailbox-reply'
const fieldMismatch = () => new CoreError('CONFIG_REVISION_CONFLICT', 'The settings changed. Reload them before saving again.')
const commandConflict = () => new CoreError('IDENTITY_CONFLICT', 'This command ID was used for different settings.')
const mailboxMissing = () => new CoreError('MAILBOX_NOT_FOUND', 'The selected mailbox account is unavailable.')
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const replyUnknown = () => new CoreError('MAILBOX_REPLY_UNKNOWN', 'Delivery could not be confirmed. Check Sent mail before starting another reply.')

function accountOf(state: ConnectorState, accountId: string) {
  const account = state.accounts.find(item => item.id === accountId)
  if (!account) throw mailboxMissing()
  return account
}

function emailAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 254
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu.test(value)) return null
  return value
}

function hostField(value: unknown) {
  const name = textValue(value, 'the mail server hostname', 253).toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(name)
    || !/[a-z]$/u.test(name)) throw new CoreError('INVALID_INPUT', 'Enter a mail server hostname.')
  return name
}

function portOf(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CoreError('INVALID_INPUT', 'Choose a valid mail server port.')
  }
  return value
}

function parseAccount(raw: unknown) {
  const value = strictFields(raw, ['label', 'email', 'username', 'incoming', 'outgoing'])
  const incoming = strictFields(value.incoming, ['host', 'port'])
  const outgoing = strictFields(value.outgoing, ['host', 'port', 'security'])
  const email = emailAddress(value.email)
  if (!email || outgoing.security !== 'tls' && outgoing.security !== 'starttls') {
    throw new CoreError('INVALID_INPUT', 'Enter an email address and choose TLS or STARTTLS for outgoing mail.')
  }
  const security: MailboxAccount['outgoing']['security'] = outgoing.security
  return { label: textValue(value.label, 'the mailbox name', 100), email, username: textValue(value.username, 'the username', 254),
    incoming: { host: hostField(incoming.host), port: portOf(incoming.port) },
    outgoing: { host: hostField(outgoing.host), port: portOf(outgoing.port), security } }
}

function parseRule(raw: unknown) {
  const rule = strictFields(raw, ['label', 'sender', 'subjectContains', 'enabled'])
  const sender = textValue(rule.sender, 'the rule sender', 254, true).toLowerCase()
  const subjectContains = textValue(rule.subjectContains, 'the subject filter', 200, true)
  if (sender && !emailAddress(sender) || !sender && !subjectContains || typeof rule.enabled !== 'boolean') {
    throw new CoreError('INVALID_INPUT', 'Enter a sender or subject filter and choose whether the rule is active.')
  }
  return { label: textValue(rule.label, 'the rule name', 100), sender, subjectContains, enabled: rule.enabled }
}

function actionFields(input: Record<string, unknown>, fields: ReadonlyArray<string>) {
  strictFields(input, ['instanceId', 'scope', 'action', ...fields])
}

export function isConnectorRead(endpoint: string, action: unknown) {
  return endpoint === 'connector-registry' || endpoint === 'connector-auth' && action === 'status'
    || (endpoint === 'mailbox-account' || endpoint === 'mailbox-rule') && action === 'list'
}

function optionalRepositoryAccess(value: unknown): RepositoryAccess | undefined {
  if (value === undefined || value === 'public' || value === 'private') return value
  throw new CoreError('INVALID_INPUT', 'Choose public or private GitHub repository access.')
}

export class ProductConnectors {
  private readonly oauth: ConnectorOAuth
  private readonly vault: ProductCredentialVault | undefined
  private readonly transport: MailboxTransport
  private readonly shutdown = new AbortController()
  private readonly mailboxOperations = new Set<string>()
  private readonly replyTargets = new Map<string, ReplyTarget>()
  private readonly operations = new Set<Promise<unknown>>()

  constructor(private readonly options: ProductConnectorHostOptions) {
    this.oauth = new ConnectorOAuth(options.oauth)
    this.transport = options.mailbox ?? publicMailboxTransport
    this.vault = options.records ? new ProductCredentialVault(options.records) : undefined
  }

  async close() {
    this.oauth.close()
    this.shutdown.abort()
    await Promise.allSettled(this.operations)
    this.replyTargets.clear()
  }

  async dispatch(endpoint: string, payload: Record<string, unknown>, client?: ClientIdentity) {
    if (this.shutdown.signal.aborted) throw new CoreError('RUNTIME_CLOSED', 'The product Host is closed.')
    if (payload.instanceId !== this.options.instanceId || client && (client.revokedAt !== undefined || !isConnectorRead(endpoint, payload.action)
      || !client.grants.some(grant => grant.instanceId === this.options.instanceId && grant.capabilities.includes('read')))) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Connectors and mailboxes require the local authorized product settings.')
    }
    if (!Object.hasOwn(connectorFields, endpoint)) throw new CoreError('UNAVAILABLE', 'The requested connector capability is unavailable.')
    strictFields(payload, connectorFields[endpoint]!)
    mainScope(payload.scope)
    return this.track(this.route(endpoint, payload, Boolean(client)))
  }

  private async route(endpoint: string, payload: Record<string, unknown>, remote: boolean) {
    switch (endpoint) {
      case 'connector-registry': {
        const { connectors } = await this.readState()
        const items = await Promise.all((['github', 'feishu'] as const).map(provider => this.connectorView(provider, connectors[provider])))
        const login = this.oauth.current()
        return { items: remote ? items.map(item => ({ ...item, clientId: null, hasClientSecret: false, redirectUri: null, repository: null })) : items,
          canStoreCredentials: !remote && Boolean(this.vault), canImport: !remote && Boolean(this.vault && this.options.importAdapter),
          login: remote && login ? { loginId: login.loginId, state: login.state } : login, ...(remote ? { readOnly: true } : {}) }
      }
      case 'connector-save': return this.saveConnector(payload)
      case 'connector-auth': return this.authorizeConnector(payload, remote)
      case 'connector-import': return this.importConnector(payload)
      case 'mailbox-account': return this.mailboxAccount(payload, remote)
      case 'mailbox-rule': return this.mailboxRule(payload, remote)
      case 'mailbox-reply': return this.mailboxReply(payload)
    }
  }

  private track<Result>(operation: Promise<Result>) {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  private vaultAccess() {
    if (!this.vault) throw new CoreError('CONNECTOR_VAULT_UNAVAILABLE', 'This Host has no secure credential store.')
    return this.vault
  }

  private async readState() {
    return this.options.storage.transaction(this.options.instanceId, tx => this.readStateIn(tx))
  }

  private async readStateIn(tx: AsyncTx) { return await tx.get<ConnectorState>(stateKind, stateId) ?? emptyState() }

  private activeAuthorization(state: ConnectorState, request: ConnectorAuthorizationRequest) {
    const current = state.connectors[request.provider]
    const grant = current.grant
    if (!grant || !grant.binding || grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
      throw new CoreError('RESOURCE_UNAVAILABLE', 'Authorize this configured source in Connectors settings.')
    }
    const binding = grant.binding
    if (request.provider === 'github') {
      const expected = this.options.sources?.github
      if (binding.provider !== 'github' || expected?.owner !== request.owner || expected.repo !== request.repo
        || binding.owner !== request.owner || binding.repo !== request.repo || binding.access !== (current.repositoryAccess ?? 'public')) {
        throw new CoreError('GRANT_DENIED', 'The GitHub grant is outside the authorized repository scope.')
      }
      return { revision: current.revision, tokenReference: grant.reference, capabilityReference: grant.reference }
    }
    const expected = this.options.sources?.feishu
    if (binding.provider !== 'feishu' || grant.method !== 'oauth' || expected?.appId !== request.appId || expected.tenantKey !== request.tenantKey
      || binding.appId !== request.appId || binding.tenantKey !== request.tenantKey || current.clientId !== request.appId
      || !current.clientSecretReference) {
      throw new CoreError('GRANT_DENIED', 'The Feishu grant is outside the authorized app and tenant scope.')
    }
    return { revision: current.revision, tokenReference: grant.reference, capabilityReference: current.clientSecretReference }
  }

  async assertAuthorizationIn(tx: AsyncTx, request: ConnectorAuthorizationRequest) {
    if (tx.instanceId !== this.options.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The transaction is outside the connector Instance.')
    const access = this.activeAuthorization(await this.readStateIn(tx), request)
    const vault = this.vaultAccess()
    await vault.assertReference(this.options.instanceId, access.tokenReference)
    if (access.capabilityReference !== access.tokenReference) await vault.assertReference(this.options.instanceId, access.capabilityReference)
  }

  async withAuthorization<Result>(request: ConnectorAuthorizationRequest, consume: (credential: string) => Promise<Result>) {
    const initial = this.activeAuthorization(await this.readState(), request)
    const vault = this.vaultAccess()
    if (initial.capabilityReference !== initial.tokenReference) await vault.assertReference(this.options.instanceId, initial.tokenReference)
    const result = await vault.withSecret(this.options.instanceId, initial.capabilityReference, async credential => {
      const current = this.activeAuthorization(await this.readState(), request)
      if (current.revision !== initial.revision || current.capabilityReference !== initial.capabilityReference
        || current.tokenReference !== initial.tokenReference) return { stale: true as const }
      this.shutdown.signal.throwIfAborted()
      return { stale: false as const, value: await consume(credential) }
    })
    if (result.stale) throw new CoreError('RESOURCE_STALE', 'The connector authorization changed. Try the current source again.')
    return result.value
  }

  private binding(provider: ConnectorProvider, current: StoredConnector, importing = false): ConnectorBinding | null {
    const github = this.options.sources?.github
    if (provider === 'github' && github) return { provider, ...github, access: current.repositoryAccess ?? 'public' }
    const feishu = this.options.sources?.feishu
    if (provider === 'feishu' && !importing && feishu && current.clientId === feishu.appId) return { provider, ...feishu }
    return null
  }

  private async storeState(tx: AsyncTx, state: ConnectorState) {
    if (!await tx.replace(stateKind, stateId, state)) await tx.insert(stateKind, stateId, state)
  }

  private async change<Result>(input: Record<string, unknown>, fingerprint: string, secret: string | undefined,
    apply: (state: ConnectorState, key: string) => Promise<{ result: Result; secretReference?: string; cleanup?: (string | null)[] }>) {
    const commandId = inputId(input.commandId, 'commandId')
    const outcome = await commandTransaction(this.options.storage, this.options.instanceId, async tx => {
      const existing = await tx.get<CommandReceipt<Result>>(commandKind, commandId)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw commandConflict()
        if (secret !== undefined) {
          if (!existing.secretReference) throw commandConflict()
          const same = await this.vaultAccess().withSecret(this.options.instanceId, existing.secretReference, async value => value === secret)
          if (!same) throw commandConflict()
        }
        return { result: existing.result }
      }
      this.shutdown.signal.throwIfAborted()
      const state = await tx.get<ConnectorState>(stateKind, stateId) ?? emptyState()
      const updated = await apply(state, `connector:${digest(commandId)}`)
      await this.storeState(tx, state)
      await tx.insert(commandKind, commandId, { fingerprint, result: updated.result,
        ...(updated.secretReference ? { secretReference: updated.secretReference } : {}) })
      return updated
    })
    if ('cleanup' in outcome) await this.removeSecrets(outcome.cleanup)
    return outcome.result
  }

  private async removeSecrets(references: (string | null)[] | undefined) {
    if (!this.vault) return
    for (const reference of references ?? []) {
      if (reference) await this.vault.ensureRevoked(this.options.instanceId, reference).catch(() => {})
    }
  }

  private async storeSecret(secret: string, key: string, signal = this.shutdown.signal) {
    signal.throwIfAborted()
    const reference = await this.vaultAccess().create(this.options.instanceId, secret, key)
    if (signal.aborted) {
      await this.removeSecrets([reference])
      signal.throwIfAborted()
    }
    return reference
  }

  private async connectorView(provider: ConnectorProvider, connector: StoredConnector): Promise<ConnectorView> {
    let state: ConnectorView['state'] = connector.clientId ? 'configured' : 'not-configured'
    if (connector.grant) {
      state = connector.grant.expiresAt !== null && connector.grant.expiresAt <= Date.now() ? 'expired' : 'authorized'
    }
    const references = [connector.clientSecretReference, connector.grant?.reference].filter((value): value is string => Boolean(value))
    for (const reference of references) {
      try { await this.vaultAccess().assertReference(this.options.instanceId, reference) }
      catch { state = 'credential-unavailable'; break }
    }
    return { provider, revision: connector.revision, clientId: connector.clientId, hasClientSecret: Boolean(connector.clientSecretReference),
      state, authorization: connector.grant?.method ?? null, authorizedAt: connector.grant?.authorizedAt ?? null,
      redirectUri: this.oauth.redirectUri, repository: provider === 'github' && this.options.sources?.github
        ? `${this.options.sources.github.owner}/${this.options.sources.github.repo}` : null,
      repositoryAccess: provider === 'github' ? connector.repositoryAccess ?? 'public' : null,
      sourceConfigured: Boolean(this.options.sources?.[provider]) }
  }

  private async saveConnector(input: Record<string, unknown>) {
    const provider = providerId(input.provider)
    const expected = revision(input.expectedRevision)
    const clientId = textValue(input.clientId, 'the OAuth client ID', 160)
    if (!/^[a-z0-9_-]+$/iu.test(clientId)) throw new CoreError('INVALID_INPUT', 'Enter a valid OAuth client ID.')
    const secret = input.clientSecret
    const access = optionalRepositoryAccess(input.repositoryAccess)
    if (provider !== 'github' && access !== undefined) throw new CoreError('INVALID_INPUT', 'Repository access belongs to GitHub.')
    if (secret !== undefined) assertCredentialValue(secret)
    const fingerprint = digest(['save-connector', provider, expected, clientId, secret !== undefined, access ?? null])
    return this.change(input, fingerprint, secret, async (state, key) => {
      const current = state.connectors[provider]
      if (current.revision !== expected) throw fieldMismatch()
      if (secret === undefined && (current.clientId !== clientId || !current.clientSecretReference)) {
        throw new CoreError('INVALID_INPUT', 'Enter the OAuth client secret for this app.')
      }
      const reference = secret === undefined ? current.clientSecretReference!
        : await this.storeSecret(secret, key)
      const previousAccess = current.repositoryAccess ?? 'public'
      const repositoryAccess = access ?? previousAccess
      const retainsGrant = secret === undefined && repositoryAccess === previousAccess
      const updated: StoredConnector = { revision: expected + 1, clientId, clientSecretReference: reference,
        ...(provider === 'github' ? { repositoryAccess } : {}), grant: retainsGrant ? current.grant : null }
      state.connectors[provider] = updated
      return { result: await this.connectorView(provider, updated),
        ...(secret === undefined ? {} : { secretReference: reference }),
        ...(!retainsGrant ? { cleanup: [secret === undefined ? null : current.clientSecretReference, current.grant?.reference ?? null] } : {}) }
    })
  }

  private async authorizeConnector(input: Record<string, unknown>, remote: boolean) {
    const provider = providerId(input.provider)
    if (input.action === 'status' || input.action === 'cancel') {
      actionFields(input, ['provider', 'loginId'])
      const loginId = inputId(input.loginId, 'loginId')
      const login = input.action === 'status' ? this.oauth.status(provider, loginId) : this.oauth.cancel(provider, loginId)
      return remote ? { loginId: login.loginId, state: login.state } : login
    }
    if (input.action === 'disconnect') {
      actionFields(input, ['provider', 'commandId', 'expectedRevision'])
      const expected = revision(input.expectedRevision)
      return this.change(input, digest(['disconnect-connector', provider, expected]), undefined, async state => {
        const current = state.connectors[provider]
        if (expected !== current.revision) throw fieldMismatch()
        const next = { ...current, revision: expected + 1, grant: null }
        state.connectors[provider] = next
        return { result: await this.connectorView(provider, next), cleanup: [current.grant?.reference ?? null] }
      })
    }
    if (input.action !== 'start') throw new CoreError('INVALID_INPUT', 'Choose an authorization action.')
    actionFields(input, ['provider'])
    const current = (await this.readState()).connectors[provider]
    if (!current.clientId || !current.clientSecretReference) throw new CoreError('CONNECTOR_NOT_CONFIGURED', 'Save the OAuth app before authorizing it.')
    const clientId = current.clientId
    const vault = this.vaultAccess()
    const result = await vault.withSecret(this.options.instanceId, current.clientSecretReference, async clientSecret => {
      try {
        const login = await this.oauth.start({ provider, clientId, clientSecret, binding: this.binding(provider, current), authorized: (grant, signal) => this.track(
          this.installGrant({ provider, expected: current.revision, commandId: `oauth:${randomUUID()}`, method: 'oauth',
            token: grant.accessToken, expiresAt: grant.expiresAt, binding: grant.binding, signal })) })
        return { login }
      } catch (error) {
        return { error }
      }
    })
    if (result.error) throw result.error
    return result.login
  }

  private async installGrant(input: { provider: ConnectorProvider; expected: number; commandId: string; method: 'oauth' | 'imported';
    token: string; expiresAt: number | null; binding: ConnectorBinding | null; signal: AbortSignal }) {
    await this.change({ commandId: input.commandId }, digest(['grant', input.provider, input.expected, input.method]), input.token, async (state, key) => {
      input.signal.throwIfAborted()
      const connector = state.connectors[input.provider]
      if (connector.revision !== input.expected) throw fieldMismatch()
      const reference = await this.storeSecret(input.token, key, input.signal)
      const grant = { method: input.method, authorizedAt: Date.now(), expiresAt: input.expiresAt, reference, binding: input.binding }
      state.connectors[input.provider] = { ...connector, revision: connector.revision + 1, grant }
      return { result: { accepted: true }, secretReference: reference, cleanup: [connector.grant?.reference ?? null] }
    })
  }

  private async importConnector(input: Record<string, unknown>) {
    const provider = providerId(input.provider)
    const expected = revision(input.expectedRevision)
    const adapter = this.options.importAdapter
    if (!adapter) throw new CoreError('CONNECTOR_IMPORT_UNAVAILABLE', 'Connector import requires the desktop credential export picker.')
    this.vaultAccess()
    const pendingId = inputId(input.pendingId, 'pendingId')
    const credentialId = inputId(input.credentialId, 'credentialId')
    const sourceRef = inputId(input.sourceRef, 'sourceRef')
    const commandId = inputId(input.commandId, 'commandId')
    const fingerprint = digest(['connector-import', provider, expected, pendingId, credentialId, sourceRef])
    const prior = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<CommandReceipt<ConnectorView>>(commandKind, commandId))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw commandConflict()
      return prior.result
    }
    const snapshot = (await this.readState()).connectors[provider]
    if (snapshot.revision !== expected) throw fieldMismatch()
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)])
    let token: string
    let binding: ConnectorBinding | null
    try {
      const selected = await adapter.read(pendingId, credentialId, sourceRef)
      if (selected.id !== credentialId || selected.sourceRef !== sourceRef) throw new Error('The imported item changed.')
      token = selected.value
      binding = await verifyConnectorToken(provider, token, this.options.oauth?.fetch ?? globalThis.fetch, signal,
        this.binding(provider, snapshot, true))
    } catch (error) {
      if (error instanceof CoreError && error.code === 'CONNECTOR_SCOPE_DENIED') throw error
      throw new CoreError('CONNECTOR_IMPORT_FAILED', 'The provider could not verify the selected credential.')
    }
    const result = await this.change(input, fingerprint, token, async (state, key) => {
      signal.throwIfAborted()
      const current = state.connectors[provider]
      if (expected !== current.revision) throw fieldMismatch()
      const reference = await this.storeSecret(token, key, signal)
      const updated: StoredConnector = { ...current, revision: expected + 1,
        grant: { reference, method: 'imported', authorizedAt: Date.now(), expiresAt: null, binding } }
      state.connectors[provider] = updated
      return { result: await this.connectorView(provider, updated), secretReference: reference, cleanup: [current.grant?.reference ?? null] }
    })
    await adapter.finish?.(pendingId, sourceRef).catch(() => {})
    return result
  }

  private async mailboxAccount(input: Record<string, unknown>, remote: boolean) {
    if (input.action === 'list') {
      actionFields(input, [])
      const state = await this.readState()
      return { items: remote ? state.accounts.map(account => ({ id: account.id, label: account.label, revision: account.revision }))
        : state.accounts.map(accountView), canStoreCredentials: !remote && Boolean(this.vault), ...(remote ? { readOnly: true } : {}) }
    }
    if (input.action === 'check') {
      actionFields(input, ['accountId'])
      const accountId = inputId(input.accountId, 'accountId')
      return this.withMailbox(accountId, async (account, password, signal) => {
        await this.transport.verify(account, password, signal)
        return { verified: true }
      })
    }
    if (input.action === 'remove') {
      actionFields(input, ['commandId', 'accountId', 'expectedRevision'])
      const accountId = inputId(input.accountId, 'accountId')
      const expected = revision(input.expectedRevision)
      return this.change(input, digest(['mailbox-remove', accountId, expected]), undefined, async state => {
        const account = accountOf(state, accountId)
        this.assertMailboxIdle(accountId)
        if (account.revision !== expected) throw fieldMismatch()
        state.accounts = state.accounts.filter(item => item.id !== accountId)
        state.rules = state.rules.filter(rule => rule.accountId !== accountId)
        return { result: { id: accountId, removed: true }, cleanup: [account.reference] }
      })
    }
    if (input.action !== 'save') throw new CoreError('INVALID_INPUT', 'Choose a mailbox account action.')
    actionFields(input, ['commandId', 'accountId', 'expectedRevision', 'account', 'password'])
    const accountId = input.accountId === undefined ? null : inputId(input.accountId, 'accountId')
    const expected = revision(input.expectedRevision)
    const account = parseAccount(input.account)
    const password = input.password
    if (password !== undefined) assertCredentialValue(password)
    return this.change(input, digest(['mailbox-save', accountId, expected, account, password !== undefined]), password, async (state, key) => {
      const current = accountId ? accountOf(state, accountId) : null
      if (accountId) this.assertMailboxIdle(accountId)
      if (expected !== (current?.revision ?? 0)) throw fieldMismatch()
      if (!current && state.accounts.length >= 20) throw new CoreError('MAILBOX_LIMIT', 'Remove a mailbox before adding another one.')
      if (password === undefined && (!current || digest({ ...account, label: current.label }) !== digest({
        label: current.label, email: current.email, username: current.username, incoming: current.incoming, outgoing: current.outgoing,
      }))) throw new CoreError('INVALID_INPUT', 'Enter the mailbox password for these server settings.')
      const reference = password === undefined ? current!.reference : await this.storeSecret(password, key)
      const updated: StoredAccount = { ...account, id: accountId ?? randomUUID(), revision: expected + 1, reference }
      state.accounts = [...state.accounts.filter(item => item.id !== accountId), updated]
      return { result: accountView(updated), ...(password === undefined ? {} : { secretReference: reference, cleanup: [current?.reference ?? null] }) }
    })
  }

  private async mailboxRule(input: Record<string, unknown>, remote: boolean) {
    const accountId = inputId(input.accountId, 'accountId')
    if (input.action === 'list') {
      actionFields(input, ['accountId'])
      const state = await this.readState()
      accountOf(state, accountId)
      const items = state.rules.filter(rule => rule.accountId === accountId)
      return { items: remote ? items.map(({ id, label, revision, enabled }) => ({ id, label, revision, enabled })) : items }
    }
    const action = input.action
    if (action !== 'remove' && action !== 'save') throw new CoreError('INVALID_INPUT', 'Choose a mailbox rule action.')
    actionFields(input, ['commandId', 'accountId', 'ruleId', 'expectedRevision', ...(action === 'save' ? ['rule'] : [])])
    const ruleId = input.ruleId === undefined && action === 'save' ? null : inputId(input.ruleId, 'ruleId')
    const expected = revision(input.expectedRevision)
    const draft = action === 'save' ? parseRule(input.rule) : null
    return this.change<MailboxRule | { id: string; removed: true }>(input, digest(['mailbox-rule', action, accountId, ruleId, expected, draft]), undefined, async state => {
      accountOf(state, accountId)
      const current = ruleId ? state.rules.find(rule => rule.accountId === accountId && rule.id === ruleId) : null
      if (ruleId && !current) throw new CoreError('MAILBOX_RULE_NOT_FOUND', 'The selected mailbox rule is unavailable.')
      if (expected !== (current?.revision ?? 0)) throw fieldMismatch()
      if (!current && state.rules.length >= 100) throw new CoreError('MAILBOX_LIMIT', 'Remove a rule before adding another rule.')
      state.rules = state.rules.filter(rule => rule.id !== ruleId)
      if (!draft) return { result: { id: ruleId!, removed: true } }
      const updated = { ...draft, id: ruleId ?? randomUUID(), revision: expected + 1, accountId }
      state.rules.push(updated)
      return { result: updated }
    })
  }

  private assertMailboxIdle(accountId: string) {
    if (this.mailboxOperations.has(accountId)) throw new CoreError('MAILBOX_BUSY', 'Wait for the current mailbox operation to finish.')
  }

  private async withMailbox<Result>(accountId: string,
    operation: (account: MailboxAccount, password: string, signal: AbortSignal) => Promise<Result>) {
    this.assertMailboxIdle(accountId)
    this.mailboxOperations.add(accountId)
    try {
      const account = accountOf(await this.readState(), accountId)
      return await this.useMailbox(account, operation)
    } finally {
      this.mailboxOperations.delete(accountId)
    }
  }

  private async useMailbox<Result>(account: StoredAccount,
    operation: (account: MailboxAccount, password: string, signal: AbortSignal) => Promise<Result>) {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)])
    const result = await this.vaultAccess().withSecret(this.options.instanceId, account.reference, async password => {
      try {
        signal.throwIfAborted()
        return { value: await operation(accountView(account), password, signal) }
      } catch (error) {
        return { failure: error instanceof CoreError && error.code === 'MAILBOX_HOST_DENIED' ? error
          : new CoreError('MAILBOX_CONNECTION_FAILED', 'The mail server did not respond successfully. Check the server settings and credentials.') }
      }
    })
    if (result.failure) throw result.failure
    return result.value
  }

  private async mailboxReply(input: Record<string, unknown>) {
    const accountId = inputId(input.accountId, 'accountId')
    if (input.action === 'inbox') {
      actionFields(input, ['accountId'])
      return this.withMailbox(accountId, async (account, password, signal) => {
        const mail = await this.transport.read(account, password, signal)
        signal.throwIfAborted()
        const { rules } = await this.readState()
        return { items: mail.slice(0, 20).map(item => this.projectMail(account, item, rules)) }
      })
    }
    if (input.action !== 'send') throw new CoreError('INVALID_INPUT', 'Choose a mailbox reply action.')
    actionFields(input, ['accountId', 'messageKey', 'commandId', 'text'])
    const key = inputId(input.messageKey, 'messageKey')
    const commandId = inputId(input.commandId, 'commandId')
    const text = textValue(input.text, 'the reply', 16 * 1024, false, true)
    const fingerprint = digest([accountId, key, text])
    const prior = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<ReplyReceipt>(replyKind, commandId))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw commandConflict()
      if (prior.status !== 'sent') throw replyUnknown()
      return { status: 'sent' }
    }
    this.assertMailboxIdle(accountId)
    this.mailboxOperations.add(accountId)
    try {
      return await this.sendReply({ accountId, key, commandId, fingerprint, text })
    } finally {
      this.mailboxOperations.delete(accountId)
    }
  }

  private async sendReply(input: { accountId: string; key: string; commandId: string; fingerprint: string; text: string }) {
    const target = this.replyTargets.get(input.key)
    const account = accountOf(await this.readState(), input.accountId)
    if (!target || target.accountId !== account.id || target.revision !== account.revision || target.expiresAt <= Date.now()) {
      throw new CoreError('MAILBOX_MESSAGE_STALE', 'Refresh the inbox before replying to this message.')
    }
    await this.vaultAccess().assertReference(this.options.instanceId, account.reference)
    const prior = await this.options.storage.transaction(this.options.instanceId, async tx => {
      const current = await tx.get<ReplyReceipt>(replyKind, input.commandId)
      if (current) return current
      await tx.insert(replyKind, input.commandId, { fingerprint: input.fingerprint, status: 'unknown' } satisfies ReplyReceipt)
      return undefined
    })
    if (prior) {
      if (prior.fingerprint !== input.fingerprint) throw commandConflict()
      if (prior.status === 'sent') return { status: 'sent' }
      throw replyUnknown()
    }
    this.replyTargets.delete(input.key)
    try {
      await this.useMailbox(account, (view, password, signal) => this.transport.reply(view, password, {
        to: target.to, subject: /^re:\s/iu.test(target.subject) ? target.subject : `Re: ${target.subject}`,
        text: input.text, inReplyTo: target.messageId, messageId: `<${digest([this.options.instanceId, input.commandId])}@${view.email.split('@')[1]}>`,
      }, signal))
      await this.options.storage.transaction(this.options.instanceId, tx => tx.replace(replyKind, input.commandId,
        { fingerprint: input.fingerprint, status: 'sent' } satisfies ReplyReceipt))
    } catch { throw replyUnknown() }
    return { status: 'sent' }
  }

  private projectMail(account: MailboxAccount, item: ReceivedMail, rules: MailboxRule[]): MailboxMessage {
    const from = emailAddress(item.from) ?? ''
    const replyTo = emailAddress(item.replyTo)
    const subject = displayText(item.subject, 500)
    const key = randomUUID()
    const canReply = Boolean(from && replyTo && item.messageId.startsWith('<') && item.messageId.endsWith('>')
      && emailAddress(item.messageId.slice(1, -1)))
    if (canReply && replyTo) {
      this.replyTargets.set(key, { accountId: account.id, revision: account.revision, messageId: item.messageId,
        to: replyTo, subject, expiresAt: Date.now() + 10 * 60_000 })
      while (this.replyTargets.size > 400) this.replyTargets.delete(this.replyTargets.keys().next().value!)
    }
    const matches = rules.filter(rule => rule.accountId === account.id && rule.enabled
      && (!rule.sender || rule.sender === from.toLowerCase())
      && (!rule.subjectContains || subject.toLowerCase().includes(rule.subjectContains.toLowerCase())))
    return { key, from, replyTo: canReply ? replyTo : null, subject, receivedAt: item.receivedAt,
      preview: displayText(item.preview, 500), rules: matches.map(rule => rule.label), canReply }
  }
}
