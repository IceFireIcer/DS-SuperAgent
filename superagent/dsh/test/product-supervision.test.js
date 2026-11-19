import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(join(plugin, 'dev', 'harness', 'package.json'))

test('the existing settings view shows evidence and sends a decision only after a click', async () => {
  const { JSDOM } = requireHarness('jsdom')
  const React = requireHarness('react')
  const { createRoot } = requireHarness('react-dom/client')
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window; globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-supervision.js')], bundle: true,
    platform: 'browser', format: 'cjs', write: false, external: ['react'] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: id => id === 'react' ? React : requireHarness(id),
    setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto, Intl, Date, console })
  const proposal = { id: 'proposal-1', instanceId: 'private', ticketId: 'ticket-1', fingerprint: 'evidence-1', kind: 'correct',
    status: 'proposed', version: 'supervisor-r2', recommendation: 'Return to the listed files.',
    evidence: { assessment: { reason: 'The file list was ignored.' } }, impact: { summary: 'Adds one direction input.' }, createdAt: Date.now() }
  const calls = []
  let status = 'partial'
  const call = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'supervision') return { watchdogConfigured: false, run: { last: { at: Date.now(), status,
      partial: status !== 'completed', ...(status === 'failed' ? { error: 'INCOMPLETE_STATE' } : {}),
      coverage: { inspected: status === 'completed' ? 1001 : 100, batches: status === 'completed' ? 11 : 1 },
      budget: { used: 1, max: 24 } }, ...(status === 'partial' ? { checkpoint: { cursor: 'opaque' } } : {}) }, watchdog: null,
      proposals: [proposal], observation: payload.ticketId ? { history: [{ at: Date.now(), finding: 'deviation' }] } : null }
    if (endpoint === 'supervision-inspect') { status = 'completed'; return { status } }
    if (endpoint === 'supervision-decide') { proposal.status = 'approved'; proposal.action = { status: 'done', kind: 'direction' }; return proposal }
    throw new Error(`Unexpected product endpoint ${endpoint}`)
  }
  const root = createRoot(dom.window.document.querySelector('#root'))
  try {
    await React.act(async () => root.render(React.createElement(module.exports.ProductSupervisionSettings, {
      binding: { instanceId: 'private' }, call,
    })))
    assert.match(dom.window.document.body.textContent, /The file list was ignored/u)
    assert.match(dom.window.document.body.textContent, /Independent Watchdog is not configured/u)
    assert.match(dom.window.document.body.textContent, /Partial inspection/u)
    assert.match(dom.window.document.body.textContent, /Tickets inspected 100/u)
    assert.doesNotMatch(dom.window.document.body.textContent, /Inspection complete/u)
    const inspect = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'Inspect now')
    await React.act(async () => inspect.click())
    assert.match(dom.window.document.body.textContent, /Inspection complete/u)
    assert.match(dom.window.document.body.textContent, /Tickets inspected 1001/u)
    assert.equal(calls.some(item => item.endpoint === 'supervision-decide'), false)
    const history = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'View history')
    status = 'failed'
    await React.act(async () => history.click())
    assert.match(dom.window.document.body.textContent, /Inspection failed/u)
    const restart = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'Restart inspection')
    await React.act(async () => restart.click())
    assert.equal(calls.at(-2).endpoint, 'supervision-inspect')
    assert.equal(calls.at(-2).payload.restart, true)
    assert.match(dom.window.document.body.textContent, /Observation history/u)
    const approve = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'Approve')
    await React.act(async () => approve.click())
    const decision = calls.find(item => item.endpoint === 'supervision-decide')
    assert.equal(decision.payload.instanceId, 'private')
    assert.equal(decision.payload.fingerprint, 'evidence-1')
    assert.equal(decision.payload.decision, 'approve')
    assert.match(dom.window.document.body.textContent, /done/u)
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    globalThis.window = previous.window; globalThis.document = previous.document
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    globalThis.HTMLElement = previous.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
  }
})
