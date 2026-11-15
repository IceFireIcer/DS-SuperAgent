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
  const deadline = Date.now() + 25_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The background terminal did not finish.')
    await sleep(20)
  }
}

test('a selected work directory owns a terminal job and wakes only its original Worker', { timeout: 50_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-product-terminal-'))
  const root = join(base, 'work')
  await mkdir(root)
  const workerEvents = []
  const environment = await LocalEnvironment.open({ id: 'terminal-work', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search', 'command'], commands: {}, allowShell: true,
    assetsPath: join(base, 'assets') })
  const native = await nativeContext(join(base, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) { yield* textResponse('The result is available.'); return }
      if (count === 0) yield* toolResponse('delegate_work', {
        goal: 'Create terminal.txt with a PTY and verify it.', constraints: 'Use only the selected work directory.',
        acceptanceCriteria: 'Read terminal.txt and check a shell command before reporting.',
      })
      else yield* textResponse('Worker started.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (count === 0) workerEvents.push(text)
    if (text.startsWith('Background job')) {
      if (count === 0) yield* toolResponse('read_job_output', {
        jobId: text.match(/^Background job ([a-f0-9-]+)/u)[1], stream: 'stdout', offset: '0', maxBytes: '8192',
      })
      else if (count === 1) yield* toolResponse('read_file', { path: 'terminal.txt' })
      else if (count === 2) yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
      else if (count === 3) yield* toolResponse('report_ready', {
        result: 'Terminal job finished.', evidence: 'Read the file and checked shell output.', artifacts: 'terminal.txt',
      })
      else yield* textResponse('No further actions.')
      return
    }
    if (count === 0) yield* toolResponse('start_terminal', {
      command: process.platform === 'win32' ? "Set-Content -Encoding utf8 terminal.txt 'from terminal'" : "printf 'from terminal\\n' > terminal.txt",
    })
    else yield* textResponse('Terminal started in the background.')
  })
  const storage = await SqliteStorage.open(join(base, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(base, { recursive: true, force: true })
  })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'run-terminal', text: 'Run a terminal job here.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works[0]?.outcome?.status === 'success')
  const work = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  const [job] = await engine.listJobs(work.receipt.ticketId)
  assert.equal(job.state, 'exited')
  assert.equal(job.exitCode, 0)
  assert.match(workerEvents.find(text => text.startsWith('Background job')), new RegExp(job.id, 'u'))
  assert.equal((await engine.conversation(work.receipt.ticketId)).assignments[0].environment.root, root)
  assert.equal((await readFile(join(root, 'terminal.txt'), 'utf8')).trim(), 'from terminal')
})
