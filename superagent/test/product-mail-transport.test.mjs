import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { after, test } from 'node:test'
import { build } from 'esbuild'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const buildDirectory = await mkdtemp(join(pluginRoot, '.test-mail-transport-'))
await build({ entryPoints: [join(pluginRoot, 'src/connectors/index.ts')],
  outfile: join(buildDirectory, 'connectors.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external', logLevel: 'silent' })
const { createConfiguredHostConnectorMailProducts, createImapSmtpTransport,
  HOST_CONNECTOR_OAUTH_CALLBACK_URI } = await import(pathToFileURL(join(buildDirectory, 'connectors.mjs')).href)
after(async () => { await rm(buildDirectory, { recursive: true, force: true }) })

const secureAccount = {
  address: 'person@example.test',
  provider: 'other',
  imap: { host: 'imap.example.test', port: 993, secure: true },
  smtp: { host: 'smtp.example.test', port: 465, secure: true },
}
const starttlsAccount = {
  ...secureAccount,
  imap: { host: 'imap.example.test', port: 143, secure: false, starttls: true },
  smtp: { host: 'smtp.example.test', port: 587, secure: false, starttls: true },
}

const originalSource = Buffer.from([
  'From: Sender <sender@example.test>',
  'To: person@example.test',
  'Cc: team@example.test',
  'Subject: OAuth-free IMAP fixture',
  'Date: Fri, 20 Nov 2026 00:00:00 +0000',
  'Message-ID: <original@example.test>',
  'References: <root@example.test>',
  '',
  'A local mailbox fixture.',
].join('\r\n'))
const replySource = Buffer.from([
  'From: Person <person@example.test>',
  'To: sender@example.test',
  'Subject: Re: OAuth-free IMAP fixture',
  'Date: Fri, 20 Nov 2026 00:01:00 +0000',
  'Message-ID: <reply-inbox@example.test>',
  'In-Reply-To: <original@example.test>',
  '',
  'A local reply fixture.',
].join('\r\n'))

function mockModules({ failImapConnect = false, failSmtpVerify = false } = {}) {
  const requests = { imapOptions: [], smtpOptions: [], searches: [], fetched: [], sent: [],
    releasedLocks: 0, loggedOut: 0, disconnectedImap: 0, closedSmtp: 0 }
  class ImapFlow {
    constructor(options) {
      requests.imapOptions.push(options)
      this.options = options
      this.isClosed = false
      this.secureConnection = options.secure === true || options.doSTARTTLS === true
      this.mailbox = { exists: 750 }
    }
    async connect() {
      if (failImapConnect) throw new Error('Mock local IMAP server refused TLS.')
    }
    async logout() { this.isClosed = true; requests.loggedOut += 1 }
    close() { this.isClosed = true; requests.disconnectedImap += 1 }
    async getMailboxLock(path) {
      return { path, release() { requests.releasedLocks += 1 } }
    }
    async search(criteria, options) {
      requests.searches.push({ criteria, options })
      return [1001, 1002]
    }
    async *fetch(range, query, options) {
      requests.fetched.push({ range, query, options })
      if (String(range) === '1001,1002') {
        yield { seq: 4, uid: 1001, envelope: { from: [{ address: 'sender@example.test' }],
          to: [{ address: 'person@example.test' }], subject: 'Older' }, flags: new Set(['\\Seen']) }
        yield { seq: 5, uid: 1002, envelope: { from: [{ address: 'sender@example.test' }],
          to: [{ address: 'person@example.test' }], subject: 'Newer' }, flags: new Set() }
        return
      }
      yield { seq: 12, uid: 1002, source: replySource }
    }
    async fetchOne(uid, query, options) {
      requests.fetched.push({ uid, query, options })
      return { seq: 11, uid, source: originalSource }
    }
  }
  const createTransport = options => {
    requests.smtpOptions.push(options)
    const smtp = new EventEmitter()
    smtp.closed = false
    smtp.verify = async () => {
      if (failSmtpVerify) throw new Error('Mock local SMTP server refused TLS.')
    }
    smtp.sendMail = async message => {
      requests.sent.push(message)
      return { messageId: '<mock-outgoing@example.test>' }
    }
    smtp.close = () => { smtp.closed = true; requests.closedSmtp += 1 }
    return smtp
  }
  return { requests, adapters: { createImap: options => new ImapFlow(options), createSmtp: createTransport } }
}

test('IMAP and SMTP verification, reads, and replies use strict implicit TLS', async () => {
  const mock = mockModules()
  const transport = createImapSmtpTransport(mock.adapters)
  const verified = await transport.verify(secureAccount, 'fictional-password')
  assert.deepEqual(verified, { account: secureAccount.address })
  assert.equal(mock.requests.imapOptions[0].secure, true)
  assert.equal(mock.requests.imapOptions[0].doSTARTTLS, undefined)
  assert.deepEqual(mock.requests.imapOptions[0].clientInfo, {
    name: 'ds-superagent', version: '0.3', vendor: 'DS SuperAgent',
  })
  assert.deepEqual(mock.requests.imapOptions[0].tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2' })
  assert.deepEqual(mock.requests.imapOptions[0].clientInfo, {
    name: 'ds-superagent', version: '0.3', vendor: 'DS SuperAgent',
  })
  assert.equal(mock.requests.smtpOptions[0].secure, true)
  assert.equal(mock.requests.smtpOptions[0].requireTLS, undefined)
  assert.deepEqual(mock.requests.smtpOptions[0].tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2' })
  assert.equal(mock.requests.loggedOut, 1)
  assert.equal(mock.requests.closedSmtp, 1)

  const results = await transport.search({ account: secureAccount, password: 'fictional-password',
    query: 'urgent', unread: true, limit: 10 })
  assert.equal(mock.requests.searches[0].criteria.text, 'urgent')
  assert.equal(mock.requests.searches[0].criteria.seen, false)
  assert.deepEqual(results.map(item => [item.uid, item.subject, item.seen]), [
    ['1001', 'Older', true], ['1002', 'Newer', false],
  ])
  assert.equal(mock.requests.releasedLocks, 1)

  const original = await transport.read({ account: secureAccount, password: 'fictional-password', uid: '1001' })
  assert.equal(original.messages[0].messageId, '<original@example.test>')
  assert.match(original.messages[0].text, /local mailbox fixture/u)
  const thread = await transport.read({ account: secureAccount, password: 'fictional-password', uid: '1001', thread: true })
  assert.deepEqual(thread.messages.map(message => message.messageId), [
    '<original@example.test>', '<reply-inbox@example.test>',
  ])

  const sent = await transport.send({ account: secureAccount, password: 'fictional-password', idempotencyKey: 'mail-command-one',
    message: { to: 'sender@example.test', cc: 'team@example.test', subject: 'Re: original',
      text: 'A locally-tested reply.', inReplyTo: '<original@example.test>', references: ['<thread@example.test>', '<original@example.test>'] } })
  assert.deepEqual(sent, { messageId: '<mock-outgoing@example.test>' })
  assert.equal(mock.requests.sent[0].headers['X-DS-SuperAgent-Command'], 'mail-command-one')
  assert.equal(mock.requests.sent[0].inReplyTo, '<original@example.test>')
  assert.deepEqual(mock.requests.sent[0].references, ['<thread@example.test>', '<original@example.test>'])
  assert.equal(mock.requests.closedSmtp, 2)
})

test('IMAP and SMTP require STARTTLS when the account uses the submission ports', async () => {
  const mock = mockModules()
  const transport = createImapSmtpTransport(mock.adapters)
  await transport.verify(starttlsAccount, 'fictional-app-password')
  const [imapOptions] = mock.requests.imapOptions
  const [smtpOptions] = mock.requests.smtpOptions
  assert.equal(imapOptions.secure, false)
  assert.equal(imapOptions.doSTARTTLS, true)
  assert.equal(smtpOptions.secure, false)
  assert.equal(smtpOptions.requireTLS, true)
  assert.equal(smtpOptions.opportunisticTLS, false)
})

test('verification closes both mock transports when either protocol refuses connection', async () => {
  for (const options of [{ failImapConnect: true }, { failSmtpVerify: true }]) {
    const mock = mockModules(options)
    const transport = createImapSmtpTransport(mock.adapters)
    await assert.rejects(transport.verify(secureAccount, 'fictional-app-password'))
    assert.equal(mock.requests.loggedOut, 1)
    assert.equal(mock.requests.closedSmtp, 1)
  }
})

test('configured Host factory loads its installed mail transport and keeps its OAuth callback fixed', async () => {
  const credentials = {
    async readRecord() { return undefined },
    async modifyRecord(_key, mutate) { return mutate(undefined) },
    async deleteRecord() {},
  }
  const manager = {
    async get() { return undefined },
    async create() { throw new Error('Credential creation is not part of this factory smoke test.') },
  }
  const products = await createConfiguredHostConnectorMailProducts({
    instanceId: 'fixture-instance',
    actorId: 'fixture-actor',
    context: { credentials },
    credentials: manager,
    imports: null,
    oauthApps: {},
  })
  try {
    assert.equal(products.metadata.mail, 'configured')
    const overview = await products.dispatch('mail-account-list',
      { instanceId: 'fixture-instance', scope: { role: 'main' } }, { local: true })
    assert.equal(overview.available, true)
    assert.equal(HOST_CONNECTOR_OAUTH_CALLBACK_URI, 'http://127.0.0.1:38517/callback')
  } finally { await products.close() }
})
