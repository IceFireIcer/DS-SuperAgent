import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteProductClient } from '../../app/src/remote-product-client.mjs'
import { PostgresStorage } from '../dist/postgres-storage.js'
import { StorageSessionPersistence } from '../dist/session-persistence.js'
import { startPostgres } from './fixtures/postgres-harness.mjs'

const fixture = fileURLToPath(new URL('./fixtures/hosted-product-postgres.mjs', import.meta.url))
const postgres = await startPostgres('ds-superagent-hosted-product-')
const children = new Set()
const opened = []
const instanceId = 'hosted-product'
const hostId = 'hosted-product-host'
const leaseMs = 30_000
const goal = 'Recover this work after a Host replacement.'
const answerText = 'Continue after replacement.'

after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.allSettled(opened.map(storage => storage.close()))
  await postgres.close()
})

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The test did not receive a loopback port.')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function until(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  throw new Error(`The hosted product did not reach ${label}.`)
}

function startHost({ postgres: pg, home, workspace, port, enroll = false, replacement = false }) {
  const child = fork(fixture, [
    ...(enroll ? ['--enroll'] : []),
    ...(replacement ? ['--replacement'] : []),
  ], {
    execArgv: [],
    env: {
      ...process.env,
      DSH_HOME: home,
      DS_SUPERAGENT_WORKSPACE: workspace,
      DS_SUPERAGENT_POSTGRES: JSON.stringify(pg),
      DS_SUPERAGENT_HOST_ID: hostId,
      DS_SUPERAGENT_LEASE_MS: String(leaseMs),
      DS_SUPERAGENT_CLIENT_PORT: String(port),
      DS_SUPERAGENT_CLIENT_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  children.add(child)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The hosted product did not become ready: ${stderr}`)), 60_000)
    child.once('message', message => {
      clearTimeout(timer)
      if (message?.type === 'ready') resolve(message)
      else reject(new Error(`The hosted product failed: ${message?.message ?? 'unknown error'}${stderr ? `\n${stderr}` : ''}`))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`The hosted product exited before it was ready (${code}): ${stderr}`))
    })
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    children.delete(child)
    resolve({ code, signal })
  }))
  return { child, ready, exited, stderr: () => stderr }
}

async function readSession(persistence, sessionId) {
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    const value = await handle.read()
    return value.events
  } finally {
    await handle.close()
  }
}

async function openWaitingProduct({ pg, home, workspace, port, persistence }) {
  const holder = startHost({ postgres: pg, home, workspace, port, enroll: true })
  const first = await holder.ready
  const client = new RemoteProductClient()
  const initial = await client.connect({ address: first.address, instanceId, credential: first.credential })
  assert.equal(initial.binding.mainId, first.mainId)
  await client.call('send', { instanceId, commandId: 'hosted-product-work', text: goal })
  const waiting = await until(async () => {
    const history = await client.call('history', { instanceId, limit: 100 })
    const work = history.works?.find(item => item.brief.goal === goal)
    return work?.status === 'waiting' && work.control?.attention ? { history, work } : undefined
  }, 'the waiting Worker question')
  const observations = await client.call('observe-list', { instanceId, limit: 100 })
  const workerObservation = observations.items.find(item => item.role === 'worker')
  const routerObservation = observations.items.find(item => item.role === 'router'
    && item.workBriefId === workerObservation?.workBriefId)
  assert.ok(routerObservation)
  assert.ok(workerObservation)
  const [routerDetail, workerDetail] = await Promise.all([
    client.call('observe-read', { instanceId, observationId: routerObservation.id,
      generation: routerObservation.generation, limit: 100 }),
    client.call('observe-read', { instanceId, observationId: workerObservation.id,
      generation: workerObservation.generation, limit: 100 }),
  ])
  assert.equal(typeof routerDetail.sessionId, 'string')
  assert.equal(routerDetail.sessionId, first.routerSessionId)
  assert.equal(workerDetail.sessionId, waiting.work.control.assignment.sessionId)
  const sessionIds = [first.mainSessionId, routerDetail.sessionId, workerDetail.sessionId]
  assert.equal(new Set(sessionIds).size, 3)
  const sessionsBefore = await Promise.all(sessionIds.map(id => readSession(persistence, id)))
  assert.deepEqual(sessionsBefore.map(events => events.length > 0), [true, true, true])
  return { holder, first, client, waiting, workerDetail, sessionIds, sessionsBefore }
}

async function replaceAndReconnect({ holder, client, first, waiting, sessionIds, sessionsBefore,
  persistence, storage, pg, home, workspace, port }) {
  client.disconnect()
  holder.child.kill('SIGKILL')
  await holder.exited
  const relays = await ticketRelayEffects(storage, waiting.work.receipt.ticketId)
  assert.equal(relays.length, 1)
  const [originalRelay] = relays
  assert.equal(originalRelay.state, 'running')
  assert.equal(originalRelay.followup, false)
  assert.equal(originalRelay.attempts, 1)
  await sleep(leaseMs + 1_000)
  const replacement = startHost({ postgres: pg, home, workspace, port, replacement: true })
  const second = await replacement.ready
  assert.equal(second.mainId, first.mainId)
  const reconnected = await client.connect({ address: second.address, instanceId, credential: first.credential })
  assert.equal(reconnected.binding.mainId, first.mainId)
  assert.equal(reconnected.history.messages.some(message => message.role === 'user' && message.text === goal), true)
  const recovered = reconnected.history.works?.find(work =>
    work.brief.workItemId === waiting.work.brief.workItemId)
  assert.ok(recovered)
  assert.equal(recovered.receipt.ticketId, waiting.work.receipt.ticketId)
  assert.equal(recovered.status, 'waiting')
  assert.equal(recovered.control.assignment.id, waiting.work.control.assignment.id)
  assert.equal(recovered.control.assignment.generation, waiting.work.control.assignment.generation)
  assert.equal(recovered.control.attention.id, waiting.work.control.attention.id)
  const sessionsAfter = await Promise.all(sessionIds.map(id => readSession(persistence, id)))
  assert.deepEqual(sessionsAfter.map((events, index) => events.length >= sessionsBefore[index].length), [true, true, true])
  const takeover = await storage.transaction(instanceId, transaction =>
    transaction.get('host-takeover', JSON.stringify(['host-takeover', instanceId, 2])))
  assert.equal(takeover?.state, 'completed')
  assert.equal(takeover?.epoch, 2)
  assert.equal(takeover?.previousHostId, hostId)
  assert.equal(takeover?.tickets.some(ticket =>
    ticket.ticketId === waiting.work.receipt.ticketId && ticket.outcome === 'waiting-human'), true)
  return { replacement, recovered, originalRelay }
}

async function ticketRelayEffects(storage, ticketId) {
  return storage.transaction(instanceId, async transaction => {
    const page = await transaction.scan('effect', { limit: 100 })
    assert.equal(page.cursor, undefined, 'the fixture should retain only one page of pending effects')
    return page.items.map(item => item.value).filter(effect => effect.stream === 'relay' && effect.scope === ticketId)
      .map(({ id, generation, state, attempts, leaseUntil, reason, payload }) => ({ id, generation, state, attempts, leaseUntil, reason,
        followup: typeof payload.inputId === 'string' }))
  })
}

async function completeRecoveredWork({ client, recovered, workerDetail, originalRelay, persistence, storage }) {
  const writer = await persistence.open(SessionId(workerDetail.sessionId), 'write')
  await writer.close()
  const ticketId = recovered.receipt.ticketId
  const remainingRelayLeaseMs = originalRelay.leaseUntil - Date.now()
  assert.ok(remainingRelayLeaseMs > 0 && remainingRelayLeaseMs <= 61_000, 'the answer must arrive before the interrupted relay lease expires')
  await client.call('work-answer', {
    instanceId,
    commandId: 'answer-after-host-replacement',
    workItemId: recovered.brief.workItemId,
    ticketId: recovered.receipt.ticketId,
    expectedGeneration: recovered.control.assignment.generation,
    attentionId: recovered.control.attention.id,
    attentionVersion: recovered.control.attention.version,
    text: answerText,
  })
  let lastWork
  const completed = await until(async () => {
    const history = await client.call('history', { instanceId, limit: 100 })
    lastWork = history.works?.find(item => item.brief.workItemId === recovered.brief.workItemId)
    return lastWork?.outcome?.status === 'success' ? { history, work: lastWork } : undefined
  }, 'the recovered Worker result', remainingRelayLeaseMs + 15_000).catch(async error => {
    const observation = await client.call('observe-read', { instanceId, observationId: workerDetail.id,
      generation: recovered.control.assignment.generation, limit: 100 }).catch(failure => ({ error: failure.message }))
    const timeline = observation.events?.filter(event => ['tool-call', 'tool-result', 'turn'].includes(event.kind))
    const relayEffects = await ticketRelayEffects(storage, ticketId).catch(failure => ({ error: failure.message }))
    throw new Error(`${error.message}: ${JSON.stringify({ relayEffects, work: lastWork, timeline, observationError: observation.error })}`, { cause: error })
  })
  assert.equal(completed.work.outcome.summary, 'The Worker resumed after Host replacement.')
  assert.equal(completed.work.outcome.artifacts[0].path, 'recovered.txt')
  assert.equal(completed.work.control.assignment.sessionId, workerDetail.sessionId)
  assert.notEqual(completed.work.control.assignment.generation, recovered.control.assignment.generation)
  const receipt = await storage.transaction(instanceId, transaction =>
    transaction.get('effect-receipt', JSON.stringify([originalRelay.id, originalRelay.generation])))
  assert.equal(receipt?.state, 'done')
  assert.equal(receipt?.attempts, 2)
  const events = await readSession(persistence, workerDetail.sessionId)
  const answers = events.filter(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === answerText))
  assert.equal(answers.length, 1)
  assert.ok(answers[0].time >= originalRelay.leaseUntil)
  await until(async () => {
    const history = await client.call('history', { instanceId, limit: 100 })
    return history.messages.some(message =>
      message.role === 'main' && message.text.includes('recovered Work result is available'))
  }, 'the same Main result after recovery', 15_000)
}

test('a hosted product replacement restores the same PostgreSQL-backed Main, Router and waiting Worker Session', {
  timeout: 180_000,
}, async t => {
  const database = await postgres.createDatabase()
  const pg = { ...postgres.configuration, database }
  const root = await mkdtemp(join(tmpdir(), 'r5-hosted-product-process-'))
  const home = join(root, 'home')
  const workspace = join(root, 'work')
  const port = await freePort()
  const storage = await PostgresStorage.open(pg)
  opened.push(storage)
  const persistence = new StorageSessionPersistence(new Context(), storage)
  let holder
  let replacement
  t.after(async () => {
    for (const child of [holder, replacement]) {
      if (child && child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL')
    }
    await persistence.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  const openedProduct = await openWaitingProduct({ pg, home, workspace, port, persistence })
  holder = openedProduct.holder
  const recovered = await replaceAndReconnect({
    ...openedProduct, persistence, storage, pg, home, workspace, port,
  })
  replacement = recovered.replacement
  await completeRecoveredWork({
    client: openedProduct.client,
    recovered: recovered.recovered,
    workerDetail: openedProduct.workerDetail,
    originalRelay: recovered.originalRelay,
    persistence,
    storage,
  })
})
