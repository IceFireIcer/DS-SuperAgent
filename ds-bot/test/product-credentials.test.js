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

test('credential settings keep values out of projections and show exact grant and deletion receipts', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.confirm = () => true
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-credentials.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window,
      document: dom.window.document, crypto: globalThis.crypto, console })
    const { ProductCredentialSettings } = module.exports
    const calls = []
    let resource
    let feishuResourceId = null
    let githubResourceId = null
    let rotationCalls = 0
    const requests = []
    let loseRequestReceipt = true
    let failRequestList = false
    let paginateRequests = false
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'feishu-status') return { configured: true, credentialMode: 'managed', sourceInstanceId: 'source-one',
        resourceId: feishuResourceId, state: feishuResourceId ? 'polling' : 'failed' }
      if (endpoint === 'github-status') return { configured: true, credentialMode: 'managed', sourceInstanceId: 'github:acme/repo',
        resourceId: githubResourceId, state: githubResourceId ? 'polling' : 'failed' }
      if (endpoint === 'resource-select-feishu') { feishuResourceId = payload.resourceId; return { resourceId: feishuResourceId } }
      if (endpoint === 'resource-select-github') { githubResourceId = payload.resourceId; return { resourceId: githubResourceId } }
      if (endpoint === 'resource-list') {
        if (!resource) return { items: [] }
        if (payload.after) return { items: [{ id: 'resource-last', label: 'Last resource', status: 'active', revision: 1, grants: [] }] }
        return { items: [{ ...resource }, ...Array.from({ length: 99 }, (_, index) => ({ id: `other-${index}`,
          label: `Other resource ${index}`, status: 'active', revision: 1, grants: [] }))], cursor: 'next-page' }
      }
      if (endpoint === 'resource-request-list') {
        if (failRequestList) { failRequestList = false; throw new Error('Request list unavailable') }
        if (paginateRequests && !payload.after) return { items: [], cursor: 'request-next-page' }
        return { items: requests.map(({ commandId: _commandId, ...request }) => ({ ...request })) }
      }
      if (endpoint === 'resource-create') {
        resource = { id: 'resource-one', label: payload.label, status: 'active', revision: 1, grants: [] }
        return { ...resource }
      }
      if (endpoint === 'resource-request') {
        let request = requests.find(item => item.commandId === payload.commandId)
        if (!request) {
          request = { commandId: payload.commandId, id: `request-${requests.length + 1}`, resourceId: payload.resourceId,
            scope: payload.scope, purpose: payload.purpose, status: 'pending' }
          requests.push(request)
        }
        if (loseRequestReceipt) { loseRequestReceipt = false; throw new Error('Request response lost') }
        const { commandId: _commandId, ...result } = request
        return { ...result }
      }
      if (endpoint === 'resource-cancel') {
        const request = requests.find(item => item.id === payload.requestId)
        request.status = 'cancelled'
        return { ...request }
      }
      if (endpoint === 'resource-grant') {
        if (payload.requestId) requests.find(item => item.id === payload.requestId).status = 'granted'
        resource = { ...resource, revision: 2, grants: [{ id: 'grant-one', scope: payload.scope, purposes: payload.purposes }] }
        return { ...resource }
      }
      if (endpoint === 'resource-rotate') {
        rotationCalls++
        if (rotationCalls === 1) throw new Error(`A provider error must not show ${payload.value}`)
        resource = { ...resource, revision: resource.revision + 1 }
        return { status: 'committed', resource: { ...resource }, cleanupPending: false }
      }
      if (endpoint === 'resource-rotation-read') return { status: rotationCalls === 1 ? 'pending' : 'committed',
        resourceId: resource.id, cleanupPending: rotationCalls === 1, resource: { ...resource } }
      if (endpoint === 'resource-revoke') { resource = { ...resource, revision: resource.revision + 1, grants: [] }; return { ...resource } }
      if (endpoint === 'resource-delete') { resource = { ...resource, revision: resource.revision + 1, status: 'deleted' }; return { ...resource } }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    let root = createRoot(dom.window.document.querySelector('#root'))
    const click = async node => { await React.act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))) }
    const change = async (field, value) => React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    try {
      await React.act(async () => root.render(React.createElement(ProductCredentialSettings,
        { binding: { instanceId: 'personal' }, call })))
      const document = dom.window.document
      await change(document.querySelector('.bt-product-resource-create input[maxlength="128"]'), 'Issue delivery')
      await change(document.querySelector('.bt-product-resource-create input[type="password"]'), 'fictional-resource-value')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Save resource'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-create').payload.value, 'fictional-resource-value')
      assert.equal(document.querySelector('input[type="password"]').value, '')
      assert.equal(document.body.textContent.includes('fictional-resource-value'), false)
      assert.equal(calls.some(entry => entry.endpoint === 'resource-list' && entry.payload.after === 'next-page'), true)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Issue delivery'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Use for GitHub'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-select-github').payload.resourceId, 'resource-one')
      assert.match(document.body.textContent, /Selected GitHub resource: Issue delivery/u)
      assert.equal(document.querySelectorAll('.bt-product-resource-grant input')[2].value, 'github:acme/repo')
      const scopeInputs = document.querySelectorAll('.bt-product-resource-grant input')
      await change(scopeInputs[0], 'item-one')
      await change(scopeInputs[1], 'work-one')
      await change(scopeInputs[2], 'source-one')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Request authorization'))
      assert.match(document.body.textContent, /Request response lost/u)
      const pendingRequest = JSON.parse(dom.window.sessionStorage.getItem('product-request:personal'))
      assert.equal(pendingRequest.payload.resourceId, 'resource-one')
      await React.act(async () => root.unmount())
      root = createRoot(document.querySelector('#root'))
      await React.act(async () => root.render(React.createElement(ProductCredentialSettings,
        { binding: { instanceId: 'personal' }, call })))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Request authorization'))
      assert.equal(requests[0].status, 'pending')
      assert.equal(requests.length, 1)
      assert.equal(calls.filter(entry => entry.endpoint === 'resource-request')[0].payload.commandId,
        calls.filter(entry => entry.endpoint === 'resource-request')[1].payload.commandId)
      assert.equal(dom.window.sessionStorage.getItem('product-request:personal'), null)
      assert.match(document.body.textContent, /Pending authorization request/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel request'))
      assert.equal(requests[0].status, 'cancelled')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Request authorization'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Approve request'))
      assert.equal(requests[1].status, 'granted')
      assert.equal(calls.find(entry => entry.endpoint === 'resource-grant').payload.requestId, requests[1].id)
      assert.deepEqual(JSON.parse(JSON.stringify(calls.find(entry => entry.endpoint === 'resource-grant').payload.scope)),
        { role: 'worker', workItemId: 'item-one', environmentId: 'work-one', sourceInstanceId: 'source-one' })
      assert.match(document.body.textContent, /worker · tool/u)
      await change(document.querySelector('.bt-product-resource-selected input[type="password"]'), 'fictional-next-value')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Rotate credential'))
      assert.match(document.body.textContent, /Rotation is pending/u)
      assert.equal(document.body.textContent.includes('fictional-next-value'), false)
      assert.ok(dom.window.sessionStorage.getItem('product-rotation:personal'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Check rotation'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Retry rotation'))
      const rotations = calls.filter(entry => entry.endpoint === 'resource-rotate')
      assert.equal(rotations.length, 2)
      assert.equal(rotations[0].payload.commandId, rotations[1].payload.commandId)
      assert.equal(dom.window.sessionStorage.getItem('product-rotation:personal'), null)
      assert.equal(document.querySelector('.bt-product-resource-selected input[type="password"]').value, '')
      assert.match(document.body.textContent, /Credential rotated\./u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Use for Feishu'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-select-feishu').payload.resourceId, 'resource-one')
      assert.match(document.body.textContent, /Selected Feishu resource: Issue delivery/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Clear Feishu selection'))
      assert.equal(calls.filter(entry => entry.endpoint === 'resource-select-feishu').at(-1).payload.resourceId, null)
      for (const value of ['item-one', 'work-one', 'source-one']) assert.match(document.body.textContent, new RegExp(value, 'u'))
      failRequestList = true
      paginateRequests = true
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Revoke authorization'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-revoke').payload.grantId, 'grant-one')
      assert.match(document.body.textContent, /Request list unavailable/u)
      assert.match(document.body.textContent, /Issue delivery/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Retry request list'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Load more requests'))
      assert.equal(calls.some(entry => entry.endpoint === 'resource-request-list' && entry.payload.after === 'request-next-page'), true)
      assert.match(document.body.textContent, /Current access revoked/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Delete resource'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-delete').payload.resourceId, 'resource-one')
      assert.match(document.body.textContent, /deleted · v5/u)
    } finally { await React.act(async () => root.unmount()) }
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(globalThis, key, { configurable: true, value })
      else if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
