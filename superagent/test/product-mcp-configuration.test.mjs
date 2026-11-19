import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check) {
  const deadline = Date.now() + 40000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The MCP work did not settle.')
    await sleep(25)
  }
}

test('local MCP settings save, approve, disconnect and retry at the actual Worker call', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-mcp-settings-'))
  const work = join(root, 'work')
  const core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  await writeFile(join(work, 'evidence.txt'), 'verified local file\n')
  const secret = 'mock-mcp-setting-credential'
  const requests = []
  const calls = []
  let failNextCall = false
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) { res.writeHead(202).end(); return }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ method: message.method, authorized: req.headers.authorization === `Bearer ${secret}` })
    res.setHeader('content-type', 'application/json')
    if (!('id' in message)) { res.writeHead(202).end(); return }
    if (message.method === 'server/discover') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
      return
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'check', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
        : message.method === 'tools/call'
          ? (calls.push(message.params), failNextCall
            ? { isError: true, content: [{ type: 'text', text: 'mock tool rejected input' }] }
            : { content: [{ type: 'text', text: `checked ${message.params.arguments.text}` }] })
          : null
    if (!result) { res.writeHead(404).end(); return }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const mainTools = []
  const routerTools = []
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      mainTools.push(...options.tools.map(tool => tool.name))
      if (text.startsWith('[Work update]')) { yield* textResponse('Received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: text, constraints: 'Local work only.',
        acceptanceCriteria: 'Use the approved MCP tool and verify the local file.' })
      else yield* textResponse('Work started.')
    } else if (options.model === 'router') {
      routerTools.push(...options.tools.map(tool => tool.name))
      yield* routerResponse(options)
    } else if (count === 0) {
      yield* toolResponse('mcp__approved__check', { input: JSON.stringify({ text: 'fixture' }) })
    } else if (count === 1) {
      const result = JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1))
      if (result.includes('checked fixture')) yield* toolResponse('run_shell', {
        command: process.platform === 'win32' ? 'Get-Content evidence.txt' : 'cat evidence.txt',
      })
      else yield* textResponse('The tool is unavailable.')
    } else if (count === 2) {
      yield* toolResponse('report_ready', { result: 'MCP and local file verified.', evidence: 'The bound file was read.', artifacts: 'evidence.txt' })
    } else yield* textResponse('Done.')
  })
  await native.plugin(LocalCredentials, { path: join(root, 'credentials.yaml'), watch: false })
  const config = { databasePath: join(core, 'business.sqlite'), workspaceRoot: work, instanceId: 'personal', actorId: 'alice',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' }, workerMcpTool: { serverName: 'approved', toolName: 'check',
      url: `http://127.0.0.1:${server.address().port}/mcp`, resourceId: 'deployment-selection' } }
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { ...config, workerMcpTool: undefined })
  assert.deepEqual(await host.dispatch('mcp-status', { instanceId: 'personal' }),
    { configured: false, state: 'unavailable', location: 'host', remote: 'unsupported' })
  await assert.rejects(host.dispatch('mcp-connect', { instanceId: 'personal', commandId: 'no-deployment', expectedRevision: 0 }),
    { code: 'UNAVAILABLE' })
  const resource = await host.dispatch('resource-create', { instanceId: 'personal', commandId: 'resource-create', label: 'Fixture MCP', value: secret })
  await host.close()
  host = await createProductHost(native, config)
  const directory = (await host.dispatch('directory-options', { instanceId: 'personal' })).directories[0]
  const state = () => host.dispatch('mcp-status', { instanceId: 'personal' })
  const command = (endpoint, id, extra = {}) => state().then(current => host.dispatch(endpoint,
    { instanceId: 'personal', commandId: id, expectedRevision: current.revision, ...extra }))
  const remote = { id: 'remote', grants: [{ instanceId: 'personal', capabilities: ['read', 'command'] }] }
  await assert.rejects(host.dispatch('mcp-status', { instanceId: 'personal' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('mcp-save', { instanceId: 'personal', commandId: 'remote', expectedRevision: 0,
    resourceId: resource.id }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  const saved = await command('mcp-save', 'save', { resourceId: resource.id })
  assert.equal(saved.state, 'needs-approval')
  assert.equal((await host.dispatch('history', { instanceId: 'personal' })).works.length, 0)
  await assert.rejects(command('mcp-connect', 'early'), { code: 'MCP_NOT_APPROVED' })
  const approved = await command('mcp-approve', 'approve', { approved: true })
  assert.equal(approved.state, 'off')
  await assert.rejects(command('mcp-connect', 'ungranted'), { code: 'GRANT_DENIED' })
  const granted = await host.dispatch('resource-grant', { instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: resource.revision, scope: { role: 'worker', environmentId: directory.id }, purposes: ['tool'] })
  assert.equal((await command('mcp-connect', 'connect')).state, 'ready')
  assert.equal((await host.dispatch('history', { instanceId: 'personal' })).works.length, 0)
  assert.equal((await host.dispatch('mcp-connect', { instanceId: 'personal', commandId: 'connect', expectedRevision: approved.revision })).state, 'ready')
  await assert.rejects(host.dispatch('mcp-save', { instanceId: 'personal', commandId: 'connect', expectedRevision: approved.revision,
    resourceId: resource.id }), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(host.dispatch('mcp-disconnect', { instanceId: 'personal', commandId: 'stale', expectedRevision: 0 }),
    { code: 'MCP_REVISION_CONFLICT' })
  const send = async id => {
    await host.dispatch('send', { instanceId: 'personal', commandId: id, text: `Check ${id}.` })
    let workCard
    await until(async () => {
      workCard = (await host.dispatch('history', { instanceId: 'personal' })).works.find(work => work.brief?.goal === `Check ${id}.`)
      return ['success', 'failed'].includes(workCard?.status)
    })
    return workCard
  }
  const first = await send('connected')
  assert.equal(first.status, 'success', JSON.stringify({ first, calls, requests }))
  assert.equal(calls.length, 1)
  const raw = await SqliteStorage.open(config.databasePath)
  const report = await raw.transaction('personal', tx => tx.get('report', first.receipt.ticketId))
  await raw.close()
  const mcpFacts = report.toolFacts.filter(fact => fact.tool === 'mcp__approved__check')
  assert.equal(mcpFacts.length, 1)
  assert.equal(mcpFacts[0].outcome, 'success')
  assert.equal(mcpFacts[0].output.text, 'checked fixture')
  assert.match(mcpFacts[0].output.requestId, /^[a-f0-9-]{36}$/u)
  assert.equal(mcpFacts[0].output.state, 'confirmed')
  const observed = await host.dispatch('observe-list', { instanceId: 'personal', query: first.receipt.ticketId })
  const worker = observed.items.find(item => item.role === 'worker' && item.ticketId === first.receipt.ticketId)
  assert.ok(worker)
  const confirmed = await host.dispatch('observe-read', { instanceId: 'personal', observationId: worker.id,
    generation: worker.generation })
  assert.ok(confirmed.facts.some(fact => fact.label === 'MCP request'
    && fact.value.includes(`confirmed success · approved/check · original request ${mcpFacts[0].output.requestId}`)))
  assert.ok(confirmed.facts.some(fact => fact.label === 'Tool fact 1: mcp__approved__check'
    && fact.value.includes(mcpFacts[0].output.requestId)))
  failNextCall = true
  const failed = await send('server-rejected')
  assert.equal(failed.status, 'failed')
  const rejected = (await host.dispatch('observe-list', { instanceId: 'personal', query: failed.receipt.ticketId }))
    .items.find(item => item.role === 'worker' && item.ticketId === failed.receipt.ticketId)
  assert.ok(rejected)
  const failedDetail = await host.dispatch('observe-read', { instanceId: 'personal', observationId: rejected.id,
    generation: rejected.generation })
  assert.ok(failedDetail.facts.some(fact => fact.label === 'MCP request'
    && fact.value.includes('confirmed failed · approved/check') && fact.value.includes('code MCP_TOOL_FAILED')))
  assert.equal(failedDetail.facts.some(fact => fact.label === 'Result'), false,
    'a failed tool does not invent a ReadyReport')
  failNextCall = false
  assert.equal((await command('mcp-disconnect', 'disconnect')).state, 'off')
  await host.close()
  host = await createProductHost(native, config)
  assert.equal((await state()).state, 'off')
  assert.equal((await send('disconnected')).status, 'failed')
  assert.equal(calls.length, 2, 'disconnect prevents another MCP handshake after Host restart')
  assert.equal((await command('mcp-retry', 'retry')).state, 'ready')
  assert.equal((await send('reconnected')).status, 'success')
  assert.equal(calls.length, 3)
  assert.equal((await command('mcp-approve', 'revoke-approval', { approved: false })).state, 'needs-approval')
  assert.equal((await send('unapproved')).status, 'failed')
  assert.equal(calls.length, 3, 'tool approval revocation prevents a new MCP connection')
  assert.equal((await command('mcp-approve', 'approve-again', { approved: true })).state, 'off')
  assert.equal((await command('mcp-connect', 'connect-again')).state, 'ready')
  await host.dispatch('resource-revoke', { instanceId: 'personal', commandId: 'revoke', resourceId: resource.id,
    grantId: granted.grants[0].id, expectedRevision: granted.revision })
  assert.equal((await state()).state, 'needs-grant')
  const revoked = await send('revoked')
  assert.equal(revoked.status, 'failed')
  const revokedObservation = (await host.dispatch('observe-list', { instanceId: 'personal',
    query: revoked.receipt.ticketId })).items
    .find(item => item.role === 'worker' && item.ticketId === revoked.receipt.ticketId)
  assert.ok(revokedObservation)
  const revokedDetail = await host.dispatch('observe-read', { instanceId: 'personal',
    observationId: revokedObservation.id, generation: revokedObservation.generation })
  assert.ok(revokedDetail.facts.some(fact => fact.label === 'MCP state'
    && fact.value.includes('not dispatched') && fact.value.includes('GRANT_DENIED')),
  'revoking the only grant is reported as an authorization denial, not a disconnect')
  assert.equal(revokedDetail.facts.some(fact => fact.label === 'MCP request'), false)
  assert.equal(calls.length, 3, 'revocation is checked at the tool use site')
  assert.ok(requests.every(request => request.authorized))
  assert.ok(mainTools.every(name => !name.startsWith('mcp__')))
  assert.ok(routerTools.every(name => !name.startsWith('mcp__')))
  assert.equal(JSON.stringify(await host.dispatch('history', { instanceId: 'personal' })).includes(secret), false)
  await host.close()
  host = await createProductHost(native, { ...config, workerMcpTool: { ...config.workerMcpTool, toolName: 'different' } })
  assert.equal((await state()).error, 'CONFIG_CHANGED')
  assert.equal((await send('changed-declaration')).status, 'failed')
  assert.equal(calls.length, 3, 'a changed trusted endpoint declaration needs fresh approval')
})
