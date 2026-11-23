import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createProductHost, Engine, NativeSessions } from '../dist/index.js'
import { exposeMainSession } from '../dist/session-reader.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

const instanceId = 'personal'
const actorId = 'alice'
const routes = { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }

test('legacy Main upgrades at boot once and retains its transcript and model context', async context => {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, 'superagent-legacy-main-'))
  const native = await nativeContext(join(root, 'sessions'), function* (request) {
    const users = request.messages.filter(message => message.role === 'user')
    yield* textResponse(users.length === 1 ? 'Earlier reply' : 'Continued with prior context')
  })
  let host
  context.after(async () => {
    await host?.close()
    await native.fiber.dispose()
    assert.equal(dirname(await realpath(root)), temp)
    await rm(root, { recursive: true, force: true })
  })
  const databasePath = join(root, 'state.sqlite')
  const storage = await SqliteStorage.open(databasePath)
  const sessions = new NativeSessions(native, routes)
  const engine = new Engine(storage, instanceId, { sourceInstanceId: 'product-desktop', actorId, allowedActorIds: [actorId] }, {}, sessions)
  let original
  try {
    original = await engine.openMain({ instanceId })
    await engine.sendMainMessage({ instanceId, commandId: 'before-upgrade', text: 'Earlier message' })
  } finally {
    await engine.shutdown()
    await sessions.close()
    await storage.close()
  }
  const id = SessionId(original.mainSessionId)
  const before = await native.sessionPersistence.stat(id)
  assert.equal(before.header.cwd, undefined)
  const readSession = async sessionId => {
    const handle = await native.sessionPersistence.open(SessionId(sessionId), 'read')
    try { return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events } }
    finally { await handle.close() }
  }
  const originalLog = await readSession(id)
  const config = { databasePath, instanceId, actorId, ...routes }
  const writer = await native.sessionPersistence.open(id, 'write')
  try {
    const busy = await createProductHost(native, config)
    try {
      assert.equal((await busy.dispatch('open')).mainSessionMode, 'product-history')
      assert.deepEqual((await busy.dispatch('history', { instanceId })).messages.map(message => message.text),
        ['Earlier message', 'Earlier reply'])
    } finally { await busy.close() }
    assert.deepEqual((await native.sessionPersistence.list()).map(snapshot => snapshot.header.id), [id])
  } finally { await writer.close() }

  const migration = new NativeSessions(native, { ...routes, mainCwd: root })
  let preparedId
  try {
    await assert.rejects(migration.upgradeLegacyMainSession(id, async childId => {
      preparedId = childId
      throw new Error('Simulated failure before publishing the rollover')
    }), /Simulated failure before publishing/u)
  } finally { await migration.close() }

  const orphanWriter = await native.sessionPersistence.open(SessionId(preparedId), 'write')
  const retry = new NativeSessions(native, { ...routes, mainCwd: root })
  try {
    await assert.rejects(retry.upgradeLegacyMainSession(id, async () => {}), { code: 'MAIN_SESSION_UPGRADE_BUSY' })
  } finally {
    await retry.close()
    await orphanWriter.close()
  }

  host = await createProductHost(native, config)
  const upgraded = await host.dispatch('open')
  assert.notEqual(upgraded.mainSessionId, id)
  assert.deepEqual(upgraded, { ...original, mainSessionId: preparedId, generation: original.generation + 1, mainSessionMode: 'native' })
  const child = await readSession(upgraded.mainSessionId)
  assert.equal(child.header.cwd, root)
  assert.equal(child.header.parentSession, id)
  assert.equal(child.inheritedEventCount, originalLog.events.length)
  assert.deepEqual(child.events.slice(0, child.inheritedEventCount), originalLog.events)
  const history = await host.dispatch('history', { instanceId })
  assert.equal(history.mainSessionMode, 'native')
  assert.equal(history.mainRollover.previousSessionId, id)
  assert.equal(history.mainRollover.sessionId, upgraded.mainSessionId)
  const transcript = page => page.messages.filter(message => message.role !== 'system')
  assert.deepEqual(transcript(history).map(message => message.text), ['Earlier message', 'Earlier reply'])
  assert.equal(child.events.find(event => event.type === 'user/message').data.id, transcript(history)[0].id)

  await host.close()
  host = await createProductHost(native, config)
  assert.deepEqual(await host.dispatch('open'), upgraded)

  await host.dispatch('send', { instanceId, commandId: 'after-upgrade', text: 'Continue this conversation' })
  const updated = await host.dispatch('history', { instanceId })
  assert.equal(updated.mainSessionId, upgraded.mainSessionId)
  assert.equal(updated.generation, upgraded.generation)
  assert.deepEqual(transcript(updated).map(message => message.text), [
    'Earlier message', 'Earlier reply', 'Continue this conversation', 'Continued with prior context',
  ])
  assert.equal(updated.messages.filter(message => message.id === history.mainRollover.id).length, 1)
  assert.deepEqual(await readSession(id), originalLog)
  assert.equal((await native.sessionPersistence.stat(id)).revision, before.revision)
})

test('the reader uses a boot-provisioned Session and refuses legacy or unrelated Session reads', async context => {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, 'superagent-main-reader-'))
  const native = await nativeContext(join(root, 'sessions'), () => assert.fail('Session reads must not call the model'))
  let host
  context.after(async () => {
    await host?.close()
    await native.fiber.dispose()
    assert.equal(dirname(await realpath(root)), temp)
    await rm(root, { recursive: true, force: true })
  })
  host = await createProductHost(native, { databasePath: join(root, 'state.sqlite'), instanceId, actorId, ...routes })
  const [initial] = await native.sessionPersistence.list()
  const binding = await host.dispatch('open')
  assert.equal(binding.mainSessionMode, 'native')
  const { mainSessionId } = binding
  assert.equal(initial.header.id, mainSessionId)
  assert.equal(initial.header.cwd, root)

  const requests = []
  const controller = {
    async list() { return { items: [{ sessionId: 'unrelated' }, { sessionId: mainSessionId }] } },
    async events(request) { requests.push(request); return { events: [] } },
    async *follow(request) { requests.push(request); yield { type: 'snapshot', records: [], assistantStream: { revision: 0 } } },
    async *control() {
      yield { type: 'baseline', value: { projections: { [mainSessionId]: 'main', unrelated: 'unrelated' } } }
      yield { type: 'projection', sessionId: 'unrelated' }
      yield { type: 'projection', sessionId: mainSessionId }
    },
  }
  let current = binding
  let reads = 0
  native.provide('superagentSessionReader', controller)
  await exposeMainSession(native, { dispatch: async () => { reads += 1; return current } })
  const readerFor = principal => native.extend({ invocation: { peer: { principal } } }).get('sessionController')
  const reader = readerFor({ kind: 'owner' })
  const remoteReader = readerFor({ kind: 'remote' })
  const signal = new AbortController().signal
  const address = { kind: 'session', sessionId: mainSessionId }
  const denied = { code: 'SOURCE_NOT_AUTHORIZED' }
  await assert.rejects(remoteReader.list({}, signal), denied)
  await assert.rejects(remoteReader.events({ address }, signal), denied)
  await assert.rejects(remoteReader.follow({ address }, signal).next(), denied)
  await assert.rejects(remoteReader.control(signal).next(), denied)
  assert.equal(reads, 0)
  assert.deepEqual(await reader.list({}, signal), { items: [{ sessionId: mainSessionId }] })
  await reader.events({ address }, signal)
  const follow = { address, assistantStream: true, maxMessages: 24, turnWindow: { minMessages: 8, minTurns: 2 } }
  assert.deepEqual(await Array.fromAsync(reader.follow({ ...follow, activate: true }, signal)), [
    { type: 'snapshot', records: [], assistantStream: { revision: 0 } },
  ])
  assert.deepEqual(requests, [{ address }, follow])
  assert.deepEqual(await Array.fromAsync(reader.control(signal)), [
    { type: 'baseline', value: { projections: { [mainSessionId]: 'main' } } },
    { type: 'projection', sessionId: mainSessionId },
  ])
  assert.equal((await native.sessionPersistence.stat(SessionId(mainSessionId))).revision, initial.revision)

  current = { ...binding, mainSessionMode: 'product-history' }
  await assert.rejects(reader.events({ address }, signal), { code: 'MAIN_SESSION_REQUIRES_PRODUCT_HISTORY' })
  await assert.rejects(reader.follow({ address }, signal).next(), { code: 'MAIN_SESSION_REQUIRES_PRODUCT_HISTORY' })
  await assert.rejects(reader.events({ address: { ...address, sessionId: 'unrelated' } }, signal), { code: 'SOURCE_NOT_AUTHORIZED' })
  assert.deepEqual(await reader.list({}, signal), { items: [] })
  assert.deepEqual(await Array.fromAsync(reader.control(signal)), [{ type: 'baseline', value: { projections: {} } }])
  assert.equal(requests.length, 2)
  assert.equal(await native.sessionPersistence.stat(SessionId('unrelated')), undefined)
})
