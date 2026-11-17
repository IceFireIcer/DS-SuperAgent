import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(plugin, 'dev', 'harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

test('product browser settings manage isolated resources, work grants and unknown operations', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.confirm = () => true
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false })
  const intervals = []
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length }
  dom.window.clearInterval = () => {}
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-browser-settings.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window,
      document: dom.window.document, crypto: globalThis.crypto, console })
    const { ProductBrowserSettings } = module.exports
    const calls = []
    const receipts = new Map()
    let loseCreate = true
    const operation = { id: 'operation-one', resourceId: 'browser-one', ticketId: 'ticket-one', workItemId: 'item-one',
      assignmentId: 'assignment-one', generation: 'generation-one', ownerRuntime: 'old-runtime', action: 'open',
      state: 'unknown', createdAt: 1 }
    let resources = [{
      id: 'browser-one', environmentId: 'local', label: 'Research browser', revision: 1, state: 'unknown',
      grants: [], owner: { ticketId: 'ticket-one', assignmentId: 'assignment-one', generation: 'generation-one' },
      operations: [operation],
    }]
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'browser-list') return structuredClone(resources)
      if (receipts.has(payload.commandId)) return structuredClone(receipts.get(payload.commandId))
      if (endpoint === 'browser-create') {
        const resource = { id: 'browser-two', environmentId: payload.environmentId, label: payload.label,
          revision: 1, state: 'available', grants: [], operations: [] }
        resources = [...resources, resource]
        receipts.set(payload.commandId, resource)
        if (loseCreate) { loseCreate = false; throw new Error('Create response lost') }
        return structuredClone(resource)
      }
      if (endpoint === 'browser-grant') {
        const current = resources.find(resource => resource.id === payload.resourceId)
        const next = { ...current, revision: current.revision + 1,
          grants: [...current.grants.filter(grant => grant.workItemId !== payload.workItemId),
            { workItemId: payload.workItemId, active: payload.active }] }
        resources = resources.map(resource => resource.id === next.id ? next : resource)
        receipts.set(payload.commandId, next)
        return structuredClone(next)
      }
      if (endpoint === 'browser-resolve') {
        const current = resources.find(resource => resource.id === payload.resourceId)
        const next = { ...current, state: 'available', owner: undefined,
          operations: current.operations.map(item => item.id === payload.operationId
            ? { ...item, state: 'resolved', resolution: payload.reason } : item) }
        resources = resources.map(resource => resource.id === next.id ? next : resource)
        receipts.set(payload.commandId, next.operations.find(item => item.id === payload.operationId))
        return structuredClone(receipts.get(payload.commandId))
      }
      if (endpoint === 'browser-revoke') {
        const current = resources.find(resource => resource.id === payload.resourceId)
        const next = { ...current, revision: current.revision + 1, state: 'revoked' }
        resources = resources.map(resource => resource.id === next.id ? next : resource)
        receipts.set(payload.commandId, next)
        return structuredClone(next)
      }
      if (endpoint === 'browser-take') {
        const current = resources.find(resource => resource.id === payload.resourceId)
        const control = { id: 'control-one', state: 'held', ticketId: 'ticket-one', workItemId: payload.workItemId,
          assignmentId: 'assignment-one', generation: 'generation-one', responsibleActorId: 'alice' }
        resources = resources.map(resource => resource.id === current.id ? { ...current, state: 'human', control,
          revision: current.revision + 1 } : resource)
        receipts.set(payload.commandId, control)
        return structuredClone(control)
      }
      if (endpoint === 'browser-control-view') return { profileKey: 'session-11111111-1111-4111-8111-111111111111' }
      if (endpoint === 'browser-return') {
        const current = resources.find(resource => resource.id === payload.resourceId)
        resources = resources.map(resource => resource.id === current.id ? { ...current, state: 'available', control: undefined } : resource)
        const result = { id: payload.controlId, state: 'returned' }
        receipts.set(payload.commandId, result)
        return result
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const props = { binding: { instanceId: 'personal' }, call,
      works: [{ receipt: { status: 'accepted' }, brief: { workItemId: 'item-one', environmentId: 'local', goal: 'Research the fixture.' } }],
      directoryOptions: { directories: [{ id: 'local', title: 'Project' }, { id: 'other', title: 'Other project' }] } }
    const click = async label => {
      const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, `Missing ${label}`)
      await React.act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    }
    const change = async (field, value) => React.act(async () => {
      const prototype = field instanceof dom.window.HTMLSelectElement
        ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
    let root = createRoot(dom.window.document.querySelector('#root'))
    try {
      await React.act(async () => root.render(React.createElement(ProductBrowserSettings, props)))
      assert.match(dom.window.document.body.textContent, /Outcome unknown/u)
      assert.match(dom.window.document.body.textContent, /operation-one/u)
      const beforeRefresh = calls.filter(entry => entry.endpoint === 'browser-list').length
      await React.act(async () => intervals.at(-1)())
      assert.ok(calls.filter(entry => entry.endpoint === 'browser-list').length > beforeRefresh)
      await click('Refresh browser resources')
      await change(dom.window.document.querySelector('.bt-product-browser-create input'), 'Private research')
      await click('Create browser resource')
      assert.match(dom.window.document.body.textContent, /Create response lost/u)
      assert.ok(dom.window.sessionStorage.getItem('product-browser-command:personal'))
      const environment = dom.window.document.querySelector('.bt-product-browser-create select')
      await change(environment, 'other')
      assert.equal(environment.value, 'other', 'a pending create must not lock another Environment')
      await change(environment, 'local')
      await click('Grant browser to this work')
      assert.equal(calls.filter(entry => entry.endpoint === 'browser-grant').length, 1,
        'an unrelated pending create must not block an existing resource grant')
      await click('Retry pending browser change')
      const creates = calls.filter(entry => entry.endpoint === 'browser-create')
      assert.equal(creates.length, 2)
      assert.equal(creates[0].payload.commandId, creates[1].payload.commandId)
      assert.equal(dom.window.sessionStorage.getItem('product-browser-command:personal'), null)
      await click('Private research')
      await click('Grant browser to this work')
      assert.equal(calls.find(entry => entry.endpoint === 'browser-grant').payload.active, true)
      await click('Revoke browser from this work')
      assert.equal(calls.filter(entry => entry.endpoint === 'browser-grant').at(-1).payload.active, false)
      await click('Research browser')
      const reason = dom.window.document.querySelector('.bt-product-browser-resolve select')
      await change(reason, 'UNCHANGED')
      await click('Record browser check')
      assert.equal(calls.find(entry => entry.endpoint === 'browser-resolve').payload.operationId, 'operation-one')
      assert.equal(calls.find(entry => entry.endpoint === 'browser-resolve').payload.reason, 'UNCHANGED')
      assert.match(dom.window.document.body.textContent, /Page stayed on the original view/u)
      await click('Revoke browser resource')
      assert.equal(calls.some(entry => entry.endpoint === 'browser-revoke'), true)
      assert.match(dom.window.document.body.textContent, /Revoked/u)
      await React.act(async () => root.unmount())
      root = createRoot(dom.window.document.querySelector('#root'))
      dom.window.sessionStorage.setItem('product-browser-command:personal', JSON.stringify({
        'grant:missing:missing': { endpoint: 'browser-grant', commandId: 'missing-command', fingerprint: 'fixture',
          input: { resourceId: 'missing', workItemId: 'missing', expectedRevision: 1, active: true } },
        'resolve:other:operation-two': { endpoint: 'browser-resolve', commandId: 'resolve-command', fingerprint: 'fixture',
          input: { resourceId: 'other', operationId: 'operation-two' } },
      }))
      await React.act(async () => root.render(React.createElement(ProductBrowserSettings, {
        ...props, works: [],
        call: async endpoint => {
          if (endpoint === 'browser-list') return structuredClone(resources)
          throw Object.assign(new Error('The browser resource no longer exists.'), { code: 'NOT_FOUND' })
        },
      })))
      assert.ok([...dom.window.document.querySelectorAll('button')].some(button => button.textContent === 'Revoke browser resource'),
        'the resource can still be revoked without an accepted work item')
      const retryLabels = [...dom.window.document.querySelectorAll('button')]
        .filter(button => button.getAttribute('aria-label')?.startsWith('Retry '))
        .map(button => button.getAttribute('aria-label'))
      assert.equal(retryLabels.length, 2)
      assert.equal(new Set(retryLabels).size, 2, 'pending actions identify their resource or operation')
      const retryGrant = [...dom.window.document.querySelectorAll('button')]
        .find(button => button.getAttribute('aria-label')?.includes('Change browser grant'))
      assert.ok(retryGrant)
      await React.act(async () => retryGrant.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      assert.deepEqual(Object.keys(JSON.parse(dom.window.sessionStorage.getItem('product-browser-command:personal'))),
        ['resolve:other:operation-two'])
      assert.match(dom.window.document.body.textContent, /no longer exists/u)
      await React.act(async () => root.unmount())
      root = createRoot(dom.window.document.querySelector('#root'))
      let delayedReads = false
      const pendingReads = []
      const raceResource = { id: 'race-browser', environmentId: 'local', label: 'Race browser',
        revision: 1, state: 'available', grants: [], operations: [] }
      const raceCall = async endpoint => {
        if (endpoint !== 'browser-list') throw new Error(`Unexpected endpoint: ${endpoint}`)
        if (!delayedReads) return [structuredClone(raceResource)]
        return new Promise(resolve => pendingReads.push(resolve))
      }
      await React.act(async () => root.render(React.createElement(ProductBrowserSettings, {
        ...props, works: [], call: raceCall,
      })))
      delayedReads = true
      await click('Refresh browser resources')
      await click('Refresh browser resources')
      assert.equal(pendingReads.length, 2)
      await React.act(async () => pendingReads[1]([{ ...raceResource, revision: 9, state: 'busy' }]))
      await React.act(async () => pendingReads[0]([{ ...raceResource, revision: 1, state: 'available' }]))
      assert.match(dom.window.document.body.textContent, /In use/u)
      assert.match(dom.window.document.body.textContent, /v9/u)
      await React.act(async () => root.unmount())
      root = createRoot(dom.window.document.querySelector('#root'))
      dom.window.sessionStorage.clear()
      resources = [{ id: 'browser-one', environmentId: 'local', label: 'Research browser', revision: 3,
        state: 'available', grants: [{ workItemId: 'item-one', active: true }], operations: [] }]
      const viewCalls = []
      const browserBridge = { views: {
        create: async (...args) => { viewCalls.push(['create', ...args]); return args[1] },
        place: async (...args) => { viewCalls.push(['place', ...args]); return true },
        navigate: async (...args) => { viewCalls.push(['navigate', ...args]) },
        close: async (...args) => { viewCalls.push(['close', ...args]) },
      } }
      await React.act(async () => root.render(React.createElement(ProductBrowserSettings, { ...props, browserBridge })))
      await click('Take over browser')
      assert.equal(calls.find(entry => entry.endpoint === 'browser-take').payload.workItemId, 'item-one')
      assert.match(dom.window.document.body.textContent, /Human control/u)
      assert.equal(viewCalls.some(entry => entry[0] === 'create'
        && entry[1] === 'session-11111111-1111-4111-8111-111111111111'), true)
      await change(dom.window.document.querySelector('.bt-product-manual-browser-form input'), 'https://example.test/')
      await React.act(async () => dom.window.document.querySelector('.bt-product-manual-browser-form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
      assert.equal(viewCalls.some(entry => entry[0] === 'navigate' && entry[3] === 'https://example.test/'), true)
      await click('Give browser back')
      assert.equal(calls.find(entry => entry.endpoint === 'browser-return').payload.controlId, 'control-one')
      assert.equal(viewCalls.some(entry => entry[0] === 'close'), true)
      await React.act(async () => root.unmount())
      root = createRoot(dom.window.document.querySelector('#root'))
      await React.act(async () => root.render(React.createElement(ProductBrowserSettings, {
        ...props, call: async () => { throw Object.assign(new Error('No browser bridge.'), { code: 'UNAVAILABLE' }) },
      })))
      assert.match(dom.window.document.body.textContent, /no CDP browser bridge/u)
    } finally {
      await React.act(async () => root.unmount())
    }
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(globalThis, key, { configurable: true, value })
      else if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
