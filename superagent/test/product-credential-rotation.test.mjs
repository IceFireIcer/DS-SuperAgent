import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { CoreError, ProductCredentialManager } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { startPostgres } from './fixtures/postgres-harness.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'r5-credential-rotation-'))
  const database = join(directory, 'business.sqlite')
  let storage = await SqliteStorage.open(database)
  let context = new Context()
  const providerPath = join(directory, 'credentials.yaml')
  await context.plugin(LocalCredentials, { path: providerPath, watch: false })
  t.after(async () => { await storage.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { get storage() { return storage }, get context() { return context }, database, providerPath,
    manager: () => new ProductCredentialManager(storage, 'personal', context.credentials),
    async restart() {
      await storage.close(); await context.fiber.dispose()
      storage = await SqliteStorage.open(database)
      context = new Context()
      await context.plugin(LocalCredentials, { path: providerPath, watch: false })
      return new ProductCredentialManager(storage, 'personal', context.credentials)
    } }
}

async function resourceWithGrant(fixture) {
  const manager = fixture.manager()
  const resource = await manager.create({ instanceId: 'personal', commandId: 'create', label: 'Connector', value: 'fictional-old-value' })
  const granted = await manager.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: 1, scope: { role: 'worker', workItemId: 'work-one' }, purposes: ['tool'] })
  return { manager, granted, use: { instanceId: 'personal', resourceId: resource.id, role: 'worker',
    workItemId: 'work-one', purpose: 'tool' } }
}

test('one stable rotation switches the grant consumer and cleans only the old DSH record', async t => {
  const f = await fixture(t)
  const { manager, granted, use } = await resourceWithGrant(f)
  const original = await f.storage.transaction('personal', tx => tx.get('resource-credential', granted.id))
  await assert.rejects(manager.rotate({ instanceId: 'personal', commandId: 'invalid-value', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'invalid\nsecret' }), { code: 'INVALID_INPUT' })
  assert.equal(await manager.rotationStatus({ instanceId: 'personal', commandId: 'invalid-value' }), undefined)
  const input = { instanceId: 'personal', commandId: 'rotate-one', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  const rotated = await manager.rotate(input)
  assert.equal(rotated.status, 'committed')
  assert.equal(rotated.resource.revision, 3)
  assert.deepEqual(rotated.resource.grants, granted.grants)
  assert.equal(rotated.cleanupPending, false)
  assert.equal(await manager.use(use, async secret => secret), input.value)
  assert.equal(await f.context.credentials.readRecord(original.vaultReference), undefined)
  assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length, 1)
  assert.deepEqual(await manager.rotate(input), rotated)
  await assert.rejects(manager.rotate({ ...input, value: 'fictional-different-value' }), { code: 'IDENTITY_CONFLICT' })
  const status = await manager.rotationStatus({ instanceId: 'personal', commandId: input.commandId })
  const publicData = JSON.stringify({ rotated, status, list: await manager.list({ instanceId: 'personal' }) })
  assert.equal(publicData.includes('vault-'), false)
  assert.equal(publicData.includes('fictional-old-value') || publicData.includes(input.value), false)
  const intent = await f.storage.transaction('personal', tx => tx.get('resource-rotation-intent', input.commandId))
  assert.equal(JSON.stringify(intent).includes(input.value), false)
  assert.deepEqual(await manager.resumeRotations(), { reconciled: 1, pending: 0 })
})

test('a lost business COMMIT response is checked by the original rotation ID after restart', async t => {
  const f = await fixture(t)
  const { granted, use } = await resourceWithGrant(f)
  let inject = true
  const guarded = { transaction: async (instanceId, operation) => {
    let switched = false
    const result = await f.storage.transaction(instanceId, tx => operation({ ...tx,
      replace: async (kind, id, value) => {
        if (kind === 'resource-rotation-intent' && value.status === 'committed') switched = true
        return tx.replace(kind, id, value)
      } }))
    if (switched && inject) { inject = false; throw new CoreError('COMMIT_UNKNOWN', 'The response was lost.') }
    return result
  }, reconnect: async () => { throw new Error('The response is still unavailable.') } }
  const interrupted = new ProductCredentialManager(guarded, 'personal', f.context.credentials)
  const input = { instanceId: 'personal', commandId: 'lost-commit', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  await assert.rejects(interrupted.rotate(input), { code: 'COMMIT_UNKNOWN' })
  const resumed = await f.restart()
  assert.equal((await resumed.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).status, 'committed')
  assert.deepEqual(await resumed.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal((await resumed.rotate(input)).resource.revision, 3)
  assert.equal(await resumed.use(use, async secret => secret), input.value)
})

test('a fenced old Host cannot switch a staged vault record after losing its lease', async t => {
  const f = await fixture(t)
  const { granted, use } = await resourceWithGrant(f)
  let fenced = false
  const guarded = { transaction: (instanceId, operation) => f.storage.transaction(instanceId, tx => {
    if (fenced) throw new CoreError('HOST_LEASED', 'The old Host lost its lease.')
    return operation(tx)
  }), reconnect: async () => guarded }
  const records = { readRecord: key => f.context.credentials.readRecord(key),
    modifyRecord: async (key, mutate) => {
      const saved = await f.context.credentials.modifyRecord(key, mutate)
      fenced = true
      return saved
    }, deleteRecord: key => f.context.credentials.deleteRecord(key) }
  const old = new ProductCredentialManager(guarded, 'personal', records)
  const input = { instanceId: 'personal', commandId: 'fenced-rotation', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  await assert.rejects(old.rotate(input), { code: 'HOST_LEASED' })
  const replacement = f.manager()
  assert.deepEqual(await replacement.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal((await replacement.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).status, 'abandoned')
  assert.equal(await replacement.use(use, async secret => secret), 'fictional-old-value')
  assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length, 1)
})

test('a vault write with a lost response is abandoned and cleaned after restart', async t => {
  const f = await fixture(t)
  const { granted, use } = await resourceWithGrant(f)
  const records = { readRecord: key => f.context.credentials.readRecord(key),
    modifyRecord: async (key, mutate) => {
      await f.context.credentials.modifyRecord(key, mutate)
      throw new Error('Provider response lost after writing fictional-next-value.')
    }, deleteRecord: key => f.context.credentials.deleteRecord(key) }
  const input = { instanceId: 'personal', commandId: 'lost-provider', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  await assert.rejects(new ProductCredentialManager(f.storage, 'personal', records).rotate(input), error => {
    assert.equal(error.code, 'CREDENTIAL_WRITE_FAILED')
    assert.equal(JSON.stringify(error).includes(input.value), false)
    return true
  })
  const resumed = await f.restart()
  assert.deepEqual(await resumed.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal(await resumed.use(use, async secret => secret), 'fictional-old-value')
  assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length, 1)
})

for (const failAfterWrite of [false, true]) {
  test(`a replacement Host abandons a late vault write and repeatedly cleans it (${failAfterWrite ? 'interrupted' : 'fenced'})`, async t => {
    const f = await fixture(t)
    const { granted, use } = await resourceWithGrant(f)
    let release, reached
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { reached = resolve })
    t.after(() => release())
    const records = { readRecord: key => f.context.credentials.readRecord(key),
      modifyRecord: async (key, mutate) => {
        reached(); await gate
        const written = await f.context.credentials.modifyRecord(key, mutate)
        if (failAfterWrite) throw new Error('The old Host lost its vault receipt.')
        return written
      }, deleteRecord: key => f.context.credentials.deleteRecord(key) }
    const old = new ProductCredentialManager(f.storage, 'personal', records)
    const replacement = f.manager()
    const input = { instanceId: 'personal', commandId: 'late-rotation', resourceId: granted.id,
      expectedRevision: granted.revision, value: 'fictional-next-value' }
    const rotating = old.rotate(input)
    await started
    assert.deepEqual(await replacement.resumeRotations(), { reconciled: 1, pending: 0 })
    assert.equal((await replacement.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).status, 'abandoned')
    release()
    await assert.rejects(rotating, { code: failAfterWrite ? 'CREDENTIAL_WRITE_FAILED' : 'RESOURCE_UNAVAILABLE' })
    assert.equal(await replacement.use(use, async secret => secret), 'fictional-old-value')
    assert.deepEqual(await replacement.resumeRotations(), { reconciled: 1, pending: 0 })
    assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length, 1)
    await assert.rejects(replacement.rotate(input), { code: 'RESOURCE_UNAVAILABLE' })
  })
}

for (const change of ['revoke', 'delete']) {
  test(`${change} during vault staging prevents an old rotation from restoring access`, async t => {
    const f = await fixture(t)
    const { manager, granted, use } = await resourceWithGrant(f)
    let release, reached
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { reached = resolve })
    t.after(() => release())
    const records = { readRecord: key => f.context.credentials.readRecord(key),
      modifyRecord: async (key, mutate) => {
        const written = await f.context.credentials.modifyRecord(key, mutate)
        reached(); await gate
        return written
      }, deleteRecord: key => f.context.credentials.deleteRecord(key) }
    const old = new ProductCredentialManager(f.storage, 'personal', records)
    const input = { instanceId: 'personal', commandId: 'racing-rotation', resourceId: granted.id,
      expectedRevision: granted.revision, value: 'fictional-next-value' }
    const rotating = old.rotate(input)
    await started
    if (change === 'revoke') {
      await manager.revokeGrant({ instanceId: 'personal', commandId: 'revoke-now', resourceId: granted.id,
        expectedRevision: granted.revision, grantId: granted.grants[0].id })
    } else {
      await manager.delete({ instanceId: 'personal', commandId: 'delete-now', resourceId: granted.id,
        expectedRevision: granted.revision })
    }
    release()
    await assert.rejects(rotating, { code: change === 'delete' ? 'RESOURCE_UNAVAILABLE' : 'RESOURCE_REVISION_CONFLICT' })
    await assert.rejects(manager.use(use, async () => true), { code: change === 'delete' ? 'RESOURCE_UNAVAILABLE' : 'GRANT_DENIED' })
    assert.equal((await manager.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).status, 'abandoned')
    assert.deepEqual(await manager.resumeRotations(), { reconciled: 1, pending: 0 })
    assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length,
      change === 'delete' ? 0 : 1)
  })
}

test('failed old-record deletion stays visible and resumes after provider restart', async t => {
  const f = await fixture(t)
  const { granted, use } = await resourceWithGrant(f)
  const original = await f.storage.transaction('personal', tx => tx.get('resource-credential', granted.id))
  let fail = true
  const records = { readRecord: key => f.context.credentials.readRecord(key),
    modifyRecord: (key, mutate) => f.context.credentials.modifyRecord(key, mutate),
    deleteRecord: key => key === original.vaultReference && fail
      ? Promise.reject(new Error('fictional-old-value must not escape')) : f.context.credentials.deleteRecord(key) }
  const input = { instanceId: 'personal', commandId: 'cleanup-fails', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  const result = await new ProductCredentialManager(f.storage, 'personal', records).rotate(input)
  assert.equal(result.status, 'committed')
  assert.equal(result.cleanupPending, true)
  assert.equal(JSON.stringify(result).includes('fictional-old-value'), false)
  assert.equal(await f.manager().use(use, async secret => secret), input.value)
  fail = false
  const resumed = await f.restart()
  assert.deepEqual(await resumed.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal((await resumed.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).cleanupPending, false)
  await resumed.delete({ instanceId: 'personal', commandId: 'delete', resourceId: granted.id, expectedRevision: 3 })
  await assert.rejects(resumed.rotate(input), { code: 'RESOURCE_UNAVAILABLE' })
  assert.deepEqual(await resumed.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal((await f.context.credentials.listRecords()).filter(item => String(item.key).startsWith('ds-superagent-profile/vault-')).length, 0)
})

test('a late old record reopens cleanup status when the provider cannot delete it', async t => {
  const f = await fixture(t)
  const { granted } = await resourceWithGrant(f)
  const original = await f.storage.transaction('personal', tx => tx.get('resource-credential', granted.id))
  const input = { instanceId: 'personal', commandId: 'late-old-record', resourceId: granted.id,
    expectedRevision: granted.revision, value: 'fictional-next-value' }
  assert.equal((await f.manager().rotate(input)).cleanupPending, false)
  await f.context.credentials.modifyRecord(original.vaultReference, async () => ({ kind: 'api-key', key: 'fictional-old-value' }))
  let failDelete = true
  const records = { readRecord: key => f.context.credentials.readRecord(key),
    modifyRecord: (key, mutate) => f.context.credentials.modifyRecord(key, mutate),
    deleteRecord: key => key === original.vaultReference && failDelete
      ? Promise.reject(new Error('Provider unavailable.')) : f.context.credentials.deleteRecord(key) }
  const manager = new ProductCredentialManager(f.storage, 'personal', records)
  assert.deepEqual(await manager.resumeRotations(), { reconciled: 0, pending: 1 })
  assert.equal((await manager.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).cleanupPending, true)
  failDelete = false
  assert.deepEqual(await manager.resumeRotations(), { reconciled: 1, pending: 0 })
  assert.equal((await manager.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).cleanupPending, false)
  assert.equal(await f.context.credentials.readRecord(original.vaultReference), undefined)
})

test('PostgreSQL keeps a rotation receipt and CAS across new connections', {
  skip: process.platform === 'win32' && 'The embedded PostgreSQL fixture startup does not complete on this Windows host.',
  timeout: 120000,
}, async t => {
  const postgres = await startPostgres('r5-credential-rotation-pg-')
  t.after(() => postgres.close())
  const { storage } = await postgres.newStorage()
  const saved = new Map()
  const records = { readRecord: async key => saved.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(saved.get(key))
      if (next) saved.set(key, next)
      return next
    }, deleteRecord: async key => { saved.delete(key) } }
  const manager = new ProductCredentialManager(storage, 'personal', records)
  const resource = await manager.create({ instanceId: 'personal', commandId: 'create', label: 'PostgreSQL fixture', value: 'fictional-old-value' })
  const input = { instanceId: 'personal', commandId: 'rotate', resourceId: resource.id,
    expectedRevision: resource.revision, value: 'fictional-next-value' }
  const first = await manager.rotate(input)
  const reopened = new ProductCredentialManager(postgres.register(await storage.reconnect()), 'personal', records)
  assert.deepEqual(await reopened.rotate(input), first)
  await assert.rejects(reopened.rotate({ ...input, commandId: 'stale', value: 'fictional-other-value' }),
    { code: 'RESOURCE_REVISION_CONFLICT' })
  assert.equal((await reopened.rotationStatus({ instanceId: 'personal', commandId: input.commandId })).cleanupPending, false)
  assert.equal(saved.size, 1)
})
