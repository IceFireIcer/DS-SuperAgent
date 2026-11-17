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

test('memory side query selects a role, searches, and reads bounded pages through product calls', async () => {
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
    let resolvePendingSideQuery
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'memory-list') return { items: [] }
      if (endpoint === 'memory-proposals') return []
      if (endpoint === 'memory-import-list') return { items: [] }
      if (endpoint === 'memory-access-read') return { revision: 0, enabled: true }
      if (endpoint === 'memory-side-query') {
        if (payload.query === 'stale') return new Promise(resolve => { resolvePendingSideQuery = resolve })
        return [{ id: 'fictional-memory', scope: { kind: 'work', workItemId: 'item-a' }, snippet: 'fictional note' }]
      }
      if (endpoint === 'memory-side-read') return payload.after
        ? { id: payload.id, text: ' end', pagination: { truncated: false } }
        : { id: payload.id, text: 'fictional note', pagination: { truncated: true, cursor: 'next' } }
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
      const button = [...doc.querySelectorAll('button')].find(item => item.textContent === label && !item.disabled)
      assert.ok(button, `Missing button: ${label}`)
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    try {
      await React.act(async () => root.render(React.createElement(module.exports.ProductMemorySettings,
        { binding: { instanceId: 'fictional-instance' }, works: [{ brief: { workItemId: 'item-a', goal: 'Fictional work' }, receipt: { status: 'accepted' } }], call })))
      await change('Reader', 'work')
      await change('Work', 'item-a')
      await change('Side query', 'fictional')
      await click('Search')
      assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([endpoint]) => endpoint === 'memory-side-query')?.[1])),
        { instanceId: 'fictional-instance', target: { kind: 'work', workItemId: 'item-a' }, query: 'fictional' })
      await click('View full detail')
      await click('Load more detail')
      assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([endpoint]) => endpoint === 'memory-side-read').map(([, payload]) => payload))), [
        { instanceId: 'fictional-instance', target: { kind: 'work', workItemId: 'item-a' }, id: 'fictional-memory', maxBytes: 4096 },
        { instanceId: 'fictional-instance', target: { kind: 'work', workItemId: 'item-a' }, id: 'fictional-memory', after: 'next', maxBytes: 4096 },
      ])
      assert.equal(doc.querySelector('.bt-product-memory-detail pre')?.textContent, 'fictional note end')
      await change('Reader', 'main')
      assert.equal(doc.querySelector('.bt-product-memory-detail'), null)
      await change('Side query', 'stale')
      await click('Search')
      assert.ok(resolvePendingSideQuery)
      await React.act(async () => root.render(React.createElement(module.exports.ProductMemorySettings,
        { binding: { instanceId: 'other-instance' }, works: [], call })))
      assert.equal(doc.querySelector('.bt-mem-entry-text')?.textContent, undefined)
      await React.act(async () => resolvePendingSideQuery([
        { id: 'old-instance-entry', scope: { kind: 'main' }, snippet: 'old instance data' },
      ]))
      assert.equal(doc.body.textContent.includes('old instance data'), false)
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
