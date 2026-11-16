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

test('product MCP settings use local scoped commands and retry the original uncertain action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-mcp-settings.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window,
      document: dom.window.document, crypto: globalThis.crypto, console })
    const { ProductMcpSettings } = module.exports
    const calls = []
    const receipts = new Map()
    let lostDisconnect = true
    let denyConnect = true
    let state = { configured: true, serverName: 'approved', toolName: 'check', location: 'host', remote: 'unsupported',
      resourceId: 'deployment-resource', revision: 0, approved: true, connected: true, state: 'error' }
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'mcp-status') return { ...state }
      if (endpoint === 'resource-list') return { items: [{ id: 'resource-one', label: 'Fixture MCP', status: 'active', revision: 1 }] }
      if (receipts.has(payload.commandId)) return receipts.get(payload.commandId)
      if (endpoint === 'mcp-connect' && denyConnect) {
        denyConnect = false
        throw Object.assign(new Error('Grant needed'), { code: 'GRANT_DENIED' })
      }
      if (endpoint === 'mcp-save') state = { ...state, resourceId: payload.resourceId, approved: false, connected: false,
        revision: state.revision + 1, state: 'needs-approval', error: undefined }
      if (endpoint === 'mcp-approve') state = { ...state, approved: payload.approved, revision: state.revision + 1,
        state: payload.approved ? 'off' : 'needs-approval' }
      if (endpoint === 'mcp-connect' || endpoint === 'mcp-retry') state = { ...state, connected: true,
        revision: state.revision + 1, state: 'ready' }
      if (endpoint === 'mcp-disconnect') state = { ...state, connected: false,
        revision: state.revision + 1, state: 'off' }
      receipts.set(payload.commandId, { ...state })
      if (endpoint === 'mcp-disconnect' && lostDisconnect) { lostDisconnect = false; throw new Error('Response lost') }
      return { ...state }
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    dom.window.sessionStorage.setItem('product-mcp-command:personal', JSON.stringify({ endpoint: 'resource-delete',
      commandId: 'forged', expectedRevision: 1, resourceId: 'resource-one' }))
    const click = async label => React.act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, `Missing ${label}`)
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    try {
      await React.act(async () => root.render(React.createElement(ProductMcpSettings,
        { binding: { instanceId: 'personal' }, call })))
      const document = dom.window.document
      assert.equal(calls.some(entry => entry.endpoint === 'resource-delete'), false)
      assert.equal(dom.window.sessionStorage.getItem('product-mcp-command:personal'), null)
      const select = document.querySelector('select')
      await React.act(async () => { select.value = 'resource-one'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
      await click('Save MCP resource')
      assert.equal(calls.find(entry => entry.endpoint === 'mcp-save').payload.resourceId, 'resource-one')
      await click('Approve tool')
      await click('Connect')
      assert.equal(dom.window.sessionStorage.getItem('product-mcp-command:personal'), null)
      assert.match(document.body.textContent, /Grant needed/u)
      await click('Connect')
      assert.match(document.body.textContent, /MCP state: ready/u)
      await click('Disconnect')
      assert.match(document.body.textContent, /MCP change pending confirmation/u)
      assert.ok(dom.window.sessionStorage.getItem('product-mcp-command:personal'))
      await click('Retry pending change')
      const attempts = calls.filter(entry => entry.endpoint === 'mcp-disconnect')
      assert.equal(attempts.length, 2)
      assert.equal(attempts[0].payload.commandId, attempts[1].payload.commandId)
      assert.equal(dom.window.sessionStorage.getItem('product-mcp-command:personal'), null)
      await click('Try again')
      assert.match(document.body.textContent, /MCP state: ready/u)
      assert.equal(document.body.textContent.includes('fictional-secret'), false)
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
