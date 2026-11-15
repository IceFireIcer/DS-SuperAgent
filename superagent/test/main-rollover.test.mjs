import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, MainConversation, NativeSessions, WorkDelegation } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

function* maxTokensResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

async function until(check, label) {
  const deadline = Date.now() + 15_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Main rollover did not reach ${label}.`)
    await sleep(100)
  }
}

function delegationFor(storage, readTicket) {
  return new WorkDelegation({
    storage,
    instanceId: 'personal',
    source: { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    sessions: {},
    effects: {},
    environmentId: 'product-workspace',
    createTicket: async () => ({ ticketId: 'unused' }),
    readTicket,
    routerProfile: async () => { throw new Error('unused') },
    recordRouterUse: async () => {},
    notifyMain: async () => {},
    applyFollowUp: async () => { throw new Error('unused') },
    readContext: async () => { throw new Error('unused') },
  })
}

test('Main rolls over with the same identity, durable work refs, stop state and bounded evidence', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-rollover-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const mainSessions = []
  const mainPrompts = []
  const mainEvidence = []
  let workItemId
  const originalRequest = `Delegate this rollover fixture. ${'Keep the original request and constraints. '.repeat(12)}`.trim()
  const native = await nativeContext(join(directory, 'sessions'), function* respond(options) {
    const text = lastUserText(options)
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      mainSessions.push(options.sessionId)
      mainPrompts.push(text)
      if (text === originalRequest && completed === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Preserve the rollover fixture.',
          constraints: 'Do not widen the authorized work.',
          acceptanceCriteria: 'Keep the fixture work identity visible.',
        })
        return
      }
      if (text === originalRequest) {
        yield* textResponse('The fixture work was delegated.')
        return
      }
      if (text === 'Fill the Main context.') {
        yield* maxTokensResponse('The context is full before a final answer.')
        return
      }
      if (text === 'Read original evidence.' && completed === 0) {
        yield* toolResponse('read_work_evidence', { workItemId, kind: 'trigger', maxBytes: 256 }, 'read-main-evidence')
        return
      }
      if (text === 'Read original evidence.' && completed > 0) {
        const tool = options.messages.slice(options.messages.lastIndexOf(options.messages.filter(message => message.role === 'user').at(-1)) + 1)
          .find(message => message.role === 'tool')
        const result = typeof tool.content === 'string' ? tool.content
          : Array.isArray(tool.content) ? tool.content.find(block => block.type === 'text').text : JSON.stringify(tool.content)
        mainEvidence.push(JSON.parse(result))
        yield* textResponse('Current Main generation is ready.')
        return
      }
      yield* textResponse('Current Main generation is ready.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    yield* textResponse('Waiting for the authorized stop.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })

  const firstBinding = await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'delegate-rollover', text: originalRequest })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.some(work => work.receipt.status === 'accepted'),
    'accepted work')
  const before = await engine.getMainConversation({ instanceId: 'personal' })
  const work = before.works[0]
  workItemId = work.brief.workItemId
  await engine.stopTicket({ commandId: 'stop-before-rollover', ticketId: work.receipt.ticketId, reason: 'Preserve this stop across Main rollover.' })

  const rolled = await engine.sendMainMessage({ instanceId: 'personal', commandId: 'fill-context', text: 'Fill the Main context.' })
  assert.equal(rolled.status, 'interrupted')
  const secondBinding = await engine.openMain({ instanceId: 'personal' })
  assert.equal(secondBinding.mainId, firstBinding.mainId)
  assert.notEqual(secondBinding.mainSessionId, firstBinding.mainSessionId)
  assert.equal(secondBinding.generation, firstBinding.generation + 1)

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'after-rollover', text: 'Read original evidence.' })
  const history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(history.mainId, firstBinding.mainId)
  assert.equal(history.mainSessionId, secondBinding.mainSessionId)
  assert.equal(history.generation, secondBinding.generation)
  assert.equal(history.mainRollover.previousSessionId, firstBinding.mainSessionId)
  assert.equal(history.mainRollover.sessionId, secondBinding.mainSessionId)
  assert.equal(history.mainRollover.workIndex.some(item => item.workItemId === work.brief.workItemId
    && item.status === 'stopped' && item.goal === 'Preserve the rollover fixture.'), true)
  assert.equal(history.mainRollover.evidenceRefs.some(ref => ref.kind === 'trigger' && ref.ticketId === work.receipt.ticketId), true)
  assert.equal(history.messages.some(message => message.role === 'system' && /context rolled over/iu.test(message.text)), true)
  assert.equal(history.messages.some(message => message.status === 'interrupted' && message.text === 'Fill the Main context.'), true)
  assert.equal(history.messages.some(message => message.role === 'main' && message.text === 'Current Main generation is ready.'), true)
  assert.ok(mainEvidence[0]?.pagination, JSON.stringify(mainEvidence[0]))
  assert.equal(mainEvidence[0].pagination.truncated, true)
  assert.match(mainEvidence[0].text, /Delegate this rollover fixture/u)
  assert.equal(new Set(mainSessions).size, 2)
  assert.match(mainPrompts.at(-1), /Read original evidence/u)
  assert.ok((await engine.getSessionHistory(firstBinding.mainSessionId)).events.length > 0)
  assert.ok((await engine.getSessionHistory(secondBinding.mainSessionId)).events.length > 0)

  const first = await engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'trigger' }, maxBytes: 256 })
  assert.equal(first.pagination.truncated, true)
  assert.ok(first.pagination.cursor)
  const second = await engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'trigger' }, after: first.pagination.cursor, maxBytes: 256 })
  assert.match(first.text + second.text, /Keep the original request and constraints/u)
  const ticketPage = await engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'ticket' }, maxBytes: 256 })
  assert.ok(ticketPage.pagination.cursor)
  await storage.transaction('personal', async transaction => {
    const intent = await transaction.get('intent', work.receipt.ticketId)
    await transaction.replace('intent', work.receipt.ticketId, { ...intent, reason: 'worker-background' })
    const report = {
      id: 'bounded-report', ticketId: work.receipt.ticketId, assignmentId: 'assignment-bounded', sessionId: 'worker-bounded',
      kind: 'ready', result: 'Bounded report.', evidence: 'Bounded facts.', directionVersion: 1, createdAt: Date.now(),
      artifacts: Array.from({ length: 20 }, (_, index) => ({ path: `artifact-${index}.txt`, bytes: index, sha256: 'a'.repeat(64) })),
      toolFacts: Array.from({ length: 80 }, (_, index) => ({ tool: 'read_file', outcome: `long tool fact ${index} ${'x'.repeat(80)}` })),
    }
    if (!await transaction.replace('report', work.receipt.ticketId, report)) await transaction.insert('report', work.receipt.ticketId, report)
  })
  await assert.rejects(engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'ticket' }, after: ticketPage.pagination.cursor, maxBytes: 256 }), { code: 'CONTEXT_CURSOR_STALE' })
  const report = await engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'report' }, maxBytes: 256 })
  assert.equal(report.factsTruncated, true)
  assert.ok(report.factsBytes <= 4096)
  assert.ok(Buffer.byteLength(JSON.stringify(report.facts)) <= 4096)
  await assert.rejects(engine.readMainEvidence({ instanceId: 'personal', workItemId: work.brief.workItemId,
    ref: { kind: 'trigger', ticketId: 'forged-ticket' }, maxBytes: 256 }), { code: 'INVALID_INPUT' })
})

test('an old Main Session callback cannot publish into the current generation', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-stale-generation-'))
  let started
  let release
  const running = new Promise(resolve => { started = resolve })
  const finish = new Promise(resolve => { release = resolve })
  const native = await nativeContext(join(directory, 'sessions'), function respond() {
    return { async *[Symbol.asyncIterator]() {
      started()
      await finish
      for (const event of textResponse('Stale generation reply.')) yield event
    } }
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }, {}, sessions)
  t.after(async () => {
    release(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const binding = await engine.openMain({ instanceId: 'personal' })
  const send = engine.sendMainMessage({ instanceId: 'personal', commandId: 'stale-run', text: 'This turn belongs to the old generation.' })
  await running
  await storage.transaction('personal', async transaction => {
    const state = await transaction.get('main-state', 'main')
    await transaction.replace('main-state', 'main', {
      ...state,
      mainSessionId: 'main-session-current',
      generation: binding.generation + 1,
    })
  })
  release()
  await assert.rejects(send, { code: 'MAIN_TURN_STALE' })
  const history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(history.generation, binding.generation + 1)
  assert.equal(history.mainSessionId, 'main-session-current')
  assert.equal(history.messages.some(message => message.text === 'Stale generation reply.'), false)
  assert.equal(history.messages[0].status, 'failed')
  assert.equal(history.health.state, 'degraded')
})

test('Main rollover carries an input that was queued during the context-full turn', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-rollover-queue-'))
  let started
  let release
  const running = new Promise(resolve => { started = resolve })
  const finish = new Promise(resolve => { release = resolve })
  const native = await nativeContext(join(directory, 'sessions'), function respond(options) {
    const text = lastUserText(options)
    if (text === 'Fill the Main context.') {
      return { async *[Symbol.asyncIterator]() {
        started()
        await finish
        for (const event of maxTokensResponse('Context full.')) yield event
      } }
    }
    return textResponse('Queued input continued in the new generation.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }, {}, sessions)
  t.after(async () => {
    release(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const old = await engine.openMain({ instanceId: 'personal' })
  const roll = engine.sendMainMessage({ instanceId: 'personal', commandId: 'rollover-queue', text: 'Fill the Main context.' })
  await running
  const queued = engine.sendMainMessage({ instanceId: 'personal', commandId: 'queued-during-rollover',
    text: 'Keep this queued input after rollover.' })
  release()
  assert.equal((await roll).status, 'interrupted')
  await queued
  const history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(history.mainRollover.unreadInputs.some(input => input.text === 'Keep this queued input after rollover.'), true)
  assert.equal(history.messages.some(message => message.text === 'Queued input continued in the new generation.'), true)
  assert.equal(history.mainId, old.mainId)
  assert.notEqual(history.mainSessionId, old.mainSessionId)
})

test('rollover reports when more than twenty queued inputs are retained outside the handoff excerpt', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-rollover-queue-limit-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  let started
  let release
  const running = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const sessions = {
    mainRoute: { provider: 'mock', model: 'main' },
    async run(request) {
      started()
      await gate
      await request.onForkPrepared?.('main-session-queue-limit')
      return { sessionId: request.sessionId, status: 'idle', stepCount: 1, forkedSessionId: 'main-session-queue-limit', events: [] }
    },
    async hasMessage() { return { found: false } },
    async readSession() { return { sessionId: '', events: [] } },
    async close() {},
  }
  const main = new MainConversation(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }, sessions)
  t.after(async () => { release(); await main.close(); await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const first = main.send({ instanceId: 'personal', commandId: 'queue-limit-first', text: 'Fill context.' })
  await running
  const queued = Array.from({ length: 21 }, (_, index) => main.send({ instanceId: 'personal', commandId: `queue-limit-${index}`,
    text: `Queued input ${index}.` }))
  for (const request of queued) request.catch(() => {})
  release()
  assert.equal((await first).status, 'interrupted')
  await main.close()
  const rollover = await storage.transaction('personal', async tx => (await tx.scan('main-session-rollover', { limit: 1 })).items[0].value)
  assert.equal(rollover.unreadInputCount, 21)
  assert.equal(rollover.unreadInputs.length, 20)
  assert.equal(rollover.unreadInputsTruncated, true)
})

test('work-update Main turns use the same durable generation rollover', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-update-rollover-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  let runs = 0
  const sessions = {
    mainRoute: { provider: 'mock', model: 'main' },
    async run(request) {
      runs++
      if (runs === 1) return {
        sessionId: request.sessionId, status: 'idle', stepCount: 1, forkedSessionId: 'main-session-update-child',
        events: [{ type: 'user/message', data: { id: request.messageId } }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }],
      }
      return {
        sessionId: request.sessionId, status: 'idle', stepCount: 1,
        events: [
          { type: 'user/message', data: { id: request.messageId } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Verified update.' }] } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
      }
    },
    async hasMessage() { return { found: false } },
    async readSession() { return { sessionId: '', events: [] } },
    async close() {},
  }
  const main = new MainConversation(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }, sessions)
  t.after(async () => { await main.close(); await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const first = await main.open({ instanceId: 'personal' })
  const notification = {
    mainId: first.mainId,
    receipt: { version: 1, workBriefId: 'brief-update', status: 'accepted', ticketId: 'ticket-update', nextStep: 'Continue.', createdAt: Date.now() },
    update: { version: 1, id: 'update-rollover', workBriefId: 'brief-update', ticketId: 'ticket-update', status: 'success',
      owner: 'router', summary: 'Verified.', needsDecision: false, createdAt: Date.now() },
  }
  await assert.rejects(main.notify(notification, new AbortController().signal, async () => true), { code: 'MAIN_UPDATE_INTERRUPTED' })
  let updateCommand = await storage.transaction('personal', tx => tx.get('main-update-command', notification.update.id))
  assert.equal(updateCommand.state, 'interrupted')
  await main.notify(notification, new AbortController().signal, async () => true)
  const history = await main.page({ instanceId: 'personal' })
  assert.equal(runs, 2)
  assert.equal(history.generation, first.generation + 1)
  assert.equal(history.mainSessionId, 'main-session-update-child')
  assert.equal(history.messages.some(message => message.text === 'Verified update.'), true)
  updateCommand = await storage.transaction('personal', tx => tx.get('main-update-command', notification.update.id))
  assert.equal(updateCommand.state, 'completed')
  assert.equal(updateCommand.attempt, 1)
})

test('shutdown leaves an active Main turn recoverable after Engine reopen', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-shutdown-reopen-'))
  let started
  let release = () => {}
  const running = new Promise(resolve => { started = resolve })
  let calls = 0
  const native = await nativeContext(join(directory, 'sessions'), function respond(options) {
    calls++
    if (calls === 1) {
      return { [Symbol.asyncIterator]() {
        return { next: async () => {
          started()
          await new Promise((resolve, reject) => {
            const abort = () => { release(); reject(new Error('Host shutdown aborted the Main stream.')) }
            if (options.signal?.aborted) abort()
            else options.signal?.addEventListener('abort', abort, { once: true })
          })
          return { done: true, value: undefined }
        } }
      } }
    }
    return textResponse('Recovered after Host reopen.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const source = { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }
  let first = new Engine(storage, 'personal', source, {}, sessions)
  let reopened
  t.after(async () => {
    release(); await first.shutdown(); await reopened?.shutdown(); await sessions.close(); await native.fiber.dispose()
    await storage.close(); await rm(directory, { recursive: true, force: true })
  })
  const sent = first.sendMainMessage({ instanceId: 'personal', commandId: 'shutdown-main', text: 'Survive Host shutdown.' })
  await running
  const closing = first.shutdown()
  await assert.rejects(sent, error => ['HOST_SHUTDOWN', 'RUNTIME_CLOSED'].includes(error.code))
  await closing
  reopened = new Engine(storage, 'personal', source, {}, sessions)
  const resumed = await reopened.resumeMainInputs({ instanceId: 'personal' })
  assert.equal(resumed.resumed, 1)
  const history = await reopened.getMainConversation({ instanceId: 'personal' })
  assert.equal(history.messages.some(message => message.text === 'Recovered after Host reopen.'), true)
  assert.equal(history.health.queuedInputs, 0)
  assert.equal(history.messages[0].status, 'completed')
})

test('handoff includes more than twenty works and the latest follow-up cannot hide authoritative constraints', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-handoff-scan-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const mainId = 'main-handoff'
  const createdAt = Date.now()
  await storage.transaction('personal', async tx => {
    for (let index = 0; index < 21; index++) {
      const briefId = `brief-${index}`
      const ticketId = `ticket-${index}`
      await tx.insert('work-brief', briefId, {
        id: briefId, version: 1, instanceId: 'personal', mainId, mainSessionId: 'main-session', routerSessionId: 'router-session',
        mainMessageId: `message-${index}`, originalUserText: `Request ${index}`,
        authorization: { kind: 'authorized-main-actor', sourceInstanceId: 'product-desktop', actorId: 'alice' },
        goal: `Goal ${index}`, constraints: `Constraint ${index}`, acceptanceCriteria: `Acceptance ${index}`,
        evidence: { kind: 'main-message', id: `message-${index}` }, environmentId: 'product-workspace', configurationRevision: 1,
        createdAt: createdAt + index,
      })
      await tx.insert('work-receipt', briefId, {
        version: 1, workBriefId: briefId, status: 'accepted', ticketId, nextStep: 'Continue.', createdAt: createdAt + index,
      })
    }
  })
  const delegation = delegationFor(storage, async ticketId => ({
    ticketId, status: 'running', reason: 'worker-running', lifecycle: 'open',
  }))
  const handoff = await delegation.handoff(mainId)
  assert.equal(handoff.workIndex.length, 21)
  assert.equal(new Set(handoff.workIndex.map(item => item.workItemId)).size, 21)

  const itemId = 'item-authoritative'
  const briefId = 'brief-authoritative'
  const ticketId = 'ticket-authoritative'
  const followUpId = 'follow-up-ready'
  await storage.transaction('personal', async tx => {
    await tx.insert('work-brief', briefId, {
      id: briefId, version: 1, instanceId: 'personal', mainId, mainSessionId: 'main-session', routerSessionId: 'router-session',
      mainMessageId: 'message-authoritative', originalUserText: 'Authoritative work',
      authorization: { kind: 'authorized-main-actor', sourceInstanceId: 'product-desktop', actorId: 'alice' },
      goal: 'Authoritative goal', constraints: 'Authoritative constraint', acceptanceCriteria: 'Authoritative acceptance',
      evidence: { kind: 'main-message', id: 'message-authoritative' }, environmentId: 'product-workspace', configurationRevision: 1, createdAt,
    })
    await tx.insert('work-item', itemId, {
      id: itemId, version: 1, workBriefId: briefId, sourceEventId: 'source-authoritative', position: 0,
      goal: 'Authoritative goal', constraints: 'Authoritative constraint', acceptanceCriteria: 'Authoritative acceptance', createdAt,
    })
    await tx.insert('work-receipt', itemId, {
      version: 1, workBriefId: briefId, workItemId: itemId, status: 'accepted', ticketId, nextStep: 'Continue.', createdAt,
    })
    await tx.insert('work-input', 'input-ready', {
      id: 'input-ready', delivery: { completedAt: createdAt + 1, outcome: 'ready' },
    })
    await tx.insert('work-follow-up', `${JSON.stringify(['work-follow-up', itemId])}:${createHash('sha256').update(followUpId).digest('hex')}`, {
      id: followUpId, version: 1, instanceId: 'personal', commandId: 'follow-up-command',
      authorization: { kind: 'authorized-main-actor', sourceInstanceId: 'product-desktop', actorId: 'alice' },
      mainId, mainSessionId: 'main-session', originalUserText: 'Authoritative work', workBriefId: briefId, workItemId: itemId,
      originalSourceEventId: 'source-authoritative', ticketId, text: 'Follow up', reason: 'Test', source: { kind: 'main-message', id: 'message-authoritative' },
      routing: 'direct-to-original', directionVersion: 2, attachment: 'attached', inputId: 'input-ready', createdAt: createdAt + 1,
    })
  })
  let snapshot = { ticketId, status: 'stopped', reason: 'stopped', lifecycle: 'open' }
  const guarded = delegationFor(storage, async () => snapshot)
  assert.equal((await guarded.query(mainId, { workItemId: itemId })).status, 'stopped')
  snapshot = { ticketId, status: 'waiting-human', reason: 'waiting-human', lifecycle: 'open' }
  assert.equal((await guarded.query(mainId, { workItemId: itemId })).status, 'waiting')
  snapshot = { ticketId, status: 'running', reason: 'recovery-blocked', lifecycle: 'open' }
  assert.equal((await guarded.query(mainId, { workItemId: itemId })).status, 'unknown')
})
