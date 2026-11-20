import { ImapFlow } from 'imapflow'
import type { FetchMessageObject, ImapFlow as ImapFlowClient, ImapFlowOptions } from 'imapflow'
import nodemailer from 'nodemailer'
import type { SentMessageInfo, Transporter } from 'nodemailer'
import type * as SMTPTransport from 'nodemailer/lib/smtp-transport'
import { simpleParser } from 'mailparser'
import type { AddressObject, ParsedMail } from 'mailparser'
import type { MailAccountConfig, MailMessage, MailSummary, ProductMailTransport } from './service.js'

const imapClientInfo = { name: 'ds-superagent', version: '0.3', vendor: 'DS SuperAgent' }

interface MailSmtpConnectionOptions {
  host: string
  port: number
  secure: boolean
  requireTLS?: boolean
  opportunisticTLS: false
  tls: { rejectUnauthorized: true; minVersion: 'TLSv1.2' }
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
  disableFileAccess: true
  disableUrlAccess: true
}

export interface HostMailTransportAdapters {
  createImap?: (options: ImapFlowOptions) => ImapFlowClient
  createSmtp?: (options: MailSmtpConnectionOptions) => Transporter<SentMessageInfo, SMTPTransport.Options>
  parse?: typeof simpleParser
}

export interface HostMailModules {
  ImapFlow: typeof ImapFlow
  nodemailer: typeof nodemailer
  simpleParser: typeof simpleParser
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  return Array.isArray(value) ? value.map(address => address.text).join(', ') : value?.text ?? ''
}

function parsedAddresses(value: ParsedMail['to']): string | undefined {
  const text = addressText(value)
  return text || undefined
}

function messageOf(uid: number, folder: string, parsed: ParsedMail): MailMessage {
  const inReplyTo = parsed.inReplyTo
  const parsedReferences = parsed.references
  const references = Array.isArray(parsedReferences) ? parsedReferences
    : typeof parsedReferences === 'string' ? parsedReferences.match(/<[^>]+>/gu) ?? [parsedReferences] : []
  return {
    uid: String(uid),
    folder,
    from: addressText(parsed.from),
    to: parsedAddresses(parsed.to) ?? '',
    ...(parsed.cc === undefined ? {} : { cc: addressText(parsed.cc) }),
    subject: parsed.subject ?? '',
    date: parsed.date?.toISOString?.() ?? '',
    text: parsed.text ?? '',
    ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
    ...(references.length ? { references } : {}),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    attachments: (parsed.attachments ?? []).map((attachment, index) => ({
      filename: attachment.filename ?? `attachment-${index + 1}`,
      size: attachment.size ?? attachment.content.length,
    })),
  }
}

function isSeen(message: FetchMessageObject, flag: string): boolean {
  return Boolean(message.flags?.has(flag))
}

function summary(message: FetchMessageObject, folder: string): MailSummary {
  return {
    uid: String(message.uid),
    folder,
    from: message.envelope?.from?.map(address => address.address ?? address.name ?? '').filter(Boolean).join(', ') ?? '',
    to: message.envelope?.to?.map(address => address.address ?? address.name ?? '').filter(Boolean).join(', ') ?? '',
    subject: message.envelope?.subject ?? '',
    date: message.envelope?.date instanceof Date ? message.envelope.date.toISOString()
      : message.envelope?.date ?? '',
    seen: isSeen(message, '\\Seen'),
    flagged: isSeen(message, '\\Flagged'),
  }
}

function imapOptions(account: MailAccountConfig, password: string): ImapFlowOptions {
  const secure = account.imap.secure === true
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure,
    ...(!secure ? { doSTARTTLS: true } : {}),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: account.address, pass: password },
    clientInfo: imapClientInfo,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  }
}

function smtpOptions(account: MailAccountConfig, password: string): MailSmtpConnectionOptions {
  const secure = account.smtp.secure === true
  const requireTLS = !secure && account.smtp.starttls === true
  if (!secure && !requireTLS) throw new Error('SMTP requires implicit TLS or STARTTLS.')
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure,
    ...(requireTLS ? { requireTLS: true } : {}),
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: account.address, pass: password },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

function createImapFactory(adapters: HostMailTransportAdapters) {
  return adapters.createImap ?? ((options: ImapFlowOptions) => new ImapFlow(options))
}

function createSmtpFactory(adapters: HostMailTransportAdapters) {
  return adapters.createSmtp ?? ((options: MailSmtpConnectionOptions) =>
    nodemailer.createTransport(options) as Transporter<SentMessageInfo, SMTPTransport.Options>)
}

function createParser(adapters: HostMailTransportAdapters) {
  return adapters.parse ?? simpleParser
}

async function usingImap<Result>(factory: (options: ImapFlowOptions) => ImapFlowClient,
  account: MailAccountConfig, password: string,
  operation: (imap: ImapFlowClient) => Promise<Result>): Promise<Result> {
  const imap = factory(imapOptions(account, password))
  try {
    await imap.connect()
    if (!imap.secureConnection) throw new Error('IMAP connection did not negotiate TLS.')
    return await operation(imap)
  } finally {
    if (!imap.isClosed) await imap.logout().catch(() => {})
    if (!imap.isClosed) imap.close()
  }
}

async function usingSmtp<Result>(factory: (options: MailSmtpConnectionOptions) =>
  Transporter<SentMessageInfo, SMTPTransport.Options>, account: MailAccountConfig, password: string,
  operation: (transport: Transporter<SentMessageInfo, SMTPTransport.Options>) => Promise<Result>): Promise<Result> {
  const transport = factory(smtpOptions(account, password))
  try { return await operation(transport) }
  finally { transport.close() }
}

export function createImapSmtpTransport(adapters: HostMailTransportAdapters = {}): ProductMailTransport {
  const imapFactory = createImapFactory(adapters)
  const smtpFactory = createSmtpFactory(adapters)
  const parse = createParser(adapters)

  return {
    async verify(account, password) {
      const imap = imapFactory(imapOptions(account, password))
      const smtp = smtpFactory(smtpOptions(account, password))
      try {
        await Promise.all([imap.connect(), smtp.verify()])
        if (!imap.secureConnection) throw new Error('IMAP connection did not negotiate TLS.')
        return { account: account.address }
      } finally {
        if (!imap.isClosed) await imap.logout().catch(() => {})
        if (!imap.isClosed) imap.close()
        smtp.close()
      }
    },

    async search({ account, password, query, folder = 'INBOX', limit = 20, unread }) {
      return usingImap(imapFactory, account, password, async imap => {
        const lock = await imap.getMailboxLock(folder)
        try {
          const criteria: Record<string, unknown> = {}
          if (query) criteria.text = query
          if (unread === true) criteria.seen = false
          const result = await imap.search(criteria, { uid: true })
          const uids = Array.isArray(result) ? result.slice(-limit) : []
          if (uids.length === 0) return []
          const items: MailSummary[] = []
          for await (const message of imap.fetch(uids, { envelope: true, flags: true }, { uid: true })) {
            items.push(summary(message, folder))
          }
          return items
        } finally { lock.release() }
      })
    },

    async read({ account, password, uid, folder = 'INBOX', thread = false }) {
      return usingImap(imapFactory, account, password, async imap => {
        const lock = await imap.getMailboxLock(folder)
        try {
          const found = await imap.fetchOne(Number(uid), { source: true }, { uid: true })
          if (found === false || !found.source) throw new Error('The requested message is unavailable.')
          const message = messageOf(found.uid, folder, await parse(found.source))
          if (!thread) return { messages: [message] }

          const relationIds = new Set([message.messageId, ...(message.references ?? [])].filter((id): id is string => Boolean(id)))
          const messages = [message]
          const allUids = await imap.search({ all: true }, { uid: true })
          const uids = Array.isArray(allUids) ? allUids.filter(candidate => candidate !== found.uid).slice(-499) : []
          if (uids.length === 0) return { messages }
          for await (const candidate of imap.fetch(uids, { source: true }, { uid: true })) {
            if (candidate.uid === found.uid || !candidate.source) continue
            const related = messageOf(candidate.uid, folder, await parse(candidate.source))
            if (!related.inReplyTo || !relationIds.has(related.inReplyTo)) continue
            messages.push(related)
            if (related.messageId) relationIds.add(related.messageId)
          }
          messages.sort((left, right) => left.date.localeCompare(right.date))
          return { messages }
        } finally { lock.release() }
      })
    },

    async send({ account, password, message, idempotencyKey }) {
      return usingSmtp(smtpFactory, account, password, async transport => {
        const result = await transport.sendMail({
          from: account.address,
          to: message.to,
          ...(message.cc ? { cc: message.cc } : {}),
          ...(message.bcc ? { bcc: message.bcc } : {}),
          subject: message.subject,
          text: message.text,
          ...(message.inReplyTo ? { inReplyTo: message.inReplyTo,
            references: message.references ?? [message.inReplyTo] } : {}),
          headers: { 'X-DS-SuperAgent-Command': idempotencyKey },
        })
        return result.messageId === undefined ? {} : { messageId: result.messageId }
      })
    },
  }
}

export async function loadHostMailTransport(): Promise<ProductMailTransport> {
  const modules = await loadHostMailModules()
  return createImapSmtpTransport({
    createImap: options => new modules.ImapFlow(options),
    createSmtp: options => modules.nodemailer.createTransport(options),
    parse: modules.simpleParser,
  })
}

export async function loadHostMailModules(): Promise<HostMailModules> {
  return { ImapFlow, nodemailer, simpleParser }
}
