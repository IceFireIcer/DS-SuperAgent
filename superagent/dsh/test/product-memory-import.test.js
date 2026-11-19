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

test('memory import previews source ownership and requires an explicit item target', async () => {
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
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-memory.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : requireHarness(id),
      window: dom.window, document: dom.window.document, crypto: globalThis.crypto,
      Intl, Date, setTimeout, clearTimeout, console })

    const calls = []
    const preview = {
      id: 'batch-fictional', sourceHash: 'abc123', sourceName: 'legacy-memory.json',
      origin: { owner: 'Legacy Alice', instanceId: 'legacy-instance' },
      status: 'partial', targetInstanceId: 'fictional-instance', targetRoles: ['main', 'worker', 'shared'],
      items: [
        { sourceId: 'legacy-1', originalScope: { kind: 'main', role: 'Legacy Main' }, status: 'ready',
          text: 'Fictional portable fact' },
        { sourceId: 'legacy-2', originalScope: { kind: 'work', role: 'Legacy Writer', work: 'Old work' },
          status: 'conflict', reason: 'DUPLICATE_MEMORY', existingMemoryId: 'existing-fictional',
          text: 'Fictional duplicate fact' },
      ],
    }
    const committed = {
      ...preview, status: 'completed',
      items: [
        { ...preview.items[0], status: 'imported', target: { kind: 'main' }, entryId: 'new-fictional' },
        preview.items[1],
      ],
    }
    const cancelled = { ...preview, status: 'cancelled' }
    const otherPreview = {
      ...preview, id: 'batch-other', sourceName: 'other-memory.json', status: 'ready',
      items: [{ ...preview.items[0], text: 'Other portable fact' }],
    }
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'memory-list') return { items: [] }
      if (endpoint === 'memory-proposals') return []
      if (endpoint === 'memory-access-read') return { revision: 0, enabled: false }
      if (endpoint === 'memory-import-list') return { items: [otherPreview] }
      if (endpoint === 'memory-import-preview') return preview
      if (endpoint === 'memory-import-read') return payload.batchId === 'batch-other' ? otherPreview : preview
      if (endpoint === 'memory-import-commit') return committed
      if (endpoint === 'memory-import-cancel') return cancelled
      if (endpoint === 'memory-import-retry') return preview
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const doc = dom.window.document
    const change = async (label, value) => React.act(async () => {
      const field = doc.querySelector(`[aria-label="${label}"]`)
      assert.ok(field, `Missing field: ${label}`)
      const proto = field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    const click = async label => React.act(async () => {
      const control = [...doc.querySelectorAll('button, input[type=checkbox]')]
        .find(item => item.textContent === label || item.getAttribute('aria-label') === label)
      assert.ok(control, `Missing control: ${label}`)
      control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    try {
      await React.act(async () => root.render(React.createElement(module.exports.ProductMemorySettings,
        { binding: { instanceId: 'fictional-instance' },
          works: [{ brief: { workItemId: 'item-a', goal: 'Fictional target work' }, receipt: { status: 'accepted' } }], call })))
      const fileInput = doc.querySelector('[aria-label="Choose memory export"]')
      assert.ok(fileInput)
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [{
        name: 'legacy-memory.json', size: 128,
        arrayBuffer: async () => Uint8Array.from(Buffer.from(JSON.stringify({
          schema: 'ds-bot-memory-export', version: 1,
        }))).buffer,
      }] })
      await React.act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
      const previewCall = calls.find(([endpoint]) => endpoint === 'memory-import-preview')
      assert.ok(previewCall?.[1].commandId)
      assert.equal(previewCall[1].sourceName, 'legacy-memory.json')
      assert.equal(typeof previewCall[1].dataBase64, 'string')
      assert.match(doc.body.textContent, /Legacy Alice/)
      assert.match(doc.body.textContent, /Legacy Writer/)
      assert.match(doc.body.textContent, /Fictional portable fact/)
      assert.match(doc.body.textContent, /Fictional target work/)

      await change('Saved memory imports', 'batch-fictional')
      await click('Open import')
      assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([endpoint]) => endpoint === 'memory-import-read')?.[1])),
        { instanceId: 'fictional-instance', batchId: 'batch-fictional' })

      await click('Import item legacy-1')
      await change('Target role legacy-1', 'shared')
      await click('Share with Main legacy-1')
      await change('Saved memory imports', 'batch-other')
      await click('Open import')
      assert.equal(doc.querySelector('[aria-label="Import item legacy-1"]')?.checked, false)
      assert.equal(doc.querySelector('[aria-label="Target role legacy-1"]'), null)
      await change('Saved memory imports', 'batch-fictional')
      await click('Open import')

      await click('Cancel import')
      assert.equal(calls.some(([endpoint]) => endpoint === 'memory-import-cancel'), true)
      assert.ok(doc.body.textContent.includes('Retry import'))
      await click('Retry import')
      assert.equal(calls.some(([endpoint]) => endpoint === 'memory-import-retry'), true)
      assert.match(doc.body.textContent, /Memory import is ready to continue/)

      await click('Import item legacy-1')
      await change('Target role legacy-1', 'shared')
      await click('Share with Main legacy-1')
      await click('Import selected')
      const commit = calls.find(([endpoint]) => endpoint === 'memory-import-commit')
      assert.deepEqual(JSON.parse(JSON.stringify(commit?.[1].selections)),
        [{ sourceId: 'legacy-1', scope: { kind: 'shared', main: true, workItemIds: [] } }])
      assert.ok(commit[1].commandId)
      assert.match(doc.body.textContent, /Imported to/)
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
