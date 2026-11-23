import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createProductApi } from '../src/client/api.js'

const binding = { instanceId: 'instance', mainId: 'main', mainSessionId: 'session', routerSessionId: 'router', generation: 1 }
const avatar = 'data:image/png;base64,AA=='
const settings = { revision: 2, roles: { main: { name: 'Main', model: { provider: 'test', model: 'family/model' },
  appearance: { image: avatar } } }, providers: [{ id: 'test', name: 'Test', key: { configured: false, writable: true },
  models: [{ model: 'family/model', name: 'Model', ref: 'test/family/model' }] }] }

const history = { ...binding, health: { state: 'ready' }, messages: [
  { id: 'input', sequence: 7, role: 'user', text: 'Hi', createdAt: 10 },
  { id: 'reply', sequence: 8, role: 'main', text: 'Hello', createdAt: 11 },
  { id: 'status', sequence: 9, role: 'system', text: 'Stopped', createdAt: 12 },
], cursor: 7 }

const directoryOptions = { default: { environmentId: 'chosen-environment', root: '/work' }, picker: 'browse',
  directories: [{ id: 'other-environment', root: '/other', title: 'Other' }] }

function assertCommand(payload, expected) {
  const { commandId, ...fields } = payload
  assert.match(commandId, /^[\da-f-]{36}$/u)
  assert.deepEqual(fields, { instanceId: binding.instanceId, ...expected })
  return commandId
}

function fixture(responses = {}, options = {}) {
  const calls = []
  const { call, productCall } = createProductApi({ ...options, fetch: async (url, request) => {
    assert.equal(new URL(url, 'http://localhost/').pathname, '/api/product')
    assert.equal(request.method, 'POST')
    assert.equal(request.credentials, 'same-origin')
    const { endpoint, payload } = JSON.parse(request.body)
    calls.push([endpoint, payload, request.signal])
    if (endpoint === 'open' && !Object.hasOwn(responses, endpoint)) return Response.json({ ok: true, value: binding })
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected product endpoint ${endpoint}`)
    const handler = responses[endpoint]
    const value = typeof handler === 'function' ? await handler(payload) : handler
    return value instanceof Response ? value : Response.json({ ok: true, value })
  } })
  return { call, productCall, calls }
}

test('unsupported caller names are rejected before opening a Host or probing its connection', async () => {
  let probes = 0
  const { call, productCall, calls } = fixture({}, { bridge: () => { probes++; return null } })
  for (const endpoint of ['create-bot', 'team-workspace', 'computer-stop', 'toString', '__proto__', 'not-wired']) {
    await assert.rejects(call(endpoint), { code: 'bot/refused' })
    await assert.rejects(productCall(endpoint), { code: 'UNAVAILABLE' })
  }
  assert.equal(probes, 0)
  assert.deepEqual(calls, [])
})

test('state, models, efforts, providers, provider-key, avatar and set-prefs project current settings', async () => {
  const data = new Map([['ds-bot:prefs', '{"theme":"mono"}']])
  const keys = []
  const storage = () => ({ getItem(key) { keys.push(key); return data.get(key) }, setItem(key, value) { keys.push(key); data.set(key, value) } })
  let configured = false
  const { call, calls } = fixture({ history, 'product-status': { ready: true },
    settings: () => ({ ...settings, providers: settings.providers.map(provider => ({ ...provider, key: { ...provider.key, configured } })) }),
    'settings-efforts': { efforts: [{ id: 'high', name: 'High' }] },
    'provider-key': payload => {
      assert.deepEqual(payload, { instanceId: 'instance', provider: 'test', value: null })
      configured = false
      return { provider: 'test', configured }
    },
  }, { storage })

  assert.deepEqual(await call('set-prefs', { theme: 'paper', fontSize: 16 }), { theme: 'paper', fontSize: 16 })
  await assert.rejects(call('set-prefs', { defaultBotModel: 'test/family/model' }), { code: 'bot/invalid' })
  assert.equal(calls.length, 0)
  assert.ok(keys.every(key => key === 'ds-superagent:prefs'))
  const state = await call('state', { instanceId: 'untrusted' })
  assert.deepEqual(state.mainBotIds, ['main'])
  assert.equal(state.bots[0].sessionId, 'session')
  assert.deepEqual(state.rooms, [])
  assert.deepEqual(state.work.bots, {})
  assert.deepEqual(state.partsRunning, {})
  assert.deepEqual(state.prefs, { theme: 'paper', fontSize: 16 })
  assert.deepEqual(state.models, [{ id: 'family/model', name: 'Model', provider: 'test', providerName: 'Test',
    ref: 'test/family/model', needsKey: true }])
  assert.deepEqual(await call('models'), { modelsKey: state.modelsKey })
  assert.deepEqual(await call('state', { since: state.revision, models: state.modelsKey, live: state.liveKey }),
    { revision: state.revision, unchanged: true, liveKey: state.liveKey })
  assert.deepEqual(await call('efforts', { ref: 'test/family/model' }), { efforts: [{ id: 'high', name: 'High' }] })
  assert.deepEqual(calls.find(([endpoint]) => endpoint === 'settings-efforts')?.[1],
    { instanceId: 'instance', provider: 'test', model: 'family/model' })
  assert.deepEqual(await call('efforts', { ref: 'bad' }), { efforts: [] })
  configured = true
  assert.equal((await call('providers')).providers[0].key.configured, true)
  const refreshed = await call('provider-key', { provider: 'test', value: null, instanceId: 'untrusted' })
  assert.deepEqual(refreshed.providers[0].models, [{ id: 'family/model', name: 'Model', ref: 'test/family/model' }])
  assert.equal(refreshed.providers[0].key.configured, false)
  assert.deepEqual(await call('avatar', { botId: 'main' }), { botId: 'main', image: avatar,
    ref: createHash('sha256').update(avatar).digest('hex').slice(0, 16) })
  assert.ok(calls.every(([endpoint, payload]) => endpoint === 'open' ? !Object.keys(payload).length : payload.instanceId === 'instance'))
})

test('chat, earlier, send and stop-chat use the current Main and keep a send identity across unknown outcomes', async () => {
  let attempts = 0
  let firstId
  const { call, calls } = fixture({
    history: payload => payload.before ? { ...history, cursor: undefined, messages: [] }
      : { ...history, activeTurn: { messageId: 'turn', status: 'running' } },
    send: payload => {
      const commandId = assertCommand(payload, { text: 'Hi', attachments: ['photo'] })
      if (++attempts === 1) {
        firstId = commandId
        return Response.json({ ok: false, error: { code: 'COMMIT_UNKNOWN', message: 'Check Main before retrying.' } }, { status: 503 })
      }
      if (attempts === 2) assert.equal(commandId, firstId)
      else assert.notEqual(commandId, firstId)
      return { ...binding, messageId: 'turn', status: 'queued' }
    },
    'stop-main': payload => { assertCommand(payload, { messageId: 'turn' }); return { status: 'stopping' } },
  })
  const page = await call('chat', { botId: 'main' })
  assert.deepEqual(page.items.map(row => [row.kind, row.seq, row.text]), [['user', 7, 'Hi'], ['bot', 8, 'Hello'], ['event', 9, 'Stopped']])
  assert.deepEqual(page.cursor, { part: 1, beforeSeq: 7 })
  assert.deepEqual(await call('earlier', { sessionId: 'session', cursor: page.cursor }),
    { sessionId: 'session', items: [], cursor: null, startedAt: null, btw: [] })
  assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'history').map(([, payload]) => payload), [
    { instanceId: 'instance', limit: 50 }, { instanceId: 'instance', limit: 50, before: 7 },
  ])
  await assert.rejects(call('send', { sessionId: 'router', text: 'Wrong session' }), { code: 'bot/not-found' })
  const input = { sessionId: 'session', text: ' Hi ', images: ['photo'], commandId: 'untrusted' }
  await assert.rejects(call('send', input), { code: 'bot/internal', message: 'Check Main before retrying.' })
  assert.equal(await call('send', input), true)
  assert.equal(await call('send', input), true)
  assert.equal(await call('stop-chat', { botId: 'main', messageId: 'stale-turn' }), false)
  assert.equal(await call('stop-chat', { botId: 'main', messageId: 'turn' }), true)
  assert.equal(calls.filter(([endpoint]) => endpoint === 'stop-main').length, 1)
})

test('folders, folder-pick and folder-list project directory options without sending caller identity', async () => {
  const listing = { path: '/work', home: '/home', crumbs: [], entries: [], truncated: false }
  const { call, calls } = fixture({ 'directory-options': directoryOptions, 'directory-pick': null, 'directory-list': listing })
  assert.deepEqual(await call('folders'), { team: '/work', picker: 'browse', folders: [{ path: '/other', title: 'Other' }] })
  assert.equal(await call('folder-pick', { instanceId: 'unsafe', path: '/should-not-be-forwarded' }), null)
  assert.deepEqual(await call('folder-list', { path: '', instanceId: 'unsafe' }), listing)
  assert.deepEqual(await call('folder-list', { path: '/work', extra: true }), listing)
  assert.deepEqual(calls.filter(([endpoint]) => endpoint !== 'open').map(([endpoint, payload]) => [endpoint, payload]), [
    ['directory-options', { instanceId: 'instance' }], ['directory-pick', { instanceId: 'instance' }],
    ['directory-list', { instanceId: 'instance' }], ['directory-list', { instanceId: 'instance', path: '/work' }],
  ])
})

test('a reconnect refreshes the Main session before reading missed history or accepting a send', async () => {
  let current = binding
  const { call, calls } = fixture({ open: () => current, history: () => ({ ...history, ...current }) })
  const before = await call('chat', { botId: binding.mainId })
  current = { ...binding, generation: 2, mainSessionId: 'successor-session' }
  const after = await call('chat', { botId: binding.mainId })
  assert.equal(after.sessionId, current.mainSessionId)
  assert.deepEqual(after.items, before.items)
  await assert.rejects(call('send', { sessionId: binding.mainSessionId, text: 'Stale session' }), { code: 'bot/not-found' })
  assert.deepEqual(calls.map(([endpoint]) => endpoint), ['open', 'history', 'open', 'history', 'open'])
})

test('approval-answer, answer-question and view-reply use authorized attention facts', async () => {
  const view = { title: 'Approval', view: { actions: [{ id: 'approve' }] } }
  const work = (id, card) => ({ control: { workItemId: `work-${id}`, ticketId: `ticket-${id}`,
    permissions: { canAnswer: true }, assignment: { id: `assignment-${id}`, generation: 'generation' },
    attention: { id, assignmentId: `assignment-${id}`, status: 'waiting', version: 4, ...(card ? { view: card } : {}) } } })
  const expected = id => ({ workItemId: `work-${id}`, ticketId: `ticket-${id}`, expectedGeneration: 'generation',
    attentionId: id, attentionVersion: 4 })
  const { call } = fixture({ history: { ...history, works: [work('question'), work('approval', view), work('view', view)] },
    'work-answer': payload => { assertCommand(payload, { ...expected('question'), text: 'Yes' }); return {} },
    'work-answer-view': payload => {
      const id = payload.attentionId
      assertCommand(payload, { ...expected(id), action: 'approve', values: id === 'view' ? { reason: 'yes' } : {} })
      return {}
    },
  })
  assert.equal(await call('answer-question', { sessionId: 'session', questionId: 'question', answer: 'Yes', attentionVersion: 0 }), true)
  assert.equal(await call('approval-answer', { id: 'approval', choice: 'approve' }), true)
  assert.equal(await call('view-reply', { sessionId: 'session', viewId: 'view', action: 'approve', values: { reason: 'yes' } }), true)
  await assert.rejects(call('answer-question', { sessionId: 'router', questionId: 'question', answer: 'Yes' }), { code: 'bot/not-found' })
  await assert.rejects(call('approval-answer', { id: 'stale', choice: 'approve' }), { code: 'bot/stale' })
})

test('an answer to a displayed question fails closed after the displayed version changes', async () => {
  let version = 1
  const { call, calls } = fixture({ settings, 'product-status': {}, history: () => ({ ...history, works: [{ control: {
    workItemId: 'work', ticketId: 'ticket', permissions: { canAnswer: true }, assignment: { id: 'assignment', generation: 'generation' },
    attention: { id: 'question', question: 'Proceed?', options: ['Yes'], freeText: true, assignmentId: 'assignment', status: 'waiting', version },
  } }] }) })
  const state = await call('state')
  assert.equal(state.questions.session.id, 'question')
  version++
  await assert.rejects(call('answer-question', { sessionId: 'session', questionId: 'question', answer: 'Yes' }), { code: 'bot/stale' })
  assert.equal(calls.some(([endpoint]) => endpoint === 'work-answer'), false)
})

test('file-text, image, file-download and stage-image use product assets with verified byte pages', async () => {
  const contents = Buffer.from('字!')
  const page = ({ offset, maxBytes }) => {
    assert.equal(maxBytes, 8192)
    const bytes = contents.subarray(offset, offset + 2)
    return { reference: { name: 'photo.png', mediaType: 'image/png' }, offset, nextOffset: offset + bytes.length,
      totalBytes: contents.length, sha256: 'asset-digest', encoding: 'base64', text: bytes.toString('base64') }
  }
  const { call } = fixture({ 'directory-options': directoryOptions,
    'attachment-upload': payload => {
      assertCommand(payload, { kind: 'image', name: 'photo.png', mediaType: 'image/png', data: 'eA==', environmentId: 'chosen-environment' })
      return { id: 'photo' }
    },
    'attachment-read': payload => { assert.equal(payload.id, 'photo'); return page(payload) },
    'artifact-read': payload => { assert.equal(payload.workItemId, 'work'); assert.equal(payload.path, 'result.txt'); return page(payload) },
  })
  assert.deepEqual(await call('stage-image', { mediaType: 'image/png', data: 'eA==', environmentId: 'other' }), { id: 'photo' })
  assert.deepEqual(await call('file-text', { file: { attachmentId: 'photo' } }), { text: '字!', whole: true })
  assert.deepEqual(await call('image', { sessionId: 'session', attachmentId: 'photo' }), { mime: 'image/png', data: contents.toString('base64') })
  assert.deepEqual(await call('file-download', { workItemId: 'work', path: 'result.txt' }),
    { size: 4, bytes: contents.toString('base64'), mime: 'image/png', name: 'photo.png' })
  assert.deepEqual(await call('file-download', { attachmentId: 'photo', offset: 2, version: 'asset-digest' }),
    { size: 4, bytes: contents.subarray(2).toString('base64'), mime: 'image/png', name: 'photo.png', nextOffset: 4, done: true, version: 'asset-digest' })
  await assert.rejects(call('file-download', { attachmentId: 'photo', offset: 2, version: 'different' }), { code: 'bot/stale' })
})

test('HTTP failures keep native codes, translate upstream codes and preserve cancellation', async () => {
  const controller = new AbortController()
  const { call, productCall, calls } = fixture({ 'directory-pick': () => Response.json({ ok: false,
    error: { code: 'SOURCE_NOT_AUTHORIZED', message: 'Requires a local window.' } }, { status: 403 }) })
  await assert.rejects(call('folder-pick', null, controller.signal), { code: 'bot/refused', message: 'Requires a local window.' })
  assert.ok(calls.every(([, , signal]) => signal === controller.signal))
  await assert.rejects(productCall('directory-pick', { instanceId: 'instance' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  controller.abort()
  const count = calls.length
  await assert.rejects(call('folder-pick', null, controller.signal), { name: 'AbortError' })
  assert.equal(calls.length, count)
})

test('the desktop product bridge remains the only transport after remote selection', async () => {
  let bridge
  const remoteCalls = []
  const { call, productCall, calls } = fixture({}, { bridge: () => bridge })
  bridge = { status: async () => ({ connected: true }), call: async (endpoint, payload) => {
    remoteCalls.push([endpoint, payload])
    if (endpoint === 'open') return binding
    if (endpoint === 'history') return history
    throw Object.assign(new Error('Remote command denied.'), { code: 'SOURCE_NOT_AUTHORIZED' })
  } }
  const result = await call('chat', { botId: 'main', instanceId: 'other' })
  assert.equal(result.sessionId, 'session')
  assert.deepEqual(remoteCalls, [['open', {}], ['history', { instanceId: 'instance', limit: 50 }]])
  await assert.rejects(productCall('send', { instanceId: 'instance' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  bridge = undefined
  await assert.rejects(productCall('open'), { code: 'NETWORK' })
  assert.deepEqual(calls, [])
})
