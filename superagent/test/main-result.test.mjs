import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check) {
  const deadline = Date.now() + 10_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The delegated result did not reach its expected boundary.')
    await sleep(20)
  }
}

test('a busy Main cannot release the Worker result and a superseded report discards its late reply', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'main-result-boundary-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  let releaseMain
  const gate = new Promise(resolve => { releaseMain = resolve })
  let mainStarted = false
  const respond = options => {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'router') return routerResponse(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) return (async function* () {
        const notification = JSON.parse(text.split('\n').at(-1))
        if (notification.outcome?.status === 'success') {
          mainStarted = true
          await gate
        }
        yield* textResponse('Main reviewed the result.')
      })()
      return calls === 0 ? toolResponse('delegate_work', {
        goal: 'Write and verify note.txt.', constraints: 'Stay in the workspace.', acceptanceCriteria: 'Read back the note.',
      }) : textResponse('Work accepted.')
    }
    const next = [
      ['write_file', { path: 'note.txt', text: 'checked' }],
      ['read_file', { path: 'note.txt' }],
      ['report_ready', { result: 'Worker finished note.txt.', evidence: 'Read back note.txt.', artifacts: 'note.txt' }],
    ][calls]
    return next ? toolResponse(next[0], next[1], `worker-${calls}`) : textResponse('Finished.')
  }
  const environment = await LocalEnvironment.open({ id: 'workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    releaseMain()
    await engine.effects.stop()
    await engine.shutdown()
    await sessions.close()
    await native.fiber.dispose()
    await environment.close()
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'work', text: 'Create a verified note.' })
  await until(() => mainStarted)
  const work = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  const ticketId = work.receipt.ticketId
  assert.equal((await engine.conversation(ticketId)).messages.some(message => message.purpose === 'result'), false)
  await storage.transaction('personal', async tx => {
    const report = await tx.get('report', ticketId)
    await tx.replace('report', ticketId, { ...report, id: `${report.id}:superseded` })
  })
  releaseMain()
  await until(() => storage.transaction('personal', async tx => {
    const update = await tx.get('work-update-head', work.brief.workItemId)
    return (await tx.get('main-update-command', update.id))?.state === 'discarded'
  }))
  assert.equal((await engine.conversation(ticketId)).messages.some(message => message.purpose === 'result'), false)
})
