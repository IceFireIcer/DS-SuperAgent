import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function fixture(t, channel, effects = {}, versioned = false, sourceInstanceId = 'desktop') {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-delivery-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const engine = new core.Engine(storage, 'private', {
    sourceInstanceId, actorId: 'user', allowedActorIds: ['user'],
    ...(versioned ? { allowedThreadIds: ['room'], versionOrder: 'sequence' } : {}),
  }, effects, undefined, [], {}, {}, {}, { channel })
  return { engine, storage, directory }
}

test('a product work result cannot be reconstructed from its Worker report when the Delivery is missing', async t => {
  const sent = []
  const { engine, storage } = await fixture(t, {
    deliver: async delivery => { sent.push(delivery); return { type: 'success' } },
  })
  const accepted = await engine.submit({ commandId: 'product-result', eventId: 'product-input', text: 'Do the work.' })
  const effect = await storage.transaction('private', async tx => {
    await tx.insert('work-ticket', accepted.ticketId, { workBriefId: 'brief', workItemId: 'item', ticketId: accepted.ticketId })
    await tx.insert('report', accepted.ticketId, { id: 'ready-report', ticketId: accepted.ticketId,
      assignmentId: 'assignment', directionVersion: 1, result: 'Worker-only text' })
    return engine.effects.enqueue(tx, { key: 'missing-delivery', stream: 'outbox', scope: accepted.ticketId,
      payload: { purpose: 'result', ticketId: accepted.ticketId } })
  })
  await engine.effects.drain()
  assert.equal(sent.some(delivery => delivery.purpose === 'result'), false)
  assert.equal((await engine.effects.receipt(effect.id, effect.generation)).delivery, 'dropped')
})

test('a direct product Ticket cannot reconstruct a Worker result without Main ownership', async t => {
  const sent = []
  const { engine, storage } = await fixture(t, {
    deliver: async delivery => { sent.push(delivery); return { type: 'success' } },
  }, {}, false, 'product-desktop')
  const accepted = await engine.submit({ commandId: 'direct-product', eventId: 'direct-input', text: 'Do the work.' })
  const effect = await storage.transaction('private', async tx => {
    await tx.insert('report', accepted.ticketId, { id: 'direct-report', ticketId: accepted.ticketId,
      assignmentId: 'direct-assignment', directionVersion: 1, result: 'Worker-only text' })
    return engine.effects.enqueue(tx, { key: 'direct-result', stream: 'outbox', scope: accepted.ticketId,
      payload: { purpose: 'result', ticketId: accepted.ticketId } })
  })
  await engine.effects.drain()
  assert.equal(sent.some(delivery => delivery.purpose === 'result'), false)
  assert.equal((await engine.effects.receipt(effect.id, effect.generation)).delivery, 'dropped')
})

test('acknowledgement is queryable before delivery and retries reuse one channel message', async t => {
  const calls = []
  const { engine } = await fixture(t, {
    deliver: async (delivery, context) => {
      calls.push({ purpose: delivery.purpose, text: delivery.text, key: context.idempotencyKey })
      return { type: 'success' }
    },
  })
  const command = { commandId: 'request', eventId: 'message', text: 'Inspect the project.' }
  const receipt = await engine.submit(command)
  const pending = await engine.getTicketDeliveries(receipt.ticketId)
  assert.deepEqual(pending.map(delivery => [delivery.purpose, delivery.state]), [['acknowledgement', 'pending']])
  await engine.effects.drain()
  await engine.effects.drain()
  const delivered = await engine.getTicketDeliveries(receipt.ticketId)
  assert.deepEqual(delivered.map(delivery => [delivery.purpose, delivery.state, delivery.attempts]), [['acknowledgement', 'sent', 1]])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].purpose, 'acknowledgement')
  assert.equal(calls[0].text, 'Request accepted.')

  await engine.submit({ ...command, commandId: 'transport-retry' })
  await engine.effects.drain()
  assert.equal(calls.length, 1)
  assert.equal((await engine.getTicketDeliveries(receipt.ticketId)).length, 1)
})

test('a temporarily unavailable destination waits with its reason and a permanent failure drops the delivery', async t => {
  let now = 100
  let attempts = 0
  const transient = await fixture(t, {
    deliver: async () => {
      attempts++
      return attempts === 1 ? { type: 'transient', reason: 'SOURCE_TEMPORARILY_CLOSED' } : { type: 'success' }
    },
  }, { now: () => now, retryDelayMs: 1 })
  const transientReceipt = await transient.engine.submit({ commandId: 'transient', eventId: 'transient-message', text: 'Try the source.' })
  await transient.engine.effects.drain()
  let waiting = (await transient.engine.getTicketDeliveries(transientReceipt.ticketId))[0]
  assert.equal(waiting.state, 'pending')
  assert.equal(waiting.reason, 'SOURCE_TEMPORARILY_CLOSED')
  now += 10
  await transient.engine.effects.drain()
  const delivered = (await transient.engine.getTicketDeliveries(transientReceipt.ticketId))[0]
  assert.equal(delivered.state, 'sent')
  assert.equal(delivered.attempts, 2)

  const permanent = await fixture(t, { deliver: async () => ({ type: 'permanent', reason: 'DESTINATION_UNREACHABLE' }) })
  const permanentReceipt = await permanent.engine.submit({ commandId: 'permanent', eventId: 'permanent-message', text: 'Send once.' })
  await permanent.engine.effects.drain()
  const dropped = (await permanent.engine.getTicketDeliveries(permanentReceipt.ticketId))[0]
  assert.equal(dropped.state, 'dropped')
  assert.equal(dropped.reason, 'DESTINATION_UNREACHABLE')
})

test('an exhausted transient delivery stays pending instead of being dropped', async t => {
  let now = 100
  const { engine } = await fixture(t, { deliver: async () => ({ type: 'transient', reason: 'SOURCE_TEMPORARILY_CLOSED' }) },
    { now: () => now, retryDelayMs: 1, maxAttempts: 2 })
  const receipt = await engine.submit({ commandId: 'exhausted-transient', eventId: 'exhausted-message', text: 'Keep waiting for the source.' })
  await engine.effects.drain()
  now += 10
  await engine.effects.drain()
  const [delivery] = await engine.getTicketDeliveries(receipt.ticketId)
  assert.equal(delivery.state, 'pending')
  assert.equal(delivery.reason, 'SOURCE_TEMPORARILY_CLOSED')
  assert.equal(delivery.attempts, 2)
})

test('delivery history keeps reading past the second page instead of stopping at the first cursor', async t => {
  const { engine, storage } = await fixture(t, { deliver: async () => ({ type: 'success' }) })
  const receipt = await engine.submit({ commandId: 'long-history', eventId: 'long-history-message', text: 'Keep the history.' })
  const prefix = JSON.stringify(['delivery-history', receipt.ticketId])
  await storage.transaction('private', async transaction => {
    for (let index = 0; index < 205; index++) {
      const id = `history-${index}`
      const record = { id, instanceId: 'private', ticketId: receipt.ticketId, purpose: 'result', text: `History ${index}.`,
        destination: { sourceInstanceId: 'desktop', actorId: 'user', eventId: `event-${index}` },
        basis: { kind: 'policy-update', revision: index }, effectId: `effect-${index}`, effectGeneration: 'generation-1',
        sequence: 1000 + index, createdAt: index }
      await transaction.insert('delivery-history', `${prefix}:${createHash('sha256').update(id).digest('hex')}:${String(record.sequence).padStart(16, '0')}`, record)
    }
  })
  const deliveries = await engine.getTicketDeliveries(receipt.ticketId)
  assert.equal(deliveries.length, 206)
  assert.equal(deliveries.at(-1).sequence, 1204)
})

test('an unknown platform outcome is visible and reconciles under the original delivery idempotency key', async t => {
  const sentKeys = []
  const reconcileKeys = []
  let reconcileAttempt = 0
  const { engine } = await fixture(t, {
    deliver: async (_delivery, context) => {
      sentKeys.push(context.idempotencyKey)
      return { type: 'unknown', reason: 'PLATFORM_ACCEPTED_RESPONSE_LOST' }
    },
    reconcile: async (_delivery, context) => {
      reconcileKeys.push(context.idempotencyKey)
      reconcileAttempt++
      return reconcileAttempt === 1 ? { type: 'transient', reason: 'RECONCILE_TEMPORARILY_UNAVAILABLE' } : { type: 'success' }
    },
  }, { maxAttempts: 2 })
  const receipt = await engine.submit({ commandId: 'unknown-request', eventId: 'unknown-message', text: 'Deliver once.' })
  await engine.effects.drain()
  const [unknown] = await engine.getTicketDeliveries(receipt.ticketId)
  assert.deepEqual({ state: unknown.state, reconcileRequired: unknown.reconcileRequired, attempts: unknown.attempts },
    { state: 'unknown', reconcileRequired: true, attempts: 1 })
  assert.equal(unknown.reason, 'PLATFORM_ACCEPTED_RESPONSE_LOST')

  const command = { commandId: 'reconcile-unknown', ticketId: receipt.ticketId, deliveryId: unknown.id }
  const retryable = await engine.reconcileDelivery(command)
  assert.deepEqual([retryable.state, retryable.reconcileRequired, retryable.reason],
    ['unknown', true, 'RECONCILE_TEMPORARILY_UNAVAILABLE'])
  const reconciled = await engine.reconcileDelivery(command)
  assert.deepEqual({ state: reconciled.state, reconcileRequired: reconciled.reconcileRequired, attempts: reconciled.attempts },
    { state: 'sent', reconcileRequired: false, attempts: 3 })
  assert.equal(reconcileKeys.every(key => key === sentKeys[0]), true)
  assert.equal(sentKeys.length, 1)
  assert.deepEqual(await engine.reconcileDelivery(command), reconciled)
  assert.equal(sentKeys.length, 1)
  assert.equal(reconcileKeys.length, 2)
})

test('reconciliation uses immutable delivery identity after the live answer basis changes', async t => {
  const sentKeys = []
  const reconcileKeys = []
  const { engine } = await fixture(t, {
    deliver: async (delivery, context) => {
      if (delivery.purpose !== 'answer') return { type: 'success' }
      sentKeys.push(context.idempotencyKey)
      return { type: 'unknown', reason: 'ANSWER_RESPONSE_LOST' }
    },
    reconcile: async (_delivery, context) => {
      reconcileKeys.push(context.idempotencyKey)
      return { type: 'success' }
    },
  }, {}, true)
  const question = await engine.receiveSource({ commandId: 'reconcile-question', threadId: 'room', objectId: 'question-reconcile',
    type: 'created', version: '1', text: 'What changed?', authorId: 'alice', authorKind: 'human', addressing: 'direct' })
  const receipt = await engine.acceptSource({ commandId: 'accept-reconcile', threadId: 'room', objectId: 'question-reconcile', expectedEventId: question.eventId })
  await engine.queueAnswer({ commandId: 'answer-reconcile', ticketId: receipt.ticketId, questionEventId: question.eventId,
    text: 'The original answer.', fact: 'The answer was verified before the question changed.' })
  await engine.effects.drain()
  const answer = (await engine.getTicketDeliveries(receipt.ticketId)).find(delivery => delivery.purpose === 'answer')
  assert.equal(answer.state, 'unknown')
  await engine.receiveSource({ commandId: 'delete-reconcile-question', threadId: 'room', objectId: 'question-reconcile',
    type: 'deleted', version: '2', deletionEvidence: 'The question was deleted after the uncertain answer send.' })
  const reconciled = await engine.reconcileDelivery({ commandId: 'reconcile-answer-after-delete', ticketId: receipt.ticketId, deliveryId: answer.id })
  assert.equal(reconciled.state, 'sent')
  assert.deepEqual(reconcileKeys, sentKeys)
})

test('a not-applied reconciliation remains retryable with the same stable command', async t => {
  let delivered = 0
  const reconcileKeys = []
  const { engine } = await fixture(t, {
    deliver: async () => {
      delivered++
      return delivered === 1 ? { type: 'unknown', reason: 'FIRST_RESPONSE_LOST' } : { type: 'success' }
    },
    reconcile: async (_delivery, context) => {
      reconcileKeys.push(context.idempotencyKey)
      return { type: 'not-applied', reason: 'PLATFORM_CONFIRMED_NOT_APPLIED' }
    },
  })
  const receipt = await engine.submit({ commandId: 'not-applied-request', eventId: 'not-applied-message', text: 'Retry safely.' })
  await engine.effects.drain()
  const unknown = (await engine.getTicketDeliveries(receipt.ticketId))[0]
  assert.equal(unknown.state, 'unknown')
  const command = { commandId: 'not-applied-reconcile', ticketId: receipt.ticketId, deliveryId: unknown.id }
  const pending = await engine.reconcileDelivery(command)
  assert.equal(pending.state, 'pending')
  const sent = await engine.reconcileDelivery(command)
  assert.equal(sent.state, 'sent')
  assert.equal(delivered, 2)
  assert.equal(reconcileKeys.length, 1)
})

test('an answer requires a current human question and returns to that exact message', async t => {
  const calls = []
  const { engine } = await fixture(t, {
    deliver: async delivery => { calls.push(delivery); return { type: 'success' } },
  }, {}, true)
  const question = await engine.receiveSource({ commandId: 'question', threadId: 'room', objectId: 'question-1', type: 'created',
    version: '1', text: 'What is the current status?', authorId: 'alice', authorKind: 'human', addressing: 'direct' })
  const receipt = await engine.acceptSource({ commandId: 'accept-question', threadId: 'room', objectId: 'question-1', expectedEventId: question.eventId })
  const queued = await engine.queueAnswer({ commandId: 'answer', ticketId: receipt.ticketId, questionEventId: question.eventId,
    text: 'The work is ready for review.', fact: 'The ready report names the verified artifact.' })
  assert.equal(queued.state, 'pending')
  await engine.effects.drain()
  const answer = (await engine.getTicketDeliveries(receipt.ticketId)).find(delivery => delivery.purpose === 'answer')
  assert.equal(answer.state, 'sent')
  assert.deepEqual(answer.destination, { sourceInstanceId: 'desktop', actorId: 'alice', eventId: 'question-1', threadId: 'room' })
  assert.deepEqual(calls.map(delivery => delivery.purpose), ['acknowledgement', 'answer'])

  await assert.rejects(engine.queueAnswer({ commandId: 'missing-question', ticketId: receipt.ticketId, questionEventId: 'missing',
    text: 'No answer.', fact: 'No fact.' }), { code: 'NOT_FOUND' })
  await engine.receiveSource({ commandId: 'delete-question', threadId: 'room', objectId: 'question-1', type: 'deleted',
    version: '2', deletionEvidence: 'Removed in the source.' })
  await assert.rejects(engine.queueAnswer({ commandId: 'stale-question', ticketId: receipt.ticketId, questionEventId: question.eventId,
    text: 'Too late.', fact: 'The question was deleted.' }), { code: 'SOURCE_NOT_CURRENT' })
})

test('a native result is delivered after its acknowledgement with a current-report receipt', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-delivery-runtime-'))
  let native, storage, sessions, engine
  t.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  const calls = []
  native = await nativeContext(directory, async function* (options) {
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const completed = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
    if (options.model === 'worker') {
      if (!completed) yield* toolResponse('report_ready', { result: 'The answer is 4.', evidence: 'Computed 2 + 2 = 4.' })
      else yield* textResponse('Recorded.')
      return
    }
    const tool = options.tools[completed]
    if (!tool) { yield* textResponse('Router complete.'); return }
    if (tool.name.startsWith('deliver_result')) {
      const ready = JSON.parse(text.slice('Ready report:'.length))
      yield* toolResponse(tool.name, { reportId: ready.id }, `router-${completed}`)
    } else yield* toolResponse(tool.name, {}, `router-${completed}`)
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {},
    sessions, [], {}, {}, {}, { channel: { deliver: async delivery => { calls.push(delivery); return { type: 'success' } } } })
  const receipt = await engine.submit({ commandId: 'runtime', eventId: 'runtime-message', text: 'What is 2 + 2?' })
  for (let index = 0; index < 6; index++) await engine.effects.drain()
  assert.deepEqual(calls.map(delivery => delivery.purpose), ['acknowledgement', 'result'])
  const deliveries = await engine.getTicketDeliveries(receipt.ticketId)
  assert.deepEqual(deliveries.map(delivery => [delivery.purpose, delivery.state]), [['acknowledgement', 'sent'], ['result', 'sent']])
  const result = deliveries.find(delivery => delivery.purpose === 'result')
  assert.equal(result.reportId, (await engine.conversation(receipt.ticketId)).reports[0].id)
  assert.equal(result.text, 'The answer is 4.')
})
