import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createDesktopClassicAgent } from '../src/classic-agent.mjs'
import { apply as applyDesktopSessionGate } from '../../superagent/src/desktop-session-gate.ts'

test('the local window uses one attested DSH Peer for Native Agent requests', async () => {
  const renderer = { id: 40, mainFrame: {} }
  const origin = 'http://127.0.0.1:8891'
  const ownerCookie = 'owner=desktop-fixture'
  const calls = []
  const revocations = []
  const listeners = new Set()
  let connectedToRemote = false
  let listener
  const host = {
    onMessage(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    send(message) {
      if (message.type === 'ds-superagent:classic-revoke') revocations.push(message.detach)
      if (message.type !== 'ds-superagent:classic-bind') return
      assert.equal(message.cookie, ownerCookie)
      for (const callback of listeners) callback({ type: 'ds-superagent:classic-bound', id: message.id, bound: true })
    },
  }
  const bridge = createDesktopClassicAgent({ window: () => ({ webContents: renderer }), remote: () => connectedToRemote,
    request: async (url, options) => {
      calls.push(url.pathname)
      assert.equal(url.origin, origin)
      if (url.pathname === '/connect') return new Response(null, { status: 302, headers: { 'set-cookie': `${ownerCookie}; HttpOnly` } })
      assert.equal(options.headers.Cookie, ownerCookie)
      assert.ok(options.headers['x-ds-superagent-desktop-proof'])
      assert.deepEqual(JSON.parse(options.body), { endpoint: 'classic-open', payload: { instanceId: 'personal' } })
      return Response.json({ ok: true, value: { sessionId: 'classic-session' } })
    } })
  bridge.replaceHost(host, `${origin}/?token=fixture`)
  bridge.install({ webRequest: { onBeforeSendHeaders(_filter, callback) { listener = callback } } })
  const headers = variation => new Promise(resolve => listener({ url: `${origin}/api/session/list`, webContentsId: renderer.id,
    frame: renderer.mainFrame, initiatorOrigin: origin, resourceType: 'xhr', requestHeaders: { cookie: 'owner=ordinary-fixture' },
    ...variation }, resolve))

  assert.deepEqual(await headers({ webContentsId: 41, url: 'ws://127.0.0.1:8891/api/remote.mux', resourceType: 'webSocket' }), {})
  const accepted = await headers({ url: 'ws://127.0.0.1:8891/api/remote.mux', resourceType: 'webSocket' })
  assert.deepEqual(accepted, { requestHeaders: { Cookie: ownerCookie } })
  assert.deepEqual(await headers({}), accepted)
  assert.deepEqual(await headers({ frame: {} }), {})
  assert.deepEqual(await headers({ frame: null }), {})
  assert.deepEqual(await headers({ initiatorOrigin: undefined }), {})
  assert.deepEqual(await headers({ initiatorOrigin: 'http://127.0.0.1:8892' }), {})
  assert.deepEqual(await headers({ url: 'http://127.0.0.1:8892/api/session/list' }), {})
  assert.equal((await bridge.call(renderer, 'classic-open', { instanceId: 'personal' })).value.sessionId, 'classic-session')
  assert.equal((await bridge.call({}, 'classic-open', { instanceId: 'personal' })).error.code, 'CLASSIC_DENIED')
  bridge.revoke()
  assert.deepEqual(await headers({}), accepted)
  connectedToRemote = true
  assert.equal((await bridge.call(renderer, 'classic-open', { instanceId: 'personal' })).error.code, 'CLASSIC_DENIED')
  connectedToRemote = false
  bridge.revoke({ navigation: true })
  assert.deepEqual(await headers({}), {})
  assert.equal((await bridge.call(renderer, 'classic-open', { instanceId: 'personal' })).error.code, 'CLASSIC_DENIED')
  assert.deepEqual(revocations, [false, true])
  assert.deepEqual(calls, ['/connect', '/api/product'])
})

test('navigation never attaches a desktop credential to a stale request', async () => {
  const response = Promise.withResolvers()
  const renderer = { id: 41, mainFrame: {} }
  const origin = 'http://127.0.0.1:8892'
  const bound = []
  let listener
  const bridge = createDesktopClassicAgent({ window: () => ({ webContents: renderer }), remote: () => false,
    request: () => response.promise })
  bridge.replaceHost({ send(message) { bound.push(message.type) } }, `${origin}/?token=fixture`)
  bridge.install({ webRequest: { onBeforeSendHeaders(_filter, callback) { listener = callback } } })
  const pending = new Promise(resolve => listener({ url: 'ws://127.0.0.1:8892/api/remote.mux', webContentsId: renderer.id,
    frame: renderer.mainFrame, initiatorOrigin: origin, resourceType: 'webSocket', requestHeaders: {} }, resolve))
  bridge.revoke({ navigation: true })
  renderer.mainFrame = {}
  response.resolve(new Response(null, { status: 302, headers: { 'set-cookie': 'owner=desktop-fixture; HttpOnly' } }))
  assert.deepEqual(await pending, {})
  assert.deepEqual(bound, ['ds-superagent:classic-revoke'])
})

function gateFixture() {
  let upgrade
  let forwarded
  const makePeer = () => {
    const lifetime = new AbortController()
    return { principal: { kind: 'owner' }, interactions: 'answer', signal: lifetime.signal,
      async dispose() { lifetime.abort() } }
  }
  const browserPeer = makePeer()
  const services = new Map([
    ['superagentDesktopWebServer', { registerUpgrade(route) { upgrade = route.handler } }],
    ['superagentDesktopGateway', { registerRemoteEvents(source) { forwarded = source } }],
    ['superagentProduct', { async dispatch() { return { mainSessionId: 'main', mainSessionMode: 'native' } } }],
    ['connection', { browserPeer, admit: request => ({ peer: request.peer }) }],
  ])
  applyDesktopSessionGate({ get: name => services.get(name), provide: (name, value) => services.set(name, value), effect() {} })
  let accepted = 0
  services.get('webServer').registerUpgrade({ path: '/api/remote.mux', handler() { accepted += 1 } })
  return { services, browserPeer, makePeer, gate: services.get('superagentDesktopSessionGate'),
    upgrade(peer) {
      const socket = Object.assign(new EventEmitter(), {
        end(response) { this.response = response },
        destroy() { this.destroyed = true; this.emit('close') },
      })
      upgrade({ peer }, socket, Buffer.alloc(0))
      return socket
    },
    accepted: () => accepted,
    async forward(events) {
      services.get('typertGateway').registerRemoteEvents(async function* () { yield* events }, { home: '/mock' })
      return await Array.fromAsync(forwarded(new AbortController().signal))
    },
  }
}

test('the desktop gate serves Main when Classic is disabled and releases superseded Peers', async () => {
  const { gate, upgrade, accepted, browserPeer, makePeer } = gateFixture()
  const desktop = makePeer()
  assert.equal(gate.bindDesktop(browserPeer, 'fixture'), false)
  assert.match(upgrade(browserPeer).response, /403 Forbidden/u)
  assert.equal(gate.bindDesktop(desktop, 'fixture'), true)
  assert.match(upgrade(makePeer()).response, /403 Forbidden/u)
  const socket = upgrade(desktop)
  assert.equal(accepted(), 1)
  gate.revoke()
  assert.equal(desktop.signal.aborted, false)
  const next = makePeer()
  assert.equal(gate.bindDesktop(next, 'fixture'), true)
  assert.equal(desktop.signal.aborted, true)
  assert.equal(socket.destroyed, true)
  assert.match(upgrade(desktop).response, /403 Forbidden/u)
  const active = upgrade(next)
  gate.revoke(true)
  assert.equal(next.signal.aborted, true)
  assert.equal(active.destroyed, true)
})

test('the desktop event source delegates unrelated callbacks and cancels withdrawn Classic callbacks', async () => {
  const { gate, makePeer, services, forward } = gateFixture()
  const peer = makePeer()
  const lease = new AbortController()
  const pending = []
  let bound
  const capture = (event, agentId, signal) => ({ event, context: { agentId }, request: { agent: { agentId }, signal },
    resolve(outcome) { pending.push([agentId, outcome.kind]) } })
  services.set('superagentClassicSession', {
    bindDesktop(candidate) { bound = candidate },
    revoke() { if (bound) lease.abort() },
    forPeer: candidate => candidate && candidate === bound && !lease.signal.aborted ? { sessionId: 'classic', signal: lease.signal } : undefined,
  })
  assert.equal(gate.bindDesktop(peer, 'fixture'), true)
  const original = new AbortController()
  const main = capture('approval/request', 'main')
  const router = capture('approval/request', 'router')
  const classic = capture('user-questions/request', 'classic', original.signal)
  const pulled = await forward([main, router, classic, { event: 'api-session/status', args: ['router', true] },
    { event: 'api-session/status', args: ['classic', true] }])
  assert.deepEqual(pending, [['router', 'next']])
  assert.equal(pulled.length, 3)
  assert.equal(pulled[0], main)
  assert.equal(pulled[1].request.agent, classic.request.agent)
  assert.notEqual(pulled[1].request.signal, original.signal)
  assert.equal(pulled[1].request.signal.aborted, false)
  assert.deepEqual(pulled[2].args, ['classic', true])
  gate.revoke()
  assert.equal(pulled[1].request.signal.aborted, true)
  assert.equal(original.signal.aborted, false)
  assert.deepEqual(await forward([classic, main]), [main])
  assert.deepEqual(pending.at(-1), ['classic', 'next'])
})
