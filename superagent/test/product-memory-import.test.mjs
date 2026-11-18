import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine } from '../dist/index.js'
import { ProductMemory } from '../dist/product-memory.js'
import { SqliteStorage } from '../dist/storage.js'

const instanceId = 'fictional-instance'
const source = { sourceInstanceId: 'product-desktop', actorId: 'fictional-user', allowedActorIds: ['fictional-user'] }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'r5-memory-import-'))
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const engine = new Engine(storage, instanceId, source)
  await engine.acquireHost()
  await storage.transaction(instanceId, tx => tx.insert('main-state', 'main', {
    instanceId, mainId: 'main-fictional', mainSessionId: 'main-session-fictional',
    routerSessionId: 'router-fictional', generation: 0, sequence: 0,
  }))
  await storage.transaction(instanceId, async tx => {
    await tx.insert('work-brief', 'brief-a', { id: 'brief-a', instanceId, mainId: 'main-fictional' })
    await tx.insert('work-item-ticket', 'item-a', { ticketId: 'ticket-a', workBriefId: 'brief-a' })
    await tx.insert('work-ticket', 'ticket-a', { workItemId: 'item-a', workBriefId: 'brief-a' })
    await tx.insert('ticket', 'ticket-a', { id: 'ticket-a', instanceId, state: 'open' })
    await tx.insert('assignment', 'ticket-a', { id: 'assignment-a', sessionId: 'session-a', state: 'running' })
  })
  t.after(async () => { await engine.shutdown(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  return { root, storage, engine }
}

const exported = items => JSON.stringify({
  schema: 'ds-bot-memory-export',
  version: 1,
  origin: { owner: 'Legacy Alice', instanceId: 'legacy-instance', kind: 'bot', exportedAt: '2026-11-16T00:00:00Z' },
  items,
})

test('memory export preview keeps the source unchanged and imports only explicit reviewed choices', { timeout: 15_000 }, async t => {
  const { root, storage, engine } = await fixture(t)
  const existing = await engine.saveProductMemory({ instanceId, commandId: 'existing-conflict',
    scope: { kind: 'main' }, text: 'Fictional shared fact' })
  const data = exported([
    { id: 'legacy-1', text: 'Fictional shared fact', originalScope: { kind: 'main', role: 'Legacy Main' } },
    { id: 'legacy-2', text: 'Fictional private method', originalScope: { kind: 'work', role: 'Legacy Writer', work: 'Old work' } },
    { id: 'legacy-3', text: 'Fictional final note', originalScope: { kind: 'unknown', label: 'Archived chat' } },
  ])
  const file = join(root, 'memory-export.json')
  const originalBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(data)])
  await writeFile(file, originalBytes)
  const before = await readFile(file)
  const sourceHash = createHash('sha256').update(before).digest('hex')
  const preview = await engine.previewProductMemoryImport({ instanceId, commandId: 'preview-memory',
    sourceName: 'memory-export.json', data: before })
  assert.equal(preview.sourceHash, sourceHash)
  assert.equal(preview.origin.owner, 'Legacy Alice')
  assert.equal(preview.items[1].originalScope.role, 'Legacy Writer')
  assert.equal(preview.items[1].text, 'Fictional private method')
  assert.deepEqual(preview.targetRoles, ['main', 'worker', 'shared'])
  assert.equal(preview.status, 'ready')
  assert.deepEqual((await engine.listProductMemory({ instanceId })).items.map(item => item.id), [existing.id])
  assert.equal((await readFile(file)).compare(before), 0, 'preview must not alter the provided export')
  assert.equal((await engine.previewProductMemoryImport({ instanceId, commandId: 'preview-again',
    sourceName: 'renamed.json', data: before })).id, preview.id)
  const changed = await engine.previewProductMemoryImport({ instanceId, commandId: 'preview-source-conflict',
    sourceName: 'changed.json', data: exported([
      { id: 'legacy-2', text: 'Changed fictional private method', originalScope: { kind: 'work', role: 'Legacy Writer' } },
    ]) })
  assert.deepEqual([changed.items[0].status, changed.items[0].reason, changed.items[0].existingBatchId],
    ['conflict', 'SOURCE_CONTENT_CONFLICT', preview.id])
  assert.equal(changed.status, 'partial')
  const restarted = new ProductMemory(storage, instanceId)
  assert.equal((await restarted.importBatch(preview.id)).id, preview.id)
  assert.deepEqual((await restarted.importBatches()).items.map(batch => batch.id).sort(), [preview.id, changed.id].sort())

  const command = { instanceId, commandId: 'commit-1', batchId: preview.id, selections: [
    { sourceId: 'legacy-1', scope: { kind: 'main' } },
    { sourceId: 'legacy-2', scope: { kind: 'work', workItemId: 'item-a' } },
  ] }
  await assert.rejects(engine.commitProductMemoryImport({ ...command, commandId: 'commit-no-target', selections: [] }),
    { code: 'INVALID_INPUT' })
  await assert.rejects(engine.commitProductMemoryImport({ ...command, commandId: 'commit-empty-shared',
    selections: [{ sourceId: 'legacy-2', scope: { kind: 'shared', main: false, workItemIds: [] } }] }),
  { code: 'INVALID_INPUT' })
  const partial = await engine.commitProductMemoryImport(command)
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.items.map(item => [item.sourceId, item.status]), [
    ['legacy-1', 'conflict'], ['legacy-2', 'imported'], ['legacy-3', 'ready'],
  ])
  assert.equal(partial.items[0].reason, 'DUPLICATE_MEMORY')
  assert.equal(partial.items[0].existingMemoryId, existing.id)
  const imported = partial.items.find(item => item.sourceId === 'legacy-2')
  assert.equal(imported.target.kind, 'work')
  const importedEntry = await engine.getProductMemory({ instanceId, id: imported.entryId })
  assert.equal(importedEntry.text, 'Fictional private method')
  assert.deepEqual(importedEntry.provenance, {
    batchId: preview.id, sourceItemId: 'legacy-2', sourceHash,
    originalOwner: 'Legacy Alice', originalScope: { kind: 'work', role: 'Legacy Writer', work: 'Old work' },
  })
  assert.equal(await storage.transaction(instanceId, tx => tx.get('session', 'legacy-session')), undefined)
  assert.equal(await storage.transaction(instanceId, tx => tx.get('ticket', 'legacy-ticket')), undefined)
  const worker = { role: 'worker', ticketId: 'ticket-a', assignmentId: 'assignment-a', sessionId: 'session-a' }
  await assert.rejects(engine.searchProductMemory({ instanceId, reader: worker, query: 'private method' }), { code: 'MEMORY_DENIED' })
  await engine.grantProductWorkMemory({ instanceId, commandId: 'grant-imported-work', workItemId: 'item-a',
    expectedRevision: 0, enabled: true })
  assert.equal((await engine.searchProductMemory({ instanceId, reader: worker, query: 'private method' })).length, 1)
  await engine.grantProductWorkMemory({ instanceId, commandId: 'revoke-imported-work', workItemId: 'item-a',
    expectedRevision: 1, enabled: false })
  await assert.rejects(engine.searchProductMemory({ instanceId, reader: worker, query: 'private method' }), { code: 'MEMORY_DENIED' })

  const replay = await engine.commitProductMemoryImport(command)
  assert.deepEqual(replay.items[1].entryId, imported.entryId)
  const repeated = await engine.commitProductMemoryImport({ ...command, commandId: 'commit-repeat' })
  assert.deepEqual(repeated.items[1].entryId, imported.entryId)
  assert.equal((await engine.listProductMemory({ instanceId })).items.length, 2)
  await assert.rejects(engine.commitProductMemoryImport({ ...command, commandId: 'commit-other-target',
    selections: [{ sourceId: 'legacy-2', scope: { kind: 'main' } }] }), { code: 'MEMORY_IMPORT_CONFLICT' })

  const cancelled = await engine.cancelProductMemoryImport({ instanceId, commandId: 'cancel-import', batchId: preview.id })
  assert.equal(cancelled.status, 'cancelled')
  const resumed = await engine.retryProductMemoryImport({ instanceId, commandId: 'retry-import', batchId: preview.id })
  assert.equal(resumed.status, 'partial')
  const completed = await engine.commitProductMemoryImport({ instanceId, commandId: 'commit-final', batchId: preview.id,
    selections: [{ sourceId: 'legacy-3',
      scope: { kind: 'shared', main: true, workItemIds: [] } }] })
  assert.equal(completed.status, 'partial')
  assert.equal((await readFile(file)).compare(before), 0, 'import and cancel must leave the source file untouched')
  const finalEntry = completed.items.find(item => item.sourceId === 'legacy-3')
  assert.deepEqual((await engine.getProductMemory({ instanceId, id: finalEntry.entryId })).scope,
    { kind: 'shared', main: true, workItemIds: [] })
  await engine.shareProductMemory({ instanceId, commandId: 'share-imported', id: finalEntry.entryId,
    expectedRevision: 1, main: true, workItemIds: ['item-a'] })
  assert.equal((await engine.searchProductMemory({ instanceId, reader: { role: 'main', sessionId: 'main-session-fictional' },
    query: 'final note' })).length, 1)
  await engine.forgetProductMemory({ instanceId, commandId: 'forget-imported', id: finalEntry.entryId, expectedRevision: 2 })
  await assert.rejects(engine.getProductMemory({ instanceId, id: finalEntry.entryId }), { code: 'NOT_FOUND' })
})

test('sensitive or malformed export items are rejected without persisting their text', { timeout: 15_000 }, async t => {
  const { storage, engine } = await fixture(t)
  const secrets = ['access_token=must-not-enter-memory', 'refresh_token=also-private',
    'client_secret=private-client-value', ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')]
  const data = exported([
    { id: 'safe', text: 'Fictional safe note', originalScope: { kind: 'main' } },
    ...secrets.map((secret, index) => ({ id: `secret-${index}`, text: secret, originalScope: { kind: 'main' } })),
  ])
  const preview = await engine.previewProductMemoryImport({ instanceId, commandId: 'preview-sensitive',
    sourceName: 'sensitive.json', data })
  assert.deepEqual(preview.items.map(item => [item.sourceId, item.status, item.reason]), [
    ['safe', 'ready', undefined], ...secrets.map((_secret, index) =>
      [`secret-${index}`, 'rejected', 'MEMORY_SENSITIVE']),
  ])
  const storedItems = JSON.stringify(await storage.transaction(instanceId, tx =>
    tx.scan('product-memory-import-item', { limit: 10 })))
  assert.equal(secrets.some(secret => storedItems.includes(secret)), false)
  await assert.rejects(engine.previewProductMemoryImport({ instanceId, commandId: 'preview-bad-json',
    sourceName: 'bad.json', data: '{' }), { code: 'INVALID_INPUT' })
  await assert.rejects(engine.previewProductMemoryImport({ instanceId, commandId: 'preview-legacy-identity',
    sourceName: 'legacy-identity.json', data: JSON.stringify({ schema: 'ds-bot-memory-export', version: 1,
      origin: { owner: 'Fictional' }, items: [], legacySessionId: 'must-not-import' }) }), { code: 'INVALID_INPUT' })
})
