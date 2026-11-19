import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { credentialImportSourceRef } from '../../app/src/credential-import.mjs'
import { createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

const instanceId = 'personal'
const owner = { label: 'Legacy profile', instanceId: 'legacy-instance' }
const sourceRef = '595d5b2f0f4fe2ffb1e7b760606be561be229bb2e1b76c0f820fc3ed0b2a7a7e'
const secondSourceRef = 'eb4236c907b7e95364ff526c6085db7dc5649958de57b292733b0cbd42892366'
const retrySourceRef = credentialImportSourceRef(owner, 'retry-token')
const cancelRaceSourceRef = credentialImportSourceRef(owner, 'cancel-race')

function preview(id, label, ref, originalScope = { kind: 'main', role: 'Legacy Main' }) {
  return { owner, sourceLabel: 'credential-export.json', entries: [{ id, label, type: 'api-key', originalScope, sourceRef: ref }] }
}

test('the product imports only the selected item into a new explicitly scoped credential resource', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-credential-import-host-'))
  const work = join(directory, 'work')
  const core = join(directory, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Main is ready.'))
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const values = new Map([
    [`11111111-1111-4111-8111-111111111111:${sourceRef}`, 'fictional-import-secret'],
    [`88888888-8888-4888-8888-888888888888:${cancelRaceSourceRef}`, 'fictional-cancel-race-secret'],
    [`66666666-6666-4666-8666-666666666666:${credentialImportSourceRef(owner, 'invalid-tool')}`, 'fictional-invalid-tool-secret'],
    [`77777777-7777-4777-8777-777777777777:${credentialImportSourceRef(owner, 'invalid-source')}`, 'fictional-invalid-source-secret'],
    [`33333333-3333-4333-8333-333333333333:${secondSourceRef}`, 'fictional-cancel-secret'],
    ['44444444-4444-4444-8444-444444444444:3b095d5ea1f7250e61b63003a14d9785c0bcea383bd4fd689af323ba8b7bc7f4', 'fictional-recovery-secret'],
    [`55555555-5555-4555-8555-555555555555:${retrySourceRef}`, 'fictional-retry-secret'],
  ])
  const reads = []
  const readGates = new Map()
  const adapter = {
    async read(pendingId, credentialId, ref) {
      reads.push({ pendingId, credentialId, sourceRef: ref })
      const value = values.get(`${pendingId}:${ref}`)
      if (!value) throw Object.assign(new Error('not found'), { code: 'CREDENTIAL_IMPORT_NOT_FOUND' })
      const gate = readGates.get(ref)
      if (gate) { gate.started(); await gate.promise }
      return { id: credentialId, sourceRef: ref, value }
    },
    async cancel(pendingId, ref) { values.delete(`${pendingId}:${ref}`) },
    async finish(pendingId, ref) { values.delete(`${pendingId}:${ref}`) },
  }
  const config = { databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    instanceId, actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    credentialImportAdapter: adapter }
  let host
  let raw
  t.after(async () => {
    await raw?.close()
    await host?.close()
    await native.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  host = await createProductHost(native, config)

  const pendingId = '11111111-1111-4111-8111-111111111111'
  const reviewed = await host.dispatch('credential-import-preview', { instanceId, pendingId,
    preview: preview('service-key', 'Legacy API', sourceRef) })
  assert.equal(reviewed.items[0].status, 'pending')
  assert.equal(reviewed.items[0].originalScope.role, 'Legacy Main')
  assert.equal(JSON.stringify(reviewed).includes('fictional-import-secret'), false)
  const invalidTargets = [
    { pendingId: '66666666-6666-4666-8666-666666666666', id: 'invalid-tool',
      target: { label: 'Invalid tool grant', purpose: 'tool', scope: { role: 'main' } } },
    { pendingId: '77777777-7777-4777-8777-777777777777', id: 'invalid-source',
      target: { label: 'Invalid source grant', purpose: 'source', scope: { role: 'main' } } },
  ]
  for (const item of invalidTargets) {
    const ref = credentialImportSourceRef(owner, item.id)
    await host.dispatch('credential-import-preview', { instanceId, pendingId: item.pendingId,
      preview: preview(item.id, item.id, ref) })
    await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: `invalid-${item.id}`,
      pendingId: item.pendingId, sourceRef: ref, credentialId: item.id, target: item.target }), { code: 'INVALID_INPUT' })
    const saved = await host.dispatch('credential-import-list', { instanceId, limit: 20 })
    const record = saved.items.find(candidate => candidate.sourceRef === ref)
    assert.equal(record.status, 'pending')
    assert.equal(record.target, undefined)
  }
  assert.equal(reads.length, 0, 'invalid targets never request a secret from the App')
  const cancelRacePendingId = '88888888-8888-4888-8888-888888888888'
  await host.dispatch('credential-import-preview', { instanceId, pendingId: cancelRacePendingId,
    preview: preview('cancel-race', 'Cancellation race item', cancelRaceSourceRef) })
  let releaseRead
  let markReadStarted
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  const readGate = new Promise(resolve => { releaseRead = resolve })
  readGates.set(cancelRaceSourceRef, { started: markReadStarted, promise: readGate })
  const cancelRaceTarget = { label: 'Must stay cancelled', purpose: 'tool', scope: {
    role: 'worker', workItemId: 'work-cancel-race' } }
  const racingCommit = host.dispatch('credential-import-commit', { instanceId, commandId: 'cancel-race-commit',
    pendingId: cancelRacePendingId, sourceRef: cancelRaceSourceRef, credentialId: 'cancel-race', target: cancelRaceTarget })
  await readStarted
  await Promise.resolve()
  const racingCancel = host.dispatch('credential-import-cancel', { instanceId, commandId: 'cancel-race-cancel',
    pendingId: cancelRacePendingId, sourceRef: cancelRaceSourceRef })
  let raceStatus
  for (let retry = 0; retry < 100; retry++) {
    raceStatus = (await host.dispatch('credential-import-list', { instanceId, limit: 100 })).items
      .find(item => item.sourceRef === cancelRaceSourceRef)?.status
    if (raceStatus === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.equal(raceStatus, 'cancelled')
  releaseRead()
  await assert.rejects(racingCommit, { code: 'CREDENTIAL_IMPORT_CANCELLED' })
  assert.equal((await racingCancel).status, 'cancelled')
  assert.equal(values.has(`${cancelRacePendingId}:${cancelRaceSourceRef}`), false)
  assert.equal((await host.dispatch('resource-list', { instanceId, limit: 100 })).items
    .some(item => item.label === 'Must stay cancelled'), false)
  const remote = { id: 'read-only-client', label: 'Reader', grants: [{ instanceId, capabilities: ['read'] }], createdAt: 1 }
  await assert.rejects(host.dispatch('credential-import-list', { instanceId }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: 'remote-import', pendingId,
    sourceRef, credentialId: 'service-key', target: { label: 'Imported API', purpose: 'tool', scope: {
      role: 'worker', workItemId: 'work-a', environmentId: 'environment-a' } } }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })

  const target = { label: 'Imported API', purpose: 'tool', scope: {
    role: 'worker', workItemId: 'work-a', environmentId: 'environment-a' } }
  const committed = await host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-one',
    pendingId, sourceRef, credentialId: 'service-key', target })
  assert.equal(committed.status, 'applied')
  assert.deepEqual(committed.target, target)
  const resource = await host.dispatch('resource-read', { instanceId, resourceId: committed.resourceId })
  assert.equal(resource.label, 'Imported API')
  assert.deepEqual(resource.grants.map(grant => ({ scope: grant.scope, purposes: grant.purposes })), [{
    scope: target.scope, purposes: ['tool'],
  }])
  assert.equal(JSON.stringify(resource).includes('Legacy Main'), false)
  assert.equal(JSON.stringify(resource).includes('fictional-import-secret'), false)

  const replay = await host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-replay',
    pendingId: '22222222-2222-4222-8222-222222222222', sourceRef, credentialId: 'service-key', target })
  assert.equal(replay.resourceId, committed.resourceId)
  assert.equal(reads.filter(read => read.sourceRef === sourceRef).length, 1,
    'an applied import is returned without reading the export again')
  const revoke = await host.dispatch('resource-revoke', { instanceId, commandId: 'revoke-imported',
    resourceId: committed.resourceId, grantId: committed.grantId, expectedRevision: 2 })
  assert.deepEqual(revoke.grants, [], 'the imported authorization is revocable through the existing resource API')
  await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: 'different-target',
    pendingId, sourceRef, credentialId: 'service-key', target: { ...target, label: 'Wider name',
      scope: { role: 'main', workItemId: 'other-work' } } }),
  { code: 'CREDENTIAL_IMPORT_CONFLICT' })
  await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-one',
    pendingId, sourceRef, credentialId: 'service-key', target: { ...target, label: 'Changed command input' } }),
  { code: 'IDENTITY_CONFLICT' })

  const secondPendingId = '33333333-3333-4333-8333-333333333333'
  await host.dispatch('credential-import-preview', { instanceId, pendingId: secondPendingId,
    preview: preview('legacy-token', 'Legacy token', secondSourceRef, { kind: 'work', role: 'Old Worker' }) })
  const uncommitted = await host.dispatch('resource-create', { instanceId,
    commandId: `credential-import:${secondSourceRef}:create`, label: 'Interrupted import', value: 'fictional-cancel-secret' })
  const cancelled = await host.dispatch('credential-import-cancel', { instanceId, commandId: 'cancel-interrupted',
    sourceRef: secondSourceRef })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.resourceId, uncommitted.id)
  assert.equal((await host.dispatch('resource-read', { instanceId, resourceId: uncommitted.id })).status, 'deleted')

  const recoverySourceRef = '3b095d5ea1f7250e61b63003a14d9785c0bcea383bd4fd689af323ba8b7bc7f4'
  const recoveryPendingId = '44444444-4444-4444-8444-444444444444'
  await host.dispatch('credential-import-preview', { instanceId, pendingId: recoveryPendingId,
    preview: preview('recover-token', 'Legacy recoverable token', recoverySourceRef) })
  const retryPendingId = '55555555-5555-4555-8555-555555555555'
  await host.dispatch('credential-import-preview', { instanceId, pendingId: retryPendingId,
    preview: preview('retry-token', 'Legacy retry token', retrySourceRef) })
  const credentialRecords = native.get('credentials')
  const modifyRecord = credentialRecords.modifyRecord.bind(credentialRecords)
  let writeReceiptsToLose = 2
  credentialRecords.modifyRecord = async (key, mutate) => {
    const result = await modifyRecord(key, mutate)
    if (writeReceiptsToLose > 0 && key.startsWith('ds-superagent-profile/vault-')) {
      writeReceiptsToLose--
      throw new Error('simulated provider acknowledgement loss')
    }
    return result
  }
  const recoveryTarget = { label: 'Recoverable import', purpose: 'tool', scope: {
    role: 'worker', workItemId: 'work-recovery', environmentId: 'environment-recovery' } }
  await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-recovery',
    pendingId: recoveryPendingId, sourceRef: recoverySourceRef, credentialId: 'recover-token', target: recoveryTarget }),
  { code: 'CREDENTIAL_IMPORT_UNKNOWN' })
  const retryTarget = { label: 'Recovered retry', purpose: 'tool', scope: {
    role: 'worker', workItemId: 'work-retry', environmentId: 'environment-retry' } }
  await assert.rejects(host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-retry',
    pendingId: retryPendingId, sourceRef: retrySourceRef, credentialId: 'retry-token', target: retryTarget }),
  { code: 'CREDENTIAL_IMPORT_UNKNOWN' })

  await host.close()
  host = await createProductHost(native, config)
  const recovered = await host.dispatch('credential-import-cancel', { instanceId, commandId: 'cancel-recovered',
    sourceRef: recoverySourceRef, pendingId: recoveryPendingId })
  assert.equal(recovered.status, 'cancelled')
  assert.equal(recovered.cleanupPending, undefined)
  assert.equal(values.has(`${recoveryPendingId}:${recoverySourceRef}`), false)
  const retryPreview = await host.dispatch('credential-import-preview', { instanceId, pendingId: retryPendingId,
    preview: preview('retry-token', 'Legacy retry token', retrySourceRef) })
  const retried = await host.dispatch('credential-import-commit', { instanceId, commandId: 'commit-retry-after-restart',
    pendingId: retryPendingId, sourceRef: retrySourceRef, credentialId: 'retry-token', target: retryTarget })
  assert.equal(retryPreview.items[0].status, 'unknown')
  assert.equal(retried.status, 'applied')
  assert.equal(reads.filter(item => item.sourceRef === retrySourceRef).length, 2,
    'the same value is available for stable-command reconciliation after a Host restart')
  assert.equal(values.has(`${retryPendingId}:${retrySourceRef}`), false)
  const credentialIds = await host.dispatch('resource-list', { instanceId })
  assert.deepEqual(credentialIds.items.filter(item => item.status === 'active').map(item => item.label).sort(),
    ['Imported API', 'Recovered retry'].sort())

  raw = await SqliteStorage.open(config.databasePath)
  const persisted = await raw.transaction(instanceId, async tx => ({
    imported: await tx.get('product-credential-import', sourceRef),
    storedResource: await tx.get('resource-credential', committed.resourceId),
  }))
  assert.equal(JSON.stringify(persisted).includes('fictional-import-secret'), false)
  assert.equal(persisted.imported.status, 'applied')
  const secretRecord = await native.get('credentials')?.readRecord(persisted.storedResource.vaultReference)
  assert.equal(secretRecord?.key, 'fictional-import-secret')
})
