import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(join(plugin, 'dev/harness/package.json'))
const { JSDOM } = requireHarness('jsdom')

test('product browser import previews value-free data, retries the same command and cancels the batch', async () => {
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
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-browser-import.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window,
      document: dom.window.document, crypto: globalThis.crypto, console })
    const calls = []
    const cancelled = []
    let changes = 0
    let commitAttempts = 0
    let previews = 0
    const preview = {
      source: { kind: 'file', label: 'fiction.cookies.json' },
      format: 'cookie-editor', flavor: null, entries: 2, cookies: 2,
      sourceDigest: 'a'.repeat(64),
      sites: [{ site: 'example.test', cookies: 2, session: 1, httpOnly: 1, skipped: 0 }],
      warnings: [], skipped: [], notes: ['session-cookies'], cookieValues: ['must-not-render'],
    }
    let batches = []
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'browser-import-list') return { items: structuredClone(batches) }
      if (endpoint === 'browser-import') {
        commitAttempts++
        if (commitAttempts === 1 || commitAttempts === 3) {
          const id = commitAttempts === 1 ? 'import-one' : 'import-two'
          const resourceId = commitAttempts === 1 ? 'resource-one' : 'resource-two'
          batches = [{ id: 'import-one', sourceRef: payload.sourceRef, resourceId: 'resource-one', environmentId: payload.environmentId,
            label: payload.label, status: 'unknown', preview, code: 'BROWSER_IMPORT_UNKNOWN',
            createdAt: 1, updatedAt: 2 }]
          if (commitAttempts === 3) batches = [{ id, sourceRef: payload.sourceRef, resourceId, environmentId: payload.environmentId,
            label: payload.label, status: 'unknown', preview, code: 'BROWSER_IMPORT_UNKNOWN',
            createdAt: 3, updatedAt: 4 }]
          throw Object.assign(new Error('The browser import result is unknown.'), { code: 'BROWSER_IMPORT_UNKNOWN' })
        }
        batches = [{ id: 'import-one', sourceRef: payload.sourceRef, resourceId: 'resource-one', environmentId: payload.environmentId,
          label: payload.label, status: 'applied', preview,
          report: { stored: 2, droppedCount: 0, failedCount: 0, dropped: [], failed: [], flushed: true },
          createdAt: 1, updatedAt: 3 }]
        return batches[0]
      }
      if (endpoint === 'browser-import-cancel') {
        batches = batches.map(batch => batch.id === payload.importId ? { ...batch, status: 'cancelled' } : batch)
        return batches.find(batch => batch.id === payload.importId)
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const browserBridge = {
      importSources: async () => [],
      importPick: async () => ({ id: previews++ === 0 ? 'pending-one' : 'pending-two', preview }),
      importCancel: async id => { cancelled.push(id) },
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const document = dom.window.document
    const click = async label => React.act(async () => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, `Missing button: ${label}`)
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const change = async (field, value) => React.act(async () => {
      const prototype = field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    try {
      await React.act(async () => root.render(React.createElement(module.exports.ProductBrowserImport, {
        binding: { instanceId: 'personal' }, call, browserBridge,
        directoryOptions: { directories: [{ id: 'local', title: 'Project' }] },
        onChanged: () => { changes++ },
      })))
      await click('Choose cookie export')
      assert.match(document.body.textContent, /fiction\.cookies\.json/u)
      assert.match(document.body.textContent, /example\.test/u)
      assert.equal(document.body.textContent.includes('must-not-render'), false)
      const name = document.querySelector('.bt-product-browser-import-preview input')
      await change(name, 'Imported private browser')
      const environment = document.querySelector('.bt-product-browser-import-preview select')
      await change(environment, 'local')
      await click('Import into new browser')
      assert.match(document.body.textContent, /Import needs retry/u)
      assert.match(document.body.textContent, /The browser import result is unknown/u)
      await click('Import into new browser')
      const commits = calls.filter(entry => entry.endpoint === 'browser-import')
      assert.equal(commits.length, 2)
      assert.equal(commits[0].payload.commandId, commits[1].payload.commandId)
      assert.equal(commits[0].payload.pendingId, 'pending-one')
      assert.equal(typeof commits[0].payload.sourceRef, 'string')
      assert.equal(commits[0].payload.environmentId, 'local')
      assert.equal(changes, 1)
      assert.match(document.body.textContent, /Import applied/u)
      await click('Choose cookie export')
      await change(document.querySelector('.bt-product-browser-import-preview input'), 'Second imported browser')
      await change(document.querySelector('.bt-product-browser-import-preview select'), 'local')
      await click('Import into new browser')
      assert.match(document.body.textContent, /Import needs retry/u)
      assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Use preview to retry'))
      await click('Cancel browser import')
      assert.equal(calls.some(entry => entry.endpoint === 'browser-import-cancel'), true)
      assert.equal(cancelled.at(-1), 'pending-two')
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
