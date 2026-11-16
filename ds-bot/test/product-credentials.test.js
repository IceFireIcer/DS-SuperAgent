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
    let rotationCalls = 0
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'feishu-status') return { configured: true, credentialMode: 'managed', sourceInstanceId: 'source-one',
        resourceId: feishuResourceId, state: feishuResourceId ? 'polling' : 'failed' }
      if (endpoint === 'resource-select-feishu') { feishuResourceId = payload.resourceId; return { resourceId: feishuResourceId } }
      if (endpoint === 'resource-list') {
        if (!resource) return { items: [] }
        if (payload.after) return { items: [{ id: 'resource-last', label: 'Last resource', status: 'active', revision: 1, grants: [] }] }
        return { items: [{ ...resource }, ...Array.from({ length: 99 }, (_, index) => ({ id: `other-${index}`,
          label: `Other resource ${index}`, status: 'active', revision: 1, grants: [] }))], cursor: 'next-page' }
      }
      if (endpoint === 'resource-create') {
        resource = { id: 'resource-one', label: payload.label, status: 'active', revision: 1, grants: [] }
        return { ...resource }
      }
      if (endpoint === 'resource-grant') {
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
    const root = createRoot(dom.window.document.querySelector('#root'))
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
      const scopeInputs = document.querySelectorAll('.bt-product-resource-grant input')
      await change(scopeInputs[0], 'item-one')
      await change(scopeInputs[1], 'work-one')
      await change(scopeInputs[2], 'source-one')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Record authorization'))
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
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Revoke authorization'))
      assert.equal(calls.find(entry => entry.endpoint === 'resource-revoke').payload.grantId, 'grant-one')
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
