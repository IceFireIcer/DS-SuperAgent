import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
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
        yield* toolResponse('delegate_work', text.includes('budget failure')
          ? { items: [{ goal: 'Exercise Router budget failure.', constraints: 'Keep the failure visible.', acceptanceCriteria: 'Record the failed Router attempt.' }] }
          : text.includes('gamma')
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
      if (text.includes('budget failure')) {
        const tool = options.tools?.[0]
        const brief = JSON.parse(text.slice(text.indexOf('{')).trim())
        if (tool) yield* toolResponse(tool.name, { items: brief.requestedItems }, 'router-budget')
        else yield* textResponse('No Router tool was available.')
        return
      }
      yield* routerResponse(options)
      return
    }
    if (text.startsWith('Continue after resume.')) {
      yield* textResponse('The resumed Worker reviewed its retained Session.')
      return
    }
    const goal = goalFromWorkerPrompt(text)
    const file = goal.includes('alpha') ? 'observed-alpha.txt' : goal.includes('gamma') ? 'observed-gamma.txt' : 'observed-beta.txt'
    if (calls === 0) yield* toolResponse('write_file', { path: file,
      text: file.includes('alpha') ? `${file}\n${'observed alpha output '.repeat(600)}` : `${file}\n` })
    else if (calls === 1) yield* toolResponse('read_file', { path: file })
    else if (calls === 2) yield* toolResponse('report_ready', {
      result: `${file} was observed.`,
      evidence: `Read ${file} after writing it. ${'Verified output line.\n'.repeat(600)}`,
      artifacts: file,
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
  assert.equal(discovered.length, 5, JSON.stringify(discovered.map(item => [item.role, item.workBriefId, item.workItemId, item.title])))
  assert.equal(new Set(discovered.map(item => item.id)).size, 5)
  assert.deepEqual(new Set(discovered.map(item => item.role)), new Set(['router', 'worker']))
  assert.equal(discovered.filter(item => item.role === 'worker').every(item => item.ticketId && item.generation && item.sessionId), true)

  const alpha = (await engine.getWorkObservations({ instanceId: 'personal', query: 'alpha' })).items.find(item => item.role === 'worker')
  assert.ok(alpha?.generation)
  assert.ok(alpha?.ticketId)
  const detail = await engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, limit: 100 })
  assert.equal(detail.current, true)
  assert.equal(detail.historyStatus, 'available')
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
  assert.equal(detail.facts.some(fact => fact.label === 'Configuration revision' && fact.value === '1'), true)
  const oversizedEvent = detail.events.find(event => event.kind === 'tool-result' && event.detailId)
  assert.ok(oversizedEvent?.detailId)
  const eventDetail = await engine.readWorkObservationDetail({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, detailId: oversizedEvent.detailId, limit: 700 })
  assert.equal(eventDetail.label, 'Tool output')
  assert.equal(eventDetail.text.length, 700)
  assert.ok(eventDetail.bytes > 700)
  assert.equal(eventDetail.hasMore, true)
  assert.equal(typeof eventDetail.next, 'number')
  const eventDetailNext = await engine.readWorkObservationDetail({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, detailId: oversizedEvent.detailId, offset: eventDetail.next, limit: 700 })
  assert.notEqual(eventDetailNext.text, eventDetail.text)
  const evidenceFact = detail.facts.find(fact => fact.label === 'Evidence' && fact.detailId)
  assert.ok(evidenceFact?.detailId)
  const evidenceDetail = await engine.readWorkObservationDetail({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, detailId: evidenceFact.detailId, limit: 1200 })
  assert.equal(evidenceDetail.label, 'Evidence')
  assert.equal(evidenceDetail.text.includes('Verified output line.'), true)
  assert.equal(evidenceDetail.bytes > evidenceDetail.text.length, true)
  const eventLocator = JSON.parse(Buffer.from(oversizedEvent.detailId, 'base64url').toString('utf8'))
  const guessedEventDetail = Buffer.from(JSON.stringify({ ...eventLocator, seq: eventLocator.seq + 100000 })).toString('base64url')
  await assert.rejects(engine.readWorkObservationDetail({ instanceId: 'personal', observationId: alpha.id,
    generation: alpha.generation, detailId: guessedEventDetail }), { code: 'NOT_FOUND' })

  const firstGeneration = alpha.generation
  const config = await engine.getRoleConfig()
  await engine.updateRoleConfig({ commandId: 'observe-config-v2', expectedRevision: config.revision,
    roles: { ...config.roles, worker: { ...config.roles.worker,
      instructions: '{{goal}} {{constraints}} Use the replacement configuration.' } } })
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
  assert.equal(current.facts.some(fact => fact.label === 'Configuration revision' && fact.value === '2'), true)
  const alphaWork = (await engine.getMainConversation({ instanceId: 'personal' })).works.find(work => work.brief.goal.includes('alpha'))
  assert.equal(alphaWork.brief.configurationRevision, 1, 'the Worker projection does not reuse the earlier Main revision')
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
  assert.equal(firstRouterHistory.facts.some(fact => fact.label === 'Configuration revision' && fact.value === '1'), true)
  assert.equal(JSON.stringify(gammaRouterHistory.events).includes('observation gamma'), true)
  assert.equal(JSON.stringify(gammaRouterHistory.events).includes('observation alpha'), false)

  const routerCount = routerObservations.length
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'router-budget-failure', text: 'Trigger Router budget failure.' })
  await until(async () => (await engine.getWorkObservations({ instanceId: 'personal', limit: 100 })).items
    .filter(item => item.role === 'router').length > routerCount, 'the failed Router attempt record')
  const failedRouter = (await engine.getWorkObservations({ instanceId: 'personal', limit: 100 })).items
    .filter(item => item.role === 'router').sort((left, right) => right.createdAt - left.createdAt)[0]
  await until(async () => (await engine.readWorkObservation({ instanceId: 'personal', observationId: failedRouter.id, limit: 100 }))
    .facts.some(fact => fact.label === 'Router turns' && fact.value.includes('failed') && fact.value.includes('STEP_BUDGET')),
  'the failed Router turn audit')
  const failedRouterUses = await engine.getRoleConfigUses(failedRouter.sessionId)
  assert.equal(failedRouterUses.some(use => use.role === 'router' && use.revision === 2), true,
    'a failed Router attempt records the revision it actually used')

  const sessionRoot = join(directory, 'sessions')
  const sessionFiles = (await readdir(sessionRoot, { recursive: true }))
    .filter(file => file.includes(firstRouterHistory.sessionId) && !file.endsWith(firstRouterHistory.sessionId))
  assert.ok(sessionFiles.length > 0)
  await Promise.all(sessionFiles.map(file => rm(join(sessionRoot, file), { force: true })))
  const missing = await engine.readWorkObservation({ instanceId: 'personal', observationId: firstRouter.id, limit: 100 })
  assert.equal(missing.historyStatus, 'missing')
  assert.deepEqual(missing.events, [])

  await assert.rejects(engine.readWorkObservation({ instanceId: 'personal', observationId: alpha.id, generation: 'guessed-generation' }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'team' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(engine.getWorkObservations({ instanceId: 'personal', limit: 2, query: 'different', after: first.cursor }), { code: 'INVALID_INPUT' })
})
