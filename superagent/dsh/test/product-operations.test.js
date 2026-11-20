import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(join(plugin, 'dev', 'harness', 'package.json'))

test('the existing operations page installs, backs up and restores without sending Main work', async () => {
  const { JSDOM } = requireHarness('jsdom')
  const React = requireHarness('react')
  const { createRoot } = requireHarness('react-dom/client')
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window; globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-operations.js')], bundle: true,
    platform: 'browser', format: 'cjs', write: false, external: ['react'] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: id => id === 'react' ? React : requireHarness(id),
    setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, console })

  const calls = []
  const backupCalls = []
  const status = { main: { state: 'ready' }, processingPaused: false, supervision: {} }
  const usage = { createdAt: Date.now(), roles: { main: { status: 'none' }, router: { status: 'none' }, worker: { status: 'none' } },
    planning: [], works: [], unattributed: { status: 'none' }, cost: { reason: 'No price catalog.' },
    hourly: [{ at: Date.now(), owner: 'worker', provider: 'mock', model: 'fixture', kind: 'execution', usage: { totalTokens: 54 } }],
    coverage: { status: 'available', includedSessions: 2, knownSessions: 2, omittedRoleUses: 0, omittedSessions: 0,
      omittedEvents: 0, limits: { roleUses: 100, sessions: 100, eventsPerSession: 20000 } } }
  const backup = { id: 'backup-1', createdAt: Date.now(), restorable: true,
    business: { recordCount: 12, sizeBytes: 1024 }, sessions: { sessionCount: 3, totalBytes: 2048 } }
  const app = {
    updates: { subscribe: () => () => {}, state: async () => ({ phase: 'downloaded', version: '0.2.6' }),
      install: async () => { backupCalls.push('install') } },
    backups: { list: async () => [backup], create: async () => { backupCalls.push('create') },
      restore: async id => { backupCalls.push(`restore:${id}`) } },
    diagnostics: async () => ({ appVersion: '0.2.5', backupsAvailable: true, events: [] }),
  }
  const call = async endpoint => { calls.push(endpoint); return endpoint === 'product-status' ? status : usage }
  const root = createRoot(dom.window.document.querySelector('#root'))
  const render = async section => React.act(async () => root.render(React.createElement(module.exports.ProductOperationsSettings, {
    binding: { instanceId: 'local' }, call, app, section, onNavigate() {},
  })))
  try {
    await render()
    const button = label => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
    await React.act(async () => button('Install and restart').click())
    await React.act(async () => button('Create backup').click())
    await React.act(async () => button('Restore').click())
    assert.match(dom.window.document.body.textContent, /Restore the business and Session snapshot/u)
    assert.match(button('Confirm restore').className, /bt-danger/u)
    await React.act(async () => button('Confirm restore').click())
    assert.deepEqual(backupCalls, ['install', 'create', 'restore:backup-1'])
    assert.deepEqual([...new Set(calls)].sort(), ['product-status', 'usage-breakdown'])
    assert.match(dom.window.document.body.textContent, /recent Main, Router and Worker Sessions/u)

    calls.length = 0
    await render('usage')
    assert.deepEqual(calls, ['usage-breakdown'])
    assert.match(dom.window.document.body.textContent, /Token usage by role/u)
    assert.equal(dom.window.document.querySelector('[role=img]').getAttribute('aria-label'), 'Active on 1 day in the last year')
    assert.equal(button('Create backup'), undefined)
    assert.equal(button('Install and restart'), undefined)

    calls.length = 0
    await render('status')
    assert.deepEqual(calls, ['product-status'])
    assert.doesNotMatch(dom.window.document.body.textContent, /Token usage by role/u)
    assert.ok(button('Create backup'))
    assert.ok(button('Download diagnostic summary'))
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    globalThis.window = previous.window; globalThis.document = previous.document
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    globalThis.HTMLElement = previous.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
  }
})
