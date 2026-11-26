import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse, toolResponse } from '../dev/native-mock.mjs'

test('a Host without a project starts Main and leaves Router and Worker idle', { timeout: 30_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'ds-superagent-main-only-'))
  const stateRoot = join(base, 'state')
  const project = join(base, 'project')
  await Promise.all([mkdir(stateRoot), mkdir(project)])
  const calls = []
  const native = await nativeContext(join(base, 'sessions'), function* (request) {
    calls.push(request.model)
    const userIndex = request.messages.findLastIndex(message => message.role === 'user')
    const user = request.messages[userIndex]
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const result = request.messages.slice(userIndex + 1).find(message => message.role === 'tool')
    if (!text.includes('delegate without a project')) {
      yield* textResponse('Hello from Main.')
      return
    }
    if (result) {
      yield* textResponse('Choose a project before delegated work.')
      return
    }
    yield* toolResponse('delegate_work', {
      goal: 'Change a project file.', constraints: 'Use the selected project only.', acceptanceCriteria: 'The file is changed.',
    })
  })
  let host
  t.after(async () => {
    await host?.close()
    await native.fiber.dispose()
    await rm(base, { recursive: true, force: true })
  })

  host = await createProductHost(native, {
    databasePath: join(stateRoot, 'state.sqlite'), instanceId: 'personal', actorId: 'owner',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' },
  })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'personal', ...payload })
  const initial = await call('directory-options')
  assert.equal(initial.default, null)
  assert.deepEqual(initial.directories, [])
  assert.deepEqual(calls, [], 'opening the Host starts no role turn')

  await call('send', { commandId: 'delegate-without-project', text: 'Try to delegate without a project.' })
  assert.deepEqual(calls, ['main', 'main'], 'the rejected delegation stays in Main')
  assert.equal((await call('history')).works?.length ?? 0, 0, 'no Ticket or Worker starts without a project')

  await call('send', { commandId: 'main-only', text: 'Hello Main.' })
  assert.deepEqual(calls, ['main', 'main', 'main'], 'ordinary conversation calls Main only')
  const history = await call('history')
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.text),
    ['Try to delegate without a project.', 'Hello Main.'])
  assert.equal(history.messages.filter(message => message.role === 'main').length, 2)
  assert.deepEqual(history.works ?? [], [])

  const chosen = await call('directory-register', { commandId: 'select-project', path: project })
  assert.equal(chosen.root, await realpath(project))
  await call('directory-default-save', { commandId: 'use-project', expectedRevision: 0, environmentId: chosen.id })
  const selected = await call('directory-options')
  assert.equal(selected.default.root, chosen.root)
  assert.deepEqual(calls, ['main', 'main', 'main'], 'selecting a project does not start Router or Worker')
})
