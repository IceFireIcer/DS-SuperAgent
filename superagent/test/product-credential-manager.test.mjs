import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { CoreError, ProductCredentialManager } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

test('the product manager persists exact grants and deletes the DSH record after business revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-resource-'))
  const context = new Context()
  const storage = await SqliteStorage.open(join(directory, 'business.sqlite'))
  t.after(async () => { await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const manager = new ProductCredentialManager(storage, 'personal', context.credentials)
  const input = { instanceId: 'personal', commandId: 'create-one', label: 'Issue delivery', value: 'fictional-resource-value' }
  const resource = await manager.create(input)
  assert.deepEqual(await manager.create(input), resource)
  assert.equal(resource.grants.length, 0)
  assert.equal(JSON.stringify(await manager.list({ instanceId: 'personal' })).includes(input.value), false)
  assert.equal(JSON.stringify(resource).includes('vault-'), false)
  const pending = await manager.request({ instanceId: 'personal', commandId: 'request-one', resourceId: resource.id,
    scope: { role: 'worker', workItemId: 'item-one', environmentId: 'work-one' }, purpose: 'tool' })
  assert.equal(pending.status, 'pending')
  const granted = await manager.grant({ instanceId: 'personal', commandId: 'grant-one', resourceId: resource.id,
    expectedRevision: 1, scope: pending.scope, purposes: ['tool'], requestId: pending.id })
  assert.equal((await manager.getRequest({ instanceId: 'personal', requestId: pending.id })).status, 'granted')
  const use = { instanceId: 'personal', resourceId: resource.id, role: 'worker', workItemId: 'item-one',
    environmentId: 'work-one', purpose: 'tool' }
  assert.equal(await manager.use(use, async value => value === input.value), true)
  await assert.rejects(manager.use({ ...use, workItemId: 'item-two' }, async () => true), { code: 'GRANT_DENIED' })
  const revoked = await manager.revokeGrant({ instanceId: 'personal', commandId: 'revoke-one', resourceId: resource.id,
    grantId: granted.grants[0].id, expectedRevision: 2 })
  await assert.rejects(manager.use(use, async () => true), { code: 'GRANT_DENIED' })
  const deleted = await manager.delete({ instanceId: 'personal', commandId: 'delete-one', resourceId: resource.id,
    expectedRevision: revoked.revision })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.cleanupPending, undefined)
  await assert.rejects(manager.create(input), { code: 'RESOURCE_UNAVAILABLE' })
  assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), false)
  assert.deepEqual(await manager.resumeCleanup(), { cleaned: 0, pending: 0 })
  await assert.rejects(manager.use(use, async () => true), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(manager.create({ ...input, instanceId: 'team' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  const other = await manager.create({ ...input, commandId: 'create-two', label: 'Second resource' })
  await manager.delete({ instanceId: 'personal', commandId: 'delete-two', resourceId: other.id, expectedRevision: 1 })
  await assert.rejects(manager.delete({ instanceId: 'personal', commandId: 'delete-one', resourceId: other.id,
    expectedRevision: 999 }), { code: 'IDENTITY_CONFLICT' })
})

test('a failed vault cleanup remains visible and can resume after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-resource-cleanup-'))
  const context = new Context()
  const database = join(directory, 'business.sqlite')
  let storage = await SqliteStorage.open(database)
  t.after(async () => { await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  let failDelete = true
  const records = { readRecord: key => context.credentials.readRecord(key),
    modifyRecord: (key, mutate) => context.credentials.modifyRecord(key, mutate),
    deleteRecord: key => failDelete ? Promise.reject(new Error('Temporary provider failure.')) : context.credentials.deleteRecord(key) }
  const manager = new ProductCredentialManager(storage, 'personal', records)
  const resource = await manager.create({ instanceId: 'personal', commandId: 'create', label: 'Storage', value: 'fictional-resource-value' })
  const deleted = await manager.delete({ instanceId: 'personal', commandId: 'delete', resourceId: resource.id, expectedRevision: 1 })
  assert.equal(deleted.cleanupPending, true)
  await storage.close()
  storage = await SqliteStorage.open(database)
  failDelete = false
  const resumed = new ProductCredentialManager(storage, 'personal', records)
  assert.deepEqual(await resumed.resumeCleanup(), { cleaned: 1, pending: 0 })
  assert.equal((await resumed.get({ instanceId: 'personal', resourceId: resource.id })).cleanupPending, undefined)
  assert.equal((await resumed.delete({ instanceId: 'personal', commandId: 'delete', resourceId: resource.id, expectedRevision: 1 })).status, 'deleted')
})

test('a fenced Host cannot leave a new credential record after its business write is denied', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-resource-fence-'))
  const context = new Context()
  const storage = await SqliteStorage.open(join(directory, 'business.sqlite'))
  t.after(async () => { await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  let fenced = false
  const guard = { transaction: (instanceId, operation) => storage.transaction(instanceId, tx => {
    if (fenced) throw new CoreError('HOST_LEASED', 'The former Host lost its lease.')
    return operation(tx)
  }), reconnect: async () => guard, close: () => storage.close() }
  const records = { readRecord: key => context.credentials.readRecord(key),
    modifyRecord: async (key, mutate) => { const result = await context.credentials.modifyRecord(key, mutate); fenced = true; return result },
    deleteRecord: key => context.credentials.deleteRecord(key) }
  const manager = new ProductCredentialManager(guard, 'personal', records)
  await assert.rejects(manager.create({ instanceId: 'personal', commandId: 'lost-host',
    label: 'Scoped resource', value: 'fictional-resource-value' }), { code: 'HOST_LEASED' })
  assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), false)
  fenced = false
  const recovered = new ProductCredentialManager(storage, 'personal', context.credentials)
  assert.deepEqual(await recovered.resumeCreations(), { reconciled: 1, pending: 0 })
  assert.deepEqual((await recovered.list({ instanceId: 'personal' })).items, [])
})

test('a replacement Host reconciles an interrupted vault write with no business receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-resource-intent-'))
  const context = new Context()
  const storage = await SqliteStorage.open(join(directory, 'business.sqlite'))
  t.after(async () => { await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  let disconnected = false
  const guard = { transaction: (instanceId, operation) => storage.transaction(instanceId, tx => {
    if (disconnected) throw new CoreError('STORAGE_UNAVAILABLE', 'The business store disconnected.')
    return operation(tx)
  }), reconnect: async () => guard, close: () => storage.close() }
  const records = { readRecord: key => context.credentials.readRecord(key),
    modifyRecord: async (key, mutate) => { const result = await context.credentials.modifyRecord(key, mutate); disconnected = true; return result },
    deleteRecord: key => context.credentials.deleteRecord(key) }
  const interrupted = new ProductCredentialManager(guard, 'personal', records)
  await assert.rejects(interrupted.create({ instanceId: 'personal', commandId: 'interrupted-create',
    label: 'Scoped resource', value: 'fictional-resource-value' }), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), true)
  disconnected = false
  const replacement = new ProductCredentialManager(storage, 'personal', context.credentials)
  assert.deepEqual(await replacement.resumeCreations(), { reconciled: 1, pending: 0 })
  assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), false)
})

test('recovery cannot delete a vault record while its creation command is in flight', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-resource-create-race-'))
  const context = new Context()
  const storage = await SqliteStorage.open(join(directory, 'business.sqlite'))
  let release, reached
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { reached = resolve })
  t.after(async () => { release(); await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const records = { readRecord: key => context.credentials.readRecord(key),
    modifyRecord: async (key, mutate) => {
      const result = await context.credentials.modifyRecord(key, mutate)
      reached(); await gate
      return result
    }, deleteRecord: key => context.credentials.deleteRecord(key) }
  const manager = new ProductCredentialManager(storage, 'personal', records)
  const creating = manager.create({ instanceId: 'personal', commandId: 'create-one',
    label: 'Scoped resource', value: 'fictional-resource-value' })
  await started
  assert.deepEqual(await manager.resumeCreations(), { reconciled: 0, pending: 1 })
  release()
  const resource = await creating
  assert.equal(resource.status, 'active')
  assert.deepEqual(await manager.resumeCreations(), { reconciled: 0, pending: 0 })
  assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), true)
})

for (const failAfterWrite of [false, true]) {
  test(`Host recovery retains a cleanup marker across a late vault write (${failAfterWrite ? 'interrupted' : 'fenced'})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'r5-late-vault-write-'))
    const context = new Context()
    const storage = await SqliteStorage.open(join(directory, 'business.sqlite'))
    let release, reached
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { reached = resolve })
    t.after(async () => { release(); await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
    await context.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
    const records = { readRecord: key => context.credentials.readRecord(key),
      modifyRecord: async (key, mutate) => {
        reached(); await gate
        const saved = await context.credentials.modifyRecord(key, mutate)
        if (failAfterWrite) throw new Error('Old Host stopped before receiving its vault receipt.')
        return saved
      }, deleteRecord: key => context.credentials.deleteRecord(key) }
    const oldHost = new ProductCredentialManager(storage, 'personal', records)
    const newHost = new ProductCredentialManager(storage, 'personal', context.credentials)
    const input = { instanceId: 'personal', commandId: 'late-create', label: 'Scoped resource', value: 'fictional-resource-value' }
    const creating = oldHost.create(input)
    await started
    assert.deepEqual(await newHost.resumeCreations(), { reconciled: 1, pending: 0 })
    await assert.rejects(newHost.create(input), { code: 'RESOURCE_UNAVAILABLE' })
    release()
    await assert.rejects(creating, { code: failAfterWrite ? 'CREDENTIAL_WRITE_FAILED' : 'RESOURCE_UNAVAILABLE' })
    assert.deepEqual((await newHost.list({ instanceId: 'personal' })).items, [])
    if (failAfterWrite) {
      assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), true)
      assert.deepEqual(await newHost.resumeCreations(), { reconciled: 1, pending: 0 })
    }
    assert.equal((await context.credentials.listRecords()).some(entry => String(entry.key).startsWith('ds-superagent-profile/vault-')), false)
  })
}

test('creation recovery continues a bounded scan instead of dropping later intents', async () => {
  const cursors = []
  const storage = { transaction: async (_instanceId, operation) => operation({ scan: async (_kind, options) => {
    cursors.push(options.after)
    return { items: [], ...(cursors.length <= 10 ? { cursor: `page-${cursors.length}` } : {}) }
  } }) }
  const records = { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {} }
  const manager = new ProductCredentialManager(storage, 'personal', records)
  assert.deepEqual(await manager.resumeCreations(), { reconciled: 0, pending: 0, more: true })
  assert.deepEqual(await manager.resumeCreations(), { reconciled: 0, pending: 0 })
  assert.equal(cursors[10], 'page-10')
})
