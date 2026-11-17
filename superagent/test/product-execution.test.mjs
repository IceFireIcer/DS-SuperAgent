import assert from 'node:assert/strict'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { completedToolCount, lastUserText } from './input-support.mjs'

const until = async (check, label) => {
  const deadline = Date.now() + 8_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Product execution did not reach ${label} within 8000 ms.`)
    await sleep(30)
  }
}

test('the product pairs a device and binds remote-only work to its own filesystem across Host restart', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-execution-'))
  const workspace = join(directory, 'workspace')
  const deviceRootPath = join(directory, 'device-work')
  await mkdir(join(directory, 'data'))
  await mkdir(workspace)
  await mkdir(deviceRootPath)
  const assetsPath = join(directory, 'device-assets')
  const skillsPath = join(directory, 'device-skills')
  await mkdir(assetsPath)
  await mkdir(join(skillsPath, 'remote-demo'), { recursive: true })
  await writeFile(join(skillsPath, 'remote-demo', 'SKILL.md'), '# Remote demo\n\nUse the device workspace.\n')
  const deviceRoot = await realpath(deviceRootPath)
  const device = await core.RemoteDevice.open({ deviceId: 'execution-device', root: deviceRoot,
    grants: [{ instanceId: 'private', environmentId: 'remote-project', allowedActorIds: ['owner'],
      permissions: ['read', 'write', 'search', 'command'] }], assetsPath, skillsPath,
    jobsPath: join(directory, 'device-jobs'), statePath: join(directory, 'device-state.json'),
    commands: { verify: { argv: [process.execPath, '-e',
      "const fs=require('node:fs');if(fs.readFileSync('remote-result.txt','utf8')!=='remote execution\\n')process.exit(1)"],
    timeoutMs: 5000 } } })
  const endpoint = await device.start()
  const mainToolResults = []
  const workerToolNames = []
  const native = await nativeContext(join(directory, 'sessions'), function* (request) {
    if (request.model === 'router') { yield* routerResponse(request); return }
    if (request.model === 'main') {
      const toolMessages = request.messages.filter(message => message.role === 'tool')
      const completed = completedToolCount(request)
      const office = lastUserText(request).includes('Office')
      if (!completed) yield* toolResponse('delegate_work', { items: [{ goal: office ? 'Use Office in the remote execution world.'
        : 'Write a remote execution result.', constraints: 'Use the selected execution target.',
        acceptanceCriteria: office ? 'Reject if the remote Office contract is unavailable.' : 'The exact file exists on the device.' }],
        ...(office ? { capabilities: ['office'] } : {}) })
      else {
        mainToolResults.push(structuredClone(toolMessages.at(-1)?.content))
        yield* textResponse('Delegated the remote-only work.')
      }
      return
    }
    const completed = completedToolCount(request)
    if (!completed) workerToolNames.push(...request.tools.map(tool => tool.name))
    if (!completed) yield* toolResponse('write_file', { path: 'remote-result.txt', text: 'remote execution\n' })
    else if (completed === 1) yield* toolResponse('glob', { pattern: 'remote-*.txt' })
    else if (completed === 2) yield* toolResponse('grep', { pattern: 'remote execution' })
    else if (completed === 3) yield* toolResponse('run_command', { name: 'verify' })
    else if (completed === 4) yield* toolResponse('list_skills', {})
    else if (completed === 5) yield* toolResponse('read_file', { path: 'remote-result.txt' })
    else if (completed === 6) yield* toolResponse('report_ready', { result: 'Remote file verified.',
      evidence: 'The Worker read the file from the selected remote Environment.', artifacts: 'remote-result.txt' })
    else yield* textResponse('Remote work recorded.')
  })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const config = { databasePath: join(directory, 'data', 'state.sqlite'), workspaceRoot: workspace,
    instanceId: 'private', actorId: 'owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  let host
  t.after(async () => {
    await host?.close().catch(() => {})
    await device.close().catch(() => {})
    await native.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  host = await core.createProductHost(native, config)
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'private', ...payload })

  const initial = await call('execution-options')
  assert.deepEqual(initial.environments.map(environment => environment.kind), ['local'])
  assert.equal(initial.policy.defaultTarget, 'local')
  const paired = await call('remote-environment-pair', { commandId: 'pair-device', environmentId: 'remote-project',
    label: 'Build device', endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'execution-device',
    expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read', 'write', 'search', 'command'] })
  assert.equal(paired.deviceId, 'execution-device')
  assert.equal(JSON.stringify(paired).includes(device.pairingCode), false)
  assert.equal((await call('remote-environment-pair', { commandId: 'pair-device', environmentId: 'remote-project',
    label: 'Build device', endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'execution-device',
    expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read', 'write', 'search', 'command'] })).deviceId, 'execution-device')
  await assert.rejects(call('remote-environment-pair', { commandId: 'pair-device', environmentId: 'remote-project',
    label: 'Different device', endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'execution-device',
    expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read', 'write', 'search', 'command'] }), { code: 'IDENTITY_CONFLICT' })
  const options = await call('execution-options')
  assert.equal(options.environments.some(environment => environment.kind === 'remote'
    && environment.root === deviceRoot && environment.deviceId === 'execution-device'), true, JSON.stringify(options))
  const remoteOption = options.environments.find(environment => environment.kind === 'remote')
  assert.deepEqual(remoteOption.permissions, ['command', 'read', 'search', 'write'])
  assert.equal(remoteOption.capabilities.attachments.supported, true)
  assert.equal(remoteOption.capabilities.skills.supported, true)
  assert.equal((await native.credentials.listRecords()).some(item =>
    String(item.key).startsWith('ds-superagent-profile/remote-environment-')), true)
  const saved = await call('execution-policy-save', { commandId: 'remote-policy', expectedRevision: 0,
    policy: { defaultTarget: 'remote-only', preferredEnvironmentId: 'remote-project',
      requiredPermissions: ['read', 'write', 'search', 'command'] } })
  assert.equal(saved.defaultTarget, 'remote-only')
  assert.equal(saved.preferredEnvironmentId, 'remote-project')

  await call('send', { commandId: 'remote-request', text: 'Write remote-result.txt on the selected device.',
    target: 'remote-only' })
  let work
  let lastHistory
  try {
    await until(async () => {
      lastHistory = await call('history', { limit: 100 })
      work = lastHistory.works?.[0]
      return work?.status === 'success'
    }, 'a successful remote work report')
  } catch (error) {
    const observations = work?.receipt?.ticketId
      ? await call('observe-list', { query: work.receipt.ticketId, limit: 100 }).catch(failure => ({ error: failure.message }))
      : undefined
    const observationItem = observations?.items?.[0]
    const observation = observationItem
      ? await call('observe-read', { observationId: observationItem.id, generation: observationItem.generation, limit: 100 })
        .catch(failure => ({ error: failure.message })) : undefined
    throw new Error(`${error.message}: ${JSON.stringify({ lastHistory, mainToolResults, observations, observation })}`, { cause: error })
  }
  assert.equal(work.brief.target, 'remote-only')
  assert.equal(work.executionLocation.kind, 'remote')
  assert.equal(work.executionLocation.deviceId, 'execution-device')
  assert.equal(work.executionLocation.root, deviceRoot)
  assert.equal(work.executionSelection.status, 'selected')
  assert.equal(work.executionSelection.source, 'ticket')
  const workerItem = (await call('observe-list', { query: work.receipt.ticketId, limit: 100 })).items
    .find(item => item.role === 'worker')
  assert.ok(workerItem)
  const workerDetail = await call('observe-read', { observationId: workerItem.id,
    generation: workerItem.generation, limit: 100 })
  const fact = label => workerDetail.facts.find(item => item.label === label)?.value
  assert.equal(fact('Execution target'), 'remote-only')
  assert.equal(fact('Required capabilities'), 'none')
  assert.equal(fact('Selection source'), 'ticket')
  assert.equal(fact('Selection status'), 'selected')
  assert.equal(workerDetail.facts.some(item => item.label === 'Execution candidate'
    && item.value.includes('remote-project (remote): eligible')), true)
  assert.equal(fact('Device'), 'execution-device')
  assert.equal(fact('Directory'), deviceRoot)
  await assert.rejects(call('work-reconcile-stop', { commandId: 'guess-stop', workItemId: 'guessed',
    ticketId: work.receipt.ticketId }), { code: 'NOT_FOUND' })
  assert.equal((await call('work-reconcile-stop', { commandId: 'inspect-stop', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId })).ticketId, work.receipt.ticketId)
  assert.equal(work.control.assignment.environment.kind, 'remote')
  for (const name of ['glob', 'grep', 'run_command', 'list_skills', 'read_asset', 'save_attachment', 'delegate_subagent']) {
    assert.equal(workerToolNames.includes(name), true, `${name} must inherit the remote Assignment world`)
  }
  assert.equal(await readFile(join(deviceRoot, 'remote-result.txt'), 'utf8'), 'remote execution\n')
  await assert.rejects(access(join(workspace, 'remote-result.txt')))
  await call('send', { commandId: 'remote-office-request', text: 'Use Office on this device.', target: 'remote-only' })
  let officeWork
  try {
    await until(async () => {
      officeWork = (await call('history', { limit: 100 })).works?.find(item => item.brief.goal === 'Use Office in the remote execution world.')
      return officeWork?.outcome?.status === 'blocked'
    }, 'an explicit remote Office rejection')
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify({ officeWork, mainToolResults,
      history: await call('history', { limit: 100 }) })}`, { cause: error })
  }
  assert.deepEqual(officeWork.brief.capabilities, ['office'])
  assert.equal(officeWork.executionSelection.status, 'waiting')
  assert.equal(officeWork.executionSelection.candidates.find(candidate => candidate.kind === 'remote').eligible, false)
  assert.equal(officeWork.executionSelection.candidates.find(candidate => candidate.kind === 'remote').reasons
    .some(reason => reason.includes('Office')), true)
  assert.equal(officeWork.control?.assignment, undefined)
  assert.equal((await call('execution-policy-save', { commandId: 'clear-policy',
    expectedRevision: saved.revision, policy: { defaultTarget: 'local', preferredEnvironmentId: null,
      requiredPermissions: ['read'] } })).preferredEnvironmentId, undefined)

  const workItemId = work.brief.workItemId
  const ticketId = work.receipt.ticketId
  await host.close()
  const inspection = await SqliteStorage.open(config.databasePath)
  try {
    const row = (await inspection.transaction('private', tx => tx.scan('product-remote-environment', { limit: 1 }))).items[0]
    const stored = JSON.stringify(row)
    assert.equal(stored.includes('hostExchangePrivate"'), false)
    assert.equal(typeof row.value.state.hostExchangePrivateReference, 'string')
  } finally { await inspection.close() }
  host = await core.createProductHost(native, config)
  const restored = await call('execution-options')
  assert.equal(restored.environments.some(environment => environment.kind === 'remote'
    && environment.id === 'remote-project'), true)
  const restoredWork = await call('history', { limit: 100 })
  assert.equal(restoredWork.works.find(item => item.brief.workItemId === workItemId)?.receipt.ticketId, ticketId)
  const beforeRevokeFetch = globalThis.fetch
  let revokeBlocked
  let releaseRevokeRequest
  const revokeHeld = new Promise(resolve => { releaseRevokeRequest = resolve })
  const revokeReached = new Promise(resolve => { revokeBlocked = resolve })
  globalThis.fetch = async (...args) => {
    revokeBlocked()
    await revokeHeld
    return beforeRevokeFetch(...args)
  }
  const revokeRequest = call('remote-environment-revoke', { commandId: 'revoke-device', environmentId: 'remote-project' })
  let revoked
  try {
    await revokeReached
    await assert.rejects(call('remote-environment-revoke', { commandId: 'revoke-device', environmentId: 'remote-project' }),
      { code: 'REVOKE_PENDING' })
    releaseRevokeRequest()
    revoked = await revokeRequest
  } finally {
    releaseRevokeRequest()
    globalThis.fetch = beforeRevokeFetch
  }
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.deviceConfirmed, true)
  assert.deepEqual(await call('remote-environment-revoke', { commandId: 'revoke-device', environmentId: 'remote-project' }),
    revoked)
  assert.equal((await call('execution-options')).environments.some(environment => environment.kind === 'remote'), false)
  assert.equal((await native.credentials.listRecords()).some(item =>
    String(item.key).startsWith('ds-superagent-profile/remote-environment-')), false)

  await call('send', { commandId: 'wait-for-device', text: 'Write remote-result.txt after a device is available.',
    target: 'remote-only' })
  await until(async () => (await call('history', { limit: 100 })).works?.some(item =>
    item.brief.target === 'remote-only' && item.executionSelection?.status === 'waiting'
      && item.executionSelection?.candidates.every(candidate => candidate.kind !== 'remote')), 'remote-only waiting without a device')
  const waiting = (await call('history', { limit: 100 })).works.find(item =>
    item.executionSelection?.status === 'waiting' && item.executionSelection?.candidates.every(candidate => candidate.kind !== 'remote'))
  assert.equal(waiting?.executionLocation, null)
  assert.match(waiting.executionSelection.reason, /No eligible Environment matches remote-only/u)

  const realFetch = globalThis.fetch
  let losePairingResponse = true
  globalThis.fetch = async (...args) => {
    const response = await realFetch(...args)
    if (losePairingResponse) {
      losePairingResponse = false
      throw new Error('Simulated lost pairing response.')
    }
    return response
  }
  try {
    await assert.rejects(call('remote-environment-pair', { commandId: 'uncertain-pair', environmentId: 'remote-project',
      label: 'Uncertain device', endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'execution-device',
      expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read', 'write', 'search', 'command'] }))
  } finally { globalThis.fetch = realFetch }
  const uncertain = await call('remote-environment-pair-read', { commandId: 'uncertain-pair' })
  assert.equal(uncertain.status, 'unknown')
  assert.equal(uncertain.canAbandon, true)
  const abandoned = await call('remote-environment-pair-abandon', { commandId: 'uncertain-pair' })
  assert.equal(abandoned.abandoned, true)
  assert.deepEqual(await call('remote-environment-pair-abandon', { commandId: 'uncertain-pair' }), abandoned)
  assert.equal((await call('remote-environment-pair-read', { commandId: 'uncertain-pair' })).status, 'abandoned')
  assert.equal((await native.credentials.listRecords()).some(item =>
    String(item.key).startsWith('ds-superagent-profile/remote-environment-')), false)
})

test('revocation commit failure keeps local access blocked and replays without claiming a second device confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-remote-revoke-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await mkdir(join(directory, 'data'))
  const device = await core.RemoteDevice.open({ deviceId: 'revoke-device', root: workspace,
    grants: [{ instanceId: 'private', environmentId: 'remote-project', allowedActorIds: ['owner'],
      permissions: ['read'] }], statePath: join(directory, 'device-state.json') })
  const endpoint = await device.start()
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Ready.'))
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const config = { databasePath: join(directory, 'data', 'state.sqlite'), workspaceRoot: workspace,
    instanceId: 'private', actorId: 'owner' }
  let host
  t.after(async () => {
    await host?.close().catch(() => {})
    await device.close().catch(() => {})
    await native.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  host = await core.createProductHost(native, config)
  const call = (name, payload = {}) => host.dispatch(name, { instanceId: 'private', ...payload })
  await call('remote-environment-pair', { commandId: 'pair', environmentId: 'remote-project', label: 'Revoke device',
    endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'revoke-device',
    expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read'] })
  const original = SqliteStorage.prototype.transaction
  let rejected = false
  SqliteStorage.prototype.transaction = function (instanceId, operation) {
    return original.call(this, instanceId, tx => operation({ ...tx, remove: async (kind, id) => {
      if (!rejected && kind === 'product-remote-environment') {
        rejected = true
        throw new Error('Injected business transaction failure.')
      }
      return tx.remove(kind, id)
    } }))
  }
  try {
    await assert.rejects(call('remote-environment-revoke', { commandId: 'revoke', environmentId: 'remote-project' }),
      /Injected business transaction failure/u)
  } finally { SqliteStorage.prototype.transaction = original }
  assert.equal(rejected, true)
  assert.equal((await call('execution-options')).environments.some(environment => environment.id === 'remote-project'), true)
  await host.close()
  host = await core.createProductHost(native, config)
  const replay = await call('remote-environment-revoke', { commandId: 'revoke', environmentId: 'remote-project' })
  assert.equal(replay.revoked, true)
  assert.equal(replay.deviceConfirmed, false)
  assert.equal(replay.reason, 'DEVICE_REVOKE_UNKNOWN')
  assert.equal((await call('execution-options')).environments.some(environment => environment.id === 'remote-project'), false)
  assert.equal((await native.credentials.listRecords()).some(item =>
    String(item.key).startsWith('ds-superagent-profile/remote-environment-')), false)
})

test('a broken saved remote Environment stays unavailable without blocking the local Host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-execution-broken-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await mkdir(join(directory, 'data'))
  const databasePath = join(directory, 'data', 'state.sqlite')
  const seeded = await SqliteStorage.open(databasePath)
  await seeded.transaction('private', tx => tx.insert('product-remote-environment', 'broken-device', {
    label: 'Broken device', pairedAt: 1, state: { hostExchangePrivateReference: 'unavailable-reference' },
  }))
  await seeded.close()
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Local Host is ready.'))
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  let host
  t.after(async () => {
    await host?.close().catch(() => {})
    await native.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  host = await core.createProductHost(native, { databasePath, workspaceRoot: workspace, instanceId: 'private',
    actorId: 'owner', main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' } })
  const options = await host.dispatch('execution-options', { instanceId: 'private' })
  assert.equal(options.environments.some(environment => environment.kind === 'local'), true)
  assert.deepEqual(options.remoteLoadErrors, [{ id: 'broken-device', reason: 'RESOURCE_UNAVAILABLE' }])
})
