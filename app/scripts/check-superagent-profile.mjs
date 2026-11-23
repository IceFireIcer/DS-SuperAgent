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
import { mkdir, readFile, realpath, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { setTimeout as sleep } from 'node:timers/promises'
import { routerResponse, textResponse, toolResponse } from '../../superagent/dev/native-mock.mjs'
import { backupBeforeProfileChange, completeProductRestore, restoreProductBackup } from '../src/product-backups.mjs'

const log = console.log
console.log = (...values) => log(...values.map(value => typeof value === 'string' ? value.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]') : value))

const sandbox = mkdtempSync(join(tmpdir(), 'ds-superagent-profile-check-'))
const home = join(sandbox, 'profile-home')
const checkClassic = process.argv.includes('--check-classic')
// The smoke always supplies its own profile and routes.
for (const name of Object.keys(process.env)) if (name.startsWith('DS_SUPERAGENT_') || name.startsWith('DSH_')) delete process.env[name]
process.env.DSH_HOME = home
if (checkClassic) process.env.DS_SUPERAGENT_APP = '1'
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
  ...(checkClassic ? ['- id: agent-default-model', '  config: { provider: mock, model: classic }'] : []),
  '',
].join('\n'))

let application
async function boot() {
  const profile = loadAppProfile()
  const patchFiles = [reconcileSuperagentProfile(profile, true, { desktop: checkClassic })[0], routePatch]
  return runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: SUPERAGENT_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles,
    args: ['--no-open', ...(checkClassic ? ['--host', '127.0.0.1'] : []), '--port', '0'],
  })
}

try {
  application = await boot()
  const { ctx } = application
  const services = ['superagentProduct', 'webServer', 'connection', 'sessionPersistence']
  const missing = services.filter(name => ctx.get(name) === undefined)
  if (missing.length) throw new Error(`The ds-superagent profile did not start: ${missing.join(', ')}`)
  const modelCalls = []
  const classicMainEntered = Promise.withResolvers()
  const classicMainRelease = Promise.withResolvers()
  class MockRoleAdapter extends LlmAdapter {
    async listModels(provider) {
      return ['main', 'router', 'worker', 'classic'].map(id => ({ provider, id, name: id }))
    }

    async *stream(request) {
      modelCalls.push({ model: request.model,
        text: request.messages.filter(message => message.role === 'user').at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join(''),
        tools: request.tools?.map(tool => tool.name) })
      if (request.model === 'classic') {
        yield* textResponse('The independent Classic Agent answered.')
        return
      }
      if (request.model === 'main') {
        const user = request.messages.filter(message => message.role === 'user').at(-1)
        const text = user?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
        if (text === 'Finish while Classic Agent is open.') {
          classicMainEntered.resolve()
          await classicMainRelease.promise
          yield* textResponse('Main completed without resubmission.')
          return
        }
        if (text === 'Hello from the browser check.') {
          const reasoning = 'Consider the browser fixture.'
          yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: 0, text: reasoning }
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
          for (const chunk of textResponse('Main answered the browser check.')) {
            yield 'index' in chunk ? { ...chunk, index: 1 } : chunk
          }
          return
        }
        if (text === 'Wait for the browser to stop this reply.') await sleep(20000, undefined, { signal: request.signal })
        if (text === 'Fail this browser fixture turn.') throw new Error('Browser fixture model failure.')
        if (text === 'Keep the draft across model setup.') {
          yield* textResponse('Main received the draft after model setup.')
          return
        }
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
        } else if (text === 'Ask a browser fixture question.' && toolCalls === 0) {
          yield* toolResponse('delegate_work', { goal: 'Ask which browser label to use.', constraints: 'Wait for the human answer.',
            acceptanceCriteria: 'Record the selected label.' })
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
      const questionWork = request.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text.includes('Ask which browser label to use.')))
      const alreadyAsked = request.messages.some(message => message.role === 'assistant'
        && message.content.some(block => block.type === 'tool-call' && block.id === 'browser-question'))
      if (questionWork && !alreadyAsked) {
        yield* toolResponse('ask_human', { question: 'Which browser label?', options: 'Blue\nGreen' }, 'browser-question')
        return
      }
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
  assert.ok(ctx.get('sessionController'), 'the product Gateway exposes a Main Session reader')
  assert.equal(ctx.get('sessionReferenceResolver'), undefined, 'native Session discovery is unavailable')
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: {
    request: { requestId: 'forbidden-native', sessionId: binding.mainSessionId, mode: 'queue', content: [{ type: 'text', text: 'This must be refused.' }] },
  }, peer: ctx.connection.browserPeer }))
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'create', args: {
    request: { cwd: workspace },
  }, peer: ctx.connection.browserPeer }))
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'cancel', args: {
    request: { sessionId: binding.mainSessionId },
  }, peer: ctx.connection.browserPeer }))
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'events', args: {
    request: { address: { kind: 'session', sessionId: binding.routerSessionId } },
  }, peer: ctx.connection.browserPeer }))
  const exportDenied = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    `http://localhost/api/session.export?sessionId=${binding.mainSessionId}`, { method: 'GET' }), ctx.connection.browserPeer)
  assert.equal(exportDenied.status, 404)
  const firstReply = await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'profile-smoke', text: 'Hello Main.' })
  assert.equal(firstReply.status, 'completed')
  const address = { kind: 'session', sessionId: binding.mainSessionId }
  assert.ok(await ctx.sessionPersistence.stat(binding.mainSessionId), 'the product Main Session is persisted')
  const nativeHistory = await ctx.typertGateway.invoke({ namespace: 'session', method: 'events', args: { request: { address } }, peer: ctx.connection.browserPeer })
  assert.ok(nativeHistory.records.length > 0)
  const nativeCatalog = await ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer: ctx.connection.browserPeer })
  assert.deepEqual(nativeCatalog.items.map(item => item.sessionId), [binding.mainSessionId])
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
  if (checkClassic) {
    const { instanceId, mainSessionId, routerSessionId } = binding
    const origin = `http://127.0.0.1:${ctx.webServer.port}`
    const connect = async () => {
      const url = new URL(ctx.connection.authenticatedUrl(origin))
      url.pathname = '/connect'
      url.searchParams.set('interactions', 'answer')
      const response = await fetch(url, { redirect: 'manual' })
      assert.equal(response.status, 302)
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
      const admission = ctx.connection.admit({ headers: { host: new URL(origin).host, cookie } })
      assert.ok(admission.peer)
      assert.notEqual(admission.peer, ctx.connection.browserPeer)
      return { peer: admission.peer, cookie }
    }
    const desktop = await connect()
    const otherOwner = await connect()
    const browserLogin = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    assert.equal(browserLogin.status, 303)
    const browserCookie = browserLogin.headers.get('set-cookie')?.split(';', 1)[0]
    const desktopGate = ctx.get('superagentDesktopSessionGate')
    assert.ok(desktopGate)
    const proof = randomUUID()
    assert.equal(desktopGate.bindDesktop(desktop.peer, proof), true)
    const muxUrl = new URL('/api/remote.mux', origin)
    muxUrl.protocol = 'ws:'
    const openMux = cookie => new WebSocket(muxUrl, { headers: { cookie }, handshakeTimeout: 4000 })
    for (const cookie of [browserCookie, otherOwner.cookie]) {
      const socket = openMux(cookie)
      const [, response] = await once(socket, 'unexpected-response')
      assert.equal(response.statusCode, 403)
      response.resume()
    }
    const desktopMux = openMux(desktop.cookie)
    const notifications = []
    const workspaceFrames = []
    const workspaceStreamId = randomUUID()
    desktopMux.on('message', data => {
      const frame = JSON.parse(data.toString())
      if (frame.streamId === workspaceStreamId) workspaceFrames.push(frame.value)
      else notifications.push(frame.value)
    })
    await once(desktopMux, 'open')
    desktopMux.send(JSON.stringify({ type: 'open', streamId: randomUUID(), endpoint: '$events', payload: { args: {} } }))
    const awaitNotification = async (predicate, after = 0) => {
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        if (notifications.slice(after).some(predicate)) return
        await sleep(20)
      }
      assert.fail('The desktop stream did not publish the expected notification.')
    }
    await awaitNotification(event => event?.type === 'ready')
    const requestClassic = async (endpoint, desktopProof = proof, caller = desktop) => {
      const response = await fetch(`${origin}/api/product`, { method: 'POST', headers: { 'content-type': 'application/json',
        cookie: caller.cookie, 'x-ds-superagent-desktop-proof': desktopProof }, body: JSON.stringify({ endpoint, payload: { instanceId } }) })
      return response.json()
    }
    const invoke = (method, args, peer = desktop.peer) => ctx.typertGateway.invoke({ namespace: 'session', method, args, peer })
    const sessionRequest = async (method, args, cookie = desktop.cookie) => {
      const response = await fetch(`${origin}/api/session/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `session/${method}`, payload: { args } }) })
      return (await response.json()).result
    }
    const sessionEvents = sessionId => ({ request: { address: { kind: 'session', sessionId } } })
    const prompt = sessionId => ({ request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Native Classic input.' }] } })
    const list = async peer => (await invoke('list', { _request: {} }, peer)).items.map(item => item.sessionId)
    const mainInput = { instanceId, commandId: 'classic-roundtrip-main', text: 'Finish while Classic Agent is open.' }
    const inFlight = ctx.superagentProduct.dispatch('send', mainInput)
    try {
      await Promise.race([classicMainEntered.promise, sleep(8000, undefined, { ref: false }).then(() => { throw new Error('Main did not start.') })])
      assert.equal((await requestClassic('classic-open', '')).error.code, 'CLASSIC_DENIED')
      assert.equal((await requestClassic('classic-open', proof, otherOwner)).error.code, 'CLASSIC_DENIED')
      const open = await requestClassic('classic-open')
      assert.equal(open.ok, true, JSON.stringify(open.error))
      const { sessionId, workspaceId } = open.value
      assert.ok(sessionId && sessionId !== mainSessionId && sessionId !== routerSessionId)
      const classicWorkspace = ctx.workspaceRegistry.get(workspaceId)
      assert.equal(classicWorkspace.path, await realpath(workspace))
      assert.ok(classicWorkspace.sessionIds.includes(sessionId))
      assert.deepEqual(ctx.agents.get(sessionId).model.current(), ctx.agentDefaultModel.currentSelection())
      desktopMux.send(JSON.stringify({ type: 'open', streamId: workspaceStreamId, endpoint: 'workspace/follow', payload: { args: {} } }))
      const workspaceDeadline = Date.now() + 4000
      while (workspaceFrames.length === 0 && Date.now() < workspaceDeadline) await sleep(20)
      const classicWorkspaceRow = workspaceFrames[0]?.value?.items.find(item => item.workspaceId === workspaceId)
      assert.ok(classicWorkspaceRow?.sessionIds.includes(sessionId), 'the Workspace stream must show the Classic Agent landing Session')
      assert.deepEqual(await list(desktop.peer), [sessionId])
      for (const peer of [ctx.connection.browserPeer, otherOwner.peer]) {
        assert.deepEqual(await list(peer), [mainSessionId])
        await assert.rejects(invoke('events', sessionEvents(sessionId), peer))
        await assert.rejects(invoke('prompt', prompt(sessionId), peer))
      }
      for (const forbiddenId of [mainSessionId, routerSessionId]) {
        await assert.rejects(invoke('prompt', prompt(forbiddenId)))
        await assert.rejects(invoke('events', sessionEvents(forbiddenId)))
      }
      const archive = await fetch(`${origin}/api/workspace/archiveSession`, { method: 'POST', headers: { cookie: desktop.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace/archiveSession',
          payload: { args: { request: { sessionId: mainSessionId, stopActivity: true } } } }) })
      assert.equal(archive.status, 403)
      assert.equal((await sessionRequest('prompt', prompt(sessionId), browserCookie)).ok, false)
      assert.equal((await sessionRequest('prompt', prompt(sessionId))).value.accepted, true)
      await awaitNotification(event => event?.event === 'api-session/status' && event.args[0] === sessionId)
      const start = notifications.length
      ctx.emit('api-session/status', routerSessionId, true)
      ctx.emit('api-session/status', sessionId, true)
      await awaitNotification(event => event?.event === 'api-session/status' && event.args[0] === sessionId && event.args[1] === true, start)
      assert.equal(notifications.slice(start).some(event => event?.event === 'api-session/status' && event.args[0] === routerSessionId), false)
      await assert.rejects(invoke('attachment', { request: { sessionId, attachment: {} } }))
      const deadline = Date.now() + 8000
      let classicHistory
      while (Date.now() < deadline) {
        classicHistory = await invoke('events', sessionEvents(sessionId))
        if (JSON.stringify(classicHistory.records).includes('The independent Classic Agent answered.')) break
        await sleep(50)
      }
      assert.ok(JSON.stringify(classicHistory?.records).includes('The independent Classic Agent answered.'))
      assert.equal((await requestClassic('classic-renew')).value.sessionId, sessionId)
      assert.equal((await requestClassic('classic-close')).value.closed, true)
      assert.deepEqual(await list(desktop.peer), [mainSessionId])
      await assert.rejects(invoke('events', sessionEvents(sessionId)))
      const initialDirectory = (await ctx.superagentProduct.dispatch('directory-options', { instanceId })).default
      const newDirectory = join(sandbox, 'classic-unavailable')
      await mkdir(newDirectory)
      const registered = await ctx.superagentProduct.dispatch('directory-register', { instanceId, path: newDirectory, commandId: 'classic-fixture-register' })
      const unavailable = await ctx.superagentProduct.dispatch('directory-default-save', { instanceId,
        commandId: 'classic-fixture-directory', environmentId: registered.id, expectedRevision: initialDirectory.revision })
      await rmdir(newDirectory)
      assert.equal((await requestClassic('classic-open')).error.code, 'CLASSIC_UNAVAILABLE')
      await ctx.superagentProduct.dispatch('directory-default-save', { instanceId, commandId: 'classic-fixture-directory-restore',
        environmentId: initialDirectory.environmentId, expectedRevision: unavailable.revision })
      assert.deepEqual((await requestClassic('classic-open')).value, { sessionId, workspaceId })
      const desktopClosed = once(desktopMux, 'close')
      desktopMux.close()
      await desktopClosed
      if (!desktop.peer.signal.aborted) await once(desktop.peer.signal, 'abort', { signal: AbortSignal.timeout(4000) })
      assert.equal((await requestClassic('classic-renew', proof, otherOwner)).error.code, 'CLASSIC_DENIED')
      assert.deepEqual(await list(otherOwner.peer), [mainSessionId])
      await otherOwner.peer.dispose()
      assert.equal((await ctx.superagentProduct.dispatch('open')).mainSessionId, mainSessionId)
    } finally {
      desktopMux.close()
      classicMainRelease.resolve()
    }
    await inFlight
    await ctx.superagentProduct.dispatch('send', mainInput)
    assert.equal(modelCalls.filter(call => call.text === mainInput.text && call.model === 'main').length, 1)
    console.log('Classic Agent used one independent native Session, revoked the Desktop peer, and preserved the original Main receipt.')
  }
  if (process.argv.includes('--check-ui')) {
    const im = await ctx.superagentProduct.dispatch('im-accounts', { instanceId: binding.instanceId, operation: 'list' })
    assert.equal(im.accounts.length, 8)
    const { checkProductUi } = await import('./check-superagent-ui.mjs')
    await checkProductUi(ctx)
  }
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
