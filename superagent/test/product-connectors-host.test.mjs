import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

async function fixture(t, connectors, credentialImportAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'superagent-connector-contract-'))
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('Fixture is ready.'))
  await native.plugin(LocalCredentials, { path: join(root, 'fixture-records.yaml'), watch: false })
  const config = { databasePath: join(root, 'business.sqlite'), instanceId: 'personal', actorId: 'alice',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' }, connectors, ...(credentialImportAdapter ? { credentialImportAdapter } : {}) }
  let host = await createProductHost(native, config)
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const binding = await host.dispatch('open')
  return { binding,
    call: (endpoint, payload = {}, client) => host.dispatch(endpoint, { instanceId: binding.instanceId, scope: { role: 'main' }, ...payload }, client),
    restart: async () => { await host.close(); host = await createProductHost(native, config) } }
}

const redacted = (value, examples = []) => {
  const json = JSON.stringify(value)
  for (const field of ['clientSecret', 'client_secret', 'accessToken', 'access_token', 'code_verifier', 'vault-', ...examples]) {
    assert.equal(json.includes(`"${field}"`) || (examples.includes(field) || field === 'vault-') && json.includes(field), false)
  }
}

test('GitHub and Feishu complete a Host-local, single-use OAuth exchange', { timeout: 15000 }, async t => {
  let current
  const exchangeCalls = []
  let exchangeStarted
  let releaseExchange
  let exchangeQueued
  const fetch = async (address, options) => {
    const url = new URL(address)
    assert.equal(options.redirect, 'error')
    assert.equal(url.protocol, 'https:')
    if (options.method === 'POST') {
      const body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : JSON.parse(options.body)
      assert.equal(body.redirect_uri, current.redirect)
      assert.equal(body.code, 'fixture-authorization-code')
      assert.equal(body.client_id, `${current.provider}_fixture_id`)
      assert.equal(body.client_secret, `${current.provider}-fixture-app-secret`)
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), current.challenge)
      exchangeCalls.push(url.hostname)
      exchangeStarted()
      await exchangeQueued
      return Response.json({ ...(current.provider === 'feishu' ? { code: 0, expires_in: 3600 } : {}), access_token: `${current.provider}-fixture-grant` })
    }
    assert.equal(options.headers.authorization, `Bearer ${current.provider}-fixture-grant`)
    return Response.json(current.provider === 'github' ? { login: 'fixture-user' } : { code: 0, data: { open_id: 'fixture-user' } })
  }
  const { binding, call, restart } = await fixture(t, { oauth: { fetch, port: 0, ttlMs: 6000 } })
  const starters = (await call('connector-registry')).items
  assert.deepEqual(starters.map(item => item.state), ['not-configured', 'not-configured'])
  await assert.rejects(call('connector-registry', { scope: { role: 'worker', workItemId: 'item-one' } }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(call('connector-registry', { instanceId: 'other' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(call('connector-registry', { botId: 'legacy' }), { code: 'INVALID_INPUT' })
  const remote = { id: 'remote', label: 'Remote', grants: [{ instanceId: binding.instanceId, capabilities: ['read', 'command'] }], createdAt: 1 }
  const remoteRegistry = await call('connector-registry', {}, remote)
  assert.equal(remoteRegistry.readOnly, true)
  assert.equal(remoteRegistry.canStoreCredentials, false)
  assert.ok(remoteRegistry.items.every(item => item.clientId === null && item.redirectUri === null))
  await assert.rejects(call('connector-registry', {}, { ...remote, revokedAt: 2 }), { code: 'SOURCE_NOT_AUTHORIZED' })

  for (const provider of ['github', 'feishu']) {
    const config = { provider, commandId: `save-${provider}`, expectedRevision: 0,
      clientId: `${provider}_fixture_id`, clientSecret: `${provider}-fixture-app-secret` }
    const saved = await call('connector-save', config)
    assert.equal(saved.hasClientSecret, true)
    assert.equal(saved.state, 'configured')
    redacted(saved, [config.clientSecret])
    assert.deepEqual(await call('connector-save', config), saved)
    await assert.rejects(call('connector-save', { ...config, clientSecret: 'different-fixture-secret' }), { code: 'IDENTITY_CONFLICT' })
    await assert.rejects(call('connector-save', { ...config, commandId: 'stale-configuration' }), { code: 'CONFIG_REVISION_CONFLICT' })
    await assert.rejects(call('connector-auth', { action: 'start', provider }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
    const login = await call('connector-auth', { action: 'start', provider })
    assert.equal(login.state, 'pending')
    assert.match(login.openUrl, /^http:\/\/127\.0\.0\.1:\d+\/superagent\/oauth\/open\//u)
    assert.deepEqual((await call('connector-registry')).login, login)
    assert.deepEqual(await call('connector-auth', { action: 'status', provider, loginId: login.loginId }, remote),
      { loginId: login.loginId, state: 'pending' })
    assert.deepEqual((await call('connector-registry', {}, remote)).login, { loginId: login.loginId, state: 'pending' })
    await assert.rejects(call('connector-auth', { action: 'status', provider, loginId: 'missing-login' }), { code: 'CONNECTOR_LOGIN_NOT_FOUND' })
    const redirect = await globalThis.fetch(login.openUrl, { redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('referrer-policy'), 'no-referrer')
    const auth = new URL(redirect.headers.get('location'))
    assert.equal(auth.hostname, provider === 'github' ? 'github.com' : 'accounts.feishu.cn')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    const state = auth.searchParams.get('state')
    current = { redirect: auth.searchParams.get('redirect_uri'), challenge: auth.searchParams.get('code_challenge'), provider }
    assert.equal(JSON.stringify(login).includes(state), false)
    assert.equal(JSON.stringify(login).includes(current.challenge), false)
    redacted(login, [config.clientSecret])
    const callback = new URL(current.redirect)
    callback.searchParams.set('code', 'fixture-authorization-code')
    callback.searchParams.set('state', 'different-state')
    assert.equal((await globalThis.fetch(callback)).status, 400)
    callback.searchParams.set('state', state)
    assert.equal((await globalThis.fetch(callback, { headers: { origin: 'https://unrelated.example' } })).status, 400)
    assert.equal((await globalThis.fetch(callback, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403)
    const exchangeInProgress = new Promise(resolve => { exchangeStarted = resolve })
    exchangeQueued = new Promise(resolve => { releaseExchange = resolve })
    const authorization = globalThis.fetch(callback)
    await exchangeInProgress
    try {
      assert.equal((await globalThis.fetch(callback)).status, 400)
      const status = await call('connector-auth', { action: 'status', provider, loginId: login.loginId })
      assert.equal(status.state, 'pending')
      assert.equal(status.openUrl, undefined)
    } finally {
      releaseExchange()
    }
    assert.equal((await authorization).status, 200)
    const done = await call('connector-auth', { action: 'status', provider, loginId: login.loginId })
    assert.equal(done.state, 'authorized')
    assert.equal(done.openUrl, undefined)
    const item = (await call('connector-registry')).items.find(row => row.provider === provider)
    assert.equal(item.state, 'authorized')
    assert.equal(item.authorization, 'oauth')
    assert.equal(item.revision, 2)
    redacted(item, [config.clientSecret, `${provider}-fixture-grant`])
  }
  assert.deepEqual(exchangeCalls, ['github.com', 'open.feishu.cn'])
  await restart()
  assert.deepEqual((await call('connector-registry')).items.map(item => item.state), ['authorized', 'authorized'])
  const disconnected = await call('connector-auth', { action: 'disconnect', provider: 'github', expectedRevision: 2, commandId: 'disconnect-github' })
  assert.equal(disconnected.state, 'configured')
  assert.equal(disconnected.authorization, null)
})

test('OAuth cancellation and expiry invalidate the callback, and import verifies the scoped token', { timeout: 15000 }, async t => {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method })
    if (options.headers.authorization === 'Bearer fixture-import-grant') return Response.json({ login: 'fixture-user' })
    return Response.json({ code: 1 }, { status: 401 })
  }
  const adapter = {
    read: async (pendingId, credentialId, sourceRef) => ({ id: credentialId, sourceRef,
      value: pendingId === 'correct-export' ? 'fixture-import-grant' : 'invalid-fixture-grant' }),
  }
  const { call } = await fixture(t, { oauth: { fetch, port: 0, ttlMs: 250 } }, adapter)
  await call('connector-save', { provider: 'github', commandId: 'save-github', expectedRevision: 0,
    clientId: 'github_fixture_id', clientSecret: 'github-fixture-app-secret' })
  const first = await call('connector-auth', { action: 'start', provider: 'github' })
  assert.equal((await call('connector-auth', { action: 'cancel', provider: 'github', loginId: first.loginId })).state, 'cancelled')
  const pending = await call('connector-auth', { action: 'start', provider: 'github' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal((await call('connector-auth', { action: 'status', provider: 'github', loginId: pending.loginId })).state, 'expired')
  assert.deepEqual(calls, [])
  const input = { provider: 'github', commandId: 'import-github', expectedRevision: 1, credentialId: 'token', sourceRef: 'fixture-source' }
  await assert.rejects(call('connector-import', { ...input, pendingId: 'incorrect-export' }), { code: 'CONNECTOR_IMPORT_FAILED' })
  assert.equal((await call('connector-registry')).items[0].authorization, null)
  const imported = await call('connector-import', { ...input, pendingId: 'correct-export' })
  assert.equal(imported.authorization, 'imported')
  assert.equal(imported.state, 'authorized')
  redacted(imported, ['fixture-import-grant'])
  assert.deepEqual(await call('connector-import', { ...input, pendingId: 'correct-export' }), imported)
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ url: 'https://api.github.com/user', method: 'GET' })))
})

test('mailbox accounts, scoped rules, inbox and replies use redacted durable receipts', { timeout: 15000 }, async t => {
  const outgoing = []
  let fail = false
  const { call, restart } = await fixture(t, { mailbox: {
    verify: async (_account, password) => assert.equal(password, 'fixture-mail'),
    read: async () => [{ from: 'sender@example.com', replyTo: 'replies@example.com', messageId: '<test-msg@example.com>',
      subject: 'Invoice received', receivedAt: '2026-11-19T00:00:00.000Z', preview: '<b>Untrusted literal preview</b>' },
    { from: 'sender@example.com', replyTo: 'not an address', messageId: '<no-reply@example.com>', subject: 'No reply', preview: '', receivedAt: null }],
    reply: async (account, password, message) => {
      assert.equal(account.email, 'alice@example.com')
      assert.equal(password, 'fixture-mail')
      outgoing.push(message)
      if (fail) throw new Error('Unverified mail transport result.')
    },
  } })
  const account = { label: 'Mail fixture', email: 'alice@example.com', username: 'alice',
    incoming: { host: 'imap.example.com', port: 993 }, outgoing: { host: 'smtp.example.com', port: 465, security: 'tls' } }
  const input = { action: 'save', commandId: 'mail-save', expectedRevision: 0, account, password: 'fixture-mail' }
  await assert.rejects(call('mailbox-account', { ...input, account: { ...account, incoming: { ...account.incoming, url: 'not-allowed' } } }), { code: 'INVALID_INPUT' })
  const saved = await call('mailbox-account', input)
  const accountId = saved.id
  assert.equal(saved.revision, 1)
  redacted(saved, [input.password])
  assert.deepEqual(await call('mailbox-account', input), saved)
  assert.deepEqual(await call('mailbox-account', { action: 'check', accountId }), { verified: true })
  const ruleInput = { action: 'save', accountId, commandId: 'rule-save', expectedRevision: 0,
    rule: { label: 'Invoices', sender: 'sender@example.com', subjectContains: 'invoice', enabled: true } }
  const rule = await call('mailbox-rule', ruleInput)
  assert.equal(rule.revision, 1)
  assert.deepEqual(await call('mailbox-rule', { action: 'list', accountId }), { items: [rule] })
  await assert.rejects(call('mailbox-rule', { ...ruleInput, rule: { ...ruleInput.rule, enabled: false } }), { code: 'IDENTITY_CONFLICT' })
  const inbox = await call('mailbox-reply', { action: 'inbox', accountId })
  assert.deepEqual(inbox.items[0].rules, ['Invoices'])
  assert.equal(inbox.items[1].canReply, false)
  assert.equal(inbox.items[1].replyTo, null)
  assert.equal(inbox.items[0].replyTo, 'replies@example.com')
  redacted(inbox, [input.password, '<test-msg@example.com>'])
  const reply = { action: 'send', accountId, messageKey: inbox.items[0].key, text: 'Fixture reply.', commandId: 'send-fixture-reply' }
  await assert.rejects(call('mailbox-reply', { ...reply, to: 'other@example.com' }), { code: 'INVALID_INPUT' })
  await assert.rejects(call('mailbox-reply', { ...reply, messageKey: inbox.items[1].key }), { code: 'MAILBOX_MESSAGE_STALE' })
  assert.deepEqual(await call('mailbox-reply', reply), { status: 'sent' })
  assert.equal(outgoing[0].to, 'replies@example.com')
  assert.equal(outgoing[0].inReplyTo, '<test-msg@example.com>')
  assert.equal(outgoing[0].subject, 'Re: Invoice received')
  assert.equal(outgoing[0].text, reply.text)
  await restart()
  assert.deepEqual(await call('mailbox-account', { action: 'list' }), { items: [saved], canStoreCredentials: true })
  assert.deepEqual(await call('mailbox-reply', reply), { status: 'sent' })
  assert.equal(outgoing.length, 1)
  const refresh = (await call('mailbox-reply', { action: 'inbox', accountId })).items[0]
  const next = { ...reply, commandId: 'maybe-sent', messageKey: refresh.key }
  fail = true
  await assert.rejects(call('mailbox-reply', next), { code: 'MAILBOX_REPLY_UNKNOWN' })
  await assert.rejects(call('mailbox-reply', next), { code: 'MAILBOX_REPLY_UNKNOWN' })
  assert.equal(outgoing.length, 2)
  assert.deepEqual(await call('mailbox-account', { action: 'remove', accountId, expectedRevision: 1, commandId: 'remove-mail' }),
    { id: accountId, removed: true })
  await assert.rejects(call('mailbox-rule', { action: 'list', accountId }), { code: 'MAILBOX_NOT_FOUND' })
})
