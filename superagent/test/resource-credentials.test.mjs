import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ResourceCredentials } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { startPostgres } from './fixtures/postgres-harness.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-resource-credentials-'))
  const database = join(directory, 'state.sqlite')
  const storage = await SqliteStorage.open(database)
  const connections = [storage]
  const vault = new Map([['vault:personal', { instanceId: 'personal', value: 'fictional-private-value' }],
    ['vault:team', { instanceId: 'team', value: 'fictional-team-value' }]])
  t.after(async () => {
    for (const connection of connections.reverse()) await connection.close()
    await rm(directory, { recursive: true, force: true })
  })
  const adapter = {
    async assertReference(instanceId, reference) {
      if (vault.get(reference)?.instanceId !== instanceId) throw new Error('The reference is unavailable.')
    },
    async withSecret(instanceId, reference, consume) {
      if (vault.get(reference)?.instanceId !== instanceId) throw new Error('The reference is unavailable.')
      return consume(vault.get(reference).value)
    },
  }
  return { database, storage, adapter, vault, connections, credentials: new ResourceCredentials(storage, 'personal', adapter) }
}

test('creation has no implicit grant, and the projection and receipt never contain a vault reference or value', async t => {
  const { credentials, storage } = await fixture(t)
  const command = { instanceId: 'personal', commandId: 'create-1', label: 'Issue connector', vaultReference: 'vault:personal' }
  const created = await credentials.create(command)
  assert.equal(created.status, 'active')
  assert.deepEqual(created.grants, [])
  assert.equal(created.revision, 1)
  assert.equal((await credentials.create(command)).id, created.id)
  assert.deepEqual(await credentials.get({ instanceId: 'personal', resourceId: created.id }), created)
  assert.deepEqual((await credentials.list({ instanceId: 'personal' })).items, [created])
  assert.equal(JSON.stringify(created).includes('vault:personal'), false)
  assert.equal(JSON.stringify(created).includes('fictional-private-value'), false)
  await assert.rejects(credentials.use({ instanceId: 'personal', resourceId: created.id, purpose: 'tool', role: 'worker',
    workItemId: 'work-1', environmentId: 'local' }, async () => {}), { code: 'GRANT_DENIED' })
  await assert.rejects(credentials.create({ ...command, commandId: 'create-2', vaultReference: 'vault:team' }), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(credentials.create({ ...command, commandId: 'create-3', botId: 'old-main' }), { code: 'INVALID_INPUT' })
  const persisted = await storage.transaction('personal', tx => tx.get('resource-credential', created.id))
  assert.equal(persisted.vaultReference, 'vault:personal')
  assert.equal(JSON.stringify(persisted).includes('fictional-private-value'), false)
  const team = new ResourceCredentials(storage, 'team', {
    assertReference: async () => {}, withSecret: async () => { throw new Error('Should not reach the vault.') },
  })
  assert.equal(await team.get({ instanceId: 'team', resourceId: created.id }), undefined)
  await assert.rejects(team.use({ instanceId: 'team', resourceId: created.id, purpose: 'tool', role: 'worker' }, async () => {}),
    { code: 'RESOURCE_UNAVAILABLE' })
})

test('role, work, Environment and purpose grants are checked at use, including after revocation and restart', async t => {
  const { credentials, adapter, database, connections } = await fixture(t)
  const created = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Connector', vaultReference: 'vault:personal' })
  const scope = { role: 'worker', workItemId: 'work-1', environmentId: 'remote-1' }
  const granted = await credentials.grant({ instanceId: 'personal', commandId: 'grant-1', resourceId: created.id,
    expectedRevision: 1, scope, purposes: ['tool'] })
  assert.equal(granted.revision, 2)
  assert.deepEqual(granted.grants[0].purposes, ['tool'])
  assert.equal((await credentials.grant({ instanceId: 'personal', commandId: 'grant-1', resourceId: created.id,
    expectedRevision: 1, scope, purposes: ['tool'] })).revision, 2)
  const use = { instanceId: 'personal', resourceId: created.id, purpose: 'tool', ...scope }
  assert.equal(await credentials.use(use, async value => value === 'fictional-private-value'), true)
  for (const changed of [{ role: 'main' }, { workItemId: 'work-2' }, { environmentId: 'local' },
    { purpose: 'outbound', sourceInstanceId: 'source-1' }, { purpose: 'source', sourceInstanceId: 'source-1' },
    { instanceId: 'team' }]) {
    await assert.rejects(credentials.use({ ...use, ...changed }, async () => {}),
      { code: changed.instanceId ? 'SOURCE_NOT_AUTHORIZED' : 'GRANT_DENIED' })
  }
  await assert.rejects(credentials.grant({ instanceId: 'personal', commandId: 'stale', resourceId: created.id,
    expectedRevision: 1, scope, purposes: ['tool'] }), { code: 'RESOURCE_REVISION_CONFLICT' })
  const reopenedStorage = await SqliteStorage.open(database)
  connections.push(reopenedStorage)
  const reopened = new ResourceCredentials(reopenedStorage, 'personal', adapter)
  assert.equal(await reopened.use(use, async value => value.length), 'fictional-private-value'.length)
  const revoked = await reopened.revoke({ instanceId: 'personal', commandId: 'revoke-1', resourceId: created.id,
    grantId: granted.grants[0].id, expectedRevision: 2 })
  assert.equal(revoked.revision, 3)
  assert.deepEqual(revoked.grants, [])
  await assert.rejects(credentials.use(use, async () => {}), { code: 'GRANT_DENIED' })
  assert.deepEqual(await reopened.revoke({ instanceId: 'personal', commandId: 'revoke-1', resourceId: created.id,
    grantId: granted.grants[0].id, expectedRevision: 2 }), revoked)
})

test('source, tool and outbound authorizations are independent and a cancelled request never grants access', async t => {
  const { credentials } = await fixture(t)
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Source', vaultReference: 'vault:personal' })
  const scope = { role: 'main', sourceInstanceId: 'source-1' }
  const requested = await credentials.request({ instanceId: 'personal', commandId: 'request-1', resourceId: resource.id,
    scope, purpose: 'source' })
  assert.equal(requested.status, 'pending')
  const cancelled = await credentials.cancel({ instanceId: 'personal', commandId: 'cancel-1', requestId: requested.id })
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(await credentials.cancel({ instanceId: 'personal', commandId: 'cancel-1', requestId: requested.id }), cancelled)
  await assert.rejects(credentials.use({ instanceId: 'personal', resourceId: resource.id, purpose: 'source', ...scope }, async () => {}),
    { code: 'GRANT_DENIED' })
  const grant = await credentials.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: 1, scope, purposes: ['source'] })
  assert.equal(await credentials.use({ instanceId: 'personal', resourceId: resource.id, purpose: 'source', ...scope },
    async value => value.length), 'fictional-private-value'.length)
  for (const purpose of ['tool', 'outbound']) {
    await assert.rejects(credentials.use({ instanceId: 'personal', resourceId: resource.id, purpose, ...scope }, async () => {}),
      { code: 'GRANT_DENIED' })
  }
  assert.equal(grant.grants.length, 1)
  const approvedRequest = await credentials.request({ instanceId: 'personal', commandId: 'request-2', resourceId: resource.id,
    scope, purpose: 'outbound' })
  await credentials.grant({ instanceId: 'personal', commandId: 'grant-2', resourceId: resource.id,
    expectedRevision: 2, scope, purposes: ['outbound'], requestId: approvedRequest.id })
  assert.equal((await credentials.getRequest({ instanceId: 'personal', requestId: approvedRequest.id })).status, 'granted')
  await assert.rejects(credentials.cancel({ instanceId: 'personal', commandId: 'late-cancel', requestId: approvedRequest.id }),
    { code: 'REQUEST_UNAVAILABLE' })
})

test('rotation changes only the trusted vault reference, deletion is a persistent denial, and retries cannot alter an accepted command', async t => {
  const { credentials, vault, adapter, database, connections } = await fixture(t)
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Connector', vaultReference: 'vault:personal' })
  vault.set('vault:rotated', { instanceId: 'personal', value: 'fictional-rotated-value' })
  const updated = await credentials.update({ instanceId: 'personal', commandId: 'update', resourceId: resource.id,
    expectedRevision: 1, label: 'Rotated', vaultReference: 'vault:rotated' })
  assert.equal(updated.revision, 2)
  assert.equal(updated.label, 'Rotated')
  await assert.rejects(credentials.update({ instanceId: 'personal', commandId: 'update', resourceId: resource.id,
    expectedRevision: 1, label: 'Different', vaultReference: 'vault:rotated' }), { code: 'IDENTITY_CONFLICT' })
  const granted = await credentials.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: 2, scope: { role: 'worker', workItemId: 'work-1' }, purposes: ['tool'] })
  const use = { instanceId: 'personal', resourceId: resource.id, role: 'worker', workItemId: 'work-1', purpose: 'tool' }
  assert.equal(await credentials.use(use, async value => value === 'fictional-rotated-value'), true)
  const deleted = await credentials.delete({ instanceId: 'personal', commandId: 'delete', resourceId: resource.id,
    expectedRevision: 3 })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.cleanupPending, true)
  assert.deepEqual(deleted.grants, [])
  assert.deepEqual(await credentials.delete({ instanceId: 'personal', commandId: 'delete', resourceId: resource.id,
    expectedRevision: 3 }), deleted)
  const reopenedStorage = await SqliteStorage.open(database)
  connections.push(reopenedStorage)
  const reopened = new ResourceCredentials(reopenedStorage, 'personal', adapter)
  await assert.rejects(reopened.use(use, async () => {}), { code: 'RESOURCE_UNAVAILABLE' })
  const pending = await reopened.pendingVaultDeletes({ instanceId: 'personal' })
  assert.deepEqual(pending.items, [{ resourceId: resource.id, reference: 'vault:rotated' }])
  await assert.rejects(reopened.pendingVaultDeletes({ instanceId: 'other' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  vault.delete(pending.items[0].reference)
  await reopened.confirmVaultDeletion({ instanceId: 'personal', ...pending.items[0] })
  assert.deepEqual((await reopened.pendingVaultDeletes({ instanceId: 'personal' })).items, [])
  assert.equal((await reopened.get({ instanceId: 'personal', resourceId: resource.id })).cleanupPending, undefined)
  await assert.rejects(reopened.grant({ instanceId: 'personal', commandId: 'later', resourceId: resource.id,
    expectedRevision: 4, scope: { role: 'worker' }, purposes: ['tool'] }), { code: 'RESOURCE_UNAVAILABLE' })
  assert.equal(granted.grants.length, 1)
  assert.equal(JSON.stringify(deleted).includes('vault:'), false)
})

test('vault failures and consumer errors cannot print the secret through a resource error', async t => {
  const { credentials, vault } = await fixture(t)
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Connector', vaultReference: 'vault:personal' })
  await credentials.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id, expectedRevision: 1,
    scope: { role: 'worker', workItemId: 'work-1' }, purposes: ['tool'] })
  const use = { instanceId: 'personal', resourceId: resource.id, role: 'worker', workItemId: 'work-1', purpose: 'tool' }
  await assert.rejects(credentials.use(use, async secret => { throw new Error(`Rejected ${secret}`) }), error => {
    assert.equal(error.code, 'CREDENTIAL_USE_FAILED')
    assert.equal(error.message.includes('fictional-private-value'), false)
    return true
  })
  vault.delete('vault:personal')
  await assert.rejects(credentials.use(use, async () => {}), { code: 'CREDENTIAL_USE_FAILED' })
})

test('PostgreSQL persists the same scoped grants and revocation across connections', {
  skip: process.platform === 'win32' && 'The embedded PostgreSQL fixture startup does not complete on this Windows host.',
  timeout: 120000,
}, async t => {
  const postgres = await startPostgres('superagent-resource-credentials-pg-')
  t.after(() => postgres.close())
  const { storage } = await postgres.newStorage()
  const vault = {
    async assertReference(instanceId, reference) {
      if (instanceId !== 'personal' || reference !== 'vault:personal') throw new Error('Unavailable.')
    },
    async withSecret(instanceId, reference, consume) {
      await this.assertReference(instanceId, reference)
      return consume('fictional-private-value')
    },
  }
  const credentials = new ResourceCredentials(storage, 'personal', vault)
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Connector', vaultReference: 'vault:personal' })
  const grant = await credentials.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: 1, scope: { role: 'worker', environmentId: 'remote-1' }, purposes: ['tool'] })
  const reopenedStorage = postgres.register(await storage.reconnect())
  const reopened = new ResourceCredentials(reopenedStorage, 'personal', vault)
  assert.deepEqual(await reopened.get({ instanceId: 'personal', resourceId: resource.id }), grant)
  const use = { instanceId: 'personal', resourceId: resource.id, role: 'worker', environmentId: 'remote-1', purpose: 'tool' }
  assert.equal(await reopened.use(use, async value => value.length), 'fictional-private-value'.length)
  await reopened.revoke({ instanceId: 'personal', commandId: 'revoke', resourceId: resource.id,
    expectedRevision: 2, grantId: grant.grants[0].id })
  await assert.rejects(credentials.use(use, async () => {}), { code: 'GRANT_DENIED' })
  const stored = await storage.transaction('personal', tx => tx.get('resource-credential', resource.id))
  assert.equal(JSON.stringify(stored).includes('fictional-private-value'), false)
  assert.equal((await storage.transaction('team', tx => tx.scan('resource-credential', { limit: 10 }))).items.length, 0)
})
