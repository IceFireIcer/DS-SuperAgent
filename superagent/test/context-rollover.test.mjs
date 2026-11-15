import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse, toolResponse } from '../dev/native-mock.mjs'

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`)
    await sleep(20)
  }
}

function* maxTokensResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

test('a context-full Worker forks a new Session, hands off its constraints and completes the request', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-context-rollover-'))
  let native, storage, sessions, engine
  t.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  const workerSessions = []
  const workerPrompts = []
  native = await nativeContext(directory, async function* (options) {
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const completed = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
    if (options.model === 'worker') {
      workerSessions.push(options.sessionId)
      workerPrompts.push(text)
      if (!completed && text === 'Complete this long-running task.') { yield* maxTokensResponse('I have filled the context.'); return }
      if (!completed && text.startsWith('Continue in a new Session after a context handoff.')) {
        yield* toolResponse('report_ready', { result: 'Completed after handoff.', evidence: 'Used the original request and handoff constraints in the new Session.' })
        return
      }
      yield* textResponse('Recorded.')
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
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions)
  const receipt = await engine.submit({ commandId: 'rollover', eventId: 'rollover-message', text: 'Complete this long-running task.' })
  for (let index = 0; index < 30; index++) {
    await engine.effects.drain()
    if ((await engine.conversation(receipt.ticketId)).status === 'ready') break
  }
  const conversation = await engine.conversation(receipt.ticketId)
  assert.equal(conversation.status, 'ready', JSON.stringify({ conversation, workerPrompts, effects: await engine.effects.list() }))
  assert.equal(conversation.reports[0].result, 'Completed after handoff.')
  assert.equal(conversation.assignmentHistory.length, 2)
  assert.notEqual(conversation.assignmentHistory[0].sessionId, conversation.assignmentHistory[1].sessionId)
  assert.equal(conversation.handoff.previousSessionId, conversation.assignmentHistory[0].sessionId)
  assert.equal(conversation.handoff.sessionId, conversation.assignmentHistory[1].sessionId)
  assert.equal(conversation.handoff.forked, true)
  assert.equal(conversation.handoff.goal, 'Complete this long-running task.')
  assert.equal(conversation.handoff.reason, 'CONTEXT_WINDOW')
  assert.equal(new Set(workerSessions).size, 2, JSON.stringify({ workerSessions, workerPrompts }))
  assert.notEqual(workerSessions[0], workerSessions[1])
  assert.match(workerPrompts[1], /Continue in a new Session after a context handoff/u)
  assert.match(workerPrompts[1], /Complete this long-running task/u)

  const oldHistory = await engine.getSessionHistory(conversation.handoff.previousSessionId)
  assert.ok(oldHistory.events.some(event => event.type === 'user/message'))
  const newHistory = await engine.getSessionHistory(conversation.handoff.sessionId)
  assert.ok(newHistory.events.length > 0, 'the forked Session retains an inherited prefix')
})

test('a context rollover cancels the previous generation background work', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-context-rollover-job-'))
  const root = join(directory, 'work')
  await mkdir(root)
  await writeFile(join(root, 'existing.txt'), 'verified\n')
  let native, storage, sessions, engine, environment
  t.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close(); await environment?.close()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), async function* (options) {
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const completed = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
    if (options.model === 'worker') {
      if (text.startsWith('Continue in a new Session after a context handoff.')) {
        if (!completed) {
          yield* toolResponse('read_file', { path: 'existing.txt' })
          return
        }
        yield* toolResponse('report_ready', { result: 'Completed after handoff.', evidence: 'Read existing.txt after the handoff.',
          artifacts: 'existing.txt' })
        return
      }
      if (!completed) {
        yield* toolResponse('start_command', { name: 'build' })
        return
      }
      yield* maxTokensResponse('I have filled the context.')
      return
    }
    const tool = options.tools[completed]
    if (!tool) { yield* textResponse('Router complete.'); return }
    if (tool.name.startsWith('deliver_result')) {
      const ready = JSON.parse(text.slice('Ready report:'.length))
      yield* toolResponse(tool.name, { reportId: ready.id }, `router-${completed}`)
    } else yield* toolResponse(tool.name, {}, `router-${completed}`)
  })
  environment = await core.LocalEnvironment.open({ id: 'project', instanceId: 'private', root, allowedActorIds: ['user'],
    permissions: ['read', 'write', 'search', 'command'],
    commands: { build: { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5000, backgroundTimeoutMs: 120000 } } })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] },
    { retryDelayMs: 10, scanIntervalMs: 20 }, sessions, [environment])
  engine.effects.start()
  const receipt = await engine.submit({ commandId: 'rollover-job', eventId: 'rollover-job-message',
    text: 'Start a long build then hand off.', environmentId: 'project' })
  await until(async () => {
    const current = await engine.conversation(receipt.ticketId)
    return current.assignmentHistory.length === 2 && current.jobs[0]?.state === 'cancelled'
  }, 'the rollover to cancel the previous generation job')
  const conversation = await engine.conversation(receipt.ticketId)
  assert.equal(conversation.assignmentHistory.length, 2)
  assert.equal(conversation.jobs.length, 1)
  assert.equal(conversation.jobs[0].state, 'cancelled')
  assert.equal(conversation.jobs[0].cancelReason, 'assignment-ended')
  assert.equal(conversation.jobs[0].assignmentId, conversation.assignmentHistory[0].id)
  assert.equal(conversation.handoff.reason, 'CONTEXT_WINDOW')
})
