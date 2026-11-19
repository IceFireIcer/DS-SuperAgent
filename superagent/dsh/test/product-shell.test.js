import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const requireHarness = createRequire(join(plugin, 'dev/harness/package.json'))
const { JSDOM } = requireHarness('jsdom')

test('product shell offers Main and Activity in the sidebar, header and command palette', async () => {
  const dom = new JSDOM('<!doctype html><html><body data-bt-motion="quiet"><main id="root"></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  })
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  const { window } = dom
  const { document } = window
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true })
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  window.HTMLDialogElement.prototype.close = function () { this.open = false }
  document.hasFocus = () => false
  window.localStorage.setItem('ds-bot:notify', JSON.stringify({ enabled: false }))
  const posted = []
  const badges = []
  let onOpenSession
  window.dsSuperagentApp = {
    notify: value => posted.push(value),
    setBadge: value => badges.push(value),
    onOpenSession: callback => { onOpenSession = callback; return () => { onOpenSession = undefined } },
  }

  const React = requireHarness('react')
  const { act, createElement: render, useSyncExternalStore } = React
  const { createRoot } = requireHarness('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const cleanups = []
  try {
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-shell.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, {
      module, require: requireHarness, window, document, setTimeout, clearTimeout, MutationObserver: window.MutationObserver,
      requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    })
    const { installProductShell } = module.exports
    const slots = new Map()
    const ctx = {
      effect(effect) { cleanups.push(effect()) },
      slots: {
        inject(_name, callback) { cleanups.push(callback()) },
        register({ name }, component) { slots.set(name, component); return () => slots.delete(name) },
      },
    }
    let state = { notificationScope: 'local', unread: 'cached-reply' }
    const listeners = new Set()
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    const snapshot = () => state
    const update = change => { state = { ...state, ...change }; listeners.forEach(listener => listener()) }
    const actions = {
      openMain: () => update({ activity: false }),
      openActivity: () => update({ activity: true }),
      openSettings: () => { throw new Error('Settings unavailable') },
    }
    installProductShell(ctx, { actions, useShell: () => useSyncExternalStore(subscribe, snapshot), nativeHeader: true })
    assert.deepEqual([...slots.keys()], ['sidebar.workspaces', 'sidebar.brand.mark', 'sidebar.brand.name', 'conversation.session.header', 'shell.overlay'])
    await act(async () => root.render(render(React.Fragment, null, [...slots].map(([name, Component]) => render(Component, { key: name })))))

    const button = name => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name)
    assert.equal(document.querySelector('.bt-product-brand-name').textContent, 'DS SuperAgent')
    assert.match(document.querySelector('nav [aria-current=page]').textContent, /Main/u)
    assert.equal(posted.length, 0, 'cached history must not announce on startup')
    await act(async () => button('View activity').click())
    assert.equal(document.querySelector('nav [aria-current=page]').textContent, 'Activity')

    button('Search').focus()
    await act(async () => button('Search').click())
    const search = document.querySelector('[role=combobox]')
    assert.equal(document.activeElement, search)
    assert.deepEqual([...document.querySelectorAll('[role=option]')].map(node => node.textContent), ['Main', 'Activity', 'Settings'])
    assert.equal(document.getElementById(search.getAttribute('aria-activedescendant')).textContent, 'Main')
    const key = (target, value, modifiers = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true, ...modifiers,
    }))
    const settlePalette = () => new Promise(resolve => setTimeout(resolve, 20))
    await act(async () => { key(search, 'Enter'); await settlePalette() })
    assert.equal(document.querySelector('dialog'), null)
    assert.match(document.querySelector('nav [aria-current=page]').textContent, /Main/u)

    await act(async () => { key(document.body, 'k', { ctrlKey: true }) })
    const dialog = document.querySelector('dialog')
    assert.ok(dialog.open)
    await act(async () => {
      dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }))
      await settlePalette()
    })
    assert.equal(document.querySelector('dialog'), null)

    await act(async () => { update({ modalOpen: true }); key(document.body, 'k', { ctrlKey: true }) })
    assert.equal(document.querySelector('dialog'), null)
    await act(async () => update({ modalOpen: false }))
    await act(async () => { button('Search').click() })
    await act(async () => {
      [...document.querySelectorAll('[role=option]')].find(node => node.textContent === 'Settings').click()
      await settlePalette()
    })
    assert.match(document.querySelector('[role=alert]').textContent, /Settings unavailable/u)
    await act(async () => button('Dismiss').click())
    assert.equal(document.querySelector('[role=alert]'), null)

    await act(async () => update({ unread: 'private reply identifier', pending: 'private question identifier' }))
    assert.equal(JSON.stringify(posted), JSON.stringify([{ sessionId: 'main', title: 'DS SuperAgent', body: 'Waiting for your answer' }]))
    assert.equal(badges.at(-1), 1)
    window.localStorage.setItem('ds-superagent:notify', JSON.stringify({ enabled: false }))
    await act(async () => update({ pending: 'another question' }))
    assert.equal(posted.length, 1)
    window.localStorage.removeItem('ds-superagent:notify')
    await act(async () => update({ notificationScope: 'remote', unread: 'different history' }))
    assert.equal(posted.length, 1)
    await act(async () => onOpenSession('main'))
    assert.match(document.querySelector('nav [aria-current=page]').textContent, /Main/u)
    delete window.dsSuperagentApp.notify
    await act(async () => update({ pending: undefined, unread: 'new reply' }))
    assert.match(document.querySelector('.bt-toast[role=status]').textContent, /A new reply is waiting/u)
  } finally {
    await act(async () => root.unmount())
    for (const cleanup of cleanups.reverse()) cleanup?.()
    dom.window.close()
    for (const [name, descriptor] of [['window', windowDescriptor], ['document', documentDescriptor], ['IS_REACT_ACT_ENVIRONMENT', actDescriptor]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
  assert.equal(onOpenSession, undefined)
  assert.equal(badges.at(-1), 0)
})
