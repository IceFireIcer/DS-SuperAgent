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

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Work observation did not reach ${label}.`)
    await sleep(20)
  }
}

function goalFromWorkerPrompt(text) {
  return text.match(/(?:^|\n)Goal:\n(.+?)(?:\n\n|$)/u)?.[1] ?? ''
}

test('work observations auto-discover bounded Router and Worker history with stable generations', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-work-observations-'))
  const root = join(directory, 'workspace')
  await mkdir(root)

  function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* textResponse('The observation activity was recorded.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          items: [
            { goal: 'Prepare observation alpha.', constraints: 'Write only observed-alpha.txt.', acceptanceCriteria: 'Read observed-alpha.txt back.' },
            { goal: 'Investigate observation beta.', constraints: 'Write only observed-beta.txt.', acceptanceCriteria: 'Read observed-beta.txt back.' },
          ],
        })
        return
      }
      yield* textResponse('Both observation workers were established.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (text.startsWith('Continue after resume.')) {
      yield* textResponse('The resumed Worker reviewed its retained Session.')
      return
    }
    const goal = goalFromWorkerPrompt(text)
    const file = goal.includes('alpha') ? 'observed-alpha.txt' : 'observed-beta.txt'
    if (calls === 0) yield* toolResponse('write_file', { path: file, text: `${file}\n` })
    else if (calls === 1) yield* toolResponse('read_file', { path: file })
    else if (calls === 2) yield* toolResponse('report_ready', {
      result: `${file} was observed.`, evidence: `Read ${file} after writing it.`, artifacts: file,
    })
    else yield* textResponse('No verified result was recorded.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
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
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'observation-work', text: 'Prepare A and investigate B independently.' })
  await until(async () => {
    const history = await engine.getMainConversation({ instanceId: 'personal' })
    return history.works.length === 2 && history.works.every(work => work.status === 'success')
  }, 'both verified results')

  const first = await engine.getWorkObservations({ instanceId: 'personal', limit: 2 })
  assert.equal(first.items.length, 2)
  assert.ok(first.cursor)
  const second = await engine.getWorkObservations({ instanceId: 'personal', limit: 2, after: first.cursor })
  const discovered = [...first.items, ...second.items]
  assert.equal(discovered.length, 3)
  assert.equal(new Set(discovered.map(item => item.id)).size, 3)
  assert.deepEqual(new Set(discovered.map(item => item.role)), new Set(['router', 'worker']))
  assert.equal(discovered.filter(item => item.role === 'worker').every(item => item.ticketId && item.generation && item.sessionId), true)

  const alpha = (await engine.getWorkObservations({ instanceId: 'personal', query: 'alpha' })).items.find(item => item.role === 'worker')
  assert.ok(alpha?.generation)
  assert.ok(alpha?.ticketId)
  const detail = await engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, limit: 100 })
  assert.equal(detail.current, true)
  assert.equal(detail.ticketId, alpha.ticketId)
  assert.equal(detail.events.some(event => event.kind === 'tool-call'), true)
  assert.equal(detail.events.some(event => event.kind === 'tool-result'), true)
  assert.equal(detail.events.some(event => event.kind === 'assistant-message'), true)
  assert.equal(JSON.stringify(detail).includes(root), false, 'the projection does not expose execution roots')
  assert.equal(JSON.stringify(detail).includes('runtimeToken'), false, 'the projection does not expose assignment leases')

  const firstGeneration = alpha.generation
  await engine.stopTicket({ commandId: 'observe-stop', ticketId: alpha.ticketId, reason: 'Create a retained generation.' })
  await engine.resumeTicket({ commandId: 'observe-resume', ticketId: alpha.ticketId })
  await until(async () => {
    const conversation = await engine.conversation(alpha.ticketId)
    return conversation.assignments[0]?.generation !== firstGeneration
  }, 'the replacement Assignment generation')
  const refreshed = (await engine.getWorkObservations({ instanceId: 'personal', query: 'alpha' })).items.find(item => item.role === 'worker')
  assert.notEqual(refreshed.generation, firstGeneration)
  assert.equal(refreshed.current, true)
  const old = await engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: firstGeneration })
  assert.equal(old.current, false)
  assert.match(old.nextStep, /current generation/u)
  assert.equal(old.generations.some(generation => generation.generation === firstGeneration && !generation.current), true)
  assert.equal(old.generations.some(generation => generation.generation === refreshed.generation && generation.current), true)

  await assert.rejects(engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: 'guessed-generation' }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'team' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'personal', limit: 2, query: 'different', after: first.cursor }), { code: 'INVALID_INPUT' })
})
