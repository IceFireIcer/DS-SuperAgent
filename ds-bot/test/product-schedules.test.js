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

test('product schedules create an explicit work target and guard source and cancellation controls', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16)
  dom.window.cancelAnimationFrame = clearTimeout
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-schedules.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: id => id === 'react' ? React : requireHarness(id),
      window: dom.window, document: dom.window.document, crypto: globalThis.crypto,
      Intl, Date, setInterval, clearInterval, setTimeout, clearTimeout,
      requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame, console })
    const { ProductScheduleSettings } = module.exports
    const calls = []
    let enabled = true
    let cancelled = false
    const rule = { ruleId: 'schedule-one', title: 'Release check', text: 'Review the release.', timezone: 'UTC',
      when: { kind: 'daily', time: '09:00' }, target: { kind: 'main' }, status: 'active',
      nextAt: Date.now() + 86_400_000, createdAt: Date.now() }
    const rules = [rule]
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'schedule-list') return { items: rules.map(item => ({ ...item, status: item === rule && cancelled ? 'cancelled' : 'active' })) }
      if (endpoint === 'schedule-source-read') return { enabled }
      if (endpoint === 'schedule-read') return { ...rules.find(item => item.ruleId === payload.ruleId), occurrences: [] }
      if (endpoint === 'schedule-create') { rules.push({ ...rule, ...payload, ruleId: 'schedule-two' }); return rules.at(-1) }
      if (endpoint === 'schedule-source-set') { enabled = payload.enabled; return { enabled } }
      if (endpoint === 'schedule-cancel') { cancelled = true; return { ...rule, status: 'cancelled' } }
      throw new Error(`Unexpected product endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const click = async node => { await React.act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }) }
    try {
      await React.act(async () => { root.render(React.createElement(ProductScheduleSettings,
        { binding: { instanceId: 'personal' }, works: [{ brief: { workItemId: 'work-a', goal: 'Check A' },
          receipt: { status: 'accepted' }, control: { ticketId: 'ticket-a' } }], call, onViewWork: () => {} })) })
      const document = dom.window.document
      assert.match(document.body.textContent, /Release check/u)
      const toggle = document.querySelector('[role="switch"]')
      assert.equal(toggle.getAttribute('aria-checked'), 'true')
      await click(toggle)
      assert.equal(calls.find(([endpoint]) => endpoint === 'schedule-source-set')[1].enabled, false)
      assert.equal(document.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false')
      await click(document.querySelector('button[aria-label="Delete task"]'))
      assert.equal(calls.some(([endpoint]) => endpoint === 'schedule-cancel'), false)
      await click(document.querySelector('button[aria-label="Click again to delete"]'))
      assert.equal(calls.some(([endpoint]) => endpoint === 'schedule-cancel'), true)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'New task'))
      assert.ok(document.querySelector('form select[aria-label="Send to"] option[value="main"]'))
      assert.ok(document.querySelector('form [aria-label="When"]'))
      const change = async (field, value) => {
        await React.act(async () => {
          const prototype = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
            : field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
          field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
        })
      }
      await change(document.querySelector('form input[maxlength="120"]'), 'Work check')
      await change(document.querySelector('form textarea'), 'Check the existing work again.')
      await change(document.querySelector('form select[aria-label="Send to"]'), 'work-a')
      await click(document.querySelector('form button[type="submit"]'))
      const created = calls.find(([endpoint]) => endpoint === 'schedule-create')?.[1]
      assert.deepEqual(JSON.parse(JSON.stringify(created?.target)), { kind: 'work', workItemId: 'work-a', ticketId: 'ticket-a' })
      assert.deepEqual(JSON.parse(JSON.stringify(created?.when)), { kind: 'daily', time: '09:00' })
      assert.match(document.body.textContent, /Work check/u)
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
