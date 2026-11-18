import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, toolResponse, textResponse } from '../dev/native-mock.mjs'

test('an authorized request binds one directory and returns a verified file plus actual native tool facts', { timeout: 15000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-local-execution-'))
  const root = join(directory, 'work')
  await mkdir(root)
  let environment, native, sessions, storage, engine
  context.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close(); await environment?.close()
    await rm(directory, { recursive: true, force: true })
  })
  environment = await core.LocalEnvironment.open({ id: 'project', instanceId: 'private', root, allowedActorIds: ['user'], permissions: ['read', 'write', 'search', 'command'], commands: { verify: { argv: [process.execPath, '-e', "console.log(require('node:fs').readFileSync('answer.txt','utf8'))"], timeoutMs: 2000 } } })
  const calls = []
  native = await nativeContext(join(directory, 'sessions'), options => {
    calls.push(options)
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const results = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool')
    if (options.model === 'worker') {
      const steps = [
        ['write_file', { path: 'answer.txt', text: 'hello\n' }], ['read_file', { path: 'answer.txt' }],
        ['glob', { pattern: '*.txt' }], ['grep', { pattern: 'hello' }], ['run_command', { name: 'verify' }],
        ['report_ready', { result: 'Created and verified answer.txt.', evidence: 'Read, searched and checked answer.txt with the configured verification command.', artifacts: 'answer.txt' }],
        ['write_file', { path: 'answer.txt', text: 'changed after ready' }],
      ]
      const next = steps[results.length]
      return next ? toolResponse(next[0], next[1], `call-${results.length}`) : textResponse('Ready.')
    }
    if (results.length) return textResponse('Recorded.')
    return text.startsWith('Ready report:') ? toolResponse('deliver_result', { reportId: JSON.parse(text.slice('Ready report:'.length)).id }) : toolResponse('assign_worker', {})
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions, [environment])
  const command = { commandId: 'local', eventId: 'message', text: 'Create answer.txt containing hello, verify it, and show the artifact.', environmentId: 'project' }
  const receipt = await engine.submit(command)
  for (let index = 0; index < 5; index++) await engine.effects.drain()
  const result = await engine.conversation(receipt.ticketId)
  assert.equal(result.status, 'ready')
  assert.equal(result.assignments[0].environment.id, 'project')
  assert.equal(result.assignments[0].environment.kind, 'local')
  assert.equal(result.reports[0].artifacts[0].path, 'answer.txt')
  assert.equal(result.reports[0].artifacts[0].bytes, 6)
  assert.equal(result.reports[0].artifacts[0].sha256, '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')
  assert.equal(result.reports[0].artifacts[0].reference.kind, 'artifact')
  assert.equal(result.reports[0].artifacts[0].reference.environmentId, 'project')
  assert.match(result.reports[0].artifacts[0].reference.environmentFingerprint, /^local:/u)
  assert.equal(result.reports[0].artifacts[0].reference.sha256, result.reports[0].artifacts[0].sha256)
  assert.deepEqual(result.reports[0].toolFacts.map(fact => fact.tool), ['write_file', 'read_file', 'glob', 'grep', 'run_command'])
  assert.equal(result.reports[0].toolFacts.at(-1).output.exitCode, 0)
  assert.equal(result.messages.some(message => message.purpose === 'result'), false)
  assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), 'hello\n')
  const worker = calls.find(call => call.model === 'worker')
  assert.ok(worker.messages.some(message => message.role === 'user' && message.content.some(block => block.text === command.text)))
  await assert.rejects(engine.submit({ ...command, commandId: 'other-environment', eventId: 'other-message', environmentId: 'other' }), { code: 'ENVIRONMENT_DENIED' })
})

test('failed setup remains visible without a Worker and only an explicit retry rechecks the original binding', { timeout: 15000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-setup-retry-'))
  const root = join(directory, 'work')
  await mkdir(root)
  let environment, native, sessions, storage, engine
  context.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close(); await environment?.close()
    await rm(directory, { recursive: true, force: true })
  })
  environment = await core.LocalEnvironment.open({ id: 'project', instanceId: 'private', root, allowedActorIds: ['user'], permissions: ['read', 'write', 'search', 'command'], setup: 'prepare', commands: {
    prepare: { argv: [process.execPath, '-e', "const fs=require('node:fs');fs.appendFileSync('attempts.txt','checked\\n'); if(!fs.existsSync('allow.txt')) {console.error('setup needs allow.txt');process.exit(7)}"], timeoutMs: 2000 },
  } })
  let workers = 0
  native = await nativeContext(join(directory, 'sessions'), options => {
    if (options.model === 'worker') { workers++; return textResponse('No result yet.') }
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    return options.messages.slice(options.messages.lastIndexOf(user) + 1).some(message => message.role === 'tool') ? textResponse('Assigned.') : toolResponse('assign_worker', {})
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions, [environment])
  const receipt = await engine.submit({ commandId: 'setup-request', eventId: 'message', text: 'Work in the configured project.', environmentId: 'project' })
  for (let index = 0; index < 5; index++) await engine.effects.drain()
  let conversation = await engine.conversation(receipt.ticketId)
  assert.equal(workers, 0)
  assert.equal(conversation.reason, 'setup-failed')
  assert.equal(conversation.setup.state, 'failed')
  assert.equal(conversation.setup.output.exitCode, 7)
  assert.match(conversation.setup.output.stderr, /setup needs allow.txt/u)
  assert.equal(await readFile(join(root, 'attempts.txt'), 'utf8'), 'checked\n')
  const original = conversation.assignments[0]
  await writeFile(join(root, 'allow.txt'), 'allowed')
  await engine.retrySetup({ commandId: 'retry-setup', ticketId: receipt.ticketId })
  await engine.retrySetup({ commandId: 'retry-setup', ticketId: receipt.ticketId })
  for (let index = 0; index < 5; index++) await engine.effects.drain()
  conversation = await engine.conversation(receipt.ticketId)
  assert.equal(workers, 1)
  assert.equal(conversation.setup.state, 'ready')
  assert.equal(conversation.assignments[0].id, original.id)
  assert.deepEqual(conversation.assignments[0].environment, original.environment)
  assert.equal(await readFile(join(root, 'attempts.txt'), 'utf8'), 'checked\nchecked\n')
})

test('the owning Bot supplies the hidden Worker model and instructions', { timeout: 15000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-local-worker-profile-'))
  let native, sessions, storage, engine
  context.after(async () => {
    await engine?.effects.stop(); await sessions?.close(); await native?.fiber.dispose(); await storage?.close()
    await rm(directory, { recursive: true, force: true })
  })
  const workerCalls = []
  native = await nativeContext(join(directory, 'sessions'), options => {
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const results = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool')
    if (options.model === 'worker-bot') {
      workerCalls.push({ model: options.model, sessionId: options.sessionId, request: JSON.stringify(options) })
      if (results.length) return textResponse('Recorded.')
      return toolResponse('report_ready', { result: 'Bot worker result.', evidence: 'The Bot worker used its configured model and instructions.' })
    }
    if (options.model !== 'router') return textResponse('Unexpected model.')
    if (results.length) return textResponse('Recorded.')
    return text.startsWith('Ready report:')
      ? toolResponse('deliver_result', { reportId: JSON.parse(text.slice('Ready report:'.length)).id })
      : toolResponse('assign_worker', {})
  })
  native.provide('botExecutionProfiles', {
    resolve: async sessionId => sessionId === 'ui-session'
      ? { model: { provider: 'mock', model: 'worker-bot' }, instructions: 'Bot worker instruction marker.', skills: [] }
      : undefined,
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'],
    allowedThreadIds: ['ui-session'], versionOrder: 'sequence' }, {}, sessions)
  const received = await engine.receiveSource({ commandId: 'profile-receive', threadId: 'ui-session', objectId: 'profile-message',
    type: 'created', version: '1', text: 'Use the Bot settings.' })
  const ticketId = (await engine.acceptSource({ commandId: 'profile-accept', threadId: 'ui-session', objectId: 'profile-message',
    expectedEventId: received.eventId })).ticketId
  for (let index = 0; index < 6; index++) await engine.effects.drain()
  const conversation = await engine.conversation(ticketId)
  assert.equal(conversation.status, 'ready')
  assert.equal(workerCalls[0].model, 'worker-bot')
  assert.match(workerCalls[0].request, /Bot worker instruction marker/u)
  const uses = await engine.getRoleConfigUses(workerCalls[0].sessionId)
  assert.equal(uses.some(use => use.role === 'worker' && use.worker.model === 'worker-bot'), true, JSON.stringify(uses))
})
