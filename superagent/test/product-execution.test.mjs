import assert from 'node:assert/strict'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { breakableProxy } from './fixtures/breakable-proxy.mjs'
import { completedToolCount, lastUserText } from './input-support.mjs'

const until = async (check, label, timeout = 8_000) => {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Product execution did not reach ${label} within ${timeout} ms.`)
    await sleep(30)
  }
}

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${args.join(' ')}: ${stderr || error.message}`))
    else resolve(stdout.trim())
  })
})

async function initializeRepository(root) {
  await git(root, 'init')
  await git(root, 'config', 'user.email', 'r5-31@example.invalid')
  await git(root, 'config', 'user.name', 'R5-31')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-m', 'base')
}

async function inspectVerificationJobs(jobsPath) {
  const records = await readdir(jobsPath)
  const jobs = await Promise.all(records.filter(file => file.endsWith('.json')).map(async file => {
    const job = JSON.parse(await readFile(join(jobsPath, file), 'utf8'))
    const { id, name, state, startedAt, deadlineAt, settled, exitCode, cancelled, reason, process: identity } = job
    return { id, name, state, startedAt, deadlineAt, settled, exitCode, cancelled, reason,
      processIdentityKind: identity?.kind }
  }))
  return jobs.filter(job => job.name === 'verify')
}

test('the product pairs a device and binds remote-only work to its own filesystem across Host restart', { timeout: 120000 }, async t => {
  const windowsObservationAllowanceMs = process.platform === 'win32' ? 2_000 : 0
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-execution-'))
  const workspace = join(directory, 'workspace')
  const deviceRootPath = join(directory, 'device-work')
  await mkdir(join(directory, 'data'))
  await mkdir(workspace)
  await mkdir(deviceRootPath)
  const assetsPath = join(directory, 'device-assets')
  const skillsPath = join(directory, 'device-skills')
  const jobsPath = join(directory, 'device-jobs')
  await mkdir(assetsPath)
  await mkdir(join(skillsPath, 'remote-demo'), { recursive: true })
  await writeFile(join(skillsPath, 'remote-demo', 'SKILL.md'), '# Remote demo\n\nUse the device workspace.\n')
  const deviceRoot = await realpath(deviceRootPath)
  const device = await core.RemoteDevice.open({ deviceId: 'execution-device', root: deviceRoot,
    grants: [{ instanceId: 'private', environmentId: 'remote-project', allowedActorIds: ['owner'],
      permissions: ['read', 'write', 'search', 'command'] }], assetsPath, skillsPath,
    jobsPath, statePath: join(directory, 'device-state.json'),
    commands: { verify: { argv: [process.execPath, '-e',
      "const fs=require('node:fs');if(fs.readFileSync('remote-result.txt','utf8')!=='remote execution\\n')process.exit(1)"],
    timeoutMs: 5_000 + windowsObservationAllowanceMs } } })
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
  let verificationJobs
  try {
    await until(async () => {
      lastHistory = await call('history', { limit: 100 })
      work = lastHistory.works?.[0]
      if (work?.status !== 'success') return false
      verificationJobs = await inspectVerificationJobs(jobsPath)
      return verificationJobs.some(job => job.settled)
    }, 'a successful remote work report and settled verification', 8_000 + windowsObservationAllowanceMs)
  } catch (error) {
    const lastVerificationJobs = await inspectVerificationJobs(jobsPath).catch(failure => ({ error: failure.message }))
    const observations = work?.receipt?.ticketId
      ? await call('observe-list', { query: work.receipt.ticketId, limit: 100 }).catch(failure => ({ error: failure.message }))
      : undefined
    const observationItem = observations?.items?.[0]
    const observation = observationItem
      ? await call('observe-read', { observationId: observationItem.id, generation: observationItem.generation, limit: 100 })
        .catch(failure => ({ error: failure.message })) : undefined
    throw new Error(`${error.message}: ${JSON.stringify({ verificationJobs: lastVerificationJobs, lastHistory,
      mainToolResults, observations, observation })}`, { cause: error })
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
  assert.equal(workerDetail.facts.some(item => item.label === 'Execution candidate'
    && item.value.includes(': blocked; target remote-only excludes local Environments')), true)
  assert.equal(fact('Device'), 'execution-device')
  assert.equal(fact('Directory'), deviceRoot)
  const [verificationJob, ...extraJobs] = verificationJobs
  assert.deepEqual(extraJobs, [])
  assert.ok(verificationJob, 'the device recorded the verification command')
  assert.deepEqual({ state: verificationJob.state, settled: verificationJob.settled, exitCode: verificationJob.exitCode,
    cancelled: verificationJob.cancelled }, { state: 'exited', settled: true, exitCode: 0, cancelled: false })
  await assert.rejects(call('work-reconcile-stop', { commandId: 'guess-stop', workItemId: 'guessed',
    ticketId: work.receipt.ticketId }), { code: 'NOT_FOUND' })
  assert.equal((await call('work-reconcile-stop', { commandId: 'inspect-stop', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId })).ticketId, work.receipt.ticketId)
  assert.equal(work.control.assignment.environment.kind, 'remote')
  for (const name of ['glob', 'grep', 'run_command', 'list_skills', 'read_asset', 'save_attachment', 'delegate_subagent']) {
    assert.equal(workerToolNames.includes(name), true, `${name} must inherit the remote Assignment world`)
  }
  assert.equal(await readFile(join(deviceRoot, 'remote-result.txt'), 'utf8'), 'remote execution\n')
  assert.equal((await call('artifact-read', { workItemId: work.brief.workItemId, path: 'remote-result.txt' })).text,
    'remote execution\n', 'the reported remote artifact is downloadable through its work card')
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

test('an offline remote stop survives Host restart, keeps unrelated local work available, and confirms only the original range', {
  timeout: 120000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-remote-stop-'))
  let device, proxy, native, host
  t.after(async () => {
    await host?.close().catch(() => {})
    await proxy?.close().catch(() => {})
    await device?.close().catch(() => {})
    await native?.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const workspace = join(directory, 'workspace')
  const deviceRoot = join(directory, 'device-work')
  await mkdir(join(directory, 'data'))
  await mkdir(workspace)
  await mkdir(deviceRoot)
  device = await core.RemoteDevice.open({
    deviceId: 'offline-stop-device', root: deviceRoot,
    grants: [{ instanceId: 'private', environmentId: 'remote-project', allowedActorIds: ['owner'],
      permissions: ['read', 'write', 'search', 'command'] }],
    jobsPath: join(directory, 'device-jobs'), statePath: join(directory, 'device-state.json'),
    commands: { hold: { argv: [process.execPath, '-e',
      "const fs=require('node:fs');fs.writeFileSync('hold.pid',String(process.pid));console.log('started');setInterval(()=>{},1000)"],
    timeoutMs: 5000, backgroundTimeoutMs: 120000 } },
  })
  const endpoint = await device.start()
  proxy = await breakableProxy(endpoint)
  native = await nativeContext(join(directory, 'sessions'), function* (request) {
    if (request.model === 'router') { yield* routerResponse(request); return }
    const text = lastUserText(request)
    const completed = completedToolCount(request)
    if (request.model === 'main') {
      if (!completed) yield* toolResponse('delegate_work', { items: [{ goal: text,
        constraints: 'Keep this work independent.', acceptanceCriteria: 'Record the requested result.' }] })
      else yield* textResponse('Delegated.')
      return
    }
    if (text.includes('remote job')) {
      if (!completed) yield* toolResponse('start_command', { name: 'hold' })
      else yield* textResponse('The remote range was started.')
      return
    }
    if (!completed) yield* toolResponse('ask_human', { question: 'The independent local work reached its review point.',
      options: 'Continue\nStop' })
    else yield* textResponse('The independent local work is waiting for review.')
  })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const config = { databasePath: join(directory, 'data', 'state.sqlite'), workspaceRoot: workspace,
    instanceId: 'private', actorId: 'owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  host = await core.createProductHost(native, config)
  const call = (name, payload = {}) => host.dispatch(name, { instanceId: 'private', ...payload })
  await call('remote-environment-pair', { commandId: 'pair-offline-stop', environmentId: 'remote-project',
    label: 'Offline stop device', endpoint: proxy.endpoint, pairingCode: device.pairingCode,
    expectedDeviceId: 'offline-stop-device', expectedDeviceKey: device.deviceKeyFingerprint,
    permissions: ['read', 'write', 'search', 'command'] })

  await call('send', { commandId: 'remote-stop-request', target: 'remote-only',
    text: 'Start a long remote job.' })
  let remoteWork
  await until(async () => {
    remoteWork = (await call('history', { limit: 100 })).works?.find(work => work.brief.goal === 'Start a long remote job.')
    return remoteWork?.control?.assignment && await readFile(join(deviceRoot, 'hold.pid'), 'utf8').catch(() => false)
  }, 'the running remote Work card and device process', 25000)
  const pid = Number(await readFile(join(deviceRoot, 'hold.pid'), 'utf8'))
  proxy.state.blocked = true
  await sleep(1000)
  await call('work-stop', { commandId: 'offline-work-stop', workItemId: remoteWork.control.workItemId,
    ticketId: remoteWork.control.ticketId, expectedGeneration: remoteWork.control.assignment.generation,
    expectedTicketVersion: remoteWork.control.ticketVersion, reason: 'Stop while the device is disconnected.' })
  remoteWork = (await call('history', { limit: 100 })).works.find(work => work.brief.goal === 'Start a long remote job.')
  assert.equal(remoteWork.control.stop.pendingDeviceConfirmation, true)
  assert.equal(remoteWork.control.permissions.canHandoff, false)
  assert.equal(remoteWork.control.handoff.status, 'blocked')
  assert.equal(remoteWork.control.handoff.owner, 'human')
  assert.equal(remoteWork.control.handoff.nextStep, 'resolve')
  assert.equal(remoteWork.control.handoff.blockers.some(blocker => blocker.code === 'ticket-stopping'), true)
  await assert.rejects(call('work-resume', { commandId: 'resume-before-device-quiet',
    workItemId: remoteWork.control.workItemId, ticketId: remoteWork.control.ticketId,
    expectedGeneration: remoteWork.control.assignment.generation }), { code: 'STOPPING' })

  await call('send', { commandId: 'unrelated-local-request', target: 'local-only',
    text: 'Complete an independent local check.' })
  let localHistory
  try {
    await until(async () => {
      localHistory = await call('history', { limit: 100 })
      return localHistory.works?.some(work =>
        work.brief.goal === 'Complete an independent local check.' && work.status === 'waiting')
    }, 'unrelated local work while the remote stop is pending', 25000)
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(localHistory)}`, { cause: error })
  }

  await host.close()
  host = await core.createProductHost(native, config)
  remoteWork = (await call('history', { limit: 100 })).works.find(work => work.brief.goal === 'Start a long remote job.')
  assert.equal(remoteWork.control.stop.pendingDeviceConfirmation, true)
  assert.equal((await call('history', { limit: 100 })).works.some(work =>
    work.brief.goal === 'Complete an independent local check.' && work.status === 'waiting'), true)
  assert.equal((await call('history', { limit: 100 })).works.find(work =>
    work.brief.goal === 'Complete an independent local check.').control.permissions.canHandoff, false)
  const waitingHandoff = (await call('history', { limit: 100 })).works.find(work =>
    work.brief.goal === 'Complete an independent local check.').control.handoff
  assert.equal(waitingHandoff.status, 'blocked')
  assert.equal(waitingHandoff.blockers.some(blocker => blocker.code === 'waiting-human'), true)

  await call('work-reconcile-stop', { commandId: 'offline-reconcile-blocked',
    workItemId: remoteWork.control.workItemId, ticketId: remoteWork.control.ticketId })
  remoteWork = (await call('history', { limit: 100 })).works.find(work => work.brief.goal === 'Start a long remote job.')
  assert.equal(remoteWork.control.stop.pendingDeviceConfirmation, true)

  proxy.state.blocked = false
  let reconciled
  for (let attempt = 0; attempt < 20 && remoteWork.control.stop.pendingDeviceConfirmation; attempt++) {
    reconciled = await call('work-reconcile-stop', { commandId: `offline-reconcile-${attempt}`,
      workItemId: remoteWork.control.workItemId, ticketId: remoteWork.control.ticketId })
    await sleep(250)
    remoteWork = (await call('history', { limit: 100 })).works.find(work => work.brief.goal === 'Start a long remote job.')
  }
  assert.equal(remoteWork.control.stop.pendingDeviceConfirmation, false)
  assert.equal(remoteWork.control.stop.state, 'stopped')
  assert.equal(typeof remoteWork.control.stop.cancellationConfirmedAt, 'number')
  assert.equal(remoteWork.control.permissions.canResume, true)
  assert.equal(remoteWork.outcome?.status, 'stopped')
  assert.equal(reconciled.jobs.some(job => job.state === 'cancelled'), true, JSON.stringify(reconciled.jobs))
  await until(() => {
    try { process.kill(pid, 0); return false } catch { return true }
  }, 'the original remote range to stop', 15000)
  const confirmedGeneration = remoteWork.control.assignment.generation
  await call('work-resume', { commandId: 'resume-after-device-confirmation',
    workItemId: remoteWork.control.workItemId, ticketId: remoteWork.control.ticketId,
    expectedGeneration: confirmedGeneration })
  await until(async () => {
    remoteWork = (await call('history', { limit: 100 })).works.find(work => work.brief.goal === 'Start a long remote job.')
    return remoteWork.control.assignment?.generation && remoteWork.control.assignment.generation !== confirmedGeneration
  }, 'an explicit new Assignment after the confirmed stop', 15000)
  assert.notEqual(remoteWork.control.assignment.id, reconciled.assignments[0].id)
})

test('a Main work card hands the same work to a paired remote after verified copy synchronization', {
  timeout: 120000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-handoff-'))
  const sourceRoot = join(directory, 'source')
  const targetRoot = join(directory, 'target')
  await Promise.all([mkdir(sourceRoot), mkdir(join(directory, 'data'))])
  await initializeRepository(sourceRoot)
  await git(directory, 'clone', sourceRoot, targetRoot)
  await writeFile(join(sourceRoot, 'tracked.txt'), 'changed locally\n')
  await writeFile(join(sourceRoot, 'new.txt'), 'untracked locally\n')
  const device = await core.RemoteDevice.open({
    deviceId: 'handoff-device', root: targetRoot,
    grants: [{ instanceId: 'private', environmentId: 'handoff-remote', allowedActorIds: ['owner'],
      permissions: ['read', 'write', 'search'] }],
    statePath: join(directory, 'device-state.json'),
  })
  const endpoint = await device.start()
  const workerTurns = []
  const native = await nativeContext(join(directory, 'sessions'), function* (request) {
    if (request.model === 'router') { yield* routerResponse(request); return }
    if (request.model === 'main') {
      if (!completedToolCount(request)) yield* toolResponse('delegate_work', {
        items: [{ goal: 'Keep this work ready to move.', constraints: 'Preserve uncommitted and untracked content.',
          acceptanceCriteria: 'Continue in the same work and Session after the handoff.' }],
      })
      else yield* textResponse('The movable work was delegated.')
      return
    }
    workerTurns.push(lastUserText(request))
    yield* textResponse('The Worker reached a safe handoff boundary.')
  })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  let host
  t.after(async () => {
    await host?.close().catch(() => {})
    await device.close().catch(() => {})
    await native.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  host = await core.createProductHost(native, {
    databasePath: join(directory, 'data', 'state.sqlite'), workspaceRoot: sourceRoot,
    instanceId: 'private', actorId: 'owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'private', ...payload })
  const sourceEnvironment = (await call('directory-options')).default
  await call('remote-environment-pair', {
    commandId: 'pair-handoff-device', environmentId: 'handoff-remote', label: 'Handoff device',
    endpoint, pairingCode: device.pairingCode, expectedDeviceId: 'handoff-device',
    expectedDeviceKey: device.deviceKeyFingerprint, permissions: ['read', 'write', 'search'],
  })
  await call('send', {
    commandId: 'handoff-work', text: 'Keep this work ready to move.',
    target: 'auto', environmentId: sourceEnvironment.environmentId,
  })
  let work
  await until(async () => {
    work = (await call('history', { limit: 100 })).works.find(candidate =>
      candidate.brief.goal === 'Keep this work ready to move.')
    return work?.control?.assignment && work.status === 'failed'
  }, 'the safe Worker boundary', 25000)
  const sourceAssignment = structuredClone(work.control.assignment)
  const prepared = await call('work-handoff-prepare', {
    commandId: 'prepare-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
    targetEnvironmentId: 'handoff-remote',
  })
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
  assert.deepEqual(prepared.files.map(file => [file.path, file.state]).sort(), [
    ['new.txt', 'untracked'], ['tracked.txt', 'modified'],
  ])
  const preparedWork = (await call('history', { limit: 100 })).works.find(candidate =>
    candidate.brief.workItemId === work.control.workItemId)
  assert.equal(preparedWork.control.handoff.copy.status, 'prepared')
  assert.equal(preparedWork.control.permissions.canHandoff, true)
  assert.equal(preparedWork.control.handoff.targets.some(target => target.id === 'handoff-remote'
    && target.deviceId === 'handoff-device'), true)
  for (const file of prepared.files) {
    await writeFile(join(targetRoot, ...file.path.split('/')), await readFile(join(sourceRoot, ...file.path.split('/'))))
  }
  const verified = await call('work-handoff-verify', {
    commandId: 'verify-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
  })
  assert.equal(verified.status, 'verified', JSON.stringify(verified))
  const handoff = await call('work-handoff', {
    commandId: 'request-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
    targetEnvironmentId: 'handoff-remote', reason: 'Move safely to the paired remote.',
  })
  assert.equal(handoff.state, 'completed', JSON.stringify(handoff))
  assert.equal(handoff.sourceAssignmentId, sourceAssignment.id)
  assert.notEqual(handoff.targetAssignmentId, sourceAssignment.id)
  assert.equal(handoff.sourceGeneration, sourceAssignment.generation)
  assert.equal((await call('work-handoff-prepare', {
    commandId: 'prepare-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
    targetEnvironmentId: 'handoff-remote',
  })).id, prepared.id, 'a lost prepare response replays after the Assignment generation changes')
  assert.equal((await call('work-handoff-verify', {
    commandId: 'verify-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
  })).status, 'verified', 'a lost verify response replays after the Assignment generation changes')
  assert.equal((await call('work-handoff', {
    commandId: 'request-main-handoff', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: sourceAssignment.generation,
    targetEnvironmentId: 'handoff-remote', reason: 'Move safely to the paired remote.',
  })).id, handoff.id, 'a lost handoff response returns the committed handoff after generation changes')
  const after = (await call('history', { limit: 100 })).works.find(candidate =>
    candidate.brief.workItemId === work.control.workItemId)
  assert.equal(after.receipt.ticketId, work.receipt.ticketId)
  assert.equal(after.executionLocation.id, 'handoff-remote')
  assert.equal(after.executionLocation.deviceId, 'handoff-device')
  assert.equal(after.control.assignment.sessionId, sourceAssignment.sessionId)
  assert.equal(after.control.assignment.generation, handoff.targetGeneration)
  assert.equal(after.control.handoff.record.state, 'completed')
  assert.equal(Object.hasOwn(after.control.handoff.record, 'command'), false)
  assert.equal(after.control.handoff.copy.status, 'verified')
  await until(async () => {
    const current = (await call('history', { limit: 100 })).works.find(candidate =>
      candidate.brief.workItemId === work.control.workItemId)
    return workerTurns.length === 2 && current?.control?.assignment?.generation === handoff.targetGeneration
      && current.status === 'failed'
  }, 'the remote Worker safe boundary', 25000)
  const remoteAssignment = (await call('history', { limit: 100 })).works.find(candidate =>
    candidate.brief.workItemId === work.control.workItemId).control.assignment
  const preparedBack = await call('work-handoff-prepare', {
    commandId: 'prepare-main-handoff-back', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: remoteAssignment.generation,
    targetEnvironmentId: sourceEnvironment.environmentId,
  })
  assert.equal(preparedBack.status, 'prepared', JSON.stringify(preparedBack))
  const verifiedBack = await call('work-handoff-verify', {
    commandId: 'verify-main-handoff-back', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: remoteAssignment.generation,
  })
  assert.equal(verifiedBack.status, 'verified', JSON.stringify(verifiedBack))
  const handoffBack = await call('work-handoff', {
    commandId: 'request-main-handoff-back', workItemId: work.control.workItemId,
    ticketId: work.control.ticketId, expectedGeneration: remoteAssignment.generation,
    targetEnvironmentId: sourceEnvironment.environmentId, reason: 'Return safely to the Host.',
  })
  assert.equal(handoffBack.state, 'completed', JSON.stringify(handoffBack))
  assert.equal(handoffBack.sourceAssignmentId, remoteAssignment.id)
  assert.notEqual(handoffBack.targetAssignmentId, remoteAssignment.id)
  const returned = (await call('history', { limit: 100 })).works.find(candidate =>
    candidate.brief.workItemId === work.control.workItemId)
  assert.equal(returned.receipt.ticketId, work.receipt.ticketId)
  assert.equal(returned.executionLocation.id, sourceEnvironment.environmentId)
  assert.equal(returned.control.assignment.sessionId, sourceAssignment.sessionId)
  assert.equal(returned.control.assignment.generation, handoffBack.targetGeneration)
  const observation = (await call('observe-list', {
    query: work.receipt.ticketId, limit: 100,
  })).items.find(item => item.role === 'worker')
  const detail = await call('observe-read', {
    observationId: observation.id, generation: observation.generation, limit: 100,
  })
  assert.equal(detail.sessionId, sourceAssignment.sessionId)
  assert.equal(detail.generations.length, 3)
  assert.equal(detail.generations.find(generation => generation.generation === sourceAssignment.generation)?.current, false)
  assert.equal(detail.generations.find(generation => generation.generation === handoff.targetGeneration)?.current, false)
  assert.equal(detail.generations.find(generation => generation.generation === handoffBack.targetGeneration)?.current, true)
  for (let index = 0; index < 200 && workerTurns.length < 3; index++) await sleep(30)
  assert.equal(workerTurns.length, 3, JSON.stringify(workerTurns))
  assert.match(workerTurns[1], /new execution Environment/u)
  assert.match(workerTurns[2], /new execution Environment/u)
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
  const pendingOptions = await call('execution-options')
  const pendingEnvironment = pendingOptions.environments.find(environment => environment.id === 'remote-project')
  assert.ok(pendingEnvironment)
  assert.notEqual(pendingEnvironment.eligible, true,
    'a pending revoke must quarantine the restored Environment after Host restart')
  assert.notEqual(pendingEnvironment.online, true)
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
