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

test('product settings save scoped rules and review and stop a prepared result', async () => {
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
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-proactive.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: id => id === 'react' ? React : requireHarness(id),
      window: dom.window, document: dom.window.document, crypto: globalThis.crypto, structuredClone,
      setInterval, clearInterval, setTimeout, clearTimeout, console })
    const { ProductProactiveSettings } = module.exports
    const calls = []
    let revision = 1, rules = [], paused = false
    const run = { id: 'review-one', ruleId: 'review-one', ruleRevision: 1, state: 'prepared', sourceInstanceId: 'feishu:fixture',
      eventId: 'event-one', summary: 'Review ready.', evidence: 'Verified source event.', modelSteps: 2,
      artifacts: [{ path: 'review.md', bytes: 6, sha256: 'a'.repeat(64) }],
      work: { ticketId: 'ticket-one', status: 'idle', stage: 'idle', lifecycle: 'open', reason: 'worker-idle',
        ticket: { id: 'ticket-one', state: 'open', directionVersion: 1 },
        mandate: { id: 'mandate-one', scope: 'Review the verified failure only.', strength: 'inferred', environment: 'local' },
        assignment: { id: 'assignment-one', generation: 'generation-two', state: 'running', environment: { kind: 'local' } },
        budgets: { preparationSteps: 2, preparationStepLimit: 8, routerSteps: 1, routerStepLimit: 2,
          workerLastTurnSteps: 4, workerTurnStepLimit: 8, workerAssignments: 2, maxArtifactBytes: 4096,
          ruleRunLimit: 3, ruleRunsUsed: 2, ruleWindowMs: 3_600_000 },
        usage: { roles: {
          preparation: { status: 'available', calls: 2, reportedCalls: 2, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
          router: { status: 'available', calls: 1, reportedCalls: 1, inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          worker: { status: 'partial', calls: 2, reportedCalls: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        }, total: { status: 'partial', calls: 5, reportedCalls: 4, inputTokens: 240, outputTokens: 60, totalTokens: 300 },
        cost: { status: 'unavailable', amount: null, currency: null } },
        control: { canStop: true }, reportState: 'current',
        report: { id: 'report-one', result: 'The verified review is ready.', evidence: 'Checked the source and artifact.',
          artifacts: [{ path: 'work.md', bytes: 12, sha256: 'b'.repeat(64) }] } } }
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'proactive-rules') return { revision, rules, control: { paused },
        sources: [{ sourceInstanceId: 'feishu:fixture', label: 'Feishu', kind: 'feishu' },
          { sourceInstanceId: 'github:acme/repo', label: 'GitHub acme/repo', kind: 'github' }] }
      if (endpoint === 'proactive-list') return { items: [run], total: 1 }
      if (endpoint === 'proactive-read') return run
      if (endpoint === 'proactive-artifact') return { text: 'review', nextOffset: 6, hasMore: false }
      if (endpoint === 'proactive-work-artifact') return { text: 'verified work', nextOffset: 13, hasMore: false }
      if (endpoint === 'proactive-save') { rules = payload.rules; revision++; return { revision, rules } }
      if (endpoint === 'proactive-pause') { paused = payload.paused; return { paused } }
      if (endpoint === 'proactive-stop') { run.state = 'stopped'; return run }
      throw new Error(`Unexpected product endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const click = async node => React.act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const change = async (field, value) => React.act(async () => {
      const type = field.tagName === 'SELECT' ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    try {
      await React.act(async () => { root.render(React.createElement(ProductProactiveSettings,
        { binding: { instanceId: 'private' }, call })) })
      const document = dom.window.document
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'New rule'))
      await change(document.querySelector('form input[maxlength="128"]'), 'Review changes')
      await change(document.querySelector('form select[value="observe"]') ?? document.querySelectorAll('form select')[1], 'auto')
      await click(document.querySelector('form button[type="submit"]'))
      const saved = calls.find(([endpoint]) => endpoint === 'proactive-save')[1].rules[0]
      assert.deepEqual(saved.match.sourceInstanceIds, ['feishu:fixture'])
      assert.equal(saved.mode, 'auto')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Edit rule'))
      await change(document.querySelectorAll('form select')[0], 'github:acme/repo')
      assert.deepEqual([...document.querySelectorAll('fieldset input')].map(input => input.checked), [true, true])
      await click(document.querySelector('fieldset input'))
      await click(document.querySelector('form button[type="submit"]'))
      const githubRule = calls.filter(([endpoint]) => endpoint === 'proactive-save').at(-1)[1].rules[0]
      assert.deepEqual(githubRule.match.sourceInstanceIds, ['github:acme/repo'])
      assert.deepEqual(Array.from(githubRule.match.actorKinds), ['ci'])
      const toggle = document.querySelector('[role="switch"]')
      await click(toggle)
      assert.equal(calls.find(([endpoint]) => endpoint === 'proactive-pause')[1].paused, true)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Review'))
      assert.match(document.body.textContent, /Verified source event/u)
      assert.match(document.body.textContent, /ticket-one/u)
      assert.match(document.body.textContent, /Review the verified failure only\./u)
      assert.match(document.body.textContent, /generation-two/u)
      assert.match(document.body.textContent, /The verified review is ready\./u)
      assert.match(document.body.textContent, /300 tok/u)
      assert.match(document.body.textContent, /Cost unavailable/u)
      assert.match(document.body.textContent, /Rule run budget: 2 \/ 3/u)
      assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'View work'), false)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Read file'))
      assert.match(document.body.textContent, /review/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Read verified file'))
      assert.match(document.body.textContent, /verified work/u)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Stop preparation'))
      assert.equal(calls.find(([endpoint]) => endpoint === 'proactive-stop')[1].runId, 'review-one')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Delete rule'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm delete rule'))
      assert.equal(rules.length, 0)
    } finally { await React.act(async () => root.unmount()) }
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    dom.window.close()
  }
})
