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
    await sleep(20)
  }
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
