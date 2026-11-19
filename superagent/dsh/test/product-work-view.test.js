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

test('Main work cards keep an answerable view separate from a read-only result view', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  let cleanup
  let root
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/*'] })
    const module = { exports: {} }
    const requests = []
    const questionView = { title: 'Choose a note layout', view: { type: 'options', id: 'layout', options: [
      { label: 'Compact' }, { label: 'Detailed' },
    ] } }
    const readOnlyView = { title: 'Review only', view: { type: 'options', id: 'review', options: [
      { label: 'Read only choice' },
    ] } }
    const resultView = { title: 'Chosen layout', view: { type: 'metric', label: 'Layout', value: 'Detailed' } }
    const history = { messages: [], sources: [], preparations: [], health: { state: 'ready' }, works: [{
      brief: { id: 'brief-view', workItemId: 'item-view', goal: 'Create a reviewed note.', constraints: 'Choose a layout.',
        acceptanceCriteria: 'Return a file and view.', target: 'local-only' },
      receipt: { status: 'accepted', ticketId: 'ticket-view' }, status: 'waiting',
      control: { workItemId: 'item-view', ticketId: 'ticket-view', ticketVersion: 2,
        permissions: { actorId: 'alice', canStop: true, canResume: false, canRetry: false, canAnswer: true },
        assignment: { id: 'assignment-view', generation: 'generation-view', sessionId: 'worker-view', state: 'ended' },
        attention: { id: 'attention-view', version: 1, status: 'waiting', question: 'View: Choose a note layout',
          options: [], freeText: true, assignmentId: 'assignment-view', sessionId: 'worker-view', view: questionView } },
    }, {
      brief: { id: 'brief-read-only', workItemId: 'item-read-only', goal: 'Wait for the local operator.', constraints: 'Remote view.',
        acceptanceCriteria: 'Keep the view read-only.', target: 'local-only' },
      receipt: { status: 'accepted', ticketId: 'ticket-read-only' }, status: 'waiting',
      control: { workItemId: 'item-read-only', ticketId: 'ticket-read-only', ticketVersion: 1,
        permissions: { actorId: 'alice', canStop: false, canResume: false, canRetry: false, canAnswer: false },
        assignment: { id: 'assignment-read-only', generation: 'generation-read-only', sessionId: 'worker-read-only', state: 'ended' },
        attention: { id: 'attention-read-only', version: 1, status: 'waiting', question: 'View: Review only',
          options: [], freeText: true, assignmentId: 'assignment-read-only', sessionId: 'worker-read-only', view: readOnlyView } },
    }, {
      brief: { id: 'brief-result', workItemId: 'item-result', goal: 'Edit the Word document.', constraints: 'Keep structure.',
        acceptanceCriteria: 'Return the checked file.', target: 'local-only' },
      receipt: { status: 'accepted', ticketId: 'ticket-result' }, status: 'success',
      outcome: { status: 'success', summary: 'Edited the document.', evidence: 'Checked the package.', nextStep: 'Review.',
        artifacts: [{ path: 'edited.docx', bytes: 20, sha256: 'a'.repeat(64) }], view: resultView },
    }] }
    const fetch = async (_url, options) => {
      const { endpoint, payload } = JSON.parse(options.body)
      requests.push([endpoint, payload])
      const value = endpoint === 'open' ? { instanceId: 'private' }
        : endpoint === 'history' ? structuredClone(history)
          : endpoint === 'directory-options' ? { default: { environmentId: 'local', root: '/work' }, directories: [] }
            : endpoint === 'execution-options' ? { policy: { defaultTarget: 'local-only', requiredPermissions: [] }, environments: [] }
              : endpoint === 'observe-list' ? { items: [] }
                : endpoint === 'work-answer-view' ? (() => {
                  const work = history.works[0]
                  work.status = 'success'
                  work.control.permissions.canAnswer = false
                  work.control.attention.status = 'answered'
                  work.control.attention.answerView = { action: payload.action, values: payload.values }
                  return { attention: work.control.attention, input: { id: 'input-view' } }
                })()
                  : null
      if (value === null) throw new Error(`Unexpected endpoint: ${endpoint}`)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : requireHarness(id),
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch,
      crypto: globalThis.crypto, sessionStorage: dom.window.sessionStorage, setTimeout, clearTimeout,
      setInterval, clearInterval, structuredClone, Blob, URL, console })
    let surface
    module.exports.applyProduct({ get: name => name === 'locale' ? 'en-US' : undefined, effect: (effect, label) => {
      if (label === 'superagent: follow the shared Main') cleanup = effect()
    }, slots: { inject: (_name, register) => register(), register: ({ name }, component) => {
      if (name === 'main.conversation') surface = component
    } } })
    root = createRoot(dom.window.document.querySelector('#root'))
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); root.render(React.createElement(surface)) })
    assert.match(dom.window.document.body.textContent, /Choose a note layout/u)
    assert.match(dom.window.document.body.textContent, /Chosen layout/u)
    const readOnly = dom.window.document.querySelector('[data-ticket-id="ticket-read-only"]')
    assert.match(readOnly?.querySelector('.bt-main-work-view')?.innerHTML ?? '', /dv-q-settled/u)
    assert.equal(readOnly?.querySelectorAll('.bt-main-work-view button').length, 0,
      'a waiting view without answer permission is read-only')
    const answer = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent.includes('Detailed'))
    assert.ok(answer, 'the interactive work view must expose its submitted option')
    await React.act(async () => answer.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const request = requests.find(([endpoint]) => endpoint === 'work-answer-view')?.[1]
    assert.deepEqual(request?.values, { selected: ['Detailed'] })
    assert.equal(request?.attentionId, 'attention-view')
    assert.equal(request?.expectedGeneration, 'generation-view')
    assert.equal(request?.commandId.length > 0, true)
    assert.equal([...dom.window.document.querySelectorAll('button')]
      .some(button => button.textContent.includes('Detailed')), false, 'an answered view is read-only')
  } finally {
    cleanup?.()
    if (root) await requireHarness('react').act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    dom.window.close()
  }
})
