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

test('a delegated child inherits the Worker directory and returns evidence only to that Worker', { timeout: 40_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-product-subagent-'))
  const root = join(base, 'work')
  await mkdir(root)
  const workerEvents = []
  const environment = await LocalEnvironment.open({ id: 'subtask-world', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search', 'command'], commands: {}, allowShell: true })
  const native = await nativeContext(join(base, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) { yield* textResponse('Worker outcome received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: 'Create child.txt through a child Agent.',
        constraints: 'Use the selected work directory and no second Ticket.', acceptanceCriteria: 'Verify the child file before reporting.' })
      else yield* textResponse('Worker started.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (text.startsWith('Write child.txt')) {
      if (count === 0) yield* toolResponse('write_file', { path: 'child.txt', text: 'delegated child\n' })
      else if (count === 1) yield* toolResponse('read_file', { path: 'child.txt' })
      else yield* textResponse('The child wrote and read back child.txt.')
      return
    }
    if (count === 0) workerEvents.push(text)
    if (text.startsWith('Subagent ')) {
      if (count === 0) yield* toolResponse('read_file', { path: 'child.txt' })
      else if (count === 1) yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
      else if (count === 2) yield* toolResponse('report_ready', {
        result: 'The child file is ready.', evidence: 'The parent verified child.txt and ran a shell check.', artifacts: 'child.txt',
      })
      else yield* textResponse('No further actions.')
      return
    }
    if (count === 0) yield* toolResponse('delegate_subagent', { task: 'Write child.txt and read it back.' })
    else yield* textResponse('Child is working independently.')
  })
  const storage = await SqliteStorage.open(join(base, 'state.sqlite'))
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' } })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(base, { recursive: true, force: true })
  })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'child-work', text: 'Create and verify a delegated child file.' })
  const deadline = Date.now() + 20_000
  let work
  while (Date.now() <= deadline) {
    work = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
    if (work?.outcome?.status === 'success') break
    await sleep(20)
  }
  if (work?.outcome?.status !== 'success') throw new Error('The delegated child did not return to its Worker.')
  const [child] = await engine.listSubagents(work.receipt.ticketId)
  assert.equal(child.state, 'completed')
  assert.match(workerEvents.find(text => text.startsWith('Subagent ')), new RegExp(child.id, 'u'))
  assert.equal((await engine.conversation(work.receipt.ticketId)).assignments[0].environment.root, root)
  assert.equal(await readFile(join(root, 'child.txt'), 'utf8'), 'delegated child\n')
  assert.equal((await engine.listTickets()).items.length, 1)
})
