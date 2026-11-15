import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

const source = { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }
const routes = { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
  worker: { provider: 'mock', model: 'worker' } }

function responseFor({ afterDelegation, failMain }) {
  return function* respond(options) {
    const text = lastUserText(options)
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (text === 'Delegate durable work.' && completed === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Create continuity-proof.txt.',
          constraints: 'Write only the fixture file.',
          acceptanceCriteria: 'Read the fixture file back before reporting.',
        })
        return
      }
      if (text === 'Delegate durable work.' && completed > 0) {
        afterDelegation()
        if (failMain) throw new Error('Simulated Main route outage after delegation.')
      }
      yield* textResponse(text === 'Queue the next request.' ? 'The queued request was handled.' : 'Main recovered.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (completed === 0) {
      yield* toolResponse('write_file', { path: 'continuity-proof.txt', text: 'durable\n' }, 'write-proof')
      return
    }
    if (completed === 1) {
      yield* toolResponse('read_file', { path: 'continuity-proof.txt' }, 'read-proof')
      return
    }
    yield* toolResponse('report_ready', {
      result: 'Created continuity-proof.txt.',
      evidence: 'Read continuity-proof.txt back after writing it.',
      artifacts: 'continuity-proof.txt',
    }, 'report-proof')
  }
}

async function fixture(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-continuity-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const engine = new Engine(storage, 'personal', source, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })
  return { directory, engine }
}

test('a failed Main turn does not block durable queued input or work', { timeout: 30_000 }, async t => {
  let delegated
  const afterDelegation = new Promise(resolve => { delegated = resolve })
  const { engine } = await fixture(t, responseFor({ afterDelegation: delegated, failMain: true }))
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()

  const first = engine.sendMainMessage({ instanceId: 'personal', commandId: 'first', text: 'Delegate durable work.' })
  await afterDelegation
  const second = engine.sendMainMessage({ instanceId: 'personal', commandId: 'second', text: 'Queue the next request.' })
  await assert.rejects(first, { code: 'MAIN_TURN_FAILED' })
  await second
  await engine.effects.stop()

  const history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.text),
    ['Delegate durable work.', 'Queue the next request.'])
  assert.equal(history.messages.filter(message => message.text === 'The queued request was handled.').length, 1)
  assert.equal(history.health.state, 'ready')
  assert.equal(history.health.failedInputs, 1)
  assert.equal(history.health.queuedInputs, 0)
  assert.equal(history.works.length, 1)
  assert.equal(['pending', 'accepted', 'running', 'success', 'waiting', 'blocked', 'unknown', 'stopped']
    .includes(history.works[0].status), true, JSON.stringify(history.works[0]))
  assert.equal(history.works[0].receipt.status, 'accepted')
  assert.equal((await engine.listTickets()).items.length, 1)
})

test('pending Main input resumes after restart without creating the work twice', { timeout: 30_000 }, async t => {
  const { engine } = await fixture(t, responseFor({ afterDelegation: () => {}, failMain: false }))
  const binding = await engine.openMain({ instanceId: 'personal' })
  const commandId = 'queued-before-schedule'
  const text = 'Queue the next request.'
  const commandKey = createHash('sha256').update(JSON.stringify([source.sourceInstanceId, source.actorId, commandId])).digest('hex')
  const fingerprint = createHash('sha256').update(JSON.stringify(['personal', text])).digest('hex')
  await engine.storage.transaction('personal', async transaction => {
    const state = await transaction.get('main-state', 'main')
    const sequence = state.sequence + 1
    const messageId = 'main-input-recovered'
    await transaction.insert('main-message', String(sequence).padStart(16, '0'), {
      id: messageId, sequence, role: 'user', text, createdAt: Date.now(), status: 'queued',
    })
    await transaction.insert('main-command', commandKey, {
      fingerprint, messageId, userSequence: sequence, status: 'queued', updatedAt: Date.now(),
    })
    await transaction.insert('main-active-command', JSON.stringify(['main-active-command', String(sequence).padStart(16, '0'), commandKey]), {
      key: commandKey, userSequence: sequence, status: 'queued',
    })
    await transaction.insert('main-health', 'main', { queuedInputs: 1, failedInputs: 0, lastStatus: 'queued', updatedAt: Date.now() })
    await transaction.replace('main-state', 'main', { ...state, sequence })
  })
  engine.effects.start()
  await engine.resumeMainInputs({ instanceId: 'personal' })
  const history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.deepEqual(history.messages.map(message => message.text), [text, 'The queued request was handled.'])
  assert.equal(history.messages[0].id, 'main-input-recovered')
  assert.equal(history.health.state, 'ready')
  assert.equal(history.health.queuedInputs, 0)
  assert.equal(history.generation, 0)
  assert.equal(history.mainId, binding.mainId)
})

test('more than one thousand completed Main commands do not burden an empty active queue', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-command-history-'))
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Unused.'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, routes)
  const engine = new Engine(storage, 'personal', source, {}, sessions)
  t.after(async () => {
    await engine.shutdown(); await sessions.close(); await native.fiber.dispose(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const binding = await engine.openMain({ instanceId: 'personal' })
  await storage.transaction('personal', async transaction => {
    const state = await transaction.get('main-state', 'main')
    for (let index = 1; index <= 1001; index++) {
      await transaction.insert('main-command', `history-${index}`, {
        fingerprint: `fingerprint-${index}`, messageId: `message-${index}`, userSequence: index,
        status: 'completed', updatedAt: Date.now() - 1001 + index,
      })
    }
    await transaction.replace('main-state', 'main', { ...state, sequence: 1001 })
  })
  const history = await engine.getMainConversation({ instanceId: 'personal', limit: 10 })
  assert.equal(history.health.queuedInputs, 0)
  assert.equal(history.health.failedInputs, 0)
  assert.equal(history.generation, binding.generation)
  assert.deepEqual(await engine.resumeMainInputs({ instanceId: 'personal' }), { resumed: 0 })
})
