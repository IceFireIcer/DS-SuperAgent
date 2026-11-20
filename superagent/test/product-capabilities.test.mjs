import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))

async function loadCapabilities(root) {
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await build({
    entryPoints: [join(plugin, 'src/storage.ts'), join(plugin, 'src/sqlite-worker.ts')],
    outdir: root,
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: true,
    logLevel: 'silent',
  })
  const { outputFiles } = await build({
    entryPoints: [join(plugin, 'src/product-capabilities.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const bundle = join(root, 'product-capabilities.mjs')
  await writeFile(bundle, outputFiles[0].text)
  const module = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`)
  const storage = await import(`${pathToFileURL(join(root, 'storage.js')).href}?v=${Date.now()}`)
  return { ...module, SqliteStorage: storage.SqliteStorage }
}

async function loadExecutionRuntime(root) {
  await build({
    entryPoints: {
      engine: join(plugin, 'src/engine.ts'),
      'local-environment': join(plugin, 'src/local-environment.ts'),
      'native-sessions': join(plugin, 'src/native-sessions.ts'),
      storage: join(plugin, 'src/storage.ts'),
      'sqlite-worker': join(plugin, 'src/sqlite-worker.ts'),
    },
    outdir: root,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    write: true,
    logLevel: 'silent',
  })
  const [engine, environment, sessions, storage] = await Promise.all([
    import(`${pathToFileURL(join(root, 'engine.js')).href}?v=${Date.now()}`),
    import(`${pathToFileURL(join(root, 'local-environment.js')).href}?v=${Date.now()}`),
    import(`${pathToFileURL(join(root, 'native-sessions.js')).href}?v=${Date.now()}`),
    import(`${pathToFileURL(join(root, 'storage.js')).href}?v=${Date.now()}`),
  ])
  return { ...engine, ...environment, ...sessions, ...storage }
}

async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Capability execution did not reach ${label}.`)
    await sleep(20)
  }
}

async function seedResource(storage, grants = []) {
  const resource = {
    id: 'resource-one',
    instanceId: 'personal',
    label: 'Fixture MCP credential',
    status: 'active',
    revision: grants.length ? 2 : 1,
    grants,
    createdAt: 1,
    updatedAt: 1,
  }
  await storage.transaction('personal', async tx => {
    if (!await tx.replace('resource-credential', resource.id, resource)) {
      await tx.insert('resource-credential', resource.id, resource)
    }
  })
  return resource
}

const mcp = {
  resourceId: 'resource-one',
  serverName: 'review',
  toolName: 'check',
  url: 'https://mcp.example.test/mcp',
}

test('capability commands enforce Host authorization, revisions, exact grants and idempotent receipts', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-capabilities-'))
  const module = await loadCapabilities(root)
  const { createProductCapabilities, dispatchProductCapabilityEndpoint, productCapabilityEndpointFields,
    SqliteStorage } = module
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  let authorized = true
  let authorizationCalls = 0
  const authorize = async () => {
    authorizationCalls++
    if (!authorized) throw Object.assign(new Error('The Host admission is closed.'), { code: 'SOURCE_NOT_AUTHORIZED' })
  }
  await seedResource(storage)
  const service = createProductCapabilities({ storage, instanceId: 'personal', authorize })

  const save = {
    instanceId: 'personal',
    commandId: 'save-review-tools',
    expectedRevision: 0,
    name: 'review-tools',
    kind: 'mcp',
    description: 'Review tools',
    mcp,
  }
  const saved = await service.save(save)
  assert.equal(saved.id, 'review-tools')
  assert.equal(saved.revision, 1)
  assert.equal(saved.approved, false)
  assert.deepEqual(saved.bindings, [])
  assert.deepEqual(JSON.parse(JSON.stringify(saved.mcp)), mcp)
  assert.equal((await service.save(save)).revision, 1, 'the original command replays its receipt')
  assert.equal(authorizationCalls > 0, true)
  assert.equal(productCapabilityEndpointFields['capability-save'].includes('botId'), false)
  assert.equal(productCapabilityEndpointFields['capability-bind'].includes('botId'), false)
  assert.equal(Object.values(productCapabilityEndpointFields).flat().includes('botId'), false)

  await assert.rejects(service.save({ ...save, commandId: 'stale-save' }), {
    code: 'CAPABILITY_REVISION_CONFLICT',
  })
  const { mcp: _mcp, ...saveBase } = save
  await assert.rejects(service.save({ ...saveBase, commandId: 'wrong-kind', expectedRevision: 1, kind: 'skill',
    content: 'Instructions' }), { code: 'CAPABILITY_KIND_CONFLICT' })
  await assert.rejects(service.save({ ...save, commandId: 'unknown-fields', expectedRevision: 1, botId: 'old-bot' }),
    { code: 'INVALID_INPUT' })

  authorized = false
  await assert.rejects(service.list({ instanceId: 'personal' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  authorized = true
  await assert.rejects(service.read({ instanceId: 'other', capabilityId: 'review-tools' }),
    { code: 'SOURCE_NOT_AUTHORIZED' })

  await assert.rejects(dispatchProductCapabilityEndpoint(service, 'capability-list',
    { instanceId: 'personal', botId: 'legacy' }), { code: 'INVALID_INPUT' })
  await assert.rejects(dispatchProductCapabilityEndpoint(service, 'capability-list',
    { instanceId: 'personal' }, { id: 'remote', grants: [] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(dispatchProductCapabilityEndpoint(service, 'capability-missing',
    { instanceId: 'personal' }), { code: 'UNAVAILABLE' })

  authorized = false
  await assert.rejects(service.approve({ instanceId: 'personal', commandId: 'approve-early',
    capabilityId: 'review-tools', expectedRevision: 1, approved: true }), { code: 'SOURCE_NOT_AUTHORIZED' })
  authorized = true
  const approved = await service.approve({ instanceId: 'personal', commandId: 'approve-review-tools',
    capabilityId: 'review-tools', expectedRevision: 1, approved: true })
  assert.equal(approved.approved, true)
  assert.equal(approved.revision, 2)
  await assert.rejects(service.approve({ instanceId: 'personal', commandId: 'approve-review-tools',
    capabilityId: 'review-tools', expectedRevision: 2, approved: false }), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(service.save({ ...save, commandId: 'secret-bearing-mcp', expectedRevision: 2,
    mcp: { ...mcp, headers: { Authorization: 'Bearer fictional-secret' } } }), { code: 'INVALID_INPUT' })
  await assert.rejects(service.bind({ instanceId: 'personal', commandId: 'nested-bot-scope',
    capabilityId: 'review-tools', expectedRevision: 2, active: true,
    scope: { role: 'worker', workItemId: 'item-one', botId: 'legacy' } }), { code: 'INVALID_INPUT' })

  await assert.rejects(service.bind({ instanceId: 'personal', commandId: 'unbounded-worker',
    capabilityId: 'review-tools', expectedRevision: 2, scope: { role: 'worker' }, active: true }),
  { code: 'INVALID_INPUT' })
  const bound = await service.bind({ instanceId: 'personal', commandId: 'bind-review-tools',
    capabilityId: 'review-tools', expectedRevision: 2,
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' }, active: true })
  assert.equal(bound.revision, 3)
  assert.equal(bound.bindings[0].status, 'needs-grant')
  const beforeGrant = await service.resolve({ instanceId: 'personal',
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' } })
  assert.equal(beforeGrant.status, 'blocked')
  assert.equal(beforeGrant.items[0].status, 'needs-grant')
  assert.deepEqual(beforeGrant.capabilities, [])

  await seedResource(storage, [{
    id: 'grant-one',
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' },
    purposes: ['tool'],
    grantedAt: 2,
  }])
  const ready = await service.resolve({ instanceId: 'personal',
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' } })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.capabilities.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(ready.capabilities[0].mcp)), mcp)
  assert.deepEqual(await service.resolve({ instanceId: 'personal', scope: { role: 'worker', workItemId: 'other' } }),
    { scope: { role: 'worker', workItemId: 'other' }, status: 'empty', items: [], capabilities: [] })
  assert.deepEqual(await service.resolve({ instanceId: 'personal', scope: { role: 'main' } }),
    { scope: { role: 'main' }, status: 'empty', items: [], capabilities: [] })

  const unapproved = await service.approve({ instanceId: 'personal', commandId: 'unapprove-review-tools',
    capabilityId: 'review-tools', expectedRevision: 3, approved: false })
  assert.equal(unapproved.revision, 4)
  assert.equal((await service.resolve({ instanceId: 'personal',
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' } })).items[0].status,
  'needs-approval')

  const deleted = await service.remove({ instanceId: 'personal', commandId: 'delete-review-tools',
    capabilityId: 'review-tools', expectedRevision: 4 })
  assert.equal(deleted.deleted, true)
  assert.deepEqual((await service.list({ instanceId: 'personal' })).items, [])
  assert.deepEqual(await service.remove({ instanceId: 'personal', commandId: 'delete-review-tools',
    capabilityId: 'review-tools', expectedRevision: 4 }), deleted)
})

test('empty skill content is rejected and approval can be revoked without its credential resource', {
  timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-capability-approval-'))
  const module = await loadCapabilities(root)
  const { createProductCapabilities, SqliteStorage } = module
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  await seedResource(storage)
  const service = createProductCapabilities({ storage, instanceId: 'personal', authorize: async () => {} })

  await assert.rejects(service.save({ instanceId: 'personal', commandId: 'empty-skill', expectedRevision: 0,
    name: 'empty-skill', kind: 'skill', content: '   ' }), { code: 'INVALID_INPUT' })
  await service.save({ instanceId: 'personal', commandId: 'save-tool', expectedRevision: 0,
    name: 'review-tools', kind: 'mcp', mcp })
  await service.approve({ instanceId: 'personal', commandId: 'approve-tool', capabilityId: 'review-tools',
    expectedRevision: 1, approved: true })
  await storage.transaction('personal', tx => tx.remove('resource-credential', 'resource-one'))
  const revoked = await service.approve({ instanceId: 'personal', commandId: 'revoke-tool',
    capabilityId: 'review-tools', expectedRevision: 2, approved: false })
  assert.equal(revoked.approved, false)
  assert.equal(revoked.resource?.status, 'missing')
})

test('skills and packs use exact role scopes and pack composition never descends to another role', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-capability-pack-'))
  const module = await loadCapabilities(root)
  const { createProductCapabilities, SqliteStorage } = module
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const service = createProductCapabilities({ storage, instanceId: 'personal', authorize: async () => {} })

  const guide = await service.save({ instanceId: 'personal', commandId: 'save-guide', expectedRevision: 0,
    name: 'guide', kind: 'skill', description: 'Guide', content: 'Read the evidence before answering.' })
  assert.equal(guide.approved, true)
  await assert.rejects(service.approve({ instanceId: 'personal', commandId: 'approve-skill',
    capabilityId: 'guide', expectedRevision: 1, approved: true }), { code: 'CAPABILITY_NOT_APPROVABLE' })
  const pack = await service.save({ instanceId: 'personal', commandId: 'save-team', expectedRevision: 0,
    name: 'team', kind: 'pack', items: ['guide'] })
  assert.deepEqual(pack.items, ['guide'])
  const bound = await service.bind({ instanceId: 'personal', commandId: 'bind-team-main',
    capabilityId: 'team', expectedRevision: 1, scope: { role: 'main' }, active: true })
  assert.equal(bound.revision, 2)

  const main = await service.resolve({ instanceId: 'personal', scope: { role: 'main' } })
  assert.equal(main.status, 'ready')
  assert.deepEqual(main.capabilities.map(item => item.name), ['guide'])
  assert.equal(main.capabilities[0].source, 'pack')
  assert.deepEqual(await service.resolve({ instanceId: 'personal', scope: { role: 'worker', workItemId: 'item-one' } }),
    { scope: { role: 'worker', workItemId: 'item-one' }, status: 'empty', items: [], capabilities: [] })

  const deleted = await service.remove({ instanceId: 'personal', commandId: 'delete-guide',
    capabilityId: 'guide', expectedRevision: 1 })
  assert.deepEqual(deleted.affectedPacks, ['team'])
  assert.deepEqual((await service.read({ instanceId: 'personal', capabilityId: 'team' })).items, [])
  await assert.rejects(service.save({ instanceId: 'personal', commandId: 'save-team-again',
    expectedRevision: 3, name: 'team', kind: 'pack', items: ['guide'] }), { code: 'INVALID_INPUT' })
  assert.equal((await service.resolve({ instanceId: 'personal', scope: { role: 'main' } })).status, 'blocked')
})

test('capability records survive a Host restart without becoming authority for another role', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-capability-restart-'))
  const path = join(root, 'business.sqlite')
  const module = await loadCapabilities(root)
  const { createProductCapabilities, SqliteStorage } = module
  let storage = await SqliteStorage.open(path)
  t.after(async () => { await storage.close().catch(() => {}); await rm(root, { recursive: true, force: true }) })
  let service = createProductCapabilities({ storage, instanceId: 'personal', authorize: async () => {} })
  await service.save({ instanceId: 'personal', commandId: 'restart-save', expectedRevision: 0,
    name: 'restart-guide', kind: 'skill', content: 'Persist this skill.' })
  await service.bind({ instanceId: 'personal', commandId: 'restart-bind', capabilityId: 'restart-guide',
    expectedRevision: 1, scope: { role: 'router' }, active: true })
  await storage.close()
  storage = await SqliteStorage.open(path)
  service = createProductCapabilities({ storage, instanceId: 'personal', authorize: async () => {} })
  const restored = await service.read({ instanceId: 'personal', capabilityId: 'restart-guide' })
  assert.equal(restored.content, 'Persist this skill.')
  assert.equal(restored.bindings[0].scope.role, 'router')
  assert.equal((await service.resolve({ instanceId: 'personal', scope: { role: 'router' } })).status, 'ready')
  assert.equal((await service.resolve({ instanceId: 'personal', scope: { role: 'main' } })).status, 'empty')
})

test('the Worker provider returns only ready local scope bindings and rechecks approval, config and grant at use', {
  timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-capability-provider-'))
  const module = await loadCapabilities(root)
  const { createProductCapabilities, SqliteStorage } = module
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const credentialUses = []
  const secret = 'fictional-capability-secret'
  const credentials = { use: async (request, consume) => {
    credentialUses.push(structuredClone(request))
    return consume(secret)
  } }
  const service = createProductCapabilities({ storage, instanceId: 'personal', authorize: async () => {}, credentials })
  await seedResource(storage, [{ id: 'grant-item', scope: { role: 'worker', workItemId: 'item-one',
    environmentId: 'environment-one' }, purposes: ['tool'], grantedAt: 2 }])
  await service.save({ instanceId: 'personal', commandId: 'save-capability', expectedRevision: 0,
    name: 'review-tools', kind: 'mcp', mcp })
  await service.approve({ instanceId: 'personal', commandId: 'approve-capability',
    capabilityId: 'review-tools', expectedRevision: 1, approved: true })
  await service.bind({ instanceId: 'personal', commandId: 'bind-capability', capabilityId: 'review-tools',
    expectedRevision: 2, scope: { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' }, active: true })
  const exactScope = { role: 'worker', workItemId: 'item-one', environmentId: 'environment-one' }
  const bindings = await service.workerMcpBindings({ instanceId: 'personal', scope: exactScope })
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].capabilityId, 'review-tools')
  assert.deepEqual(JSON.parse(JSON.stringify(bindings[0].config)), mcp)
  assert.deepEqual(await service.workerMcpBindings({ instanceId: 'personal',
    scope: { ...exactScope, workItemId: 'other-item' } }), [])
  await assert.rejects(service.workerMcpBindings({ instanceId: 'personal',
    scope: { ...exactScope, role: 'router' } }), { code: 'INVALID_INPUT' })
  const request = { instanceId: 'personal', resourceId: 'resource-one', ...exactScope, purpose: 'tool' }
  assert.equal(await bindings[0].use(request, async value => value), secret)
  assert.equal(credentialUses.length, 1)
  assert.deepEqual(credentialUses[0], request)

  await service.approve({ instanceId: 'personal', commandId: 'revoke-capability-approval',
    capabilityId: 'review-tools', expectedRevision: 3, approved: false })
  await assert.rejects(bindings[0].use(request, async value => value), { code: 'MCP_NOT_APPROVED' })
  assert.equal(credentialUses.length, 1)

  await service.save({ instanceId: 'personal', commandId: 'edit-capability', expectedRevision: 4,
    name: 'review-tools', kind: 'mcp', mcp: { ...mcp, url: 'https://next.example.test/mcp' } })
  await service.approve({ instanceId: 'personal', commandId: 'approve-new-config',
    capabilityId: 'review-tools', expectedRevision: 5, approved: true })
  await assert.rejects(bindings[0].use(request, async value => value), { code: 'CONFIG_CHANGED' })
  assert.equal(credentialUses.length, 1)

  const currentBindings = await service.workerMcpBindings({ instanceId: 'personal', scope: exactScope })
  assert.equal(currentBindings[0].config.url, 'https://next.example.test/mcp')
  await storage.transaction('personal', async tx => {
    const resource = await tx.get('resource-credential', 'resource-one')
    await tx.replace('resource-credential', 'resource-one', { ...resource, grants: [] })
  })
  await assert.rejects(currentBindings[0].use(request, async value => value), { code: 'GRANT_DENIED' })
  assert.equal(credentialUses.length, 1)
})

test('Main delegation executes ready capability MCP only in a local Worker and audits mid-call grant revocation', {
  timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'product-capability-worker-'))
  const runtimeRoot = await mkdtemp(join(plugin, '.product-capability-runtime-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'evidence.txt'), 'local evidence\n')
  const serverRequests = []
  const toolCalls = []
  const credentialUses = []
  const secret = 'fictional-capability-worker-secret'
  let revokeAfterDiscovery
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (!chunks.length) { response.writeHead(202).end(); return }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    serverRequests.push({ method: message.method, authorized: request.headers.authorization === `Bearer ${secret}` })
    response.setHeader('content-type', 'application/json')
    if (!('id' in message)) { response.writeHead(202).end(); return }
    if (message.method === 'server/discover') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Method not found' } }))
      return
    }
    if (message.method === 'initialize') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'capability-test', version: '1' },
      } }))
      return
    }
    if (message.method === 'tools/list') {
      const revoke = revokeAfterDiscovery
      revokeAfterDiscovery = undefined
      if (revoke) await revoke()
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        tools: [{ name: 'check', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
      } }))
      return
    }
    if (message.method === 'tools/call') {
      toolCalls.push(message.params)
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { content: [{ type: 'text', text: `checked ${message.params.arguments.text}` }] } }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  let native
  let storage
  let engine
  let sessions
  let localEnvironment
  const mainMcpTools = []
  const routerMcpTools = []
  const mainSystems = []
  const routerSystems = []
  const workerRequests = []
  const systemOf = options => options.system ?? (options.messages ?? []).filter(message => message.role === 'system')
    .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  let workerMode = 'local-success'
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    const mcpTools = options.tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name)
    if (options.model === 'main') {
      mainMcpTools.push(...mcpTools)
      mainSystems.push(systemOf(options))
      if (text.startsWith('[Work update]')) { yield* textResponse('Work update recorded.'); return }
      if (count === 0) {
        yield* toolResponse('delegate_work', { goal: text.includes('Recheck a revoked MCP grant')
          ? 'Recheck a revoked MCP grant.'
          : 'Use the scoped local review capability.',
        constraints: 'Use only this request and its selected Environment.',
        acceptanceCriteria: 'Use the approved MCP capability when authorized and verify local evidence.' })
      } else yield* textResponse('Work delegated.')
      return
    }
    if (options.model === 'router') {
      routerMcpTools.push(...mcpTools)
      routerSystems.push(systemOf(options))
      yield* routerResponse(options)
      return
    }
    workerRequests.push({ text, system: systemOf(options), tools: options.tools.map(tool => tool.name), remote: text.includes('remote-only') })
    if (text.includes('remote boundary')) {
      if (count === 0) yield* toolResponse('read_file', { path: 'remote-evidence.txt' })
      else yield* textResponse('Remote Worker completed the bounded read.')
      return
    }
    if (workerMode === 'local-success') {
      if (count === 0) yield* toolResponse('mcp__review__check', { input: JSON.stringify({ text: 'authorized' }) })
      else if (count === 1) yield* toolResponse('read_file', { path: 'evidence.txt' })
      else if (count === 2) yield* toolResponse('report_ready', { result: 'MCP capability ran and evidence was read.',
        evidence: 'The Worker used the explicitly approved and bound MCP tool, then read the local evidence.',
        artifacts: 'evidence.txt' })
      else yield* textResponse('The request is complete.')
      return
    }
    if (workerMode === 'revoked-grant') {
      if (count === 0) yield* toolResponse('mcp__review__check', { input: JSON.stringify({ text: 'revoked' }) })
      else if (count === 1) yield* toolResponse('read_file', { path: 'evidence.txt' })
      else if (count === 2) yield* toolResponse('report_ready', { result: 'The MCP grant was revoked before dispatch.',
        evidence: 'The Worker recorded the denied MCP attempt and independently read the local evidence.',
        artifacts: 'evidence.txt' })
      else yield* textResponse('The request is complete without the revoked tool.')
      return
    }
    yield* textResponse('The tool was denied; no result was reported.')
  })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const records = native.get('credentials')
  const runtime = await loadExecutionRuntime(runtimeRoot)
  storage = await runtime.SqliteStorage.open(join(directory, 'business.sqlite'))
  localEnvironment = await runtime.LocalEnvironment.open({ id: 'project', instanceId: 'personal', root: workspace,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {} })
  const remoteRoot = 'remote://device/workspace'
  let remoteInvocations = 0
  const remoteEnvironment = {
    kind: 'remote',
    config: { id: 'remote-project', instanceId: 'personal', root: remoteRoot,
      allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {} },
    deviceId: 'device-one',
    deviceIncarnation: 'device-one-instance',
    authorize(identity) {
      if (identity.instanceId !== 'personal' || identity.actorId !== 'alice') throw Object.assign(
        new Error('The remote Environment is not authorized.'), { code: 'ENVIRONMENT_DENIED' })
    },
    async probe(identity) {
      this.authorize(identity)
      return { online: true, root: remoteRoot, version: 'device-version-1', fingerprint: 'device-fingerprint-1',
        capabilities: ['read', 'write', 'search'], capacity: 'available' }
    },
    async prepare(identity) {
      this.authorize(identity)
      return { cwd: remoteRoot, invoke: async name => {
        remoteInvocations++
        if (name !== 'read_file') throw Object.assign(new Error('Unsupported remote fixture operation.'), { code: 'ENVIRONMENT_UNSUPPORTED' })
        return { text: 'remote evidence' }
      }, artifact: async path => ({ path, bytes: 1, sha256: 'a'.repeat(64),
        reference: { kind: 'artifact', id: 'remote-artifact', path, environmentId: 'remote-project',
          environmentKind: 'remote', sha256: 'a'.repeat(64), bytes: 1 } }), sanitize: text => text }
    },
    async close() {},
  }
  sessions = new runtime.NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' },
  })
  engine = new runtime.Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice',
    allowedActorIds: ['alice'] }, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions,
  [localEnvironment, remoteEnvironment])
  t.after(async () => {
    await engine?.effects.stop().catch(() => {})
    await engine?.shutdown().catch(() => {})
    await sessions?.close().catch(() => {})
    await native?.fiber.dispose().catch(() => {})
    await localEnvironment?.close().catch(() => {})
    await storage?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve)).catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {})
  })

  await engine.acquireHost({ initializeMain: true })
  const credentials = engine.createProductCredentialManager(records)
  const guardedCredentials = {
    use: (request, consume) => {
      credentialUses.push(structuredClone(request))
      return credentials.use(request, consume)
    },
  }
  const capabilities = engine.createProductCapabilities(guardedCredentials)
  engine.configureWorkerCapabilities(capabilities)
  const guide = await capabilities.save({ instanceId: 'personal', commandId: 'capability-guide-save', expectedRevision: 0,
    name: 'bound-guide', kind: 'skill', content: 'Apply the authorized product capability guide.' })
  await capabilities.bind({ instanceId: 'personal', commandId: 'capability-guide-main', capabilityId: guide.id,
    expectedRevision: guide.revision, scope: { role: 'main' }, active: true })
  await capabilities.bind({ instanceId: 'personal', commandId: 'capability-guide-router', capabilityId: guide.id,
    expectedRevision: guide.revision + 1, scope: { role: 'router' }, active: true })
  await capabilities.bind({ instanceId: 'personal', commandId: 'capability-guide-worker', capabilityId: guide.id,
    expectedRevision: guide.revision + 2, scope: { role: 'worker', environmentId: 'project' }, active: true })
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'capability-credential',
    label: 'Capability MCP', value: secret })
  const scope = { role: 'worker', environmentId: 'project' }
  const grant = await credentials.grant({ instanceId: 'personal', commandId: 'capability-grant',
    resourceId: resource.id, expectedRevision: resource.revision, scope, purposes: ['tool'] })
  await capabilities.save({ instanceId: 'personal', commandId: 'capability-save', expectedRevision: 0,
    name: 'review-tools', kind: 'mcp', description: 'Bound review MCP',
    mcp: { resourceId: resource.id, serverName: 'review', toolName: 'check',
      url: `http://127.0.0.1:${server.address().port}/mcp` } })
  await capabilities.approve({ instanceId: 'personal', commandId: 'capability-approve', capabilityId: 'review-tools',
    expectedRevision: 1, approved: true })
  await capabilities.bind({ instanceId: 'personal', commandId: 'capability-bind', capabilityId: 'review-tools',
    expectedRevision: 2, scope, active: true })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()

  const waitForWork = async goal => {
    let work
    await until(async () => {
      const main = await engine.getMainConversation({ instanceId: 'personal', limit: 100 })
      work = main.works.find(item => item.brief?.goal === goal && item.receipt?.ticketId)
      return Boolean(work?.receipt?.ticketId)
    }, `${goal} delegation receipt`)
    return work
  }
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'capability-local-work',
    text: 'Use MCP for the explicitly scoped local review request.', environmentId: 'project', target: 'local-only' })
  let localWork = await waitForWork('Use the scoped local review capability.')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal', limit: 100 }))
    .works.some(item => item.receipt?.ticketId === localWork.receipt.ticketId && item.outcome?.status === 'success'),
  'successful local capability work')
  localWork = (await engine.getMainConversation({ instanceId: 'personal', limit: 100 })).works
    .find(item => item.receipt?.ticketId === localWork.receipt.ticketId)
  assert.equal(toolCalls.length, 1)
  assert.deepEqual(toolCalls[0].arguments, { text: 'authorized' })
  assert.ok(serverRequests.length > 0)
  assert.ok(serverRequests.every(item => item.authorized))
  assert.equal(credentialUses.length, 2, 'MCP discovery and the actual tool call both use scoped credentials')
  assert.deepEqual(credentialUses[0], { instanceId: 'personal', resourceId: resource.id, role: 'worker',
    purpose: 'tool', workItemId: localWork.brief.workItemId, environmentId: 'project' })
  assert.ok(workerRequests.some(item => item.tools.includes('mcp__review__check')))
  assert.ok(mainSystems.some(system => system.includes('Apply the authorized product capability guide.')))
  assert.ok(routerSystems.some(system => system.includes('Apply the authorized product capability guide.')))
  assert.ok(workerRequests.some(item => item.system.includes('Apply the authorized product capability guide.')))
  assert.deepEqual(mainMcpTools, [])
  assert.deepEqual(routerMcpTools, [])
  assert.ok(localWork.outcome.evidence.includes('read the local evidence'))
  assert.equal(JSON.stringify(localWork).includes(secret), false)

  workerMode = 'revoked-grant'
  revokeAfterDiscovery = async () => credentials.revokeGrant({ instanceId: 'personal',
    commandId: 'capability-grant-revoked-during-discovery', resourceId: resource.id,
    grantId: grant.grants[0].id, expectedRevision: grant.revision })
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'capability-revoked-work',
    text: 'Recheck a revoked MCP grant without dispatching the tool.', environmentId: 'project', target: 'local-only' })
  const revokedWork = await waitForWork('Recheck a revoked MCP grant.')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal', limit: 100 })).works
    .some(item => item.receipt?.ticketId === revokedWork.receipt.ticketId && item.outcome?.status === 'success'),
  'local fallback after MCP grant revocation')
  assert.equal(toolCalls.length, 1, 'grant revoked after MCP discovery prevents tools/call')
  const details = await engine.getWorkObservations({ instanceId: 'personal', query: revokedWork.receipt.ticketId })
  const observation = details.items.find(item => item.ticketId === revokedWork.receipt.ticketId && item.role === 'worker')
  assert.ok(observation)
  const audit = await engine.readWorkObservation({ instanceId: 'personal', observationId: observation.id,
    generation: observation.generation })
  assert.ok(audit.facts.some(fact => fact.label === 'MCP state'
    && fact.value.includes('not dispatched') && fact.value.includes('GRANT_DENIED')))
  assert.equal(audit.facts.some(fact => fact.label === 'MCP request'), false)
  assert.equal(JSON.stringify(audit).includes(secret), false)
  assert.deepEqual(await capabilities.workerMcpBindings({ instanceId: 'personal',
    scope: { role: 'worker', workItemId: 'remote-item', environmentId: 'remote-project' } }), [])
  assert.equal(remoteInvocations, 0, 'Host MCP bindings never cross into a remote Worker')
  assert.deepEqual(mainMcpTools, [])
  assert.deepEqual(routerMcpTools, [])
})
