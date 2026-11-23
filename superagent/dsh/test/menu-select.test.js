import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(join(plugin, 'dev/harness/package.json'))
const { JSDOM } = requireHarness('jsdom')

test('a menu select opens from the keyboard and applies one checked choice', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  let root
  const React = requireHarness('react')
  try {
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ stdin: {
      contents: "export { MenuSelect } from './menu-select.js'",
      resolveDir: join(plugin, 'src/client'), sourcefile: 'menu-select-entry.js', loader: 'js',
    }, bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom'] })
    const module = { exports: {} }
    new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, requireHarness)
    const changes = []
    const options = [{ value: 'local', label: 'Local' }, { value: 'remote', label: 'Remote only' },
      { value: 'auto', label: 'Auto' }]
    const Harness = () => {
      const [value, setValue] = React.useState('remote')
      return React.createElement(module.exports.MenuSelect, { value, options, label: 'Execution target',
        onChange: next => { changes.push(next); setValue(next) } })
    }
    root = createRoot(dom.window.document.body)
    await React.act(async () => root.render(React.createElement(Harness)))
    const trigger = dom.window.document.querySelector('button[aria-label="Execution target: Remote only"]')
    assert.ok(trigger)
    await React.act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const menu = dom.window.document.querySelector('[role="menu"][aria-label="Execution target"]')
    assert.ok(menu)
    assert.equal(menu.querySelector('[aria-checked="true"]').textContent, 'Remote only')
    assert.equal(dom.window.document.activeElement.textContent, 'Remote only')
    await React.act(async () => dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true })))
    assert.equal(dom.window.document.activeElement.textContent, 'Auto')
    await React.act(async () => dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'l', bubbles: true })))
    assert.equal(dom.window.document.activeElement.textContent, 'Local')
    await React.act(async () => dom.window.document.activeElement.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(changes, ['local'])
    assert.ok(dom.window.document.querySelector('button[aria-label="Execution target: Local"]'))
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    assert.equal(dom.window.document.querySelector('[role="menu"]'), null)
    assert.equal(dom.window.document.activeElement.getAttribute('aria-label'), 'Execution target: Local')
  } finally {
    if (root) await React.act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, { window: previous.window, document: previous.document,
      HTMLElement: previous.HTMLElement, IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
  }
})
