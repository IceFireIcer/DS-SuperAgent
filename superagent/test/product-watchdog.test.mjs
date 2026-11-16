import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { SqliteStorage } from '../dist/storage.js'
import { productWatchdogProbe } from '../dist/product-watchdog.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { routerResponse, toolResponse } from '../dev/native-mock.mjs'

test('the product probe separates Main, Router, Worker, source, setup and unknown-job failures', async () => {
  const probe = await productWatchdogProbe({
    async getMainConversation() { return { health: { state: 'degraded', errorCode: 'MODEL_DOWN' } } },
    async getSupervision() { return { items: [{ health: { effectsUnknown: 1, jobsUnknown: 1 } }],
      counts: { needsHuman: 1, stopped: 1, blocked: 1 }, processingPaused: false, hasMore: false } },
    async getWorkObservations() { return { items: [
      { id: 'router-1', role: 'router', status: 'failed' }, { id: 'worker-1', role: 'worker', status: 'failed' },
    ] } },
    async getRoleConfig() { return { revision: 3, roles: { main: { model: { provider: 'unconfigured' } },
      router: { model: { provider: 'mock' } }, worker: { model: { provider: 'mock' } } } } },
  }, 'private', { id: 'feishu:fixture', state: 'failed', error: 'SOURCE_FAILED' }, 'SETUP_FAILED')
  assert.equal(probe.service, 'healthy', 'a model or local component failure does not turn into a Host restart')
  assert.deepEqual(probe.components.map(item => item.id), ['main', 'unknown-jobs', 'router:router-1', 'worker:worker-1'])
  assert.deepEqual(probe.setups.map(item => item.id), ['feishu', 'main'])
  assert.equal(probe.sources[0].state, 'failed')
  assert.equal(probe.unknownEffects, 1)
  assert.equal(probe.normalWaits, 3)
  assert.equal(probe.detail, 'role-config-r3')
})

test('the actual product Host publishes bounded health for an independent Watchdog and keeps inspection separate', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-watchdog-'))
  const databasePath = join(directory, 'state.sqlite')
  const statusPath = join(directory, 'status.json')
  const native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('No tools.') })
  const host = await createProductHost(native, { databasePath, watchdogStatusPath: statusPath,
    instanceId: 'private', actorId: 'user', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  assert.equal(status.service, 'healthy')
  assert.equal(status.pid, process.pid)
  assert.equal(status.epoch, 1)
  assert.deepEqual(status.sources, [])
  assert.deepEqual(status.setups, [])
  assert.equal(status.detail, 'role-config-r1')
  assert.doesNotMatch(JSON.stringify(status), /apiKey|sessionId|prompt|secret/iu)
  const before = await host.dispatch('supervision', { instanceId: 'private' })
  assert.equal(before.watchdogConfigured, true)
  const run = await host.dispatch('supervision-inspect', { instanceId: 'private' })
  assert.equal(run.status, 'completed')
  assert.equal(run.observations, 0)
  assert.deepEqual(run.inspectionBudget, { inspected: 0, maxTickets: 1000 })
  const after = await host.dispatch('supervision', { instanceId: 'private' })
  assert.equal(after.run.last.status, 'completed')
  assert.deepEqual(after.run.last.inspectionBudget, { inspected: 0, maxTickets: 1000 })
  let budgetResult
  for (let attempt = 0; attempt < 24; attempt++) budgetResult = await host.dispatch('supervision-inspect', { instanceId: 'private' })
  assert.equal(budgetResult.status, 'budget-exhausted', 'manual inspections share the persisted hourly budget')
  for (let attempt = 0; attempt < 51; attempt++) budgetResult = await host.dispatch('supervision-inspect', { instanceId: 'private' })
  assert.equal(budgetResult.status, 'budget-exhausted', 'evicting old display history does not reset the budget')
  await assert.rejects(host.dispatch('supervision-decide', { instanceId: 'private', commandId: 'no-proposal', proposalId: 'missing', fingerprint: 'x', decision: 'approve' }), { code: 'PROPOSAL_NOT_FOUND' })
  const client = { id: 'client', grants: [{ instanceId: 'private', capabilities: ['read', 'command'] }] }
  await assert.rejects(host.dispatch('supervision', { instanceId: 'private' }, client), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('supervision-decide', { instanceId: 'private', commandId: 'remote', proposalId: 'missing', fingerprint: 'x', decision: 'approve' }, client), { code: 'SOURCE_NOT_AUTHORIZED' })
  const storage = await SqliteStorage.open(databasePath)
  try {
    const persisted = await storage.transaction('private', tx => tx.get('supervisor-run', 'product-supervisor'))
    assert.equal(persisted.last.status, 'budget-exhausted')
    assert.equal(persisted.attempts.length, 24)
    await storage.transaction('private', tx => tx.insert('supervisor-proposal', JSON.stringify(['supervisor-proposal', 'foreign']), {
      id: 'foreign', instanceId: 'private', ticketId: 'foreign-ticket', status: 'proposed', createdAt: Date.now(),
    }))
    assert.deepEqual((await host.dispatch('supervision', { instanceId: 'private' })).proposals, [],
      'a proposal without an authorized Main work card stays outside the trusted settings view')
    await assert.rejects(host.dispatch('supervision', { instanceId: 'private', ticketId: 'foreign-ticket' }), { code: 'NOT_FOUND' })
  } finally { await storage.close() }
})

test('the independent CLI starts the product Host, reads its health and observes the Host exit', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-watchdog-process-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  const status = join(directory, 'status.json')
  const cli = fileURLToPath(new URL('../dist/watchdog-cli.js', import.meta.url))
  const host = fileURLToPath(new URL('../dev/r5-watchdog-host.mjs', import.meta.url))
  const args = ['--database', database, '--instance', 'fixture', '--status', status,
    '--host-command', process.execPath, '--host-arg', host,
    '--host-arg', '--database', '--host-arg', database, '--host-arg', '--instance', '--host-arg', 'fixture',
    '--host-arg', '--status', '--host-arg', status, '--grace-ms', '10000', '--once']
  const execute = async () => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', error = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk })
    const code = await new Promise(resolve => child.once('exit', resolve))
    return { code, out, error }
  }
  const first = await execute()
  assert.equal(first.code, 0, first.error)
  const inspection = JSON.parse(first.out.trim().split('\n').at(-1))
  assert.equal(inspection.kind, 'recovered')
  assert.equal(inspection.after.detail, 'role-config-r1')
  assert.equal(inspection.after.epoch, 1)
  const published = JSON.parse(await readFile(status, 'utf8'))
  assert.throws(() => process.kill(published.pid, 0), 'diagnostic mode stopped its own Host')
  const lock = `${database}.watchdog-${createHash('sha256').update('fixture').digest('hex').slice(0, 16)}.lock`
  await writeFile(lock, 'another-owner\n')
  const duplicate = await execute()
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.error, /Watchdog lock exists/u)
})

test('Main work gets a semantic proposal; the trusted decision adds one direction only after approval', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-supervision-'))
  const workspace = join(directory, 'work')
  await Promise.all([mkdir(workspace), mkdir(join(directory, 'core'))])
  const native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('Update received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: 'Review the file set.', constraints: 'Stay in this directory.', acceptanceCriteria: 'Verify the listed files.' })
      else yield* textResponse('Work delegated.')
      return
    }
    if (options.model === 'router') {
      if (options.tools.some(tool => tool.name === 'record_supervision')) {
        if (count === 0) yield* toolResponse('record_supervision', { kind: 'deviation', reason: 'The Worker drifted away from the file set.',
          recommendation: 'Return to the listed files.', action: 'correct' })
        else yield* textResponse('Recorded.')
      } else yield* routerResponse(options)
      return
    }
    if (count === 0) yield* toolResponse('start_shell', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 15' : 'sleep 15' })
    else yield* textResponse('The background investigation is in progress.')
  })
  const host = await createProductHost(native, { databasePath: join(directory, 'core', 'state.sqlite'), workspaceRoot: workspace,
    instanceId: 'private', actorId: 'user', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'private', ...payload })
  await call('send', { commandId: 'file-review', text: 'Review the file set.' })
  let card
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    card = (await call('history')).works[0]
    if (card?.receipt?.status === 'accepted' && card.control?.assignment?.state === 'running') break
    await sleep(50)
  }
  assert.equal(card?.receipt?.status, 'accepted')
  const ticketId = card.receipt.ticketId
  let proposal
  for (let attempt = 0; attempt < 30; attempt++) {
    await call('supervision-inspect')
    proposal = (await call('supervision')).proposals.find(item => item.ticketId === ticketId)
    if (proposal) break
    await sleep(50)
  }
  assert.ok(proposal, 'the real product supervisor proposed a correction')
  assert.equal(proposal.status, 'proposed')
  assert.equal(proposal.evidence.snapshot.assignmentId, card.control.assignment.id)
  assert.equal((await call('supervision', { ticketId })).observation.last.proposalId, proposal.id)
  const before = (await call('history')).works[0].control.ticketVersion
  const approved = await call('supervision-decide', { commandId: 'approve-review', proposalId: proposal.id,
    fingerprint: proposal.fingerprint, decision: 'approve' })
  assert.equal(approved.action.status, 'done')
  assert.equal(approved.action.kind, 'direction')
  const after = (await call('history')).works[0].control.ticketVersion
  assert.equal(after, before + 1)
  assert.equal((await call('supervision')).proposals.find(item => item.id === proposal.id).status, 'approved')
})
