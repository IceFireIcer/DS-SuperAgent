import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import SMTPConnection, { type SMTPConnectionOptions } from 'nodemailer/lib/smtp-connection'
import { CoreError } from '../model.js'
import type { MailboxAccount } from './protocol.js'

export interface ReceivedMail {
  from: string
  replyTo: string
  subject: string
  receivedAt: string | null
  preview: string
  messageId: string
}

export interface MailReply {
  to: string
  subject: string
  text: string
  inReplyTo: string
  messageId: string
}

export interface MailboxTransport {
  read(account: MailboxAccount, password: string, signal: AbortSignal): Promise<ReceivedMail[]>
  verify(account: MailboxAccount, password: string, signal: AbortSignal): Promise<void>
  reply(account: MailboxAccount, password: string, message: MailReply, signal: AbortSignal): Promise<void>
}

const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) {
  blocked.addSubnet(address, prefix, 'ipv4')
}
blocked.addSubnet('2001:db8::', 32, 'ipv6')
blocked.addSubnet('2002::', 16, 'ipv6')
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')

async function mailAddress(host: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const results = await lookup(host, { all: true })
  signal.throwIfAborted()
  if (!results.length || results.some(({ address }) => {
    const type = isIP(address)
    if (type === 4) return blocked.check(address, 'ipv4')
    return type !== 6 || !globalIpv6.check(address, 'ipv6') || blocked.check(address, 'ipv6')
  })) throw new CoreError('MAILBOX_HOST_DENIED', 'Use a public mail server hostname.')
  return (results.find(entry => entry.family === 4) ?? results[0]!).address
}

const previewBytes = 16 * 1024
const messageLimit = 20
async function withImap<Result>(account: MailboxAccount, password: string, signal: AbortSignal,
  operation: (client: ImapFlow) => Promise<Result>) {
  const address = await mailAddress(account.incoming.host, signal)
  const client = new ImapFlow({ host: address, servername: account.incoming.host, port: account.incoming.port,
    secure: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, auth: { user: account.username, pass: password },
    logger: false, disableAutoIdle: true, disableCompression: true, connectionTimeout: 8000, greetingTimeout: 8000,
    socketTimeout: 10000, maxLiteralSize: 256 * 1024, maxLineLength: 64 * 1024 })
  const close = () => client.close()
  client.on('error', close)
  signal.addEventListener('abort', close, { once: true })
  try {
    signal.throwIfAborted()
    await client.connect()
    signal.throwIfAborted()
    return await operation(client)
  } finally {
    close()
    signal.removeEventListener('abort', close)
  }
}

async function smtpOptions(account: MailboxAccount, signal: AbortSignal): Promise<SMTPConnectionOptions> {
  const address = await mailAddress(account.outgoing.host, signal)
  return { host: address, port: account.outgoing.port, servername: account.outgoing.host,
    secure: account.outgoing.security === 'tls', requireTLS: account.outgoing.security === 'starttls',
    tls: { servername: account.outgoing.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000, socketCloseTimeout: 0,
    maxResponseSize: 64 * 1024, logger: false, debug: false }
}

async function verifySmtp(account: MailboxAccount, password: string, signal: AbortSignal) {
  const options = await smtpOptions(account, signal)
  signal.throwIfAborted()
  const connection = new SMTPConnection(options)
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const complete = (error?: Error | null) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      connection.close()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => complete(new Error('SMTP verification was stopped.'))
    connection.on('error', complete)
    connection.once('end', () => complete(new Error('The SMTP server closed the connection.')))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else connection.connect(error => {
      if (finished) return
      if (error) complete(error)
      else connection.login({ user: account.username, pass: password }, complete)
    })
  })
}

export const publicMailboxTransport: MailboxTransport = {
  async read(account, password, signal) {
    return withImap(account, password, signal, async client => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true })
      try {
        const count = client.mailbox && client.mailbox.exists
        if (!count) return []
        const range = `${Math.max(1, count - messageLimit + 1)}:${count}`
        const messages = await client.fetchAll(range, { envelope: true, internalDate: true,
          source: { start: 0, maxLength: previewBytes } })
        return Promise.all(messages.slice(-messageLimit).reverse().map(async message => {
          const envelope = message.envelope
          const parsed = message.source && message.source.length <= previewBytes
            ? await simpleParser(message.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }).catch(() => null)
            : null
          const from = envelope?.from?.length === 1 ? envelope.from[0]?.address ?? '' : ''
          const replyTo = envelope?.replyTo?.length === 1 ? envelope.replyTo[0]?.address ?? '' : envelope?.replyTo?.length ? '' : from
          const date = message.internalDate ? new Date(message.internalDate) : null
          return { from, replyTo, messageId: envelope?.messageId ?? '',
            subject: envelope?.subject ?? '',
            receivedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
            preview: parsed?.text ?? '' }
        }))
      } finally {
        lock.release()
      }
    })
  },
  async verify(account, password, signal) {
    await withImap(account, password, signal, async () => {})
    await verifySmtp(account, password, signal)
  },
  async reply(account, password, message, signal) {
    const options = await smtpOptions(account, signal)
    const transport = nodemailer.createTransport({ ...options, auth: { user: account.username, pass: password },
      forceAuth: true, disableFileAccess: true, disableUrlAccess: true })
    try {
      signal.throwIfAborted()
      const result = await transport.sendMail({ from: account.email, to: message.to, subject: message.subject, text: message.text, signal,
        inReplyTo: message.inReplyTo, references: message.inReplyTo, messageId: message.messageId })
      if (result.accepted.length !== 1 || result.rejected.length !== 0) throw new Error('Mail reply was not accepted.')
    } finally {
      transport.close()
    }
  },
}
