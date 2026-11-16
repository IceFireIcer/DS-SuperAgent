import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { ProductMemory, memoryToolsFor } from '../dist/product-memory.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

const instanceId = 'fictional-instance'
const source = { sourceInstanceId: 'product-desktop', actorId: 'fictional-user', allowedActorIds: ['fictional-user'] }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-memory-'))
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const engine = new Engine(storage, instanceId, source)
  await engine.acquireHost()
  const main = { mainId: 'main-fictional', mainSessionId: 'main-session-fictional' }
  await storage.transaction(instanceId, tx => tx.insert('main-state', 'main', {
    instanceId, ...main, routerSessionId: 'router-fictional', generation: 0, sequence: 0,
  }))
  t.after(async () => { await engine.shutdown(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  const work = async (id, ticketId) => {
    await storage.transaction(instanceId, async tx => {
      await tx.insert('work-brief', `brief-${id}`, { id: `brief-${id}`, instanceId, mainId: main.mainId })
      await tx.insert('work-item-ticket', id, { ticketId, workBriefId: `brief-${id}` })
      await tx.insert('work-ticket', ticketId, { workItemId: id, workBriefId: `brief-${id}` })
      await tx.insert('ticket', ticketId, { id: ticketId, instanceId, state: 'open' })
      await tx.insert('assignment', ticketId, { id: `assignment-${id}`, sessionId: `session-${id}`, state: 'running' })
    })
    return { role: 'worker', ticketId, assignmentId: `assignment-${id}`, sessionId: `session-${id}` }
  }
  return { root, storage, engine, main: { role: 'main', sessionId: main.mainSessionId }, work }
}

test('Main, private work and explicit sharing stay isolated across search and full reads', { timeout: 15000 }, async t => {
  const { engine, work, main } = await fixture(t)
  const workerA = await work('item-a', 'ticket-a')
  const workerB = await work('item-b', 'ticket-b')
  const saved = async (commandId, scope, text) => engine.saveProductMemory({ instanceId, commandId, scope, text })
  const own = await saved('save-main', { kind: 'main' }, 'fictional main preference')
  const privateA = await saved('save-private', { kind: 'work', workItemId: 'item-a' }, 'fictional private detail')
  const shared = await saved('save-shared', { kind: 'shared', main: true, workItemIds: ['item-a'] }, 'fictional shared method')
  assert.deepEqual(await saved('save-main', { kind: 'main' }, 'fictional main preference'), own)
  await assert.rejects(saved('save-main', { kind: 'work', workItemId: 'item-b' }, 'changed'), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(engine.searchProductMemory({ instanceId, reader: workerA, query: 'fictional' }), { code: 'MEMORY_DENIED' })
  await engine.grantProductWorkMemory({ instanceId, commandId: 'grant-a', workItemId: 'item-a', expectedRevision: 0, enabled: true })
  await engine.grantProductWorkMemory({ instanceId, commandId: 'grant-b', workItemId: 'item-b', expectedRevision: 0, enabled: true })
  const search = reader => engine.searchProductMemory({ instanceId, reader, query: 'fictional' })
  assert.deepEqual((await search(main)).map(item => item.id).sort(), [own.id, shared.id].sort())
  assert.deepEqual((await search(workerA)).map(item => item.id).sort(), [privateA.id, shared.id].sort())
  assert.deepEqual(await search(workerB), [])
  await assert.rejects(engine.readProductMemory({ instanceId, reader: workerB, id: shared.id }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.readProductMemory({ instanceId, reader: main, id: privateA.id }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.readProductMemory({ instanceId, reader: { ...workerA, assignmentId: 'forged' }, id: privateA.id }), { code: 'MEMORY_DENIED' })
})

test('filtered memory lists count scanned rows rather than pages', { timeout: 15000 }, async t => {
  const { engine, storage } = await fixture(t)
  await storage.transaction(instanceId, async tx => {
    for (let index = 0; index < 12; index++) {
      const id = `memory-${String(index).padStart(2, '0')}`
      await tx.insert('product-memory', id, { id, scope: { kind: 'main' }, revision: 1,
        status: 'active', text: 'Unrelated note', createdAt: 1, updatedAt: 1 })
    }
    await tx.insert('product-memory', 'memory-z', { id: 'memory-z', scope: { kind: 'main' }, revision: 1,
      status: 'active', text: 'Needle note', createdAt: 1, updatedAt: 1 })
  })
  const page = await engine.listProductMemory({ instanceId, limit: 1, query: 'needle' })
  assert.deepEqual(page.items.map(item => item.id), ['memory-z'])
})

test('sharing changes and forgetting invalidate old pages and subsequent authorized recall', { timeout: 15000 }, async t => {
  const { engine, work, main, storage } = await fixture(t)
  const worker = await work('item-a', 'ticket-a')
  await engine.grantProductWorkMemory({ instanceId, commandId: 'allow', workItemId: 'item-a', expectedRevision: 0, enabled: true })
  const text = 'Fictional long term line: ' + '😀'.repeat(330)
  const entry = await engine.saveProductMemory({ instanceId, commandId: 'save', scope: { kind: 'shared', main: true, workItemIds: ['item-a'] }, text })
  const first = await engine.readProductMemory({ instanceId, reader: worker, id: entry.id, maxBytes: 256 })
  assert.equal(first.pagination.truncated, true)
  let full = first.text, cursor = first.pagination.cursor
  while (cursor) {
    const next = await engine.readProductMemory({ instanceId, reader: worker, id: entry.id, maxBytes: 256, after: cursor })
    full += next.text; cursor = next.pagination.cursor
  }
  assert.equal(full, text)
  const changed = await engine.shareProductMemory({ instanceId, commandId: 'remove-worker', id: entry.id,
    expectedRevision: 1, main: true, workItemIds: [] })
  assert.equal(changed.revision, 2)
  await assert.rejects(engine.readProductMemory({ instanceId, reader: worker, id: entry.id }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.readProductMemory({ instanceId, reader: main, id: entry.id, after: first.pagination.cursor }), { code: 'MEMORY_CURSOR_STALE' })
  await engine.forgetProductMemory({ instanceId, commandId: 'forget', id: entry.id, expectedRevision: 2 })
  await assert.rejects(engine.getProductMemory({ instanceId, id: entry.id }), { code: 'NOT_FOUND' })
  assert.deepEqual(await engine.searchProductMemory({ instanceId, reader: main, query: 'Fictional' }), [])
  assert.equal((await engine.saveProductMemory({ instanceId, commandId: 'save', scope: { kind: 'shared', main: true, workItemIds: ['item-a'] }, text })).status, 'forgotten')
  const stored = await storage.transaction(instanceId, tx => tx.get('product-memory', entry.id))
  assert.equal('text' in stored, false)
})

test('learning needs current grant, Assignment and time at approval; revocation blocks new reads', { timeout: 15000 }, async t => {
  const { engine, storage, work, main } = await fixture(t)
  const worker = await work('item-a', 'ticket-a')
  await engine.grantProductWorkMemory({ instanceId, commandId: 'grant', workItemId: 'item-a', expectedRevision: 0, enabled: true })
  const memory = new ProductMemory(storage, instanceId)
  const propose = memoryToolsFor(memory, worker).find(tool => tool.name === 'propose_memory')
  const signal = new AbortController().signal
  const proposed = JSON.parse(await propose.execute({ text: 'Fictional lesson one', reason: 'The work needs this later.' }, signal))
  assert.equal((await engine.listProductMemory({ instanceId })).items.length, 0)
  assert.equal((await engine.listProductMemoryProposals({ instanceId })).length, 1)
  await engine.grantProductWorkMemory({ instanceId, commandId: 'revoke', workItemId: 'item-a', expectedRevision: 1, enabled: false })
  assert.equal((await engine.decideProductMemoryProposal({ instanceId, commandId: 'approve-stale', proposalId: proposed.id, approve: true })).status, 'stale')
  await assert.rejects(engine.searchProductMemory({ instanceId, reader: worker, query: 'lesson' }), { code: 'MEMORY_DENIED' })
  await engine.grantProductWorkMemory({ instanceId, commandId: 'regrant', workItemId: 'item-a', expectedRevision: 2, enabled: true })
  const current = await memory.propose(worker, 'new-proposal', 'Fictional lesson two', 'The work needs this later.')
  const accepted = await engine.decideProductMemoryProposal({ instanceId, commandId: 'accept', proposalId: current.id, approve: true })
  assert.equal(accepted.status, 'approved')
  assert.equal((await engine.searchProductMemory({ instanceId, reader: worker, query: 'lesson' }))[0].id, accepted.entryId)
  assert.deepEqual(await engine.searchProductMemory({ instanceId, reader: main, query: 'lesson' }), [])
  const expired = await memory.propose(worker, 'expiring', 'Fictional lesson three', 'A proposed fact.')
  await storage.transaction(instanceId, async tx => {
    const record = await tx.get('product-memory-proposal', expired.id)
    await tx.replace('product-memory-proposal', expired.id, { ...record, expiresAt: Date.now() - 1 })
  })
  assert.equal((await engine.decideProductMemoryProposal({ instanceId, commandId: 'too-late', proposalId: expired.id, approve: true })).status, 'stale')
  await storage.transaction(instanceId, async tx => {
    const assignment = await tx.get('assignment', 'ticket-a')
    await tx.replace('assignment', 'ticket-a', { ...assignment, id: 'next-assignment' })
  })
  await assert.rejects(engine.readProductMemory({ instanceId, reader: worker, id: accepted.entryId }), { code: 'MEMORY_DENIED' })
})

test('the product Host serves local memory settings and rejects remote clients at the server', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-memory-host-'))
  await Promise.all([mkdir(join(root, 'work')), mkdir(join(root, 'core'))])
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('Main ready.'))
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(root, 'core', 'business.sqlite'), workspaceRoot: join(root, 'work'),
    instanceId, actorId: source.actorId, main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  await host.dispatch('open')
  const saved = await host.dispatch('memory-save', { instanceId, commandId: 'local-save', scope: { kind: 'main' }, text: 'Fictional Main fact' })
  assert.equal((await host.dispatch('memory-list', { instanceId })).items[0].id, saved.id)
  assert.equal((await host.dispatch('memory-read', { instanceId, id: saved.id })).text, 'Fictional Main fact')
  const remote = { id: 'remote', label: 'Reader', grants: [{ instanceId, capabilities: ['read', 'command'] }] }
  await assert.rejects(host.dispatch('memory-list', { instanceId }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('memory-read', { instanceId, id: saved.id }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('memory-save', { instanceId, commandId: 'remote', scope: { kind: 'main' }, text: 'No' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('memory-list', { instanceId: 'foreign' }), { code: 'SOURCE_NOT_AUTHORIZED' })
})
