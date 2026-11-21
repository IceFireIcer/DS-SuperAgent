import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { mainModelSetup, SuperagentModelChoice } from '../src/client/product-model-onboarding.js'

const official = { id: 'deepseek-official', key: { configured: false, writable: true }, models: [{ model: 'chat' }] }
const main = { model: { provider: official.id, model: 'chat' } }
const require = createRequire(import.meta.url)

test('only Main model readiness drives onboarding, independently of the provider key being writable', () => {
  assert.deepEqual(mainModelSetup({ roles: { main }, providers: [official] }), { keyProvider: official.id, canChooseModel: false })
  const configured = { ...official, key: { configured: true, writable: false } }
  assert.equal(mainModelSetup({ roles: { main }, providers: [configured] }), null)
  assert.deepEqual(mainModelSetup({ roles: {}, providers: [configured] }), { keyProvider: null, canChooseModel: true })
  assert.deepEqual(mainModelSetup({ roles: { main }, providers: [] }), { keyProvider: null, canChooseModel: false })
  const local = { id: 'local', key: { configured: false, writable: true }, models: [{ model: 'chat' }] }
  assert.equal(mainModelSetup({ roles: { main: { model: { provider: 'local', model: 'chat' } } }, providers: [local] }), null)
})

test('the model bubble offers only the setup actions that the product can open', () => {
  const open = () => {}
  const labels = extra => {
    const dom = new JSDOM(renderToStaticMarkup(h(SuperagentModelChoice, {
      setup: { keyProvider: null, canChooseModel: false }, openModels: open, openRoles: open, ...extra,
    })))
    try {
      return [...dom.window.document.querySelectorAll('button')].map(button => button.textContent)
    } finally { dom.window.close() }
  }
  assert.deepEqual(labels(), ['Open Models settings'])
  assert.deepEqual(labels({ setup: { keyProvider: official.id, canChooseModel: false }, signIn: open, openCustomModels: open }),
    ['Sign in to DeepSeek', 'Enter a DeepSeek API key', 'Open settings to set up a custom model'])
  assert.deepEqual(labels({ setup: { keyProvider: null, canChooseModel: true } }), ['Open Models settings', 'Choose a model'])
})

async function mountProduct(context, { connection = { connected: false }, settings } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  Object.assign(globalThis, globals)
  window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' })
  window.HTMLElement.prototype.scrollIntoView = () => {}
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const root = createRoot(document.querySelector('main'))
  const cleanups = []
  context.after(async () => {
    await act(async () => root.unmount())
    for (const cleanup of cleanups.reverse()) cleanup?.()
    dom.window.close()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })

  const requests = []
  const sessionId = 'main-fixture'
  const role = { ...main, name: 'Main', instructions: '', skills: [] }
  const snapshot = { revision: 1, roles: { main: role, router: role, worker: role }, uses: [], history: [],
    providers: [{ ...official, name: 'DeepSeek', models: [{ ...official.models[0], name: 'Chat', ref: 'deepseek-official/chat' }] }] }
  const responses = {
    open: () => ({ instanceId: 'fixture', mainSessionId: sessionId }),
    history: () => ({ mainSessionId: sessionId, messages: [], works: [], health: { state: 'ready' } }),
    settings: () => settings ? settings(snapshot) : snapshot,
    'work-members': () => ({ workers: [] }),
    'work-board': () => ({ items: [] }),
    'feishu-status': () => ({ configured: false, state: 'unavailable' }),
    'scheduled-task-list': () => ({ items: [] }),
    'scheduled-task-source-read': () => ({ enabled: true }),
    'connector-registry': () => ({ items: [], canStoreCredentials: true }),
    'directory-options': () => ({ directories: [] }),
    'execution-options': () => ({ policy: { defaultTarget: 'local-only', requiredPermissions: [] }, environments: [] }),
    'observe-list': () => ({ items: [] }),
    'settings-efforts': () => ({ efforts: [] }),
  }
  const call = async (endpoint, payload) => {
    requests.push({ endpoint, payload })
    if (!Object.hasOwn(responses, endpoint)) throw new Error(`Unexpected endpoint: ${endpoint}`)
    return structuredClone(await responses[endpoint](payload))
  }
  const fetch = async (_url, options) => {
    const { endpoint, payload } = JSON.parse(options.body)
    try {
      const value = await call(endpoint, payload)
      return { ok: true, json: async () => ({ ok: true, value }) }
    } catch (error) {
      return { ok: false, json: async () => ({ ok: false, error: { message: error.message } }) }
    }
  }
  window.dsSuperagentApp = { productClient: { status: async () => connection, call, events: async () => [] } }
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/product.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/*'] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports,
    require: name => name.startsWith('@deepseek-ai/') ? {} : require(name), window, document, fetch, console,
    crypto: globalThis.crypto, sessionStorage: window.sessionStorage, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
    AbortController, MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame })

  const entries = new Map()
  const versions = new Map()
  const listeners = new Set()
  const slots = {
    entries: name => entries.get(name) ?? [],
    getVersion: name => versions.get(name) ?? 0,
    subscribe(_name, listener) { listeners.add(listener); return () => listeners.delete(listener) },
    inject(_name, install) { cleanups.push(install()) },
    register(options, component) {
      entries.set(options.name, [...slots.entries(options.name), { options, component }])
      versions.set(options.name, slots.getVersion(options.name) + 1)
      for (const listener of listeners) listener()
      return () => entries.set(options.name, slots.entries(options.name).filter(entry => entry.component !== component))
    },
  }
  const renderSlot = (name, props, options) => {
    const entry = slots.entries(name).find(item => !options?.only || item.options.id === options.only)
    return entry ? h(entry.component, { ...props, renderSlot }) : options?.fallback
  }
  await act(async () => {
    module.exports.applyProduct({ get: () => undefined, effect: effect => cleanups.push(effect()), slots })
    root.render(h('div', null, renderSlot('sidebar.workspaces'), renderSlot('main.conversation'), renderSlot('shell.overlay')))
  })

  const findButton = (name, within = document) => [...within.querySelectorAll('button')].find(button =>
    (button.getAttribute('aria-label') ?? button.textContent) === name && !button.closest('[inert], [hidden]'))
  const click = target => act(async () => { target.focus(); target.click() })
  const key = (target, value) => act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true,
  })))
  const fill = (target, value) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set.call(target, value)
    target.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  return { act, click, document, fill, findButton, key, requests, responses, slots, snapshot, window }
}

test('Escape cancels API key entry, returns to its trigger and preserves the Main draft', async context => {
  const { click, document, fill, findButton, key, requests } = await mountProduct(context)
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep working here')
  const trigger = findButton('Enter a DeepSeek API key')
  await click(trigger)
  const input = document.querySelector('input[type="password"]')
  assert.ok(input && document.activeElement === input, 'opening the key form focuses its field')
  await key(input, 'Escape')
  assert.ok(!document.querySelector('input[type="password"]'), 'Escape closes the key form')
  assert.ok(document.activeElement === trigger, 'focus returns to the key action')
  assert.equal(draft.value, 'Keep working here')
  assert.ok(!requests.some(({ endpoint }) => endpoint === 'provider-key' || endpoint === 'send'))
})

test('a rejected key stays in the guide and an accepted key returns to the same Main draft', async context => {
  const { click, document, fill, findButton, requests, responses, snapshot, window } = await mountProduct(context)
  const draft = document.querySelector('textarea')
  const fixtureValue = 'fixture-provider-value'
  await fill(draft, 'Continue the same Main conversation')
  await click(findButton('Enter a DeepSeek API key'))
  const input = document.querySelector('input[type="password"]')
  let reject = true
  responses['provider-key'] = payload => {
    assert.equal(payload.instanceId, 'fixture')
    assert.equal(payload.provider, official.id)
    assert.equal(payload.value === fixtureValue, true)
    if (reject) throw new Error('Fixture refused the write.')
    snapshot.providers[0].key = { ...official.key, configured: true }
    return { provider: official.id, configured: true }
  }
  await fill(input, fixtureValue)
  await click(findButton('Save key'))
  assert.match(input.form.querySelector('[role=alert]')?.textContent ?? '', /Could not save the API key/u)
  assert.equal(input.value, '')
  assert.ok(document.activeElement === input, 'a failed write keeps focus at the empty field')
  assert.equal(draft.value, 'Continue the same Main conversation')

  reject = false
  await fill(input, fixtureValue)
  await click(findButton('Save key'))
  assert.ok(!findButton('Enter a DeepSeek API key'), 'a ready Main no longer needs the guide')
  assert.ok(document.activeElement === draft, 'the composer receives focus when the guide disappears')
  assert.equal(draft.value, 'Continue the same Main conversation')
  assert.deepEqual(requests.map(({ endpoint }) => endpoint).filter(endpoint => ['open', 'settings', 'provider-key', 'send'].includes(endpoint)),
    ['open', 'settings', 'provider-key', 'provider-key', 'settings'])
  assert.equal(Object.values(window.localStorage).some(value => value.includes(fixtureValue)), false)
  assert.equal(Object.values(window.sessionStorage).some(value => value.includes(fixtureValue)), false)
})

test('a slow settings page cannot replace model readiness after the guide saves a key', async context => {
  const { act, click, document, fill, findButton, key, responses, snapshot } = await mountProduct(context)
  const outdated = structuredClone(snapshot)
  const pending = Promise.withResolvers()
  responses.settings = ({ limit }) => limit === 50 ? pending.promise : snapshot
  const models = findButton('Open Models settings')
  await click(models)
  await key(document.querySelector('[role=dialog]'), 'Escape')
  await act(async () => delay(5))

  responses['provider-key'] = () => {
    snapshot.providers[0].key = { ...official.key, configured: true }
    return { provider: official.id, configured: true }
  }
  await click(findButton('Enter a DeepSeek API key'))
  await fill(document.querySelector('input[type="password"]'), 'fixture-provider-value')
  await click(findButton('Save key'))
  assert.ok(!findButton('Enter a DeepSeek API key'))
  await act(async () => pending.resolve(outdated))
  assert.ok(!findButton('Enter a DeepSeek API key'), 'the older response does not bring back the guide')
})

test('an unavailable model check can be retried without losing the Main draft', async context => {
  let unavailable = true
  const { click, document, fill, findButton } = await mountProduct(context, { settings: snapshot => {
    if (unavailable) throw new Error('The catalog is temporarily unavailable.')
    return snapshot
  } })
  const draft = document.querySelector('textarea')
  await fill(draft, 'Continue after retrying')
  assert.match(document.querySelector('[role=alert]')?.textContent ?? '', /Could not check which models are available/u)
  unavailable = false
  await click(findButton('Retry'))
  assert.ok(findButton('Enter a DeepSeek API key'))
  assert.equal(draft.value, 'Continue after retrying')
})

test('the public sign-in slot can hand off to the product API key settings', async context => {
  const { act, click, document, fill, findButton, key, requests, slots } = await mountProduct(context)
  assert.ok(!findButton('Sign in to DeepSeek'))
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep the login draft')
  await act(async () => slots.register({ name: 'settings.models.sign-in' }, ({ complete, useApiKey }) =>
    h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'DeepSeek sign-in fixture' },
      h('button', { type: 'button', onClick: complete }, 'Cancel sign-in'),
      h('button', { type: 'button', onClick: useApiKey }, 'Use API key instead'))))
  await act(async () => slots.register({ name: 'settings.section', id: 'models' }, () => h('p', null, 'Native models fixture')))

  const signIn = findButton('Sign in to DeepSeek')
  await click(signIn)
  await click(findButton('Cancel sign-in'))
  assert.ok(!document.querySelector('[role=dialog]'))
  assert.ok(document.activeElement === signIn, 'cancel returns focus to the sign-in trigger')
  assert.equal(draft.value, 'Keep the login draft')

  await click(signIn)
  await click(findButton('Use API key instead'))
  const dialog = document.querySelector('[role=dialog]')
  assert.ok(findButton('Save key', dialog), 'the alternate sign-in action opens the product key editor')
  assert.doesNotMatch(dialog.textContent, /Native models fixture/u)
  await key(dialog, 'Escape')
  await act(async () => delay(5))
  assert.ok(document.activeElement === signIn, 'closing the key editor returns focus to the original trigger')
  assert.equal(draft.value, 'Keep the login draft')
  assert.equal(requests.filter(({ endpoint }) => endpoint === 'open').length, 1)
})

test('custom model setup prefers the available native editor and rechecks Main on return', async context => {
  const { act, click, document, fill, findButton, key, responses, slots, snapshot } = await mountProduct(context)
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep the custom model draft')
  await click(findButton('Open Models settings'))
  const productDialog = document.querySelector('[role=dialog]')
  assert.ok(findButton('Save key', productDialog), 'the fallback offers the product provider settings')
  await key(productDialog, 'Escape')
  await act(async () => delay(5))

  await act(async () => slots.register({ name: 'settings.section', id: 'models' }, () =>
    h('button', { type: 'button', onClick: () => {
      snapshot.providers[0].key = { ...official.key, configured: true }
      snapshot.providers.push({ id: 'custom', name: 'Custom provider', models: [{ model: 'chat', name: 'Custom chat', ref: 'custom/chat' }] })
    } }, 'Apply native model fixture')))
  const oldCatalog = structuredClone(snapshot)
  const firstRead = Promise.withResolvers()
  let holdRead = true
  responses.settings = ({ limit }) => {
    if (limit === 50 && holdRead) { holdRead = false; return firstRead.promise }
    return snapshot
  }
  await click(findButton('Open settings to set up a custom model'))
  await click(findButton('Apply native model fixture'))
  const nativeDialog = document.querySelector('[role=dialog]')
  await click(findButton('Roles', nativeDialog))
  const customModel = () => nativeDialog.querySelector('select[aria-label="Main model"] option[value="custom/chat"]')
  assert.ok(customModel(), 'the latest native catalog is selectable')
  await act(async () => firstRead.resolve(oldCatalog))
  assert.ok(customModel(), 'the older settings response does not replace the new catalog')
  await key(nativeDialog, 'Escape')
  await act(async () => delay(5))
  assert.ok(!document.querySelector('[role=dialog]'))
  assert.ok(!findButton('Enter a DeepSeek API key'))
  assert.ok(document.activeElement === draft)
  assert.equal(draft.value, 'Keep the custom model draft')
})

test('the mounted account menu opens existing settings and returns focus to its launcher', async context => {
  const { act, click, document, findButton, key, window } = await mountProduct(context)
  const sidebar = document.querySelector('nav')
  const account = findButton('Account', sidebar)
  const connectors = findButton('Connectors', sidebar)
  assert.ok(findButton('Connect to Host', sidebar))
  await click(account)
  const menu = document.getElementById(account.getAttribute('aria-controls'))
  const items = [...menu.querySelectorAll('[role=menuitem]')]
  await key(items[0], 'End')
  assert.ok(document.activeElement === items.at(-1))
  await key(items.at(-1), 'ArrowUp')
  await click(document.activeElement)
  assert.ok(!menu.isConnected, 'reduced motion removes the menu immediately')
  const dialog = document.querySelector('[role=dialog]')
  assert.equal(dialog.querySelector('[role=tab][aria-selected=true]')?.textContent, 'Scheduled tasks')
  await key(dialog, 'Escape')
  await act(async () => delay(5))
  assert.ok(document.activeElement === account)

  await click(account)
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  assert.equal(account.getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === account)

  await click(connectors)
  const connectorDialog = document.querySelector('[role=dialog]')
  assert.equal(connectorDialog.querySelector('[aria-current=page]')?.textContent, 'Connectors')
  assert.ok(findButton('Mailbox', connectorDialog), 'the real connector settings mounted')
  await click(findButton('Close settings', connectorDialog))
  await act(async () => delay(5))
  assert.ok(document.activeElement === connectors)
})

test('a paired viewer keeps Connect to Host controls without access to local setup', async context => {
  const connection = { connected: true, address: 'https://fixture.invalid', instanceId: 'fixture', client: { id: 'viewer', label: 'Viewer' },
    capabilities: ['read'] }
  const { click, document, findButton, requests } = await mountProduct(context, { connection })
  assert.ok(!findButton('Account'))
  assert.ok(!findButton('Connectors'))
  assert.ok(!findButton('Enter a DeepSeek API key'))
  assert.ok(document.querySelector('textarea').disabled)
  await click(findButton('Connection'))
  assert.match(document.querySelector('[role=dialog]').textContent, /Read-only/u)
  assert.ok(!requests.some(({ endpoint }) => endpoint === 'settings' || endpoint === 'provider-key'))
})
