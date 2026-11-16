import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SqliteStorage } from '../dist/storage.js'
import { WorkerMcpCalls, mcpBlockIn, mcpCallPageIn } from '../dist/worker-mcp-calls.js'
import { workerMcpTool } from '../dist/worker-mcp-tool.js'

const node24Fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-unknown-'))
  const path = join(root, 'business.sqlite')
  const storage = await SqliteStorage.open(path)
  const connections = [storage]
  const ticketId = 'ticket-1'
  const assignment = { id: 'assignment-1', generation: 'generation-1', state: 'running', environment: { id: 'local' } }
  const use = { instanceId: 'personal', resourceId: 'resource-1', role: 'worker', purpose: 'tool',
    workItemId: 'work-1', environmentId: 'local' }
  await storage.transaction('personal', async tx => {
    await tx.insert('ticket', ticketId, { id: ticketId, state: 'open' })
    await tx.insert('assignment', ticketId, assignment)
    await tx.insert('work-ticket', ticketId, { workItemId: use.workItemId })
  })
  t.after(async () => {
    for (const connection of connections.reverse()) await connection.close()
    await rm(root, { recursive: true, force: true })
  })
  const reopen = async () => {
    const connection = await SqliteStorage.open(path)
    connections.push(connection)
    return connection
  }
  return { storage, reopen, ticketId, assignment, use }
}

test('a persisted pre-dispatch intent blocks the same Ticket after restart without a ready report', async t => {
  const { storage, reopen, ticketId, assignment, use } = await node24Fixture(t)
  const config = { serverName: 'approved', toolName: 'check', resourceId: use.resourceId }
  const calls = new WorkerMcpCalls(storage, 'personal')
  const first = await calls.begin(ticketId, assignment, use, config, { text: 'private raw input' })
  assert.equal(first.state, 'unknown')
  assert.equal(await storage.transaction('personal', tx => tx.get('report', ticketId)), undefined)
  await storage.close()
  const restarted = await reopen()
  await assert.rejects(new WorkerMcpCalls(restarted, 'personal').begin(ticketId, assignment, use, config,
    { text: 'private raw input' }), { code: 'MCP_OUTCOME_UNKNOWN' })
  const retained = await restarted.transaction('personal', tx => mcpBlockIn(tx, ticketId))
  assert.equal(retained.requestId, first.requestId)
  assert.equal(retained.assignmentId, assignment.id)
  assert.equal(JSON.stringify(retained).includes('private raw input'), false)
  assert.equal(JSON.stringify(retained).includes('mock-credential-value'), false)
  const otherUse = { ...use, workItemId: 'work-2' }
  const otherAssignment = { ...assignment, id: 'assignment-2' }
  await restarted.transaction('personal', async tx => {
    await tx.insert('ticket', 'ticket-2', { id: 'ticket-2', state: 'open' })
    await tx.insert('assignment', 'ticket-2', otherAssignment)
    await tx.insert('work-ticket', 'ticket-2', { workItemId: otherUse.workItemId })
  })
  assert.equal((await new WorkerMcpCalls(restarted, 'personal').begin('ticket-2', otherAssignment, otherUse,
    config, { text: 'unrelated work' })).state, 'unknown', 'another Ticket keeps its independent MCP scope')
})

test('an interrupted child MCP request remains unknown across a restart and deep history pages', { timeout: 60_000 }, async t => {
  const { storage, reopen, ticketId, assignment, use } = await node24Fixture(t)
  const secret = 'mock-credential-value'
  let callReceived
  const received = new Promise(resolve => { callReceived = resolve })
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) { res.writeHead(202).end(); return }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!('id' in message)) { res.writeHead(202).end(); return }
    res.setHeader('content-type', 'application/json')
    if (message.method === 'server/discover') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
    } else if (message.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } } }))
    } else if (message.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { tools: [{ name: 'check', inputSchema: { type: 'object' } }] } }))
    } else if (message.method === 'tools/call') {
      requests.push({ requestId: message.params._meta?.['com.ds-superagent/requestId'],
        authorized: req.headers.authorization === `Bearer ${secret}` })
      callReceived()
      // The transport closes without a response when the Worker is interrupted.
      req.on('close', () => res.destroy())
    } else res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const config = { serverName: 'approved', toolName: 'check', resourceId: use.resourceId,
    url: `http://127.0.0.1:${server.address().port}/mcp` }
  const binding = { config, credentials: { use: async (_request, consume) => consume(secret) } }
  const scope = async () => use
  const records = []
  const ledger = new WorkerMcpCalls(storage, 'personal')
  // Child tools have no parent toolFacts callback; their durable intent must be independently observable.
  const child = workerMcpTool(binding, scope, (outcome, output) => records.push({ outcome, output }), {
    begin: (request, args) => ledger.begin(ticketId, assignment, request, config, args),
    confirm: (call, outcome, code) => ledger.confirm(call, outcome, code),
  })
  const controller = new AbortController()
  const attempt = child.execute({ input: JSON.stringify({ text: 'private raw input' }) }, controller.signal)
  await received
  controller.abort()
  await assert.rejects(attempt, { code: 'MCP_OUTCOME_UNKNOWN' })
  const original = await storage.transaction('personal', tx => mcpBlockIn(tx, ticketId))
  assert.equal(original.requestId, requests[0].requestId)
  assert.equal(records.at(-1).output.requestId, original.requestId)
  assert.equal(records.at(-1).output.code, 'MCP_OUTCOME_UNKNOWN')
  assert.equal(requests[0].authorized, true)
  assert.equal(await storage.transaction('personal', tx => tx.get('report', ticketId)), undefined)
  // The unknown request is past both the 100-row page and the 1000-row snapshot budget.
  await storage.transaction('personal', async tx => {
    for (let index = 0; index < 1100; index++) {
      await tx.insert('worker-mcp-call', `${JSON.stringify(['worker-mcp-call', ticketId])}:${String(index).padStart(5, '0')}`,
        { id: String(index), ticketId, state: 'confirmed', outcome: 'success' })
    }
  })
  let after
  let count = 0
  do {
    const page = await storage.transaction('personal', tx => mcpCallPageIn(tx, ticketId, after))
    count += page.items.length
    after = page.cursor
  } while (after)
  assert.equal(count, 1101)
  await storage.close()
  const restarted = await reopen()
  const afterRestart = new WorkerMcpCalls(restarted, 'personal')
  const second = workerMcpTool(binding, scope, () => {}, {
    begin: (request, args) => afterRestart.begin(ticketId, assignment, request, config, args),
    confirm: (call, outcome, code) => afterRestart.confirm(call, outcome, code),
  })
  await assert.rejects(second.execute({ input: JSON.stringify({ text: 'private raw input' }) }, new AbortController().signal),
    { code: 'MCP_OUTCOME_UNKNOWN' })
  assert.equal(requests.length, 1, 'no second tools/call is sent even after a process restart')
  const retained = await restarted.transaction('personal', tx => mcpBlockIn(tx, ticketId))
  assert.equal(retained.requestId, original.requestId)
  assert.equal(JSON.stringify(retained).includes('private raw input'), false)
  assert.equal(JSON.stringify(retained).includes(secret), false)
})
