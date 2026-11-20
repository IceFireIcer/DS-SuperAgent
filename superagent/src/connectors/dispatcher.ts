import { CoreError, identifier } from '../model.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import { createMailService, type MailService, type ProductMailTransport } from '../product-mail/service.js'
import type { ConnectorCredentialPort } from './credentials.js'
import { createConnectorService, type ConnectorImportAdapter, type ConnectorService,
  type ConnectorVerifier } from './service.js'
import type { ConnectorOAuthBroker } from './oauth.js'
import type { ConnectorStateStore } from './store.js'

const scopedFields = (extra: readonly string[] = []) => Object.freeze(['instanceId', ...extra, 'scope', 'target'])
const instanceFields = (extra: readonly string[] = []) => Object.freeze(['instanceId', ...extra])

export const CONNECTOR_MAIL_ENDPOINT_FIELDS = Object.freeze({
  'connector-list': scopedFields(),
  'connector-save': scopedFields(['commandId', 'connectorId', 'name', 'url', 'command', 'args', 'readOnly']),
  'connector-remove': scopedFields(['commandId', 'connectorId']),
  'connector-import-scan': instanceFields(),
  'connector-import-commit': scopedFields(['commandId', 'sourceId', 'name']),
  'connector-credential-bind': scopedFields(['commandId', 'connectorId', 'resourceId']),
  'connector-token-save': scopedFields(['commandId', 'connectorId', 'label', 'value']),
  'connector-oauth-start': scopedFields(['commandId', 'connectorId']),
  'connector-oauth-status': instanceFields(['attemptId']),
  'connector-oauth-cancel': instanceFields(['commandId', 'attemptId']),
  'connector-disconnect': scopedFields(['commandId', 'connectorId']),
  'mail-account-list': scopedFields(),
  'mail-account-save': scopedFields(['commandId', 'address', 'provider', 'password', 'imap', 'smtp']),
  'mail-account-remove': scopedFields(['commandId', 'accountId']),
  'mail-rules': scopedFields(),
  'mail-rule-save': scopedFields(['commandId', 'mode', 'recipients']),
  'mail-search': scopedFields(['accountId', 'folder', 'limit', 'query', 'unread']),
  'mail-read': scopedFields(['accountId', 'folder', 'thread', 'uid']),
  'mail-reply': scopedFields(['accountId', 'body', 'commandId', 'folder', 'replyAll', 'uid']),
  'mail-reply-send': scopedFields(['commandId', 'fields', 'replyId', 'rule']),
  'mail-reply-cancel': scopedFields(['commandId', 'replyId']),
} as const)

export type ConnectorMailEndpoint = keyof typeof CONNECTOR_MAIL_ENDPOINT_FIELDS

export const CONNECTOR_MAIL_ENDPOINTS = Object.freeze(Object.keys(CONNECTOR_MAIL_ENDPOINT_FIELDS) as ConnectorMailEndpoint[])

export type ConnectorMailAccess = 'local' | 'read' | 'command'

const remoteRead = new Set<ConnectorMailEndpoint>(['connector-list', 'connector-oauth-status', 'mail-account-list', 'mail-rules',
  'mail-search', 'mail-read'])
const remoteCommand = new Set<ConnectorMailEndpoint>(['mail-reply', 'mail-reply-send', 'mail-reply-cancel'])

export function connectorMailEndpointAccess(endpoint: string): ConnectorMailAccess | undefined {
  if (!Object.hasOwn(CONNECTOR_MAIL_ENDPOINT_FIELDS, endpoint)) return undefined
  if (remoteRead.has(endpoint as ConnectorMailEndpoint)) return 'read'
  if (remoteCommand.has(endpoint as ConnectorMailEndpoint)) return 'command'
  return 'local'
}

export interface ConnectorMailDispatchContext {
  /** True only for the local authorized product Host. */
  local: boolean
  /** Trusted Host-side grant for a remote client. Ignored for local calls. */
  capabilities?: readonly string[]
}

export interface ConnectorMailProductsOptions {
  instanceId: string
  actorId: string
  records: ProductCredentialRecords
  credentials: ConnectorCredentialPort
  oauth?: ConnectorOAuthBroker
  imports?: ConnectorImportAdapter
  verifier?: ConnectorVerifier
  mailTransport?: ProductMailTransport
  store?: ConnectorStateStore
  now?: () => number
}

export interface ConnectorMailProducts {
  dispatch(endpoint: string, payload?: Record<string, unknown>,
    context?: ConnectorMailDispatchContext): Promise<unknown>
  has(endpoint: string): endpoint is ConnectorMailEndpoint
  whitelist: typeof CONNECTOR_MAIL_ENDPOINT_FIELDS
  connectors: ConnectorService
  mail: MailService
  close(): Promise<void>
}

function payloadOf(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CoreError('INVALID_INPUT', 'The product request payload must be an object.')
  }
  return value
}

function objectFields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('INVALID_INPUT', `The ${label} must be an object.`)
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new CoreError('INVALID_INPUT', `The ${label} contains unsupported fields.`)
  }
  return input
}

function scopedTarget(payload: Record<string, unknown>): unknown {
  const hasScope = Object.hasOwn(payload, 'scope')
  const hasTarget = Object.hasOwn(payload, 'target')
  if (hasScope && hasTarget) throw new CoreError('INVALID_INPUT', 'Use either scope or target, not both.')
  if (!hasScope && !hasTarget) throw new CoreError('INVALID_INPUT', 'Choose an explicit scope or target.')
  return hasScope ? payload.scope : payload.target
}

function projectRemote(endpoint: ConnectorMailEndpoint, value: unknown): unknown {
  if (endpoint === 'connector-oauth-status' && value && typeof value === 'object') {
    const attempt = value as Record<string, unknown>
    return { loginId: attempt.attemptId, state: attempt.state,
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }) }
  }
  if (endpoint !== 'connector-list' || !value || typeof value !== 'object') return value
  const result = structuredClone(value) as { items?: Array<Record<string, unknown>> }
  for (const item of result.items ?? []) {
    if (!item.pending || typeof item.pending !== 'object') continue
    const pending = item.pending as Record<string, unknown>
    item.pending = { loginId: pending.attemptId, state: 'pending' }
  }
  return result
}

export function createConnectorMailProducts(options: ConnectorMailProductsOptions): ConnectorMailProducts {
  const connectors = createConnectorService({ instanceId: options.instanceId, actorId: options.actorId,
    records: options.records, credentials: options.credentials, ...(options.oauth ? { oauth: options.oauth } : {}),
    ...(options.imports ? { imports: options.imports } : {}), ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.store ? { store: options.store } : {}), ...(options.now ? { now: options.now } : {}) })
  const mail = createMailService({ instanceId: options.instanceId, actorId: options.actorId,
    records: options.records, credentials: options.credentials,
    ...(options.mailTransport ? { transport: options.mailTransport } : {}),
    ...(options.store ? { store: options.store } : {}), ...(options.now ? { now: options.now } : {}) })

  async function dispatch(endpoint: string, rawPayload?: Record<string, unknown>,
    context: ConnectorMailDispatchContext = { local: false }): Promise<unknown> {
    if (!Object.hasOwn(CONNECTOR_MAIL_ENDPOINT_FIELDS, endpoint)) {
      throw new CoreError('UNAVAILABLE', 'This connector or mailbox capability is not connected yet.')
    }
    const access = connectorMailEndpointAccess(endpoint)!
    if (context.local !== true) {
      if (access === 'local') {
        throw new CoreError('SOURCE_NOT_AUTHORIZED',
          'This connector or mailbox action requires Host-local confirmation.')
      }
      if (!context.capabilities?.includes(access)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', `This remote client needs the ${access} capability.`)
      }
    }
    const payload = payloadOf(rawPayload)
    const allowed = CONNECTOR_MAIL_ENDPOINT_FIELDS[endpoint as ConnectorMailEndpoint]
    if (Object.keys(payload).some(key => !(allowed as readonly string[]).includes(key))) {
      if (Object.hasOwn(payload, 'botId')) {
        throw new CoreError('INVALID_INPUT', 'Legacy botId is not accepted; use an explicit target.')
      }
      throw new CoreError('INVALID_INPUT', 'The product request contains unsupported fields.')
    }
    if (payload.instanceId !== undefined) {
      identifier(payload.instanceId, 'instanceId')
      if (payload.instanceId !== options.instanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The product request belongs to another Instance.')
      }
    }
    const target = () => scopedTarget(payload)
    let result: unknown
    switch (endpoint as ConnectorMailEndpoint) {
      case 'connector-list':
        result = { ...await connectors.list({ target: target() }), access: context.local === true ? 'local'
          : context.capabilities?.includes('command') ? 'command' : 'read' }
        break
      case 'connector-save':
        result = await connectors.save({ commandId: payload.commandId as string,
          ...(payload.connectorId === undefined ? {} : { connectorId: payload.connectorId as string }),
          ...(payload.name === undefined ? {} : { name: payload.name as string }),
          ...(payload.url === undefined ? {} : { url: payload.url as string }),
          ...(payload.command === undefined ? {} : { command: payload.command as string }),
          ...(payload.args === undefined ? {} : { args: payload.args as string[] }),
          ...(payload.readOnly === undefined ? {} : { readOnly: payload.readOnly as boolean }),
          target: target() })
        break
      case 'connector-remove':
        result = await connectors.remove({ commandId: payload.commandId as string,
          connectorId: payload.connectorId as string, target: target() })
        break
      case 'connector-import-scan':
        result = await connectors.importScan()
        break
      case 'connector-import-commit':
        result = await connectors.importCommit({ commandId: payload.commandId as string, sourceId: payload.sourceId as string,
          ...(payload.name === undefined ? {} : { name: payload.name as string }), target: target() })
        break
      case 'connector-credential-bind':
        result = await connectors.bindCredential({ commandId: payload.commandId as string,
          connectorId: payload.connectorId as string, resourceId: payload.resourceId as string, target: target() })
        break
      case 'connector-token-save':
        result = await connectors.tokenSave({ commandId: payload.commandId as string, connectorId: payload.connectorId as string,
          ...(payload.label === undefined ? {} : { label: payload.label as string }),
          value: payload.value as string, target: target() })
        break
      case 'connector-oauth-start':
        result = await connectors.oauthStart({ commandId: payload.commandId as string,
          connectorId: payload.connectorId as string, target: target() })
        break
      case 'connector-oauth-status':
        result = await connectors.oauthStatus({ attemptId: payload.attemptId as string, observeOnly: context.local !== true })
        break
      case 'connector-oauth-cancel':
        result = await connectors.oauthCancel({ commandId: payload.commandId as string, attemptId: payload.attemptId as string })
        break
      case 'connector-disconnect':
        result = await connectors.disconnect({ commandId: payload.commandId as string,
          connectorId: payload.connectorId as string, target: target() })
        break
      case 'mail-account-list':
        result = await mail.list({ target: target() })
        break
      case 'mail-account-save':
        result = await mail.accountSave({ commandId: payload.commandId as string, address: payload.address as string,
          ...(payload.provider === undefined ? {} : { provider: payload.provider as string }),
          password: payload.password as string, ...(payload.imap === undefined ? {} : { imap: payload.imap }),
          ...(payload.smtp === undefined ? {} : { smtp: payload.smtp }), target: target() })
        break
      case 'mail-account-remove':
        result = await mail.accountRemove({ commandId: payload.commandId as string,
          accountId: payload.accountId as string, target: target() })
        break
      case 'mail-rules':
        result = await mail.rules({ target: target() })
        break
      case 'mail-rule-save':
        result = await mail.ruleSave({ commandId: payload.commandId as string, mode: payload.mode as string,
          ...(payload.recipients === undefined ? {} : { recipients: payload.recipients as string[] }),
          target: target() })
        break
      case 'mail-search':
        result = await mail.search({ target: target(),
          ...(payload.accountId === undefined ? {} : { accountId: payload.accountId as string }),
          ...(payload.query === undefined ? {} : { query: payload.query as string }),
          ...(payload.folder === undefined ? {} : { folder: payload.folder as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }),
          ...(payload.unread === undefined ? {} : { unread: payload.unread as boolean }) })
        break
      case 'mail-read':
        result = await mail.read({ target: target(),
          ...(payload.accountId === undefined ? {} : { accountId: payload.accountId as string }),
          uid: payload.uid as string, ...(payload.folder === undefined ? {} : { folder: payload.folder as string }),
          ...(payload.thread === undefined ? {} : { thread: payload.thread as boolean }) })
        break
      case 'mail-reply':
        result = await mail.reply({ commandId: payload.commandId as string, target: target(),
          ...(payload.accountId === undefined ? {} : { accountId: payload.accountId as string }),
          uid: payload.uid as string, body: payload.body as string,
          ...(payload.folder === undefined ? {} : { folder: payload.folder as string }),
          ...(payload.replyAll === undefined ? {} : { replyAll: payload.replyAll as boolean }) })
        break
      case 'mail-reply-send': {
        if (context.local !== true && payload.rule !== undefined) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Mail rule changes require the local authorized product settings.')
        }
        const fields = payload.fields === undefined ? undefined
          : objectFields(payload.fields, ['to', 'cc', 'bcc', 'subject', 'body'], 'reply form')
        result = await mail.replySend({ commandId: payload.commandId as string, replyId: payload.replyId as string,
          target: target(), ...(fields === undefined ? {} : { fields }),
          ...(payload.rule === undefined ? {} : { rule: payload.rule as string }) })
        break
      }
      case 'mail-reply-cancel':
        result = await mail.replyCancel({ commandId: payload.commandId as string,
          replyId: payload.replyId as string, target: target() })
        break
    }
    return context.local === true ? result : projectRemote(endpoint as ConnectorMailEndpoint, result)
  }

  return {
    dispatch,
    has: (endpoint: string): endpoint is ConnectorMailEndpoint =>
      Object.hasOwn(CONNECTOR_MAIL_ENDPOINT_FIELDS, endpoint),
    whitelist: CONNECTOR_MAIL_ENDPOINT_FIELDS,
    connectors,
    mail,
    async close() {
      const failures: unknown[] = []
      for (const close of [() => connectors.close(), () => mail.close()]) {
        try { await close() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'The connector and mail services did not close cleanly.')
    },
  }
}
