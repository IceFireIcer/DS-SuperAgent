import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { build } from 'esbuild'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const buildDirectory = await mkdtemp(join(pluginRoot, '.test-connectors-'))
const runtimeDirectory = join(buildDirectory, 'runtime')
await build({ entryPoints: [join(pluginRoot, 'src/connectors/index.ts'),
  join(pluginRoot, 'src/product-credential-manager.ts'), join(pluginRoot, 'src/storage.ts'),
  join(pluginRoot, 'src/sqlite-worker.ts')], outbase: join(pluginRoot, 'src'), outdir: runtimeDirectory,
  bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external', logLevel: 'silent' })
const product = await import(`${pathToFileURL(join(runtimeDirectory, 'connectors', 'index.js')).href}?v=${Date.now()}`)
const { ProductCredentialManager } = await import(pathToFileURL(
  join(runtimeDirectory, 'product-credential-manager.js')).href)
after(async () => { await rm(buildDirectory, { recursive: true, force: true }) })

class MemoryRecords {
  constructor() { this.records = new Map() }

  async readRecord(key) {
    const value = this.records.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async modifyRecord(key, mutate) {
    const current = this.records.get(key)
    const next = await mutate(current === undefined ? undefined : structuredClone(current))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, structuredClone(next))
    return next === undefined ? undefined : structuredClone(next)
  }

  async deleteRecord(key) { this.records.delete(key) }

  json() { return JSON.stringify([...this.records.values()]) }
}

class MemoryStorage {
  records = new Map()

  async transaction(instanceId, operation) {
    const key = (kind, id) => `${instanceId}\0${kind}\0${id}`
    const tx = {
      instanceId,
      get: async (kind, id) => this.records.has(key(kind, id))
        ? structuredClone(this.records.get(key(kind, id))) : undefined,
      insert: async (kind, id, value) => {
        const recordKey = key(kind, id)
        if (this.records.has(recordKey)) throw new Error('Duplicate storage record.')
        this.records.set(recordKey, structuredClone(value))
      },
      replace: async (kind, id, value) => {
        const recordKey = key(kind, id)
        if (!this.records.has(recordKey)) return false
        this.records.set(recordKey, structuredClone(value))
        return true
      },
      remove: async (kind, id) => this.records.delete(key(kind, id)),
      list: async (kind, limit) => [...this.records.entries()]
        .filter(([recordKey]) => recordKey.startsWith(`${instanceId}\0${kind}\0`))
        .slice(0, limit).map(([, value]) => structuredClone(value)),
      scan: async (kind, { limit, after }) => {
        const all = [...this.records.entries()]
          .filter(([recordKey]) => recordKey.startsWith(`${instanceId}\0${kind}\0`))
          .map(([recordKey, value]) => ({ id: recordKey.slice(recordKey.lastIndexOf('\0') + 1), value }))
          .filter(item => after === undefined || item.id > after)
          .sort((left, right) => left.id.localeCompare(right.id))
        const items = all.slice(0, limit).map(item => ({ id: item.id, value: structuredClone(item.value) }))
        return { items, ...(all.length > limit ? { cursor: items.at(-1).id } : {}) }
      },
    }
    return operation(tx)
  }

  async reconnect() { return this }
  async close() {}
}

function fakeOAuth() {
  const attempts = new Map()
  return {
    state: 'pending',
    finished: false,
    async start() {
      const attemptId = randomUUID()
      attempts.set(attemptId, { state: 'pending' })
      return { attemptId, authorizationUrl: 'https://auth.example/authorize?state=host-local',
        kind: 'browser', expiresAt: Date.now() + 60_000 }
    },
    async status(attemptId) {
      const attempt = attempts.get(attemptId)
      assert.ok(attempt)
      return { state: attempt.state === 'pending' ? this.state : attempt.state, ...(attempt.state === 'error' ? { errorCode: 'OAUTH_DENIED' } : {}) }
    },
    async credential(attemptId) {
      assert.ok(attempts.has(attemptId))
      return { value: JSON.stringify({ accessToken: 'oauth-access-secret', refreshToken: 'oauth-refresh-secret' }),
        account: 'octo' }
    },
    async finish() { this.finished = true },
    async cancel(attemptId) { attempts.set(attemptId, { state: 'cancelled' }) },
    async close() {},
  }
}

function fakeMail({ failSend = false } = {}) {
  const calls = { verify: [], search: [], read: [], send: [] }
  return {
    calls,
    async verify(account, password) { calls.verify.push({ account, password }); return { account: account.address } },
    async search(input) {
      calls.search.push(input)
      return [{ uid: '7', folder: 'INBOX', from: 'sender@example.test', to: 'person@example.test',
        subject: 'Question', date: '2026-11-20T00:00:00.000Z', seen: false }]
    },
    async read(input) {
      calls.read.push(input)
      return { messages: [{ uid: input.uid, folder: input.folder ?? 'INBOX', from: 'Sender <sender@example.test>',
        to: 'person@example.test', cc: 'team@example.test', subject: 'Question', date: '2026-11-20T00:00:00.000Z',
        text: 'Hello from the original message.', messageId: '<original@example.test>', references: ['<root@example.test>'] }] }
    },
    async send(input) {
      calls.send.push(input)
      if (failSend) throw new Error('Mock SMTP accepted the message but lost the receipt.')
      return { messageId: '<reply@example.test>' }
    },
  }
}

function fakeImports() {
  return {
    async scan() {
      return [{ id: 'cursor:one', name: 'Imported MCP', source: 'Cursor', transport: 'http',
        envNames: ['IMPORTED_TOKEN'], headerNames: [] }]
    },
    async read(sourceId) {
      assert.equal(sourceId, 'cursor:one')
      return { name: 'Imported MCP', url: 'https://mcp.example.test/mcp', env: { IMPORTED_TOKEN: 'import-secret-value' } }
    },
  }
}

async function fixture(t, overrides = {}) {
  const records = new MemoryRecords()
  const storage = new MemoryStorage()
  const credentials = new ProductCredentialManager(storage, 'personal', records)
  const oauth = overrides.oauth ?? fakeOAuth()
  const mailTransport = overrides.mailTransport ?? fakeMail()
  const imports = Object.hasOwn(overrides, 'imports') ? overrides.imports : fakeImports()
  const products = product.createConnectorMailProducts({ instanceId: 'personal', actorId: 'alice',
    records, credentials, oauth, ...(imports ? { imports } : {}), ...(mailTransport ? { mailTransport } : {}),
    verifier: { async verify() { return { account: 'octo' } } } })
  t.after(async () => {
    await products.close()
    await storage.close()
  })
  return { products, credentials, records, oauth, mailTransport, storage }
}

const local = { local: true }
const target = { role: 'main' }
const forbidden = 'credential-secret-value'

function assertNoSecret(value, secret) {
  assert.equal(JSON.stringify(value).includes(secret), false)
}

test('connector token writes stay in ProductCredential and are scoped to target and actor', { timeout: 30000 }, async t => {
  const { products, credentials, records } = await fixture(t)
  await assert.rejects(products.dispatch('unknown-connector-action', {}, local), { code: 'UNAVAILABLE' })
  await assert.rejects(products.dispatch('connector-list', { scope: target }, { local: false }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(products.dispatch('connector-list', { target, botId: 'legacy-main' }, local),
    { code: 'INVALID_INPUT' })
  await assert.rejects(products.dispatch('connector-list', { instanceId: 'other', scope: target }, local),
    { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(products.dispatch('connector-list', { scope: target, target }, local),
    { code: 'INVALID_INPUT' })
  const before = await products.dispatch('connector-list', { target }, local)
  assert.equal(before.items.find(item => item.id === 'github').status, 'off')
  const remoteBefore = await products.dispatch('connector-list', { instanceId: 'personal', scope: target },
    { local: false, capabilities: ['read'] })
  assert.equal(remoteBefore.items.find(item => item.id === 'github').status, 'off')
  await assert.rejects(products.dispatch('connector-token-save', { commandId: 'remote-token',
    connectorId: 'github', value: forbidden, scope: target }, { local: false, capabilities: ['command'] }),
  { code: 'SOURCE_NOT_AUTHORIZED' })
  const saved = await products.dispatch('connector-token-save', { commandId: 'token-one', connectorId: 'github',
    value: forbidden, target }, local)
  assert.equal(saved.status, 'ready')
  assert.equal(saved.credentialKind, 'token')
  assertNoSecret(saved, forbidden)
  const listed = await products.dispatch('connector-list', { target }, local)
  assertNoSecret(listed, forbidden)
  const remoteListed = await products.dispatch('connector-list', { instanceId: 'personal', scope: target },
    { local: false, capabilities: ['read'] })
  assertNoSecret(remoteListed, forbidden)
  const resource = (await credentials.list({ instanceId: 'personal' })).items[0]
  assert.equal(await credentials.use({ instanceId: 'personal', resourceId: resource.id, role: 'main', purpose: 'tool' },
    async value => value === forbidden), true)
  assert.equal(JSON.stringify(records.json()).includes(forbidden), true)
  assert.equal([...records.records.values()].filter(record => record.kind === 'grant')
    .some(record => JSON.stringify(record).includes(forbidden)), false)
  const other = await products.dispatch('connector-list', { target: { role: 'worker', workItemId: 'other-work' } }, local)
  assert.equal(other.items.find(item => item.id === 'github').status, 'off')
  const disconnected = await products.dispatch('connector-disconnect', { commandId: 'disconnect-one',
    connectorId: 'github', target }, local)
  assert.equal(disconnected.credentialKind, undefined)
  assert.equal((await credentials.list({ instanceId: 'personal' })).items.every(item => item.status === 'deleted'), true)
  assert.equal([...records.records.keys()].some(key => key.startsWith('ds-superagent-profile/vault-')), false)
})

test('catalog connectors without credentials register, connect, and disconnect without inventing secrets', { timeout: 30000 }, async t => {
  const { products } = await fixture(t)
  await assert.rejects(products.dispatch('connector-save', { commandId: 'bad-readonly', connectorId: 'exa',
    readOnly: 'yes', target }, local), { code: 'INVALID_INPUT' })
  await assert.rejects(products.dispatch('connector-save', { commandId: 'insecure-loopback-name', name: 'Unsafe local',
    url: 'http://127.example.test/mcp', target }, local), { code: 'INVALID_INPUT' })
  const connected = await products.dispatch('connector-save', { commandId: 'no-auth-connect',
    connectorId: 'exa', target }, local)
  assert.equal(connected.status, 'configured')
  assert.equal(connected.auth.kind, 'none')
  assert.equal(connected.secretCount, 0)
  const disconnected = await products.dispatch('connector-disconnect', { commandId: 'no-auth-disconnect',
    connectorId: 'exa', target }, local)
  assert.equal(disconnected.status, 'off')
  const loopback = await products.dispatch('connector-save', { commandId: 'loopback-connect', name: 'Local MCP',
    url: 'http://127.0.0.1:3333/mcp', target }, { local: true })
  assert.equal(loopback.status, 'needs-authorization')
})

test('Feishu links an existing resource without taking ownership of it', { timeout: 30000 }, async t => {
  const { products, credentials } = await fixture(t)
  const sourceInstanceId = 'feishu:tenant:chat'
  const created = await credentials.create({ instanceId: 'personal', commandId: 'feishu-resource',
    label: 'Feishu app', value: 'feishu-app-secret' })
  const granted = await credentials.grant({ instanceId: 'personal', commandId: 'feishu-grant',
    resourceId: created.id, expectedRevision: created.revision,
    scope: { role: 'main', sourceInstanceId }, purposes: ['source'] })
  const view = await products.dispatch('connector-credential-bind', { commandId: 'bind-feishu',
    connectorId: 'feishu', resourceId: created.id, target: { role: 'main', sourceInstanceId } }, local)
  assert.equal(view.status, 'ready')
  assert.equal(view.credentialKind, 'linked')
  assert.ok(granted.grants.length > 0)
  await products.dispatch('connector-disconnect', { commandId: 'unbind-feishu', connectorId: 'feishu',
    target: { role: 'main', sourceInstanceId } }, local)
  assert.equal((await credentials.get({ instanceId: 'personal', resourceId: created.id })).status, 'active')
})

test('OAuth status stores the callback result while exposing only safe state', { timeout: 30000 }, async t => {
  const { products, credentials, records, oauth } = await fixture(t)
  const started = await products.dispatch('connector-oauth-start', { commandId: 'oauth-one',
    connectorId: 'github', target }, local)
  assert.equal(started.state, 'pending')
  assert.match(started.authorizationUrl, /^https:\/\//u)
  assertNoSecret(started, 'oauth-access-secret')
  oauth.state = 'completed'
  const completed = await products.dispatch('connector-oauth-status', { attemptId: started.attemptId }, local)
  assert.equal(completed.state, 'completed')
  assert.equal(completed.account, 'octo')
  assert.equal(oauth.finished, true)
  assertNoSecret(completed, 'oauth-access-secret')
  const list = await products.dispatch('connector-list', { target }, local)
  assert.equal(list.items.find(item => item.id === 'github').status, 'ready')
  assertNoSecret(list, 'oauth-access-secret')
  const resource = (await credentials.list({ instanceId: 'personal' })).items[0]
  const stored = await credentials.use({ instanceId: 'personal', resourceId: resource.id, role: 'main', purpose: 'tool' },
    async value => value)
  assert.match(stored, /oauth-access-secret/u)
  assert.equal([...records.records.values()].filter(record => record.kind === 'grant')
    .some(record => JSON.stringify(record).includes('oauth-access-secret')), false)
})

test('remote OAuth status returns loginId and pending only, never a redirect URL', { timeout: 30000 }, async t => {
  const { products } = await fixture(t)
  const started = await products.dispatch('connector-oauth-start', { commandId: 'remote-oauth-start',
    connectorId: 'github', scope: target }, local)
  await assert.rejects(products.dispatch('connector-oauth-start', { commandId: 'remote-oauth',
    connectorId: 'github', scope: target }, { local: false, capabilities: ['command'] }),
  { code: 'SOURCE_NOT_AUTHORIZED' })
  const remote = await products.dispatch('connector-oauth-status', { instanceId: 'personal', attemptId: started.attemptId },
    { local: false, capabilities: ['read'] })
  assert.deepEqual(remote, { loginId: started.attemptId, state: 'pending' })
  const remoteList = await products.dispatch('connector-list', { instanceId: 'personal', scope: target },
    { local: false, capabilities: ['read'] })
  const remotePending = remoteList.items.find(item => item.id === 'github').pending
  assert.deepEqual(remotePending, { loginId: started.attemptId, state: 'pending' })
  assert.equal(JSON.stringify(remoteList).includes(started.authorizationUrl), false)
  await assert.rejects(products.dispatch('connector-oauth-status', { attemptId: started.attemptId },
    { local: false, capabilities: [] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(products.dispatch('connector-oauth-cancel', { commandId: 'remote-cancel',
    attemptId: started.attemptId }, { local: false, capabilities: ['command'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
})

test('the Host loopback OAuth broker completes registered GitHub and Feishu flows', { timeout: 30000 }, async () => {
  const requests = []
  const broker = new product.HostLoopbackOAuthBroker({
    clients: {
      github: { authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://token.example/github/oauth', clientId: 'github-public-client', scopes: ['repo'],
        whoami: { url: 'https://api.example/user', field: 'login' } },
      feishu: { authorizationUrl: 'https://accounts.example/authorize',
        tokenUrl: 'https://open.example/oauth/token', clientId: 'cli_registered', clientSecret: 'app-secret',
        authorizationClientIdParameter: 'app_id', tokenClientIdParameter: 'app_id',
        tokenClientSecretParameter: 'app_secret', tokenRequestFormat: 'json', tokenResponsePath: ['data'],
        whoami: { url: 'https://open.example/user', field: 'data.name' } },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('/github/oauth')) return new Response(JSON.stringify({ access_token: 'callback-access-secret',
        refresh_token: 'callback-refresh-secret', expires_in: 3600 }), { status: 200 })
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ code: 0,
        data: { access_token: 'feishu-access-secret', refresh_token: 'feishu-refresh-secret', expires_in: 3600 } }), { status: 200 })
      if (String(url).includes('open.example/user')) return new Response(JSON.stringify({ code: 0,
        data: { name: 'Alice' } }), { status: 200 })
      return new Response(JSON.stringify({ login: 'octo' }), { status: 200 })
    },
  })
  const started = await broker.start({ connectorId: 'github', scopes: ['repo'] })
  const authorization = new URL(started.authorizationUrl)
  const redirect = new URL(authorization.searchParams.get('redirect_uri'))
  assert.equal(redirect.href, product.HOST_CONNECTOR_OAUTH_CALLBACK_URI)
  const state = authorization.searchParams.get('state')
  const wrong = await fetch(`${redirect.href}?code=wrong&state=wrong`)
  assert.equal(wrong.status, 400)
  assert.equal((await broker.status(started.attemptId)).state, 'pending')
  const callback = await fetch(`${redirect.href}?code=github-host-code&state=${encodeURIComponent(state)}`)
  assert.equal(callback.status, 200)
  assert.equal((await broker.status(started.attemptId)).state, 'completed')
  assertNoSecret(await broker.status(started.attemptId), 'callback-access-secret')
  const credential = await broker.credential(started.attemptId)
  assert.match(credential.value, /callback-access-secret/u)
  await broker.finish(started.attemptId)
  await assert.rejects(broker.credential(started.attemptId), { code: 'OAUTH_ATTEMPT_CONSUMED' })
  assert.equal(requests.some(request => request.init?.body?.toString().includes('github-host-code')), true)
  const feishu = await broker.start({ connectorId: 'feishu', scopes: [] })
  const auth = new URL(feishu.authorizationUrl)
  assert.equal(auth.searchParams.get('app_id'), 'cli_registered')
  assert.equal(auth.searchParams.has('client_id'), false)
  const feishuRedirect = new URL(auth.searchParams.get('redirect_uri'))
  const feishuCallback = await fetch(`${feishuRedirect.href}?code=feishu-host-code&state=${encodeURIComponent(auth.searchParams.get('state'))}`)
  assert.equal(feishuCallback.status, 200)
  const feishuCredential = await broker.credential(feishu.attemptId)
  assert.match(feishuCredential.value, /feishu-access-secret/u)
  assert.equal(feishuCredential.account, 'Alice')
  const feishuTokenRequest = requests.find(request => request.url.includes('/oauth/token'))
  assert.equal(feishuTokenRequest.init.headers['content-type'], 'application/json')
  const feishuBody = JSON.parse(feishuTokenRequest.init.body)
  assert.equal(feishuBody.app_id, 'cli_registered')
  assert.equal(feishuBody.app_secret, 'app-secret')
  assert.equal(feishuBody.code, 'feishu-host-code')

  const unsafeOverride = new product.HostLoopbackOAuthBroker({
    clients: {
      github: { authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://token.example/github/oauth', clientId: 'github-public-client',
        extraAuthorizationParams: { redirect_uri: 'https://attacker.example/callback' } },
    },
  })
  await assert.rejects(unsafeOverride.start({ connectorId: 'github', scopes: ['repo'] }),
    { code: 'INVALID_CONFIG' })
  await unsafeOverride.close()

  const insecureAccount = new product.HostLoopbackOAuthBroker({
    clients: {
      github: { authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://token.example/github/oauth', clientId: 'github-public-client',
        whoami: { url: 'http://api.example/user', field: 'login' } },
    },
  })
  await assert.rejects(insecureAccount.start({ connectorId: 'github', scopes: ['repo'] }),
    { code: 'INVALID_CONFIG' })
  await insecureAccount.close()
})

test('connector import stores values in the vault and never projects them', { timeout: 30000 }, async t => {
  const { products, credentials, records } = await fixture(t)
  const scanned = await products.dispatch('connector-import-scan', {}, local)
  assert.deepEqual(scanned[0].envNames, ['IMPORTED_TOKEN'])
  assert.equal(JSON.stringify(scanned).includes('import-secret-value'), false)
  const imported = await products.dispatch('connector-import-commit', { commandId: 'import-one',
    sourceId: 'cursor:one', target }, local)
  assert.equal(imported.custom, true)
  assert.equal(imported.status, 'configured')
  assert.equal(imported.secretCount, 1)
  assertNoSecret(imported, 'import-secret-value')
  const resource = (await credentials.list({ instanceId: 'personal' })).items[0]
  assert.equal(await credentials.use({ instanceId: 'personal', resourceId: resource.id, role: 'main', purpose: 'tool' },
    async value => value === 'import-secret-value'), true)
  assert.equal([...records.records.values()].filter(record => record.kind === 'grant')
    .some(record => JSON.stringify(record).includes('import-secret-value')), false)
  const withToken = await products.dispatch('connector-token-save', { commandId: 'import-token',
    connectorId: imported.id, value: 'imported-connector-token', target }, local)
  assert.equal(withToken.status, 'ready')
  assert.equal(withToken.auth.kind, 'token')
  assertNoSecret(withToken, 'imported-connector-token')
})

test('unwired connector import fails closed with a readable code', { timeout: 30000 }, async t => {
  const { products } = await fixture(t, { imports: undefined })
  await assert.rejects(products.dispatch('connector-import-scan', {}, local),
    { code: 'CONNECTOR_IMPORT_UNAVAILABLE' })
})

test('Host connector import scans only configured fixed files and projects secret names only', async () => {
  const source = JSON.stringify({ mcpServers: { Local: { command: 'node', args: ['server.mjs'],
    env: { API_TOKEN: 'fixed-file-import-secret' } } } })
  const adapter = new product.HostConnectorImportAdapter({ files: [
    { id: 'approved-config', label: 'Approved config', path: join(tmpdir(), 'fixed-mcp.json') },
  ], readFile: async path => {
    assert.equal(path, join(tmpdir(), 'fixed-mcp.json'))
    return source
  } })
  const scan = await adapter.scan()
  assert.equal(scan.length, 1)
  assert.deepEqual(scan[0].envNames, ['API_TOKEN'])
  assert.equal(JSON.stringify(scan).includes('fixed-file-import-secret'), false)
  const config = await adapter.read(scan[0].id)
  assert.equal(config.env.API_TOKEN, 'fixed-file-import-secret')
  assert.equal(JSON.stringify(scan[0]).includes(join(tmpdir(), 'fixed-mcp.json')), false)
})

test('mail accounts, rules, search, and reply enforce target authorization', { timeout: 30000 }, async t => {
  const mailTransport = fakeMail()
  const { products, credentials, records } = await fixture(t, { mailTransport })
  const missing = product.createConnectorMailProducts({ instanceId: 'personal', actorId: 'alice',
    records, credentials })
  const unavailable = await missing.dispatch('mail-account-list', { target }, local)
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.unavailableCode, 'MAIL_TRANSPORT_UNAVAILABLE')
  await assert.rejects(missing.dispatch('mail-account-save', { commandId: 'no-mail', address: 'person@example.test',
    password: 'mail-password', target }, local), { code: 'MAIL_TRANSPORT_UNAVAILABLE' })
  await missing.close()
  await assert.rejects(products.dispatch('mail-account-save', { commandId: 'mail-one', address: 'person@example.test',
    password: 'mail-password', provider: 'gmail', target }, { local: false }), { code: 'SOURCE_NOT_AUTHORIZED' })
  const saved = await products.dispatch('mail-account-save', { commandId: 'mail-one', address: 'person@example.test',
    password: 'mail-password', provider: 'gmail', target }, local)
  assert.equal(saved.accounts.length, 1)
  assertNoSecret(saved, 'mail-password')
  assert.equal(JSON.stringify(mailTransport.calls.verify[0].account).includes('mail-password'), false)
  const search = await products.dispatch('mail-search', { target, query: 'question' }, local)
  assert.equal(search.items[0].subject, 'Question')
  assertNoSecret(search, 'mail-password')
  const read = await products.dispatch('mail-read', { target, uid: '7', folder: 'INBOX' }, local)
  assert.match(read.messages[0].text, /original message/u)
  const reply = await products.dispatch('mail-reply', { commandId: 'reply-one', target, uid: '7',
    folder: 'INBOX', body: 'Thanks for the note.' }, local)
  assert.equal(reply.status, 'pending-approval')
  assert.equal(reply.to, 'sender@example.test')
  assertNoSecret(reply, 'mail-password')
  const sent = await products.dispatch('mail-reply-send', { commandId: 'reply-send', replyId: reply.replyId,
    target }, local)
  assert.equal(sent.status, 'sent')
  assert.equal(mailTransport.calls.send.length, 1)
  assert.equal(mailTransport.calls.send[0].message.text, 'Thanks for the note.')
  const otherTarget = await products.dispatch('mail-account-list',
    { target: { role: 'worker', workItemId: 'other-work' } }, local)
  assert.deepEqual(otherTarget.accounts, [])
  assert.equal([...records.records.values()].filter(record => record.kind === 'grant')
    .some(record => JSON.stringify(record).includes('mail-password')), false)
  await assert.rejects(products.dispatch('mail-rule-save', { commandId: 'bad-rule', target,
    mode: 'allow-recipients', recipients: [] }, local), { code: 'INVALID_INPUT' })
  const direct = await products.dispatch('mail-rule-save', { commandId: 'direct-rule', target,
    mode: 'direct' }, local)
  assert.equal(direct.mode, 'direct')
  await products.dispatch('mail-rule-save', { commandId: 'approval-rule', target,
    mode: 'require-approval' }, local)
  const remoteSearch = await products.dispatch('mail-search', { instanceId: 'personal', scope: target,
    query: 'question' }, { local: false, capabilities: ['read'] })
  assert.equal(remoteSearch.items[0].uid, '7')
  const remoteReply = await products.dispatch('mail-reply', { commandId: 'remote-reply', instanceId: 'personal',
    scope: target, uid: '7', body: 'Remote reply' }, { local: false, capabilities: ['command'] })
  assert.equal(remoteReply.status, 'pending-approval')
  await assert.rejects(products.dispatch('mail-reply', { commandId: 'no-reply', scope: target,
    uid: '7', body: 'Denied' }, { local: false, capabilities: ['read'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
})

test('an uncertain SMTP receipt is not silently sent twice', { timeout: 30000 }, async t => {
  const mailTransport = fakeMail({ failSend: true })
  const { products } = await fixture(t, { mailTransport })
  await products.dispatch('mail-account-save', { commandId: 'uncertain-account',
    address: 'person@example.test', password: 'fictional-mail-password', provider: 'gmail', target }, local)
  await products.dispatch('mail-rule-save', { commandId: 'uncertain-rule', mode: 'direct', target }, local)
  const command = { commandId: 'uncertain-reply', target, uid: '7', body: 'Check delivery.' }
  await assert.rejects(products.dispatch('mail-reply', command, local), { code: 'MAIL_SEND_UNKNOWN' })
  await assert.rejects(products.dispatch('mail-reply', command, local), { code: 'MAIL_SEND_UNKNOWN' })
  assert.equal(mailTransport.calls.send.length, 1)
})

test('mail supports custom IMAP/SMTP accounts, explicit account selection, and durable pending replies', { timeout: 30000 }, async t => {
  const mailTransport = fakeMail()
  const { products } = await fixture(t, { mailTransport })
  const first = await products.dispatch('mail-account-save', { commandId: 'gmail-account',
    address: 'person@gmail.com', password: 'gmail-password', provider: 'gmail', target }, local)
  assert.equal(first.accounts.length, 1)
  const second = await products.dispatch('mail-account-save', { commandId: 'custom-account',
    address: 'person@example.test', password: 'custom-password', provider: 'other',
    imap: { host: 'imap.example.test', port: 993, secure: true },
    smtp: { host: 'smtp.example.test', port: 587, secure: false, starttls: true }, target }, local)
  assert.equal(second.accounts.length, 2)
  assert.equal(mailTransport.calls.verify[1].account.imap.host, 'imap.example.test')
  assert.equal(mailTransport.calls.verify[1].account.smtp.starttls, true)
  await assert.rejects(products.dispatch('mail-search', { target, query: 'question' }, local),
    { code: 'MAIL_ACCOUNT_REQUIRED' })
  const gmail = second.accounts.find(account => account.address === 'person@gmail.com')
  assert.ok(gmail)
  const searched = await products.dispatch('mail-search', { target, accountId: gmail.id, query: 'question' }, local)
  assert.equal(searched.items[0].uid, '7')
  const pending = await products.dispatch('mail-reply', { commandId: 'durable-reply', target,
    accountId: gmail.id, uid: '7', folder: 'INBOX', body: 'A durable draft.' }, local)
  assert.equal(pending.status, 'pending-approval')
  const overview = await products.dispatch('mail-account-list', { target }, local)
  assert.deepEqual(overview.replies.map(reply => [reply.replyId, reply.status, reply.body]),
    [[pending.replyId, 'pending-approval', 'A durable draft.']])
  assertNoSecret(overview, 'gmail-password')
  const remoteRead = await products.dispatch('mail-account-list', { instanceId: 'personal', scope: target },
    { local: false, capabilities: ['read'] })
  assert.equal(remoteRead.replies[0].replyId, pending.replyId)
  assertNoSecret(remoteRead, 'gmail-password')
  await assert.rejects(products.dispatch('mail-reply-send', { commandId: 'remote-rule-change',
    replyId: pending.replyId, rule: 'direct', scope: target },
  { local: false, capabilities: ['command'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  const sent = await products.dispatch('mail-reply-send', { commandId: 'remote-send', replyId: pending.replyId,
    instanceId: 'personal', scope: target }, { local: false, capabilities: ['command'] })
  assert.equal(sent.status, 'sent')
  assert.deepEqual((await products.dispatch('mail-account-list', { target }, local)).replies, [])
  await assert.rejects(products.dispatch('mail-read', { target, accountId: gmail.id, uid: 'not-a-uid' }, local),
    { code: 'INVALID_INPUT' })
  await assert.rejects(products.dispatch('mail-rule-save', { commandId: 'remote-rule', mode: 'direct', scope: target },
    { local: false, capabilities: ['command'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(products.dispatch('mail-account-save', { commandId: 'remote-account',
    address: 'remote@example.test', password: 'remote-password', provider: 'gmail', scope: target },
  { local: false, capabilities: ['command'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(products.dispatch('connector-import-scan', {},
    { local: false, capabilities: ['command'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
})

test('Host app registration config stays out of every product response', async t => {
  const { records, credentials } = await fixture(t)
  const apps = product.connectorOAuthAppsFromEnvironment({
    DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_ID: 'github-client-id',
    DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_SECRET: 'github-client-secret',
    DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_ID: 'cli_feishu_app',
    DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_SECRET: 'feishu-app-secret',
  })
  assert.equal(apps.github.clientId, 'github-client-id')
  assert.equal(apps.feishu.clientId, 'cli_feishu_app')
  const host = product.createHostConnectorMailProducts({ instanceId: 'personal', actorId: 'alice',
    context: { credentials: records }, credentials, oauthApps: apps, imports: null,
    mailTransport: fakeMail() })
  t.after(() => host.close())
  const list = await host.dispatch('connector-list', { instanceId: 'personal', scope: target }, local)
  assertNoSecret(list, 'github-client-secret')
  assertNoSecret(list, 'feishu-app-secret')
  assert.deepEqual(host.metadata.oauthProviders.sort(), ['feishu', 'github'])
  await assert.rejects(host.dispatch('connector-oauth-start', { commandId: 'ui-client', connectorId: 'github',
    clientSecret: 'ui-injected-secret', scope: target }, local), { code: 'INVALID_INPUT' })
  await host.close()

  const unconfigured = product.createHostConnectorMailProducts({ instanceId: 'personal', actorId: 'alice',
    context: { credentials: records }, credentials, oauthApps: {}, imports: null, mailTransport: fakeMail() })
  t.after(() => unconfigured.close())
  const settings = await unconfigured.dispatch('connector-list', { instanceId: 'personal', scope: target }, local)
  assert.equal(settings.items.find(item => item.id === 'github').authorizationAvailable, false)
  await assert.rejects(unconfigured.dispatch('connector-oauth-start', { commandId: 'unconfigured-oauth',
    connectorId: 'github', scope: target }, local), { code: 'OAUTH_CLIENT_UNAVAILABLE' })
  assert.throws(() => product.createHostConnectorOAuthBroker({ apps: {
    github: { clientId: 'registered-client-without-secret' },
  } }), { code: 'INVALID_CONFIG' })
})
