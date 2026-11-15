import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`The work did not reach ${label}.`)
    await sleep(20)
  }
}

test('stopping one Main work item cancels only its shell job while another directory continues', { timeout: 45_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-product-shell-stop-'))
  const first = join(base, 'first')
  const second = join(base, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const environments = await Promise.all([['first', first], ['second', second]].map(([id, root]) => LocalEnvironment.open({
    id, instanceId: 'personal', root, allowedActorIds: ['alice'], permissions: ['read', 'write', 'search', 'command'],
    allowShell: true, commands: {},
  })))
  const native = await nativeContext(join(base, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) { yield* textResponse('Work status received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: text.includes('first') ? 'Long first work.' : 'Quick second work.',
        constraints: 'Stay in the selected work directory.', acceptanceCriteria: 'Verify a file in this directory after the job finishes.' })
      else yield* textResponse('Work delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (text.startsWith('Background job')) {
      if (count === 0) yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
      else if (count === 1) yield* toolResponse('report_ready', { result: 'Second work finished.',
        evidence: 'The background shell exited and verification passed.', artifacts: 'second.txt' })
      else yield* textResponse('No further actions.')
      return
    }
    if (text.includes('Quick second work')) {
      if (count === 0) yield* toolResponse('write_file', { path: 'second.txt', text: 'second\n' })
      else if (count === 1) yield* toolResponse('start_shell', { command: process.platform === 'win32'
        ? 'Start-Sleep -Milliseconds 700' : 'sleep 0.7' })
      else yield* textResponse('Second job is running.')
      return
    }
    if (count === 0) yield* toolResponse('start_shell', { command: process.platform === 'win32'
      ? 'Start-Sleep -Seconds 20' : 'sleep 20' })
    else yield* textResponse('First job is running.')
  })
  const storage = await SqliteStorage.open(join(base, 'state.sqlite'))
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' } })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, environments)
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await Promise.all(environments.map(environment => environment.close()))
    await storage.close(); await rm(base, { recursive: true, force: true })
  })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'first-command', text: 'Start long first work.', environmentId: 'first' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works[0]?.receipt.status === 'accepted', 'first receipt')
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'second-command', text: 'Start quick second work.', environmentId: 'second' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.length === 2, 'two work items')
  const [firstWork, secondWork] = (await engine.getMainConversation({ instanceId: 'personal' })).works
  await until(async () => (await engine.listJobs(firstWork.receipt.ticketId)).some(job => job.state === 'running'), 'first shell job')
  const firstJob = (await engine.listJobs(firstWork.receipt.ticketId))[0]
  await engine.stopMainWork({ instanceId: 'personal', commandId: 'stop-first-only', workItemId: firstWork.brief.workItemId,
    ticketId: firstWork.receipt.ticketId, expectedGeneration: firstWork.control.assignment.generation,
    expectedTicketVersion: firstWork.control.ticketVersion, reason: 'Stop only the first work item.' })
  await until(async () => (await engine.getJob(firstWork.receipt.ticketId, firstJob.id)).state === 'cancelled', 'confirmed first job cancellation')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works[1]?.outcome?.status === 'success', 'independent second result')
  assert.equal((await engine.getMainConversation({ instanceId: 'personal' })).works[0].status, 'stopped')
  assert.equal((await engine.getJob(firstWork.receipt.ticketId, firstJob.id)).settled, true)
  assert.equal((await engine.conversation(secondWork.receipt.ticketId)).assignments[0].environment.root, second)
  assert.equal(await readFile(join(second, 'second.txt'), 'utf8'), 'second\n')
})
