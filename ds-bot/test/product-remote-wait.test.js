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

test('Main submits remote-only work and keeps a restarted device stop pending', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  let recognition
  dom.window.SpeechRecognition = class {
    constructor() { recognition = this }
    start() {}
    stop() { this.onend?.() }
    abort() { this.onend?.() }
  }
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
    const fetch = async (_url, options) => {
      const { endpoint, payload } = JSON.parse(options.body)
      requests.push([endpoint, payload])
      const value = endpoint === 'open' ? { instanceId: 'private' }
        : endpoint === 'history' ? { messages: [], sources: [], preparations: [], health: { state: 'ready' },
          works: [{ brief: { id: 'brief', workItemId: 'item', goal: 'Stop remote work.', constraints: 'Original work.',
            acceptanceCriteria: 'Confirm device stop.', target: 'remote-only' },
          receipt: { status: 'accepted', ticketId: 'ticket' }, status: 'stopped',
          control: { workItemId: 'item', ticketId: 'ticket', ticketVersion: 1,
            permissions: { canStop: false, canResume: false, canRetry: false, canAnswer: false },
            stop: { id: 'stop', state: 'stopped', pendingDeviceConfirmation: true } } }] }
          : endpoint === 'directory-options' ? { default: { environmentId: 'local-work', root: '/work' }, directories: [] }
            : endpoint === 'execution-options' ? { policy: { defaultTarget: 'remote-only', requiredPermissions: ['read'] },
              environments: [{ id: 'local-work', kind: 'local', root: '/work' }] }
              : endpoint === 'observe-list' ? { items: [] }
              : endpoint === 'send' ? { status: 'completed' }
                : endpoint === 'work-reconcile-stop' ? { ticketId: 'ticket' }
                  : null
      if (value === null) throw new Error(`Unexpected endpoint: ${endpoint}`)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : requireHarness(id),
      window: dom.window, document: dom.window.document,
      navigator: dom.window.navigator, fetch, crypto: globalThis.crypto, sessionStorage: dom.window.sessionStorage,
      setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, Blob, URL, console })
    let surface
    module.exports.applyProduct({ get: name => name === 'locale' ? 'en-US' : undefined, effect: (effect, label) => {
      if (label === 'superagent: follow the shared Main') cleanup = effect()
    }, slots: { inject: (_name, register) => register(), register: ({ name }, component) => {
      if (name === 'main.conversation') surface = component
    } } })
    root = createRoot(dom.window.document.querySelector('#root'))
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); root.render(React.createElement(surface)) })
    const document = dom.window.document
    assert.equal(document.querySelector('select[aria-label="Execution target"]').value, 'remote-only')
    assert.match(document.body.textContent, /This work will wait for an eligible device/u)
    assert.match(document.body.textContent, /Stopping · waiting for device cancellation confirmation\./u)
    assert.equal(document.body.textContent.includes('Stopped · cancellation confirmation is unavailable.'), false)
    const reconcile = [...document.querySelectorAll('button')].find(button => button.textContent === 'Check device stop')
    assert.ok(reconcile)
    await React.act(async () => { reconcile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(requests.find(([endpoint]) => endpoint === 'work-reconcile-stop')?.[1].workItemId, 'item')
    const input = document.querySelector('textarea')
    assert.ok(input)
    await React.act(async () => {
      document.querySelector('button[aria-label="Start dictation"]').click()
    })
    await React.act(async () => {
      recognition.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Wait for a remote device.' }], { isFinal: true })] })
    })
    await React.act(async () => { document.querySelector('button[aria-label="Stop dictation"]').click() })
    assert.equal(input.value, 'Wait for a remote device.')
    const send = document.querySelector('.bt-main-composer button[type="submit"]')
    assert.ok(send)
    assert.equal(send.disabled, false)
    await React.act(async () => { send.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const sent = requests.find(([endpoint]) => endpoint === 'send')?.[1]
    assert.equal(sent?.target, 'remote-only')
    assert.equal(sent?.text, 'Wait for a remote device.')
    assert.equal(typeof sent?.commandId, 'string')
    assert.equal(Object.hasOwn(sent, 'environmentId'), false)
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
