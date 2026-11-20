import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '../commands.js'
import { CoreError, identifier } from '../model.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import { deleteProductCredential, grantFor, saveProductCredential,
  type ConnectorCredentialPort } from '../connectors/credentials.js'
import { CommandJournal, createCredentialRecordStateStore, type ConnectorStateStore } from '../connectors/store.js'
import { normalizeTarget, targetKey, type ProductTarget } from '../connectors/target.js'
import { ALLOWED_MAIL_PROVIDERS, mailPreset, mailPresetFor, type MailServer } from './presets.js'

export interface MailAccountConfig {
  address: string
  provider: string
  imap: MailServer
  smtp: MailServer
}

export interface MailSummary {
  uid: string
  folder: string
  from: string
  to: string
  subject: string
  date: string
  seen?: boolean
  flagged?: boolean
}

export interface MailMessage extends MailSummary {
  messageId?: string
  cc?: string
  text: string
  inReplyTo?: string
  references?: string[]
  threadId?: string
  attachments?: Array<{ filename: string; size: number }>
}

export interface MailOutgoing {
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

/** Host-owned mail adapter. The password is provided only for the duration of one operation. */
export interface ProductMailTransport {
  verify(account: MailAccountConfig, password: string): Promise<{ account?: string }>
  search(input: { account: MailAccountConfig; password: string; query?: string; folder?: string;
    limit?: number; unread?: boolean }): Promise<MailSummary[]>
  read(input: { account: MailAccountConfig; password: string; uid: string; folder?: string;
    thread?: boolean }): Promise<{ messages: MailMessage[] }>
  send(input: { account: MailAccountConfig; password: string; message: MailOutgoing;
    idempotencyKey: string }): Promise<{ messageId?: string }>
  close?(): Promise<void>
}

export type MailRuleMode = 'require-approval' | 'allow-recipients' | 'direct'

export interface MailRuleView {
  mode: MailRuleMode
  recipients: string[]
}

export interface MailAccountView {
  id: string
  address: string
  provider: string
  state: 'ready' | 'needs-authorization'
  revision: number
}

export interface MailOverview {
  available: boolean
  unavailableCode?: 'MAIL_TRANSPORT_UNAVAILABLE'
  accounts: MailAccountView[]
  rule: MailRuleView
  replies: MailReplyView[]
  target: ProductTarget
}

export interface MailReplyView {
  replyId: string
  status: 'pending-approval' | 'sent' | 'cancelled'
  to: string
  cc: string
  subject: string
  body: string
  messageId?: string
}

interface MailAccountRecord {
  id: string
  instanceId: string
  actorId: string
  target: ProductTarget
  address: string
  provider: string
  imap: MailServer
  smtp: MailServer
  resourceId: string
  grantId?: string
  revision: number
  createdAt: number
  updatedAt: number
}

interface MailRuleRecord {
  instanceId: string
  actorId: string
  target: ProductTarget
  mode: MailRuleMode
  recipients: string[]
  revision: number
  updatedAt: number
}

interface MailReplyRecord {
  id: string
  instanceId: string
  actorId: string
  target: ProductTarget
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string[]
  status: 'pending' | 'sent' | 'cancelled'
  messageId?: string
  createdAt: number
  updatedAt: number
}

interface MailSendAttempt {
  fingerprint: string
  status: 'pending' | 'sent'
  messageId?: string
  createdAt: number
  updatedAt: number
}

export interface MailServiceOptions {
  instanceId: string
  actorId: string
  records: ProductCredentialRecords
  credentials: ConnectorCredentialPort
  transport?: ProductMailTransport
  store?: ConnectorStateStore
  now?: () => number
}

const accountCollection = 'mail-account'
const ruleCollection = 'mail-rule'
const replyCollection = 'mail-reply'
const sendCollection = 'mail-send-attempt'
const commandCollection = 'mail-command'
const accountIndex = (actorId: string, target: ProductTarget) => `mail:${targetKey(actorId, target)}`
const ruleId = (actorId: string, target: ProductTarget) => targetKey(actorId, target)
const replyIndex = (actorId: string, target: ProductTarget) => `reply:${targetKey(actorId, target)}`

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /\0/u.test(value)) {
    throw new CoreError('INVALID_INPUT', `${label} must be nonempty text of at most ${max} bytes.`)
  }
  return value.trim()
}

function bodyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 200_000 || /\0/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'The reply body must be nonempty text of at most 200000 bytes.')
  }
  return value
}

function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16_384 || /[\r\n]/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'Enter the mailbox app password or authorization code without line breaks.')
  }
  return value.trim()
}

function mailUid(value: unknown): string {
  const uid = text(value, 'Mail UID', 32)
  if (!/^[1-9][0-9]*$/u.test(uid) || Number(uid) > 4_294_967_295) {
    throw new CoreError('INVALID_INPUT', 'Enter a valid mail UID.')
  }
  return uid
}

function server(value: unknown, fallback: MailServer | undefined, label: string): MailServer {
  if (value === undefined && fallback) return structuredClone(fallback)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `Enter the ${label} server.`)
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['host', 'port', 'secure', 'starttls'].includes(key))) {
    throw new CoreError('INVALID_INPUT', `The ${label} server has unsupported fields.`)
  }
  const host = text(input.host, `${label} host`, 255)
  if (!/^[A-Za-z0-9.-]+$/u.test(host)) throw new CoreError('INVALID_INPUT', `Enter a valid ${label} host.`)
  const port = input.port
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new CoreError('INVALID_INPUT', `Enter a valid ${label} port.`)
  }
  if (typeof input.secure !== 'boolean') throw new CoreError('INVALID_INPUT', `Choose whether ${label} uses TLS.`)
  if (input.starttls !== undefined && typeof input.starttls !== 'boolean') {
    throw new CoreError('INVALID_INPUT', `The ${label} STARTTLS setting is invalid.`)
  }
  if (input.secure === false && input.starttls !== true) {
    throw new CoreError('INVALID_INPUT', `The ${label} server must use TLS or require STARTTLS.`)
  }
  return { host, port: port as number, secure: input.secure,
    ...(input.starttls === undefined ? {} : { starttls: input.starttls }) }
}

export function parseMailAddresses(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [value]
  const output: string[] = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[,;]+/u)) {
      const raw = part.trim()
      if (raw === '') continue
      const angle = /<([^<>\s@]+@[^<>\s@]+)>/u.exec(raw)
      const address = (angle?.[1] ?? raw).trim().toLowerCase()
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) && !output.includes(address)) output.push(address)
    }
  }
  return output
}

function firstAddress(value: string): string | undefined {
  return parseMailAddresses(value)[0]
}

function allRecipientsAllowed(to: string, cc: string, bcc: string, allowed: string[]): boolean {
  const set = new Set(allowed.map(address => address.toLowerCase()))
  const recipients = parseMailAddresses([to, cc, bcc])
  return recipients.length > 0 && recipients.every(address => set.has(address))
}

export class MailService {
  private readonly instanceId: string
  private readonly actorId: string
  private readonly credentials: ConnectorCredentialPort
  private readonly transport: ProductMailTransport | undefined
  private readonly store: ConnectorStateStore
  private readonly now: () => number
  private readonly journal: CommandJournal

  constructor(options: MailServiceOptions) {
    identifier(options.instanceId, 'instanceId'); identifier(options.actorId, 'actorId')
    this.instanceId = options.instanceId
    this.actorId = options.actorId
    this.credentials = options.credentials
    this.transport = options.transport
    this.store = options.store ?? createCredentialRecordStateStore(options.records, options.instanceId)
    this.now = options.now ?? Date.now
    this.journal = new CommandJournal(this.store, commandCollection)
  }

  private requireTransport(): ProductMailTransport {
    if (!this.transport) throw new CoreError('MAIL_TRANSPORT_UNAVAILABLE',
      'Mail is not connected in this Host. Configure a mail transport before adding an account.')
    return this.transport
  }

  private async accounts(target: ProductTarget): Promise<MailAccountRecord[]> {
    const items = await this.store.entries<MailAccountRecord>(accountCollection, accountIndex(this.actorId, target))
    return items.filter(item => item.value.actorId === this.actorId && item.value.instanceId === this.instanceId)
      .map(item => item.value)
  }

  private async account(target: ProductTarget, accountId?: string): Promise<MailAccountRecord> {
    const accounts = await this.accounts(target)
    if (accountId !== undefined) {
      identifier(accountId, 'accountId')
      const found = accounts.find(account => account.id === accountId)
      if (!found) throw new CoreError('NOT_FOUND', 'The mail account is unavailable for this target.')
      return found
    }
    if (accounts.length === 0) throw new CoreError('MAIL_ACCOUNT_NOT_FOUND', 'Add a mail account first.')
    if (accounts.length > 1) throw new CoreError('MAIL_ACCOUNT_REQUIRED', 'Choose which mail account to use.')
    return accounts[0]!
  }

  private async readRule(target: ProductTarget): Promise<MailRuleView> {
    const stored = await this.store.read<MailRuleRecord>(ruleCollection, ruleId(this.actorId, target))
    if (!stored || stored.actorId !== this.actorId || stored.instanceId !== this.instanceId) {
      return { mode: 'require-approval', recipients: [] }
    }
    return { mode: stored.mode, recipients: [...stored.recipients] }
  }

  private async writeRule(target: ProductTarget, mode: MailRuleMode, recipients: string[]): Promise<MailRuleView> {
    const previous = await this.store.read<MailRuleRecord>(ruleCollection, ruleId(this.actorId, target))
    const next: MailRuleRecord = { instanceId: this.instanceId, actorId: this.actorId, target, mode,
      recipients: [...recipients], revision: (previous?.revision ?? 0) + 1, updatedAt: this.now() }
    await this.store.write(ruleCollection, ruleId(this.actorId, target), next)
    return { mode, recipients: [...recipients] }
  }

  private async accountView(account: MailAccountRecord): Promise<MailAccountView> {
    const resource = await this.credentials.get({ instanceId: this.instanceId, resourceId: account.resourceId })
    const ready = resource?.status === 'active' && Boolean(grantFor(resource, account.target, 'tool'))
    return { id: account.id, address: account.address, provider: account.provider,
      state: ready ? 'ready' : 'needs-authorization', revision: account.revision }
  }

  private async replies(target: ProductTarget): Promise<MailReplyView[]> {
    const items = await this.store.entries<MailReplyRecord>(replyCollection, replyIndex(this.actorId, target))
    return items.filter(item => item.value.actorId === this.actorId && item.value.instanceId === this.instanceId
      && item.value.status === 'pending' && targetKey(this.actorId, item.value.target) === targetKey(this.actorId, target))
      .sort((left, right) => right.value.createdAt - left.value.createdAt)
      .slice(0, 50)
      .map(item => this.replyView(item.value))
  }

  private async overview(target: ProductTarget): Promise<MailOverview> {
    const [accounts, rule, replies] = await Promise.all([this.accounts(target), this.readRule(target), this.replies(target)])
    return { available: this.transport !== undefined,
      ...(this.transport === undefined ? { unavailableCode: 'MAIL_TRANSPORT_UNAVAILABLE' as const } : {}),
      accounts: await Promise.all(accounts.map(account => this.accountView(account))), rule, replies, target }
  }

  async list(input: { target: unknown }): Promise<MailOverview> {
    return this.overview(normalizeTarget(input.target))
  }

  async accountSave(input: { commandId: string; address: string; provider?: string; password: string;
    imap?: unknown; smtp?: unknown; target: unknown }): Promise<MailOverview> {
    const target = normalizeTarget(input.target)
    const transport = this.requireTransport()
    const address = text(input.address, 'Mailbox address', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) throw new CoreError('INVALID_INPUT', 'Enter a valid email address.')
    const password = passwordValue(input.password)
    const preset = mailPresetFor(address)
    const provider = input.provider ?? preset?.id ?? 'other'
    if (!ALLOWED_MAIL_PROVIDERS.has(provider)) throw new CoreError('INVALID_INPUT', 'Choose a supported mail provider.')
    const chosen = provider === 'other' ? undefined : mailPreset(provider)
    const imap = server(input.imap, chosen?.imap ?? preset?.imap, 'IMAP')
    const smtp = server(input.smtp, chosen?.smtp ?? preset?.smtp, 'SMTP')
    return this.journal.run(input.commandId, ['account-save', target, address, provider, password,
      imap, smtp], async () => {
      try { await transport.verify({ address, provider, imap, smtp }, password) }
      catch { throw new CoreError('MAIL_AUTH_FAILED', 'The mail server refused this account or authorization code.') }
      const existing = (await this.accounts(target)).find(account => account.address === address)
      const saved = await saveProductCredential({ credentials: this.credentials, instanceId: this.instanceId,
        commandId: `mail:${input.commandId}`, label: `Mailbox: ${address}`, value: password,
        target, purpose: 'tool',
        ...(existing ? { existing: { resourceId: existing.resourceId,
          ...(existing.grantId === undefined ? {} : { grantId: existing.grantId }) } } : {}) })
      const now = this.now()
      const account: MailAccountRecord = { id: existing?.id ?? randomUUID(), instanceId: this.instanceId,
        actorId: this.actorId, target, address, provider, imap, smtp, resourceId: saved.resourceId,
        ...(saved.grantId === undefined ? {} : { grantId: saved.grantId }),
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now }
      await this.store.write(accountCollection, account.id, account,
        accountIndex(this.actorId, target))
      return this.overview(target)
    })
  }

  async accountRemove(input: { commandId: string; accountId: string; target: unknown }): Promise<MailOverview> {
    const target = normalizeTarget(input.target)
    identifier(input.accountId, 'accountId')
    return this.journal.run(input.commandId, ['account-remove', target, input.accountId], async () => {
      const account = await this.account(target, input.accountId)
      await deleteProductCredential(this.credentials, this.instanceId,
        `mail-remove:${input.commandId}`, account.resourceId)
      for (const reply of await this.store.entries<MailReplyRecord>(replyCollection, replyIndex(this.actorId, target))) {
        if (reply.value.accountId === account.id && reply.value.status === 'pending') {
          await this.store.delete(replyCollection, reply.id, replyIndex(this.actorId, target))
        }
      }
      await this.store.delete(accountCollection, account.id, accountIndex(this.actorId, target))
      return this.overview(target)
    })
  }

  async rules(input: { target: unknown }): Promise<{ rule: MailRuleView; target: ProductTarget }> {
    const target = normalizeTarget(input.target)
    return { rule: await this.readRule(target), target }
  }

  async ruleSave(input: { commandId: string; mode: string; recipients?: string[]; target: unknown }): Promise<MailRuleView> {
    const target = normalizeTarget(input.target)
    if (!['require-approval', 'allow-recipients', 'direct'].includes(input.mode)) {
      throw new CoreError('INVALID_INPUT', 'Choose a supported mail rule.')
    }
    const mode = input.mode as MailRuleMode
    const recipients = mode === 'allow-recipients' ? parseMailAddresses(input.recipients ?? []) : []
    if (mode === 'allow-recipients' && recipients.length === 0) {
      throw new CoreError('INVALID_INPUT', 'Choose at least one allowed recipient.')
    }
    if (recipients.length > 200) throw new CoreError('INVALID_INPUT', 'The allowed recipient list is too long.')
    return this.journal.run(input.commandId, ['rule-save', target, mode, recipients], () =>
      this.writeRule(target, mode, recipients))
  }

  private async withPassword<T>(account: MailAccountRecord, target: ProductTarget,
    consume: (password: string) => Promise<T>): Promise<T> {
    try {
      return await this.credentials.use({ instanceId: this.instanceId, resourceId: account.resourceId,
        role: target.role, ...(target.workItemId === undefined ? {} : { workItemId: target.workItemId }),
        ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
        ...(target.sourceInstanceId === undefined ? {} : { sourceInstanceId: target.sourceInstanceId }),
        purpose: 'tool' }, consume)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'CREDENTIAL_USE_FAILED') {
        throw new CoreError('MAIL_OPERATION_FAILED', 'The mail operation did not complete. Check the account and try again.')
      }
      throw error
    }
  }

  async search(input: { target: unknown; accountId?: string; query?: string; folder?: string;
    limit?: number; unread?: boolean }): Promise<{ items: MailSummary[]; target: ProductTarget }> {
    const target = normalizeTarget(input.target)
    const transport = this.requireTransport()
    const account = await this.account(target, input.accountId)
    const query = input.query === undefined ? undefined : text(input.query, 'Mail search', 512)
    const folder = input.folder === undefined ? undefined : text(input.folder, 'Mail folder', 256)
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Choose 1–100 mail results.')
    const items = await this.withPassword(account, target, password => transport.search({
      account: account, password, ...(query === undefined ? {} : { query }),
      ...(folder === undefined ? {} : { folder }), limit, ...(input.unread === true ? { unread: true } : {}) }))
    return { items: items.slice(0, limit).map(item => ({ uid: String(item.uid), folder: String(item.folder),
      from: String(item.from), to: String(item.to), subject: String(item.subject), date: String(item.date),
      ...(item.seen === undefined ? {} : { seen: item.seen }), ...(item.flagged === undefined ? {} : { flagged: item.flagged }) })),
      target }
  }

  async read(input: { target: unknown; accountId?: string; uid: string; folder?: string; thread?: boolean }):
  Promise<{ messages: MailMessage[]; target: ProductTarget }> {
    const target = normalizeTarget(input.target)
    const transport = this.requireTransport()
    const account = await this.account(target, input.accountId)
    const uid = mailUid(input.uid)
    const folder = input.folder === undefined ? undefined : text(input.folder, 'Mail folder', 256)
    const result = await this.withPassword(account, target, password => transport.read({
      account, password, uid, ...(folder === undefined ? {} : { folder }),
      ...(input.thread === true ? { thread: true } : {}) }))
    return { messages: result.messages.slice(0, 50).map(message => ({
      uid: String(message.uid), folder: String(message.folder), from: String(message.from),
      to: String(message.to), subject: String(message.subject), date: String(message.date),
      text: String(message.text), ...(message.seen === undefined ? {} : { seen: message.seen }),
      ...(message.flagged === undefined ? {} : { flagged: message.flagged }),
      ...(message.messageId === undefined ? {} : { messageId: String(message.messageId) }),
      ...(message.cc === undefined ? {} : { cc: String(message.cc) }),
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: String(message.inReplyTo) }),
      ...(message.references === undefined ? {} : { references: message.references.slice(0, 100).map(String) }),
      ...(message.threadId === undefined ? {} : { threadId: String(message.threadId) }),
      ...(message.attachments === undefined ? {} : { attachments: message.attachments.slice(0, 50)
        .map(item => ({ filename: String(item.filename), size: Number(item.size) || 0 })) }),
    })), target }
  }

  private replyView(reply: MailReplyRecord): MailReplyView {
    return { replyId: reply.id, status: reply.status === 'sent' ? 'sent' : reply.status === 'cancelled'
      ? 'cancelled' : 'pending-approval',
      to: reply.to, cc: reply.cc, subject: reply.subject, body: reply.body,
      ...(reply.messageId === undefined ? {} : { messageId: reply.messageId }) }
  }

  private async sendReply(account: MailAccountRecord, target: ProductTarget, reply: {
    to: string; cc: string; bcc: string; subject: string; body: string; inReplyTo?: string;
    references?: string[] }, idempotencyKey: string): Promise<string | undefined> {
    const transport = this.requireTransport()
    const commandKey = createHash('sha256').update(canonicalJson(['mail-send-attempt-v1', this.instanceId,
      this.actorId, idempotencyKey])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson([
      target, account.id, reply.to, reply.cc, reply.bcc, reply.subject, reply.body,
      reply.inReplyTo ?? null, reply.references ?? [],
    ])).digest('hex')
    const previous = await this.store.read<MailSendAttempt>(sendCollection, commandKey)
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CoreError('IDENTITY_CONFLICT', 'This mail send command was reused for a different reply.')
      }
      if (previous.status === 'pending') {
        throw new CoreError('MAIL_SEND_UNKNOWN',
          'The Host cannot confirm whether this reply was sent. Check the mailbox Sent folder before creating a new send command.')
      }
      return previous.messageId
    }
    const now = this.now()
    await this.store.write(sendCollection, commandKey, { fingerprint, status: 'pending', createdAt: now,
      updatedAt: now } satisfies MailSendAttempt)
    let result: { messageId?: string }
    try {
      result = await this.withPassword(account, target, password => transport.send({ account, password,
        idempotencyKey, message: { to: reply.to, ...(reply.cc ? { cc: reply.cc } : {}),
        ...(reply.bcc ? { bcc: reply.bcc } : {}), subject: reply.subject, text: reply.body,
        ...(reply.inReplyTo === undefined ? {} : { inReplyTo: reply.inReplyTo }),
        ...(reply.references === undefined ? {} : { references: reply.references }) } }))
    } catch {
      throw new CoreError('MAIL_SEND_UNKNOWN',
        'The Host cannot confirm whether this reply was sent. Check the mailbox Sent folder before creating a new send command.')
    }
    await this.store.write(sendCollection, commandKey, { fingerprint, status: 'sent',
      ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
      createdAt: now, updatedAt: this.now() } satisfies MailSendAttempt)
    return result.messageId
  }

  async reply(input: { commandId: string; target: unknown; accountId?: string; uid: string;
    folder?: string; body: string; replyAll?: boolean }): Promise<MailReplyView> {
    const target = normalizeTarget(input.target)
    const body = bodyText(input.body)
    const uid = mailUid(input.uid)
    const folder = input.folder === undefined ? undefined : text(input.folder, 'Mail folder', 256)
    this.requireTransport()
    return this.journal.run(input.commandId, ['reply', target, input.accountId, uid, folder, body,
      input.replyAll === true], async () => {
      const account = await this.account(target, input.accountId)
      const transport = this.requireTransport()
      let original: MailMessage
      try {
        const result = await this.withPassword(account, target, password => transport.read({
          account, password, uid, ...(folder === undefined ? {} : { folder }) }))
        original = result.messages[0]!
      } catch (error) {
        if (error instanceof CoreError) throw error
        throw new CoreError('MAIL_READ_FAILED', 'The original message could not be read.')
      }
      if (!original) throw new CoreError('MAIL_READ_FAILED', 'The original message is unavailable.')
      const to = firstAddress(original.from)
      if (!to) throw new CoreError('MAIL_RECIPIENT_UNAVAILABLE', 'The original sender has no usable address.')
      const additional = input.replyAll === true
        ? parseMailAddresses([original.to, original.cc ?? '']).filter(address => address !== account.address && address !== to)
        : []
      const cc = additional.join(', ')
      const subject = /^re:\s*/iu.test(original.subject) ? original.subject : `Re: ${original.subject}`
      const references = [...(original.references ?? []), ...(original.messageId ? [original.messageId] : [])]
      const rule = await this.readRule(target)
      const direct = rule.mode === 'direct' || rule.mode === 'allow-recipients' && allRecipientsAllowed(to, cc, '', rule.recipients)
      if (direct) {
        const messageId = await this.sendReply(account, target,
          { to, cc, bcc: '', subject, body, ...(original.messageId ? { inReplyTo: original.messageId } : {}),
            ...(references.length === 0 ? {} : { references }) }, input.commandId)
        return { replyId: input.commandId, status: 'sent' as const, to, cc, subject, body,
          ...(messageId === undefined ? {} : { messageId }) }
      }
      const now = this.now()
      const reply: MailReplyRecord = { id: randomUUID(), instanceId: this.instanceId, actorId: this.actorId,
        target, accountId: account.id, to, cc, bcc: '', subject, body,
        ...(original.messageId === undefined ? {} : { inReplyTo: original.messageId }),
        ...(references.length === 0 ? {} : { references }), status: 'pending', createdAt: now, updatedAt: now }
      await this.store.write(replyCollection, reply.id, reply, replyIndex(this.actorId, target))
      return this.replyView(reply)
    })
  }

  async replySend(input: { commandId: string; replyId: string; target: unknown;
    fields?: Record<string, unknown>; rule?: string }): Promise<MailReplyView> {
    const target = normalizeTarget(input.target)
    identifier(input.replyId, 'replyId')
    if (input.fields !== undefined && (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)
      || Object.keys(input.fields).some(key => !['to', 'cc', 'bcc', 'subject', 'body'].includes(key)))) {
      throw new CoreError('INVALID_INPUT', 'The reply form has unsupported fields.')
    }
    return this.journal.run(input.commandId, ['reply-send', target, input.replyId, input.fields, input.rule], async () => {
      const reply = await this.store.read<MailReplyRecord>(replyCollection, input.replyId)
      if (!reply || reply.actorId !== this.actorId || reply.instanceId !== this.instanceId
        || targetKey(this.actorId, reply.target) !== targetKey(this.actorId, target)) {
        throw new CoreError('NOT_FOUND', 'This pending reply is unavailable for the selected target.')
      }
      if (reply.status === 'cancelled') throw new CoreError('MAIL_REPLY_CANCELLED', 'This reply was cancelled.')
      if (reply.status === 'sent') return this.replyView(reply)
      const to = text(input.fields?.to ?? reply.to, 'Reply recipient', 1000)
      if (parseMailAddresses(to).length === 0) throw new CoreError('INVALID_INPUT', 'Enter a valid reply recipient.')
      const cc = typeof input.fields?.cc === 'string' ? input.fields.cc.trim() : reply.cc
      const bcc = typeof input.fields?.bcc === 'string' ? input.fields.bcc.trim() : reply.bcc
      const subject = text(input.fields?.subject ?? reply.subject, 'Reply subject', 998)
      const body = bodyText(input.fields?.body ?? reply.body)
      if (input.rule !== undefined) {
        if (!['require-approval', 'allow-recipients', 'direct'].includes(input.rule)) {
          throw new CoreError('INVALID_INPUT', 'Choose a supported mail rule.')
        }
        const mode = input.rule as MailRuleMode
        await this.writeRule(target, mode,
          mode === 'allow-recipients' ? parseMailAddresses([to, cc, bcc]) : [])
      }
      const account = await this.account(target, reply.accountId)
      const messageId = await this.sendReply(account, target, { to, cc, bcc, subject, body,
        ...(reply.inReplyTo === undefined ? {} : { inReplyTo: reply.inReplyTo }),
        ...(reply.references === undefined ? {} : { references: reply.references }) }, input.commandId)
      const next: MailReplyRecord = { ...reply, to, cc, bcc, subject, body, status: 'sent',
        ...(messageId === undefined ? {} : { messageId }), updatedAt: this.now() }
      await this.store.write(replyCollection, next.id, next)
      await this.store.unindex(replyCollection, next.id, replyIndex(this.actorId, target)).catch(() => {})
      return this.replyView(next)
    })
  }

  async replyCancel(input: { commandId: string; replyId: string; target: unknown }): Promise<MailReplyView> {
    const target = normalizeTarget(input.target)
    identifier(input.replyId, 'replyId')
    return this.journal.run(input.commandId, ['reply-cancel', target, input.replyId], async () => {
      const reply = await this.store.read<MailReplyRecord>(replyCollection, input.replyId)
      if (!reply || reply.actorId !== this.actorId || reply.instanceId !== this.instanceId
        || targetKey(this.actorId, reply.target) !== targetKey(this.actorId, target)) {
        throw new CoreError('NOT_FOUND', 'This pending reply is unavailable for the selected target.')
      }
      if (reply.status === 'sent') throw new CoreError('MAIL_REPLY_ALREADY_SENT', 'This reply was already sent.')
      const next: MailReplyRecord = { ...reply, status: 'cancelled', updatedAt: this.now() }
      await this.store.write(replyCollection, next.id, next)
      await this.store.unindex(replyCollection, next.id, replyIndex(this.actorId, target)).catch(() => {})
      return this.replyView(next)
    })
  }

  async close(): Promise<void> {
    await this.transport?.close?.()
  }
}

export function createMailService(options: MailServiceOptions): MailService {
  return new MailService(options)
}
