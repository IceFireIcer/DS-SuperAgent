import { CoreError, identifier } from '../model.js'

export const connectorFields: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  'connector-registry': ['instanceId', 'scope'],
  'connector-save': ['instanceId', 'scope', 'commandId', 'provider', 'expectedRevision', 'clientId', 'clientSecret', 'repositoryAccess'],
  'connector-auth': ['instanceId', 'scope', 'action', 'provider', 'loginId', 'commandId', 'expectedRevision'],
  'connector-import': ['instanceId', 'scope', 'commandId', 'provider', 'expectedRevision', 'pendingId', 'sourceRef', 'credentialId'],
  'mailbox-account': ['instanceId', 'scope', 'action', 'commandId', 'accountId', 'expectedRevision', 'account', 'password'],
  'mailbox-rule': ['instanceId', 'scope', 'action', 'commandId', 'accountId', 'ruleId', 'expectedRevision', 'rule'],
  'mailbox-reply': ['instanceId', 'scope', 'action', 'commandId', 'accountId', 'messageKey', 'text'],
})

export type ConnectorProvider = 'github' | 'feishu'
export type RepositoryAccess = 'public' | 'private'

export interface ConnectorSourceBindings {
  github?: { owner: string; repo: string }
  feishu?: { appId: string; tenantKey: string }
}

export type ConnectorAuthorizationRequest = ({ provider: 'github'; owner: string; repo: string }
  | { provider: 'feishu'; appId: string; tenantKey: string }) & { purpose: 'source' | 'outbound' }

export interface ConnectorView {
  provider: ConnectorProvider
  revision: number
  clientId: string | null
  hasClientSecret: boolean
  state: 'not-configured' | 'configured' | 'authorized' | 'expired' | 'credential-unavailable'
  authorization: 'oauth' | 'imported' | null
  authorizedAt: number | null
  redirectUri: string | null
  repository: string | null
  repositoryAccess: RepositoryAccess | null
  sourceConfigured: boolean
}

export interface MailboxAccount {
  id: string
  revision: number
  label: string
  email: string
  username: string
  incoming: { host: string; port: number }
  outgoing: { host: string; port: number; security: 'tls' | 'starttls' }
}

export interface MailboxRule {
  id: string
  revision: number
  accountId: string
  label: string
  sender: string
  subjectContains: string
  enabled: boolean
}

export interface MailboxMessage {
  key: string
  from: string
  replyTo: string | null
  subject: string
  receivedAt: string | null
  preview: string
  rules: string[]
  canReply: boolean
}

export function strictFields(value: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) {
    throw new CoreError('INVALID_INPUT', 'Check the connector or mailbox request fields.')
  }
  return value as Record<string, unknown>
}

export function mainScope(value: unknown) {
  const scope = strictFields(value, ['role', 'workItemId'])
  if (scope.role !== 'main' || Object.hasOwn(scope, 'workItemId')) {
    throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Connectors and mailbox settings belong to Main.')
  }
}

export function providerId(value: unknown): ConnectorProvider {
  if (value !== 'github' && value !== 'feishu') throw new CoreError('INVALID_INPUT', 'Choose GitHub or Feishu.')
  return value
}

export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CoreError('INVALID_INPUT', 'Reload the current settings before saving.')
  }
  return value
}

export function inputId(value: unknown, label: string) {
  identifier(value, label)
  return value
}

export function textValue(value: unknown, label: string, maxBytes: number, optional = false, multiline = false) {
  if (typeof value !== 'string' || !optional && !value.trim() || Buffer.byteLength(value) > maxBytes
    || Array.from(value).some(character => {
      const point = character.codePointAt(0)!
      return isControl(point) && !(multiline && (point === 9 || point === 10)) || point >= 0xd800 && point <= 0xdfff
    })) {
    throw new CoreError('INVALID_INPUT', `Check ${label}.`)
  }
  return value.trim()
}

function isControl(point: number) { return point < 32 || point === 127 }

export function displayText(value: string, limit: number) {
  return Array.from(value.slice(0, limit * 2), character => isControl(character.codePointAt(0)!) ? ' ' : character)
    .join('').trim().slice(0, limit)
}
