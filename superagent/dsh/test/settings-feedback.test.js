import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = createRequire(join(process.env.DSH_HARNESS ?? join(plugin, 'dev', 'harness'), 'package.json'))
const { JSDOM } = harness('jsdom')

test('feedback keeps notes local and only copies the selected diagnostic fields', async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  let root
  try {
    const React = harness('react')
    const { createRoot } = harness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/settings-feedback.js')], bundle: true,
      format: 'cjs', platform: 'browser', write: false, external: ['react'] })
    const module = { exports: {} }
    const copied = []
    runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: harness, window: dom.window,
      document: dom.window.document, navigator: { clipboard: { writeText: async text => { copied.push(text) } } },
      AbortController, Intl, Date, console })
    const calls = []
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload.instanceId])
      return { main: { state: 'degraded', detail: 'hidden provider text' }, processingPaused: false,
        model: 'hidden model configuration', events: [{ text: 'private conversation' }] }
    }
    const app = { diagnostics: async () => ({ appVersion: '1.2.3', platform: 'win32', arch: 'x64',
      home: 'hidden local path', events: [{ area: 'host', code: 'HOST_FAILED', at: 1, message: 'private log line' },
        { area: 'host', code: 'NOT A STATUS CODE', at: 2 }] }) }
    const main = dom.window.document.querySelector('main')
    const findButton = text => [...main.querySelectorAll('button')].find(button => button.textContent === text)
    root = createRoot(main)
    const element = options => React.createElement(module.exports.FeedbackSettings, { binding: { instanceId: 'bound-instance' }, call, ...options })
    await React.act(async () => root.render(element({ app })))
    assert.deepEqual(calls, [['product-status', 'bound-instance']])
    assert.deepEqual(copied, [])
    const summary = main.querySelector('textarea[readonly]').value
    assert.match(summary, /HOST_FAILED/u)
    assert.doesNotMatch(summary, /hidden|private|NOT A STATUS CODE/u)
    const issue = main.querySelector('a[href*="github.com"]')
    assert.equal(new URL(issue.href).search, '')
    assert.equal(new URL(issue.href).pathname, '/IceFireIcer/DS-SuperAgent/issues/new')
    await React.act(async () => findButton('Copy').click())
    assert.deepEqual(copied, [summary])
    await React.act(async () => root.render(element({ app: null })))
    assert.match(main.textContent, /Desktop diagnostics are available in the desktop app/u)
  } finally {
    if (root) await harness('react').act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, previous)
  }
})
