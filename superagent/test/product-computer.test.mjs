import assert from 'node:assert/strict'
import test from 'node:test'
import { ProductComputer } from '../dist/index.js'

const scope = { instanceId: 'personal', workItemId: 'work', ticketId: 'ticket', assignmentId: 'assignment',
  generation: 'generation', environmentId: 'local', sessionId: 'worker' }
const app = { id: 'fixture-editor', name: 'Fixture Editor' }

function fixture(context) {
  const facts = {
    ticket: { state: 'open' },
    assignment: { id: 'assignment', generation: 'generation', state: 'running', sessionId: 'worker', environment: { kind: 'local', id: 'local' } },
    'work-ticket': { workItemId: 'work', workBriefId: 'brief' },
    'work-item': { workBriefId: 'brief' },
    'work-brief': { id: 'brief', instanceId: 'personal', environmentId: 'local' },
  }
  const state = { status: 'ready', localDecision: true, localReview: true, visits: [], actions: [] }
  const adapter = {
    status: async () => state.status,
    apps: async () => [app],
    approve: async request => { state.visits.push(request); return state.localDecision },
    reconcile: async () => state.localReview,
    indicator: async (active, stop) => { state.indicator = active; state.stop = stop; return true },
    execute: async (request, signal, authorize, launch) => {
      await authorize()
      state.actions.push(request)
      if (request.action === 'windows') return { windows: [{ windowId: 7, onScreen: true, title: 'Private title' }] }
      if (request.action === 'snapshot') return { text: 'Private accessibility text', screenshot: { mimeType: 'image/png', data: 'cHJpdmF0ZQ==' } }
      if (state.preflightDenied) throw new Error('Private permission detail')
      return launch(async () => {
        if (!state.inFlight) return {}
        state.inFlight.start()
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
    },
  }
  const records = new Map()
  const storage = { transaction: async (_id, fn) => fn({
    get: async (kind, key) => kind === 'computer-policy' ? records.get(key) : facts[kind],
    list: async () => [...records.values()],
    insert: async (_kind, key, value) => { records.set(key, structuredClone(value)) },
    remove: async (_kind, key) => records.delete(key),
  }) }
  const openHost = () => new ProductComputer({ instanceId: 'personal', adapter: () => adapter, storage })
  let computer = openHost()
  context.after(() => computer.close())
  const dispatch = (endpoint, payload = {}, remote = false) => computer.dispatch(endpoint, { instanceId: 'personal', ...payload }, remote)
  const policy = (operation, payload) => dispatch('computer-policy', { operation, ...payload })
  const tools = (target = scope, turn = new AbortController().signal) => {
    const entries = new Map(computer.tools(async () => target, turn).map(tool => [tool.name, tool]))
    return (tool, args = {}) => entries.get(tool).execute(args, new AbortController().signal)
  }
  const grant = async level => {
    await policy('enable', { enabled: true })
    await policy('allow', { appId: app.id, level })
  }
  const request = async (call = tools()) => JSON.parse(await call('computer_request', { appId: app.id })).leaseId
  const restart = () => { computer.close(); computer = openHost() }
  return { facts, state, dispatch, policy, tools, grant, request, restart }
}

test('computer tools need local opt-in, a current local generation, the exact app, and the local decision', async context => {
  const { facts, state, dispatch, policy, tools, grant, request } = fixture(context)
  const call = tools()
  await assert.rejects(dispatch('computer-status', {}, true), { code: 'COMPUTER_NOT_AUTHORIZED' })
  await assert.rejects(request(call), { code: 'COMPUTER_UNAVAILABLE' })
  await grant('background')
  await assert.rejects(call('computer_request', { appId: 'another-app' }), { code: 'COMPUTER_NOT_AUTHORIZED' })
  await assert.rejects(request(tools({ ...scope, generation: 'other' })), { code: 'COMPUTER_NOT_AUTHORIZED' })
  facts.assignment.environment.kind = 'remote'
  await assert.rejects(request(call), { code: 'COMPUTER_NOT_AUTHORIZED' })
  facts.assignment.environment.kind = 'local'
  state.status = 'permission-required'
  assert.equal((await policy('probe')).provider, 'permission-required')
  await assert.rejects(request(call), { code: 'COMPUTER_PERMISSION_REQUIRED' })
  assert.deepEqual(state.visits, [])
  assert.deepEqual(state.actions, [])
  state.status = 'ready'
  state.localDecision = false
  await assert.rejects(request(call), { code: 'COMPUTER_NOT_AUTHORIZED' })
  await assert.rejects(request(call), { code: 'COMPUTER_NOT_AUTHORIZED' })
  assert.equal(state.visits.length, 1, 'a denied generation cannot immediately ask again')
  assert.equal(state.visits[0].generation, scope.generation)
  assert.deepEqual(state.actions, [])
})

test('takeover aborts input and its metadata-only block survives reassignment and Host restart', async context => {
  const { facts, state, dispatch, tools, grant, request, restart } = fixture(context)
  await grant('background')
  const call = tools()
  const leaseId = await request(call)
  const use = (action, values) => call('computer_use', { leaseId, windowId: 7, action, ...values })
  assert.equal(state.indicator, true)
  await assert.rejects(use('click', { x: 1, y: 1 }), { code: 'COMPUTER_SNAPSHOT_REQUIRED' })
  assert.deepEqual(JSON.parse(await call('computer_use', { leaseId, action: 'windows' })), { windows: [{ windowId: 7, onScreen: true }] })
  const snapshot = await use('snapshot')
  assert.doesNotMatch(snapshot, /Private accessibility|cHJpdmF0ZQ==/u)
  assert.equal((await dispatch('computer-status')).lease.screenshot.data, 'cHJpdmF0ZQ==')
  await assert.rejects(use('activate'), { code: 'COMPUTER_NOT_AUTHORIZED' })
  const started = Promise.withResolvers()
  state.inFlight = { start: started.resolve }
  const click = use('click', { x: 1, y: 1 })
  const interrupted = assert.rejects(click, { code: 'COMPUTER_OUTCOME_UNKNOWN' })
  await started.promise
  const taken = await dispatch('computer-control', { operation: 'takeover', leaseId })
  await interrupted
  assert.equal(taken.lease.state, 'human')
  assert.equal(state.indicator, false)
  await assert.rejects(use('snapshot'), { code: 'COMPUTER_NOT_AUTHORIZED' })
  await dispatch('computer-control', { operation: 'return', leaseId })
  const [pending] = (await dispatch('computer-status')).pending
  assert.deepEqual(Object.keys(pending).sort(), ['action', 'appId', 'appName', 'kind', 'operationId', 'recordedAt', 'workItemId'])
  const generation = facts.assignment.generation = 'next-generation'
  await assert.rejects(request(tools({ ...scope, generation })), { code: 'COMPUTER_OUTCOME_UNKNOWN' })
  restart()
  await grant('background')
  const reopened = tools({ ...scope, generation })
  await assert.rejects(request(reopened), { code: 'COMPUTER_OUTCOME_UNKNOWN' })
  const review = { operation: 'reconcile', appId: app.id, operationId: pending.operationId }
  await assert.rejects(dispatch('computer-control', review, true), { code: 'COMPUTER_NOT_AUTHORIZED' })
  await assert.rejects(dispatch('computer-control', { ...review, operationId: 'old' }), { code: 'COMPUTER_NOT_AUTHORIZED' })
  state.localReview = false
  assert.deepEqual((await dispatch('computer-control', review)).pending, [pending])
  state.localReview = true
  assert.deepEqual((await dispatch('computer-control', review)).pending, [])
  assert.notEqual(await request(reopened), leaseId, 'review does not reuse the old local approval')
  assert.deepEqual(state.actions.map(action => action.action), ['windows', 'snapshot', 'click'])
})

test('observations and preflight failures create no pending input; acknowledged input clears its record', async context => {
  const { state, dispatch, tools, grant, request } = fixture(context)
  await grant('background')
  const call = tools()
  const leaseId = await request(call)
  const capture = leaseId => call('computer_use', { leaseId, action: 'snapshot', windowId: 7 })
  const type = leaseId => call('computer_use', { leaseId, action: 'type', windowId: 7, text: 'fixture input' })
  await capture(leaseId)
  assert.deepEqual((await dispatch('computer-status')).pending, [])
  state.preflightDenied = true
  await assert.rejects(type(leaseId), { code: 'COMPUTER_UNAVAILABLE' })
  assert.deepEqual((await dispatch('computer-status')).pending, [])
  state.preflightDenied = false
  const next = await request(call)
  await capture(next)
  await type(next)
  assert.deepEqual((await dispatch('computer-status')).pending, [])
})

test('Window operations cannot continue after the exact generation is replaced', async context => {
  const { facts, state, tools, grant, request } = fixture(context)
  await grant('view')
  const call = tools()
  const leaseId = await request(call)
  facts.assignment.generation = 'replaced'
  await assert.rejects(call('computer_use', { leaseId, action: 'snapshot', windowId: 7 }), { code: 'COMPUTER_NOT_AUTHORIZED' })
  assert.deepEqual(state.actions, [])
  assert.equal(state.indicator, false)
})
