import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

const routes = {
  main: { provider: 'mock', model: 'main' },
  router: { provider: 'mock', model: 'router' },
  worker: { provider: 'mock', model: 'worker' },
}
const source = { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Main controls did not reach ${label}.`)
    await sleep(20)
  }
}

async function seedAcceptedCard({ storage, binding, ticketId, suffix }) {
  const briefId = `seed-brief-${suffix}`
  const itemId = `seed-item-${suffix}`
  const sourceEventId = `seed-source-${suffix}`
  const now = Date.now()
  const brief = {
    id: briefId, version: 1, instanceId: 'personal', mainId: binding.mainId,
    mainSessionId: binding.mainSessionId, routerSessionId: binding.routerSessionId,
    mainMessageId: `seed-message-${suffix}`, originalUserText: `Seed ${suffix} work.`,
    authorization: { kind: 'authorized-main-actor', sourceInstanceId: source.sourceInstanceId, actorId: source.actorId },
    goal: `Seed ${suffix} work.`, constraints: 'Wait for assignment.', acceptanceCriteria: 'Remain independently stoppable.',
    sourceEventId, evidence: { kind: 'main-message', id: `seed-message-${suffix}` }, environmentId: 'product-workspace',
    configurationRevision: 1, createdAt: now,
  }
  const item = { id: itemId, version: 1, workBriefId: briefId, sourceEventId, position: 0,
    goal: brief.goal, constraints: brief.constraints, acceptanceCriteria: brief.acceptanceCriteria, createdAt: now }
  await storage.transaction('personal', async tx => {
    await tx.insert('work-brief', briefId, brief)
    await tx.insert('work-item', itemId, item)
    await tx.insert('work-split', briefId, { id: briefId, version: 1, workBriefId: briefId, sourceEventId,
      fingerprint: `seed-fingerprint-${suffix}`, itemIds: [itemId], createdAt: now })
    await tx.insert('work-receipt', itemId, { version: 1, workBriefId: briefId, workItemId: itemId, status: 'accepted',
      ticketId, nextStep: 'Wait for the assigned Worker.', createdAt: now })
    await tx.insert('work-receipt', briefId, { version: 1, workBriefId: briefId, status: 'accepted', ticketIds: [ticketId],
      nextStep: 'The seeded work was accepted.', createdAt: now })
    await tx.insert('work-item-ticket', itemId, { workBriefId: briefId, workItemId: itemId, ticketId })
    await tx.insert('work-ticket', ticketId, { workBriefId: briefId, workItemId: itemId, ticketId })
  })
  return { briefId, itemId }
}

test('stopping the current Main reply leaves the committed delegated work running', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-stop-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  let started
  const running = new Promise(resolve => { started = resolve })
  const native = await nativeContext(join(directory, 'sessions'), async function* (options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* textResponse('The independent work reported its result.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Create the stop-main note.',
          constraints: 'Write only stop-main.txt.',
          acceptanceCriteria: 'Read stop-main.txt back after writing it.',
        })
        return
      }
      started()
      await new Promise(resolve => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', resolve, { once: true })
      })
      yield* textResponse('This late Main reply must not be published.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (calls === 0) yield* toolResponse('write_file', { path: 'stop-main.txt', text: 'committed work survived\n' })
    else if (calls === 1) yield* toolResponse('read_file', { path: 'stop-main.txt' })
    else if (calls === 2) yield* toolResponse('report_ready', {
      result: 'The stop-main note is complete.',
      evidence: 'Read stop-main.txt back after writing it.',
      artifacts: 'stop-main.txt',
    })
    else yield* textResponse('Recorded.')
  })
  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const engine = new Engine(storage, 'personal', source, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  const pending = engine.sendMainMessage({ instanceId: 'personal', commandId: 'stop-main-turn', text: 'Create the durable note.' })
  await running
  const active = (await engine.getMainConversation({ instanceId: 'personal' })).activeTurn
  assert.equal(active?.status, 'running')
  const stopped = await engine.stopMainTurn({ instanceId: 'personal', commandId: 'stop-main-command', messageId: active.messageId })
  assert.equal(stopped.status, 'stopping')
  assert.equal((await pending).status, 'stopped')

  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(work => work.outcome?.status === 'success'),
    'the delegated result after the Main stop')
  const page = await engine.getMainConversation({ instanceId: 'personal' })
  const stoppedMessage = page.messages.find(message => message.id === active.messageId)
  assert.equal(stoppedMessage?.status, 'stopped')
  assert.equal(page.messages.some(message => message.text === 'This late Main reply must not be published.'), false)
  const work = page.works.find(item => item.outcome?.status === 'success')
  assert.equal(work?.control?.permissions.actorId, 'alice')
  assert.equal(work?.control?.assignment?.generation.length > 0, true)
  const initialGeneration = work.control.assignment.generation
  const stopReplay = { instanceId: 'personal', commandId: 'idempotent-stop', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId, expectedGeneration: initialGeneration, expectedTicketVersion: work.control.ticketVersion,
    reason: 'Exercise stop replay.' }
  const resumeReplay = { instanceId: 'personal', commandId: 'idempotent-resume', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId, expectedGeneration: initialGeneration }
  await engine.stopMainWork(stopReplay)
  await engine.resumeMainWork(resumeReplay)
  await until(async () => (await engine.conversation(work.receipt.ticketId)).assignments[0].generation !== initialGeneration,
    'the resumed generation')
  const resumedGeneration = (await engine.conversation(work.receipt.ticketId)).assignments[0].generation
  await engine.stopMainWork(stopReplay)
  await engine.resumeMainWork(resumeReplay)
  assert.equal((await engine.conversation(work.receipt.ticketId)).assignments[0].generation, resumedGeneration)
  await until(async () => (await engine.conversation(work.receipt.ticketId)).status === 'ready', 'the resumed result')
  const retryReplay = { instanceId: 'personal', commandId: 'idempotent-retry', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId, expectedGeneration: resumedGeneration, reason: 'Exercise retry replay.' }
  await engine.retryMainWork(retryReplay)
  await until(async () => (await engine.conversation(work.receipt.ticketId)).assignments[0].generation !== resumedGeneration,
    'the retried generation')
  const retriedGeneration = (await engine.conversation(work.receipt.ticketId)).assignments[0].generation
  await engine.retryMainWork(retryReplay)
  assert.equal((await engine.conversation(work.receipt.ticketId)).assignments[0].generation, retriedGeneration)
  for (const action of [
    () => engine.stopTicket({ commandId: 'direct-stale-stop', ticketId: work.receipt.ticketId,
      reason: 'Reject the raced stop.', expectedGeneration: 'stale-generation' }),
    () => engine.resumeTicket({ commandId: 'direct-stale-resume', ticketId: work.receipt.ticketId,
      expectedGeneration: 'stale-generation' }),
    () => engine.retryTicket({ commandId: 'direct-stale-retry', ticketId: work.receipt.ticketId,
      reason: 'Reject the raced retry.', expectedGeneration: 'stale-generation' }),
  ]) await assert.rejects(action(), { code: 'WORK_VERSION_STALE' })
  await assert.rejects(engine.stopMainWork({ instanceId: 'personal', commandId: 'stale-work-stop',
    workItemId: work.brief.workItemId, ticketId: work.receipt.ticketId, expectedGeneration: 'stale-generation',
    expectedTicketVersion: work.control.ticketVersion,
    reason: 'A stale card must be rejected.' }), { code: 'WORK_VERSION_STALE' })
})

test('a stop without a live Main controller becomes a visible host-confirmed stop after restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-stop-restart-'))
  let started
  let release
  const running = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const native = await nativeContext(join(directory, 'sessions'), async function* () {
    started()
    await held
    yield* textResponse('A completed turn after the stop must stay hidden.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const first = new Engine(storage, 'personal', source, {}, sessions)
  const restarted = new Engine(storage, 'personal', source, {}, sessions)
  t.after(async () => {
    release(); await first.shutdown(); await restarted.shutdown(); await sessions.close()
    await native.fiber.dispose(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })
  await first.openMain({ instanceId: 'personal' })
  const pending = first.sendMainMessage({ instanceId: 'personal', commandId: 'restart-turn', text: 'Wait for a stop.' })
  await running
  const active = (await restarted.getMainConversation({ instanceId: 'personal' })).activeTurn
  assert.equal(active?.status, 'running')
  await storage.transaction('personal', async tx => {
    const state = await tx.get('main-state', 'main')
    const command = await tx.get('main-command', state.activeCommand)
    const stop = { id: `main-turn-stop:${active.messageId}`, version: 1, instanceId: 'personal',
      commandId: 'restart-stop', commandKey: state.activeCommand, messageId: active.messageId,
      status: 'stopping', requestedAt: Date.now() }
    await tx.insert('main-turn-stop', active.messageId, stop)
    await tx.replace('main-command', state.activeCommand, { ...command, status: 'failed' })
    const message = await tx.get('main-message', String(command.userSequence).padStart(16, '0'))
    await tx.replace('main-message', String(command.userSequence).padStart(16, '0'), { ...message, status: 'failed' })
  })
  const reconciled = await restarted.getMainConversation({ instanceId: 'personal' })
  const stopped = await storage.transaction('personal', tx => tx.get('main-turn-stop', active.messageId))
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.confirmation, 'host-restart')
  assert.equal(stopped?.confirmedAt !== undefined, true)
  assert.equal(reconciled.activeTurn, undefined)
  assert.equal(reconciled.messages.find(message => message.id === active.messageId)?.status, 'failed')
  release()
  assert.equal((await pending).status, 'stopped')
  const page = await restarted.getMainConversation({ instanceId: 'personal' })
  assert.equal(page.activeTurn, undefined)
  assert.equal(page.messages.find(message => message.id === active.messageId)?.status, 'failed')
  assert.equal(page.messages.some(message => message.text === 'A completed turn after the stop must stay hidden.'), false)
})

test('accepted work can be stopped before an Assignment without bypassing the assignment-start race', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-pending-stop-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const native = await nativeContext(join(directory, 'sessions'), function* () {
    yield* textResponse('Unexpected model turn.')
    throw new Error('A stopped pre-Assignment card must not start a model turn.')
  })
  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const engine = new Engine(storage, 'personal', source, {}, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const binding = await engine.openMain({ instanceId: 'personal' })
  const alpha = await engine.submit({ commandId: 'seed-alpha', eventId: 'seed-alpha', text: 'Seed alpha work.' })
  const beta = await engine.submit({ commandId: 'seed-beta', eventId: 'seed-beta', text: 'Seed beta work.' })
  await seedAcceptedCard({ storage, binding, ticketId: alpha.ticketId, suffix: 'alpha' })
  await seedAcceptedCard({ storage, binding, ticketId: beta.ticketId, suffix: 'beta' })
  const cards = (await engine.getMainConversation({ instanceId: 'personal' })).works
  assert.equal(cards.length, 2)
  assert.equal(cards.every(card => card.control?.assignment === undefined && card.control?.permissions.canStop), true)
  const alphaCard = cards.find(card => card.receipt.ticketId === alpha.ticketId)
  const betaCard = cards.find(card => card.receipt.ticketId === beta.ticketId)
  assert.equal(alphaCard?.control?.ticketVersion, 1)
  assert.equal(betaCard?.control?.ticketVersion, 1)

  await storage.transaction('personal', tx => tx.insert('assignment', alpha.ticketId, {
    id: randomUUID(), generation: 'raced-generation', ticketId: alpha.ticketId, sessionId: 'raced-session',
    state: 'pending', createdAt: Date.now(), runtimeToken: 'raced-runtime',
  }))
  await assert.rejects(engine.stopMainWork({ instanceId: 'personal', commandId: 'raced-pending-stop',
    workItemId: alphaCard.brief.workItemId, ticketId: alpha.ticketId,
    expectedTicketVersion: alphaCard.control.ticketVersion, reason: 'Reject a pre-Assignment card after start.' }),
  { code: 'WORK_VERSION_STALE' })
  assert.equal((await engine.conversation(alpha.ticketId)).lifecycle, 'open')

  const pendingStop = { instanceId: 'personal', commandId: 'pending-stop-beta', workItemId: betaCard.brief.workItemId,
    ticketId: beta.ticketId, expectedTicketVersion: betaCard.control.ticketVersion, reason: 'Stop before assignment.' }
  await engine.stopMainWork(pendingStop)
  const stopped = await engine.conversation(beta.ticketId)
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.assignments.length, 0)
  assert.equal(stopped.stop?.assignmentId, undefined)
  assert.equal((await engine.getMainConversation({ instanceId: 'personal' })).works
    .find(card => card.receipt.ticketId === beta.ticketId)?.status, 'stopped')

  await storage.transaction('personal', tx => tx.insert('assignment', beta.ticketId, {
    id: randomUUID(), generation: 'late-generation', ticketId: beta.ticketId, sessionId: 'late-session',
    state: 'pending', createdAt: Date.now(), runtimeToken: 'late-runtime',
  }))
  await engine.stopMainWork(pendingStop)
  assert.equal((await engine.conversation(beta.ticketId)).assignments[0]?.state, 'pending')
})

test('a Main work card answers only the exact current Attention and records the fact once', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-answer-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const native = await nativeContext(join(directory, 'sessions'), async function* (options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* textResponse('The bounded work fact was recorded.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Ask the beta question.',
          constraints: 'Use only an authorized beta answer.',
          acceptanceCriteria: 'Read the answer and report evidence.',
        })
        return
      }
      yield* textResponse('The question work was delegated.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (text.includes('Goal:\nAsk the beta question.') && !calls) {
      yield* toolResponse('ask_human', { question: 'Continue beta?', options: 'Yes\nNo' })
      return
    }
    if (text === 'Yes') {
      yield* toolResponse('report_ready', {
        result: 'The authorized answer continued the original work.',
        evidence: 'The Worker used the exact versioned answer in the same Assignment.',
      })
      return
    }
    yield* textResponse('No result was recorded.')
  })
  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const engine = new Engine(storage, 'personal', source, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  const intruder = new Engine(storage, 'personal', { ...source, actorId: 'mallory', allowedActorIds: ['mallory'] }, {}, sessions)
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await intruder.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'answer-card', text: 'Ask before finishing.' })
  for (let count = 0; count < 12; count++) await engine.effects.drain()
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works
    .some(work => work.control?.attention?.status === 'waiting' && work.control.assignment?.state === 'ended'),
  'the released waiting-human Assignment')
  const waiting = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  assert.ok(waiting?.control)
  const control = waiting.control
  assert.equal(control?.permissions.canAnswer, true)
  assert.equal(control?.attention?.question, 'Continue beta?')
  assert.deepEqual(control?.attention?.options, ['Yes', 'No'])
  assert.equal(control?.attention?.freeText, true)
  assert.equal(control?.attention?.version, 1)
  const assignment = control.assignment
  const attention = control.attention
  const board = async () => (await engine.listMainWork({ instanceId: 'personal' })).items
    .find(item => item.ticketId === waiting.receipt.ticketId)
  const boardWaiting = await board()
  assert.equal(boardWaiting.status, waiting.status)
  assert.equal(boardWaiting.question.attention.question, 'Continue beta?')
  assert.equal(boardWaiting.question.assignment.generation, assignment.generation)
  assert.equal(boardWaiting.question.permissions.canAnswer, true)
  const command = { instanceId: 'personal', commandId: 'answer-card-yes', workItemId: waiting.brief.workItemId,
    ticketId: waiting.receipt.ticketId, expectedGeneration: assignment.generation, attentionId: attention.id,
    attentionVersion: attention.version, text: 'Yes' }

  await engine.setProcessingPaused({ commandId: 'pause-answer-continuation', paused: true })
  await assert.rejects(intruder.answerMainAttention(command), error => ['ANSWER_ACTOR_MISMATCH', 'SOURCE_NOT_AUTHORIZED'].includes(error.code))
  await assert.rejects(engine.answerMainAttention({ ...command, commandId: 'stale-version', attentionVersion: 99 }), { code: 'ATTENTION_STALE' })
  await assert.rejects(engine.answerMainAttention({ ...command, commandId: 'stale-generation', expectedGeneration: 'old-generation' }), { code: 'ATTENTION_STALE' })
  const answered = await engine.answerMainAttention(command)
  assert.equal(answered.attention.status, 'answered')
  assert.equal(answered.attention.assignmentId, assignment.id)
  assert.equal(answered.attention.sessionId, assignment.sessionId)
  assert.equal(answered.input.text, 'Yes')
  const routerNotices = async () => (await engine.effects.list()).items
    .filter(effect => effect.stream === 'notice' && effect.payload.type === 'work-attention-answer')
  const notices = await routerNotices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].state, 'pending')
  assert.equal(notices[0].scope, `router:${waiting.receipt.ticketId}`)
  const replay = await engine.answerMainAttention(command)
  assert.equal(replay.input.id, answered.input.id)
  assert.equal((await routerNotices()).length, 1)
  await assert.rejects(engine.answerMainAttention({ ...command, text: 'No' }), { code: 'IDENTITY_CONFLICT' })

  const final = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  assert.equal(final?.control?.attention?.status, 'answered')
  assert.equal(final?.control?.attention?.answerText, 'Yes')
  assert.equal(final?.control?.permissions.canAnswer, false)
  const boardAnswered = await board()
  assert.equal(boardAnswered.status, final.status)
  assert.equal(boardAnswered.question.attention.answerText, 'Yes')
  assert.equal(boardAnswered.question.permissions.canAnswer, false)
  assert.match(final?.update?.summary ?? '', /Authorized answer v1/u)
  await engine.retryMainWork({ instanceId: 'personal', commandId: 'answer-card-rollover', workItemId: waiting.brief.workItemId,
    ticketId: waiting.receipt.ticketId, expectedGeneration: assignment.generation, reason: 'Advance the answered Assignment.' })
  await until(async () => (await engine.conversation(waiting.receipt.ticketId)).assignments[0].generation !== assignment.generation,
    'the answered Assignment rollover')
  const rolledGeneration = (await engine.conversation(waiting.receipt.ticketId)).assignments[0].generation
  const rolledReplay = await engine.answerMainAttention(command)
  assert.equal(rolledReplay.input.id, answered.input.id)
  assert.equal((await routerNotices()).length, 1)
  await engine.stopMainWork({ instanceId: 'personal', commandId: 'stop-answered-card', workItemId: waiting.brief.workItemId,
    ticketId: waiting.receipt.ticketId, expectedGeneration: rolledGeneration, expectedTicketVersion: final.control.ticketVersion,
    reason: 'Stop after the answer.' })
  const stopped = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.control?.permissions.canAnswer, false)
  await assert.rejects(engine.answerMainAttention({ ...command, commandId: 'answer-after-stop', text: 'No' }), { code: 'TICKET_STOPPED' })
  const observations = await engine.getWorkObservations({ instanceId: 'personal', query: 'Ask the beta question' })
  const workerObservation = observations.items.find(item => item.role === 'worker')
  assert.ok(workerObservation)
  const observation = await engine.readWorkObservation({ instanceId: 'personal', observationId: workerObservation.id,
    generation: workerObservation.generation })
  assert.equal(observation.facts.some(fact => fact.label === 'Attention v1' && fact.value.includes('Yes')), true)
})
