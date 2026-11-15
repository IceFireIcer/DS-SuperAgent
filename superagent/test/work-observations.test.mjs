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
        yield* toolResponse('delegate_work', text.includes('gamma')
          ? { items: [{ goal: 'Investigate observation gamma.', constraints: 'Write only observed-gamma.txt.', acceptanceCriteria: 'Read observed-gamma.txt back.' }] }
          : {
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
    const file = goal.includes('alpha') ? 'observed-alpha.txt' : goal.includes('gamma') ? 'observed-gamma.txt' : 'observed-beta.txt'
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
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'gamma-observation', text: 'Investigate gamma separately.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(work => work.brief.goal.includes('gamma') && work.status === 'success'),
    'the independent gamma result')
  const insertedContinuation = await engine.getWorkObservations({ instanceId: 'personal', limit: 100, after: first.cursor })
  assert.equal(insertedContinuation.items.some(item => item.title.includes('gamma')), false,
    'a stable cursor continues the original snapshot rather than folding newer items into an older page')
  const freshFirst = await engine.getWorkObservations({ instanceId: 'personal', limit: 2 })
  const freshSecond = await engine.getWorkObservations({ instanceId: 'personal', limit: 2, after: freshFirst.cursor })
  const freshThird = freshSecond.cursor
    ? await engine.getWorkObservations({ instanceId: 'personal', limit: 2, after: freshSecond.cursor }) : { items: [] }
  const discovered = [...freshFirst.items, ...freshSecond.items, ...freshThird.items]
  assert.equal(discovered.length, 5)
  assert.equal(new Set(discovered.map(item => item.id)).size, 5)
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
  assert.equal(detail.facts.some(fact => fact.label === 'Directory' && fact.value === root), true)
  assert.equal(JSON.stringify(detail.events).includes(root), false, 'injected runtime context stays out of the transcript page')
  assert.equal(JSON.stringify(detail).includes('runtimeToken'), false, 'the projection does not expose assignment leases')
  assert.equal(detail.facts.some(fact => fact.label === 'Environment' && fact.value === 'product-workspace'), true)
  assert.equal(detail.facts.some(fact => fact.label === 'Evidence' && fact.value.includes('observed-alpha.txt')), true)
  assert.equal(detail.facts.some(fact => fact.label === 'Artifacts' && fact.value.includes('observed-alpha.txt')), true)

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
  assert.notEqual(refreshed.status, 'success', 'a replacement generation does not inherit the old verified outcome')
  const old = await engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: firstGeneration })
  assert.equal(old.current, false)
  assert.equal(old.events.some(event => event.text.includes('Continue after resume.')), false)
  assert.match(old.nextStep, /current generation/u)
  assert.equal(old.generations.some(generation => generation.generation === firstGeneration && !generation.current), true)
  assert.equal(old.generations.some(generation => generation.generation === refreshed.generation && generation.current), true)
  const current = await engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: refreshed.generation })
  assert.equal(current.current, true)
  assert.equal(current.events.some(event => event.text.includes('Prepare observation alpha.')), false,
    'the replacement generation does not expose the earlier generation transcript')

  const routerObservations = (await engine.getWorkObservations({ instanceId: 'personal', limit: 100 })).items
    .filter(item => item.role === 'router')
  assert.equal(routerObservations.length, 2)
  const firstRouter = routerObservations.find(item => {
    const decoded = JSON.parse(Buffer.from(item.id, 'base64url').toString('utf8'))
    return decoded.workBriefId === alpha.workBriefId
  })
  const gammaRouter = routerObservations.find(item => item.id !== firstRouter.id)
  const firstRouterHistory = await engine.readWorkObservation({ instanceId: 'personal', observationId: firstRouter.id, limit: 100 })
  const gammaRouterHistory = await engine.readWorkObservation({ instanceId: 'personal', observationId: gammaRouter.id, limit: 100 })
  assert.equal(JSON.stringify(firstRouterHistory.events).includes('observation gamma'), false,
    'a Router observation excludes another WorkBrief from the shared Router Session')
  assert.equal(JSON.stringify(gammaRouterHistory.events).includes('observation gamma'), true)
  assert.equal(JSON.stringify(gammaRouterHistory.events).includes('observation alpha'), false)

  await assert.rejects(engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: 'guessed-generation' }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'team' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'personal', limit: 2, query: 'different', after: first.cursor }), { code: 'INVALID_INPUT' })
})
