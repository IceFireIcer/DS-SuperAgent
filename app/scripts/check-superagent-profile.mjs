// Boot the app's ds-superagent profile without the Electron shell: the real
// profile bundles, the production Engine host and the existing chat UI.
// Uses throwaway data and a mock model route; stops the Host before it exits.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { INSTALL_ANCHOR, SUPERAGENT_PROFILE, assertLocalBackupProfile, loadAppProfile } from '../src/profile.mjs'
import { reconcileSuperagentProfile } from '../src/superagent-patch.mjs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { routerResponse, textResponse, toolResponse } from '../../superagent/dev/native-mock.mjs'
import { backupBeforeProfileChange, completeProductRestore, restoreProductBackup } from '../src/product-backups.mjs'

const log = console.log
console.log = (...values) => log(...values.map(value => typeof value === 'string' ? value.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]') : value))

const sandbox = mkdtempSync(join(tmpdir(), 'ds-superagent-profile-check-'))
const home = join(sandbox, 'profile-home')
// The smoke always supplies its own profile and routes.
for (const name of Object.keys(process.env)) if (name.startsWith('DS_SUPERAGENT_') || name.startsWith('DSH_')) delete process.env[name]
process.env.DSH_HOME = home
const workspace = join(home, 'workspace')
process.env.DS_SUPERAGENT_WORKSPACE = workspace
mkdirSync(join(home, 'profiles'), { recursive: true })
const routePatch = join(home, 'profiles', 'superagent-mock-route.patch.yml')
writeFileSync(routePatch, [
  '- id: superagent',
  '  config:',
  '    main: { provider: mock, model: main }',
  '    router: { provider: mock, model: router }',
  '    worker: { provider: mock, model: worker }',
  '',
].join('\n'))

let application
async function boot() {
  const profile = loadAppProfile()
  const patchFiles = [reconcileSuperagentProfile(profile, true)[0], routePatch]
  return runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: SUPERAGENT_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles,
    args: ['--no-open', '--port', '0'],
  })
}

try {
  application = await boot()
  const { ctx } = application
  const services = ['superagentProduct', 'webServer', 'connection', 'sessionPersistence']
  const missing = services.filter(name => ctx.get(name) === undefined)
  if (missing.length) throw new Error(`The ds-superagent profile did not start: ${missing.join(', ')}`)
  const modelCalls = []
  class MockRoleAdapter extends LlmAdapter {
    async *stream(request) {
      modelCalls.push({ model: request.model,
        text: request.messages.filter(message => message.role === 'user').at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join(''),
        tools: request.tools?.map(tool => tool.name) })
      if (request.model === 'main') {
        const user = request.messages.filter(message => message.role === 'user').at(-1)
        const text = user?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
        if (text.startsWith('[Work update]')) {
          const notification = JSON.parse(text.split('\n').at(-1))
          yield* textResponse(notification.outcome?.summary ?? notification.update.summary)
          return
        }
        const toolCalls = request.messages.slice(request.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
        if (text === 'Create and verify two local notes independently.' && toolCalls === 0) {
          yield* toolResponse('delegate_work', { items: [
            { goal: 'Create profile-alpha.txt with the exact accepted text.', constraints: 'Only write inside the configured local workspace.',
              acceptanceCriteria: 'Read profile-alpha.txt and confirm its exact contents.' },
            { goal: 'Create profile-beta.txt with the exact accepted text.', constraints: 'Only write inside the configured local workspace.',
              acceptanceCriteria: 'Read profile-beta.txt and confirm its exact contents.' },
          ] })
        } else if (text === 'Wait for a remote device.' && toolCalls === 0) {
          yield* toolResponse('delegate_work', { goal: 'Check the remote fixture.', constraints: 'Wait for the remote device.',
            acceptanceCriteria: 'Read the remote fixture.' })
        } else yield* textResponse('The independent Main answered through the public DSH loop.', { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
        return
      }
      if (request.model === 'router') {
        yield* routerResponse(request)
        return
      }
      if (request.model !== 'worker') throw new Error(`Unexpected role route ${request.model}.`)
      const userIndex = request.messages.findLastIndex(message => message.role === 'user')
      const completed = request.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length
      const userText = request.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content?.filter(block => block.type === 'text').map(block => block.text) ?? [])
        .findLast(text => text.includes('Goal:\n') && text.includes('profile-')) ?? ''
      if (!userText) {
        yield* textResponse('No verified result was recorded.')
        return
      }
      const file = userText.includes('profile-alpha') ? 'profile-alpha.txt' : 'profile-beta.txt'
      const plan = [
        ['write_file', { path: file, text: `${file} written and verified\n` }],
        ['read_file', { path: file }],
        ['run_shell', { command: `node -e "const fs=require('node:fs'); if (fs.readFileSync(process.argv[1], 'utf8').trim() !== process.argv[2]) process.exit(1)" ${file} "${file} written and verified"` }],
        ['report_ready', { result: `Created ${file}.`, evidence: `Read back and verified the accepted text in ${file}.`, artifacts: file }],
      ][completed]
      if (plan) yield* toolResponse(plan[0], plan[1], `profile-worker-${completed}`)
      else yield* textResponse('No result was recorded.')
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockRoleAdapter())
  const binding = await ctx.superagentProduct.dispatch('open')
  assert.equal(ctx.get('sessionController'), undefined, 'the native controller is isolated from the product Gateway')
  assert.equal(ctx.get('sessionReferenceResolver'), undefined, 'native Session discovery is unavailable')
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: {
    request: { requestId: 'forbidden-native', sessionId: binding.mainSessionId, mode: 'queue', content: [{ type: 'text', text: 'This must be refused.' }] },
  }, peer: ctx.connection.browserPeer }), { code: 'gateway/service-unavailable' })
  await assert.rejects(ctx.typertGateway.stream({ namespace: 'session', method: 'control', args: {}, peer: ctx.connection.browserPeer }), { code: 'gateway/service-unavailable' })
  const exportDenied = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    `http://localhost/api/session.export?sessionId=${binding.mainSessionId}`, { method: 'GET' }), ctx.connection.browserPeer)
  assert.equal(exportDenied.status, 404)
  await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'profile-smoke', text: 'Hello Main.' })
  let history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId })
  if (history.messages.length !== 2 || history.messages[1].role !== 'main') throw new Error('Main did not produce a durable reply.')
  await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'profile-delegation', text: 'Create and verify two local notes independently.' })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId })
    if (history.works?.length === 2 && history.works.every(work => work.status === 'success')) break
    await sleep(50)
  }
  assert.equal(history.works?.length, 2, JSON.stringify({ messages: history.messages, works: history.works, modelCalls }, null, 2))
  assert.equal(history.works.every(work => work.receipt.status === 'accepted' && work.status === 'success'), true)
  assert.equal(new Set(history.works.map(work => work.brief.workItemId)).size, 2)
  assert.equal(new Set(history.works.map(work => work.brief.sourceEventId)).size, 1)
  assert.deepEqual(history.works.map(work => work.outcome.artifacts[0].path).sort(), ['profile-alpha.txt', 'profile-beta.txt'], JSON.stringify({ works: history.works, modelCalls }, null, 2))
  assert.equal(await readFile(join(workspace, 'profile-alpha.txt'), 'utf8'), 'profile-alpha.txt written and verified\n')
  assert.equal(await readFile(join(workspace, 'profile-beta.txt'), 'utf8'), 'profile-beta.txt written and verified\n')
  const observations = await ctx.superagentProduct.dispatch('observe-list', { instanceId: binding.instanceId, limit: 10 })
  assert.equal(observations.items.length, 3, JSON.stringify({ observations, modelCalls }, null, 2))
  const workerObservation = observations.items.find(item => item.role === 'worker' && item.title.includes('alpha'))
  assert.ok(workerObservation?.generation)
  const observationHistory = await ctx.superagentProduct.dispatch('observe-read', { instanceId: binding.instanceId,
    observationId: workerObservation.id, generation: workerObservation.generation, limit: 100 })
  assert.equal(observationHistory.current, true)
  assert.equal(observationHistory.historyStatus, 'available')
  assert.equal(observationHistory.events.some(event => event.kind === 'tool-call'), true)
  const usage = await ctx.superagentProduct.dispatch('product-usage', { instanceId: binding.instanceId })
  assert.ok(usage.roles.main.totalTokens >= 5)
  assert.ok(usage.planning.some(item => item.total.calls > 0))
  assert.ok(usage.works.some(item => item.id === `item:${history.works[0].brief.workItemId}` && item.total.calls > 0))
  await assert.rejects(ctx.superagentProduct.dispatch('observe-read', {
    instanceId: binding.instanceId, observationId: workerObservation.id, text: 'This must be refused.',
  }), { code: 'INVALID_INPUT' })
  await assert.rejects(ctx.superagentProduct.dispatch('observe-detail', {
    instanceId: binding.instanceId, observationId: workerObservation.id, generation: workerObservation.generation,
    detailId: 'guessed-detail',
  }), { code: 'NOT_FOUND' })
  await assert.rejects(ctx.superagentProduct.dispatch('observe-detail', {
    instanceId: binding.instanceId, observationId: workerObservation.id, detailId: 'guessed-detail', write: true,
  }), { code: 'INVALID_INPUT' })
  if (ctx.get('botExecutionAdapter') !== undefined) throw new Error('The old execution adapter must not mount in the product profile.')
  if (process.argv.includes('--check-upgrade')) {
    const { instanceId } = binding
    const call = (endpoint, payload = {}) => ctx.superagentProduct.dispatch(endpoint, { instanceId, ...payload })
    await call('send', { commandId: 'wait-for-device', text: 'Wait for a remote device.', target: 'remote-only' })
    let waiting
    for (let attempt = 0; attempt < 200; attempt++) {
      waiting = (await call('history')).works.find(work => work.brief.goal === 'Check the remote fixture.')
      if (waiting?.executionSelection?.status === 'waiting') break
      await sleep(50)
    }
    assert.equal(waiting?.executionSelection?.status, 'waiting')
    await call('work-stop', { commandId: 'stop-before-upgrade', workItemId: waiting.control.workItemId,
      ticketId: waiting.control.ticketId, expectedTicketVersion: waiting.control.ticketVersion, reason: 'Keep this work stopped after upgrading.' })
    assert.equal((await call('schedule-source-set', { commandId: 'disable-schedule-before-upgrade', enabled: false })).enabled, false)
    let effects
    for (let attempt = 0; attempt < 200; attempt++) {
      effects = (await call('product-status')).effects
      if (!effects.pending && !effects.running) break
      await sleep(50)
    }
    assert.equal(effects.pending + effects.running + effects.unknown, 0, JSON.stringify(effects))
    const before = await call('history')
    assert.equal(before.works.find(work => work.brief.workItemId === waiting.brief.workItemId).control.stop.state, 'stopped')
    const roles = await call('settings', { limit: 1 })
    await application.shutdown.shutdown(0)
    application = undefined
    const backupRoot = join(sandbox, 'backups')
    const saved = await backupBeforeProfileChange({ home, backupRoot, version: 'profile-upgrade-fixture', assertProfile: () => assertLocalBackupProfile(home) })
    assert.ok(saved?.sessions.sessionCount >= 3)
    assert.ok(saved?.business.recordCount > 0)
    assert.equal(saved.restorable, true, JSON.stringify(saved.blockers))
    await restoreProductBackup({ home, backupRoot, backupId: saved.id })
    application = await boot()
    const restored = application.ctx.superagentProduct
    assert.deepEqual(await restored.dispatch('open'), binding)
    const after = await restored.dispatch('history', { instanceId })
    assert.deepEqual(after.works.map(work => [work.brief.workItemId, work.status]), before.works.map(work => [work.brief.workItemId, work.status]))
    assert.deepEqual(after.messages.map(message => message.id), before.messages.map(message => message.id))
    assert.equal(after.works.find(work => work.brief.workItemId === waiting.brief.workItemId).control.stop.state, 'stopped')
    assert.equal((await restored.dispatch('schedule-source-read', { instanceId })).enabled, false)
    assert.deepEqual((await restored.dispatch('settings', { instanceId, limit: 1 })).roles, roles.roles)
    assert.ok(await completeProductRestore({ home }))
    log('Verified product backup, restore and public profile restart with the original work history, stop and schedule authorization.')
  }
  console.log(JSON.stringify({ profile: SUPERAGENT_PROFILE, home, services, messages: history.messages.filter(message => !message.id.startsWith('reply:main-update:')).length,
    localWorkStatus: history.works.every(work => work.status === 'success') ? 'success' : 'failed', localWorkItems: history.works.length,
    observationItems: observations.items.length, observationHistoryEvents: observationHistory.events.length, observationWriteRejected: true,
    nativeSessionAccessDenied: true, nativeSessionExportDenied: true, nativeSessionReferenceDenied: true }))
} finally {
  try { await application?.shutdown?.shutdown?.(0) } catch {}
  rmSync(sandbox, { recursive: true, force: true })
  console.log = log
}
