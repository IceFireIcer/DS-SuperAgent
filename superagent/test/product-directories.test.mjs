import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

test('the product directory picker saves a default and a work override across Host restart', { timeout: 45_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-product-directories-'))
  const first = join(base, 'first')
  const second = join(base, 'second')
  const core = join(base, 'core')
  await Promise.all([mkdir(first), mkdir(second), mkdir(core)])
  const [firstRoot, secondRoot] = await Promise.all([realpath(first), realpath(second)])
  const native = await nativeContext(join(base, 'sessions'), function* () { yield* textResponse('Main is ready.') })
  native.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => second }) })
  let host
  t.after(async () => {
    await host?.close(); await native.fiber.dispose(); await rm(base, { recursive: true, force: true })
  })
  const config = { databasePath: join(core, 'state.sqlite'), workspaceRoot: first, instanceId: 'personal', actorId: 'alice',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  host = await createProductHost(native, config)
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'personal', ...payload })
  const initial = await call('directory-options')
  assert.equal(initial.default.root, firstRoot)
  assert.equal(initial.picker, 'native')
  assert.equal(await call('directory-pick'), second)
  const chosen = await call('directory-register', { commandId: 'register-second', path: second })
  assert.equal(chosen.root, secondRoot)
  assert.equal((await call('directory-register', { commandId: 'register-second', path: second })).id, chosen.id)
  await assert.rejects(call('directory-register', { commandId: 'register-second', path: core }), { code: 'PATH_DENIED' })
  await assert.rejects(call('send', { commandId: 'untrusted', text: 'Hello.', environmentId: 'another-instance' }), { code: 'ENVIRONMENT_DENIED' })
  const saved = await call('directory-default-save', { commandId: 'default-second', expectedRevision: 0, environmentId: chosen.id })
  assert.equal(saved.root, secondRoot)
  assert.equal(saved.revision, 1)
  await assert.rejects(call('directory-default-save', { commandId: 'stale', expectedRevision: 0, environmentId: chosen.id }), { code: 'DIRECTORY_REVISION_CONFLICT' })
  await call('send', { commandId: 'first-override', text: 'Hello in first.', environmentId: initial.default.environmentId })
  await host.close()
  host = await createProductHost(native, config)
  const reopened = await call('directory-options')
  assert.equal(reopened.default.root, secondRoot)
  assert.equal(reopened.directories.some(entry => entry.id === initial.default.environmentId && entry.root === firstRoot), true)
  assert.equal(reopened.directories.some(entry => entry.id === chosen.id && entry.root === secondRoot), true)
  assert.equal((await call('history')).messages.filter(message => message.role === 'user').length, 1)
})

test('a product with no initial workspace can select one and execute its first real Worker', { timeout: 30_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r5-first-directory-'))
  const root = join(base, 'work')
  const core = join(base, 'core')
  await Promise.all([mkdir(root), mkdir(core)])
  const native = await nativeContext(join(base, 'sessions'), function* (options) {
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('Work delivered.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: 'Write first.txt.', constraints: 'Use the selected work directory.',
        acceptanceCriteria: 'Verify the file and report it.' })
      else yield* textResponse('Delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (count === 0) yield* toolResponse('write_file', { path: 'first.txt', text: 'first work\n' })
    else if (count === 1) yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
    else if (count === 2) yield* toolResponse('report_ready', { result: 'First work complete.', evidence: 'Shell verification passed.', artifacts: 'first.txt' })
    else yield* textResponse('No further actions.')
  })
  let host = await createProductHost(native, { databasePath: join(core, 'state.sqlite'), instanceId: 'personal', actorId: 'alice',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(base, { recursive: true, force: true }) })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId: 'personal', ...payload })
  assert.equal((await call('directory-options')).default, null)
  const directory = await call('directory-register', { commandId: 'initial-workspace', path: root })
  assert.equal((await call('directory-default-save', { commandId: 'initial-default', expectedRevision: 0,
    environmentId: directory.id })).revision, 1)
  await call('send', { commandId: 'first-work', text: 'Write the first note.' })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await call('history')).works[0]?.outcome?.status === 'success') break
    await sleep(20)
  }
  assert.equal((await call('history')).works[0]?.outcome?.status, 'success')
  assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first work\n')
})
