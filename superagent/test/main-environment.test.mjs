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

async function until(check) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The delegated work did not finish.')
    await sleep(20)
  }
}

test('Main keeps each work item in its selected directory across a default change and retry', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-environment-'))
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const environments = await Promise.all([['first', first], ['second', second]].map(([id, root]) => LocalEnvironment.open({
    id, instanceId: 'personal', root, allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {},
  })))
  const native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) { yield* textResponse('Work update recorded.'); return }
      if (count === 0) yield* toolResponse('delegate_work', {
        goal: 'Write a checked note in the selected directory.', constraints: 'Use only this work directory.',
        acceptanceCriteria: 'Read the note back and report the result.',
      })
      else yield* textResponse('Work delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (count === 0) yield* toolResponse('write_file', { path: 'note.txt', text: text.includes('first') ? 'first\n' : 'second\n' })
    else if (count === 1) yield* toolResponse('read_file', { path: 'note.txt' })
    else if (count === 2) yield* toolResponse('report_ready', { result: 'Note complete.', evidence: 'Read back the note.', artifacts: 'note.txt' })
    else yield* textResponse('No further actions.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, environments)
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await Promise.all(environments.map(environment => environment.close()))
    await storage.close(); await rm(directory, { recursive: true, force: true })
  })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  assert.equal((await engine.getInstanceDirectory({ instanceId: 'personal' })).environmentId, 'first')
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'first-work', text: 'Write in first.', environmentId: 'first' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.length === 1)
  const previous = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  const changed = await engine.setInstanceDirectory({ instanceId: 'personal', commandId: 'change-default',
    expectedRevision: 0, environmentId: 'second' })
  assert.equal(changed.environmentId, 'second')
  assert.equal(changed.revision, 1)
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'second-work', text: 'Write in second.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.length === 2)
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.every(work => work.outcome?.status === 'success'))
  const works = (await engine.getMainConversation({ instanceId: 'personal' })).works
  const oldAssignment = (await engine.conversation(previous.receipt.ticketId)).assignments[0]
  const newAssignment = (await engine.conversation(works[1].receipt.ticketId)).assignments[0]
  assert.deepEqual([oldAssignment.environment.root, newAssignment.environment.root], [first, second])
  assert.equal(await readFile(join(first, 'note.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(second, 'note.txt'), 'utf8'), 'second\n')
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'first-work', text: 'Write in first.', environmentId: 'first' })
  await assert.rejects(engine.sendMainMessage({ instanceId: 'personal', commandId: 'first-work', text: 'Write in first.', environmentId: 'second' }), { code: 'IDENTITY_CONFLICT' })
  assert.equal((await engine.listTickets()).items.length, 2)
})
