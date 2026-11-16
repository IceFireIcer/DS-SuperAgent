import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check) {
  const deadline = Date.now() + 40_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The Worker MCP call did not settle.')
    await sleep(25)
  }
}

test('the product Worker calls only its approved MCP tool through the live tool grant', { timeout: 120_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-worker-mcp-'))
  const work = join(base, 'work')
  const core = join(base, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  await writeFile(join(work, 'evidence.txt'), 'local verification\n')
  const secret = 'mock-worker-mcp-credential'
  const requests = []
  const calls = []
  let listStarted
  let releaseList
  const pendingList = new Promise(resolve => { listStarted = resolve })
  const heldList = new Promise(resolve => { releaseList = resolve })
  let pauseList = false
  let afterList
  let echoSecret = false
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) { res.writeHead(202).end(); return }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ method: message.method, authorized: req.headers.authorization === `Bearer ${secret}` })
    res.setHeader('content-type', 'application/json')
    if (!('id' in message)) { res.writeHead(202).end(); return }
    let result
    if (message.method === 'server/discover') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
      return
    }
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'mock-approved', version: '1.0.0' } }
    else if (message.method === 'tools/list') {
      if (pauseList) { listStarted(); await heldList }
      if (afterList) { const action = afterList; afterList = undefined; await action() }
      result = { tools: [{ name: 'check', inputSchema: { type: 'object',
        properties: { text: { type: 'string' } }, required: ['text'] } }] }
    }
    else if (message.method === 'tools/call') {
      calls.push({ name: message.params.name, input: message.params.arguments })
      result = { content: [{ type: 'text', text: echoSecret ? secret : `checked ${message.params.arguments.text}` }] }
    } else { res.writeHead(404).end(); return }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const modelMessages = []
  const mainTools = []
  const routerTools = []
  let workerAttempts = 0
  let childAttempts = 0
  const native = await nativeContext(join(base, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    modelMessages.push(JSON.stringify(options.messages))
    if (options.model === 'main') {
      mainTools.push(...options.tools.map(tool => tool.name))
      if (text.startsWith('[Work update]')) { yield* textResponse('The result was received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: text, constraints: 'Use this work only.',
        acceptanceCriteria: 'Use the approved MCP tool and report its result.' })
      else yield* textResponse('Worker started.')
    } else if (options.model === 'router') {
      routerTools.push(...options.tools.map(tool => tool.name))
      yield* routerResponse(options)
    } else if (text === 'Use approved MCP tool in child.') {
      assert.equal(options.tools.filter(tool => tool.name.startsWith('mcp__')).length, 1)
      assert.equal(options.tools.some(tool => tool.name === 'delegate_subagent'), false)
      if (count === 0) yield* toolResponse('mcp__approved__check', { input: JSON.stringify({ text: 'child' }) })
      else { childAttempts++; yield* textResponse('The child observed the tool result.') }
    } else if (text.startsWith('Subagent ')) {
      yield* textResponse('The child result is evidence only.')
    } else if (text.includes('child-') && count === 0) {
      yield* toolResponse('delegate_subagent', { task: 'Use approved MCP tool in child.' })
    } else if (text.includes('child-')) {
      yield* textResponse('The child is running.')
    } else if (count === 0) {
      assert.ok(options.tools.some(tool => tool.name === 'mcp__approved__check'))
      assert.equal(options.tools.filter(tool => tool.name.startsWith('mcp__')).length, 1)
      yield* toolResponse('mcp__approved__check', { input: JSON.stringify({ text: 'fixture' }) })
    } else if (count === 1) {
      workerAttempts++
      const lastTool = options.messages.filter(message => message.role === 'tool').at(-1)
      if (JSON.stringify(lastTool).includes('checked fixture'))
        yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
      else yield* textResponse('The approved tool was unavailable.')
    } else if (count === 2) {
      yield* toolResponse('report_ready', { result: 'Used the approved MCP tool.',
        evidence: 'Checked the MCP response and verified the bound directory.', artifacts: 'evidence.txt' })
    } else yield* textResponse('No more work.')
  })
  await native.plugin(LocalCredentials, { path: join(base, 'credentials.yaml'), watch: false })
  let globalCalls = 0
  const unregisterGlobal = native.tools.register(defineTool({ name: 'mcp__global__unapproved',
    description: 'An unrelated globally installed tool.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { globalCalls++; return 'unapproved' },
  }))
  const config = { databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  let host
  t.after(async () => {
    releaseList()
    unregisterGlobal()
    await host?.close(); await native.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(base, { recursive: true, force: true })
  })
  host = await createProductHost(native, config)
  const resource = await host.dispatch('resource-create', { instanceId: 'personal', commandId: 'create-mcp', label: 'Approved MCP', value: secret })
  const directory = (await host.dispatch('directory-options', { instanceId: 'personal' })).directories[0]
  await host.close()
  host = await createProductHost(native, { ...config, workerMcpTool: {
    serverName: 'approved', toolName: 'check', url: `http://127.0.0.1:${address.port}/mcp`, resourceId: resource.id,
  } })
  const send = async id => {
    await host.dispatch('send', { instanceId: 'personal', commandId: id, text: `Check ${id}.` })
    await until(() => workerAttempts >= Number(id.split('-').at(-1)))
  }
  await send('work-1')
  assert.equal(requests.length, 0, 'no grant means no handshake or tool call')
  const wrong = await host.dispatch('resource-grant', { instanceId: 'personal', commandId: 'wrong-work', resourceId: resource.id,
    expectedRevision: resource.revision, scope: { role: 'worker', workItemId: 'different-work', environmentId: directory.id }, purposes: ['tool'] })
  await send('work-2')
  assert.equal(requests.length, 0, 'another work item cannot borrow this grant')
  const granted = await host.dispatch('resource-grant', { instanceId: 'personal', commandId: 'grant-local', resourceId: resource.id,
    expectedRevision: wrong.revision, scope: { role: 'worker', environmentId: directory.id }, purposes: ['tool'] })
  const approvedTool = await host.dispatch('mcp-approve', { instanceId: 'personal', commandId: 'approve-mcp',
    expectedRevision: 0, approved: true })
  await host.dispatch('mcp-connect', { instanceId: 'personal', commandId: 'connect-mcp',
    expectedRevision: approvedTool.revision })
  await send('work-3')
  await until(() => calls.length === 1)
  let approvedWork
  await until(async () => {
    const history = await host.dispatch('history', { instanceId: 'personal' })
    approvedWork = history.works.find(work => work.receipt?.status === 'accepted' && work.brief?.goal === 'Check work-3.')
    return Boolean(approvedWork?.receipt?.ticketId)
  })
  const raw = await SqliteStorage.open(config.databasePath)
  let report
  await until(async () => {
    report = await raw.transaction('personal', tx => tx.get('report', approvedWork.receipt.ticketId))
    return report?.toolFacts?.some(fact => fact.tool === 'mcp__approved__check')
  })
  await raw.close()
  assert.deepEqual(report.toolFacts.filter(fact => fact.tool === 'mcp__approved__check'),
    [{ tool: 'mcp__approved__check', outcome: 'success', output: { text: 'checked fixture' } }])
  assert.deepEqual(calls, [{ name: 'check', input: { text: 'fixture' } }])
  assert.ok(requests.every(request => request.authorized), 'the DSH record value reached only the MCP transport')
  let revoked
  afterList = async () => { revoked = await host.dispatch('resource-revoke', { instanceId: 'personal', commandId: 'revoke-local',
    resourceId: resource.id, grantId: granted.grants.at(-1).id, expectedRevision: granted.revision }) }
  await send('work-4')
  assert.equal(revoked.grants.length, 1)
  assert.equal(calls.length, 1, 'revocation prevents another external call')
  await host.dispatch('resource-grant', { instanceId: 'personal', commandId: 'grant-for-stop', resourceId: resource.id,
    expectedRevision: revoked.revision, scope: { role: 'worker', environmentId: directory.id }, purposes: ['tool'] })
  pauseList = true
  await host.dispatch('send', { instanceId: 'personal', commandId: 'work-5', text: 'Check work-5.' })
  await pendingList
  const active = (await host.dispatch('history', { instanceId: 'personal' })).works.find(work => work.brief?.goal === 'Check work-5.')
  assert.ok(active?.control?.assignment)
  await host.dispatch('work-stop', { instanceId: 'personal', commandId: 'stop-mcp',
    workItemId: active.brief.workItemId, ticketId: active.receipt.ticketId,
    expectedGeneration: active.control.assignment.generation, expectedTicketVersion: active.control.ticketVersion,
    reason: 'Stop before the external MCP call.' })
  releaseList()
  await until(async () => (await host.dispatch('history', { instanceId: 'personal' })).works
    .some(work => work.brief?.goal === 'Check work-5.' && work.status === 'stopped'))
  assert.equal(calls.length, 1, 'a stopped Assignment cannot dispatch after MCP discovery')
  const childWork = async id => {
    await host.dispatch('send', { instanceId: 'personal', commandId: id, text: `Check ${id}.` })
    await until(() => childAttempts >= Number(id.split('-').at(-1)) - 5)
  }
  await childWork('child-6')
  assert.equal(calls.length, 2, 'a delegated child uses the same approved tool and grant')
  assert.deepEqual(calls.at(-1), { name: 'check', input: { text: 'child' } })
  const currentResource = await host.dispatch('resource-read', { instanceId: 'personal', resourceId: resource.id })
  await host.dispatch('resource-revoke', { instanceId: 'personal', commandId: 'revoke-child', resourceId: resource.id,
    grantId: currentResource.grants.at(-1).id, expectedRevision: currentResource.revision })
  const requestsBeforeDeniedChild = requests.length
  await childWork('child-7')
  assert.equal(calls.length, 2, 'the child cannot call after the shared grant is revoked')
  assert.equal(requests.length, requestsBeforeDeniedChild, 'the revoked child cannot even start an MCP connection')
  const afterChild = await host.dispatch('resource-read', { instanceId: 'personal', resourceId: resource.id })
  await host.dispatch('resource-grant', { instanceId: 'personal', commandId: 'grant-echo', resourceId: resource.id,
    expectedRevision: afterChild.revision, scope: { role: 'worker', environmentId: directory.id }, purposes: ['tool'] })
  echoSecret = true
  const previous = workerAttempts
  await host.dispatch('send', { instanceId: 'personal', commandId: 'work-8', text: 'Check work-8.' })
  await until(() => workerAttempts > previous)
  assert.equal(calls.length, 3)
  assert.ok(mainTools.every(name => !name.startsWith('mcp__')))
  assert.ok(routerTools.every(name => !name.startsWith('mcp__')))
  assert.equal(globalCalls, 0)
  assert.equal(modelMessages.some(message => message.includes(secret)), false)
  assert.equal(JSON.stringify(await host.dispatch('history', { instanceId: 'personal' })).includes(secret), false)
})
