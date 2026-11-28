import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { mainModelSetup, SuperagentModelChoice } from '../src/client/product-model-onboarding.js'

import { main, mountProduct, official } from './helpers/mount-product.js'

async function showMethods({ click, findButton }) {
  await click(findButton('Set up a model') ?? findButton('Set up another model'))
}

test('the initial guide exposes one setup action before showing available methods', async context => {
  const product = await mountProduct(context)
  const guide = product.document.querySelector('.bt-superagent-model-dock')
  assert.equal([...guide.querySelectorAll('button')].filter(button => !button.closest('[hidden]')).length, 1)
  await showMethods(product)
  assert.ok(product.findButton('Enter a DeepSeek API key'))
  assert.ok(product.findButton('Open Models settings'))
  assert.ok(!product.findButton('Sign in to DeepSeek'))
})

test('a saved key with an unreadable catalog can retry the read without resubmitting the key', async context => {
  const product = await mountProduct(context)
  const { click, document, fill, findButton, requests, responses, snapshot } = product
  const draft = document.querySelector('#main-message')
  await fill(draft, 'Keep this first message')
  await showMethods(product)
  await click(findButton('Enter a DeepSeek API key'))
  const keyField = document.querySelector('.bt-main-model-key input')
  await fill(keyField, 'fixture-refresh-value')
  responses['provider-key'] = () => {
    snapshot.providers[0].key = { ...official.key, configured: true }
    return { configured: true }
  }
  responses.settings = () => { throw new Error('Catalog is unavailable') }
  await click(findButton('Save key'))
  assert.match(document.querySelector('.bt-superagent-model-dock').textContent, /Provider key saved.*Could not refresh/u)
  assert.ok(!findButton('Enter a DeepSeek API key'))
  assert.ok(!document.querySelector('.bt-main-model-key input'))
  responses.settings = () => snapshot
  await click(findButton('Retry'))
  assert.equal(requests.filter(({ endpoint }) => endpoint === 'provider-key').length, 1)
  assert.ok(!document.querySelector('.bt-superagent-model-dock'))
  assert.ok(document.activeElement === draft)
  assert.equal(draft.value, 'Keep this first message')
})

test('Models reloads a saved key without repeating the write after a failed refresh', async context => {
  const product = await mountProduct(context)
  const { click, document, fill, findButton, requests, responses, snapshot } = product
  await showMethods(product)
  await click(findButton('Open Models settings'))
  const dialog = document.querySelector('[role=dialog]')
  await fill(dialog.querySelector('input[type=password]'), 'fixture-provider-value')
  responses['provider-key'] = () => {
    snapshot.providers[0].key = { ...official.key, configured: true }
    return { configured: true }
  }
  responses.settings = () => { throw new Error('Catalog is unavailable') }
  await click(findButton('Save key', dialog))
  assert.match(dialog.textContent, /Key set/u)
  assert.match(dialog.textContent, /Saved\./u)
  assert.equal(requests.filter(({ endpoint }) => endpoint === 'provider-key').length, 1)
})

test('losing the provider write target clears the key editor and exposes model selection', async context => {
  const appearance = { preference: 'system', fontSizes: { text: 14 } }
  const product = await mountProduct(context, {
    remotes: { theme: { getTheme: () => appearance, overrideTokens: () => () => {} } },
  })
  const { click, document, fill, findButton, snapshot } = product
  await showMethods(product)
  await click(findButton('Enter a DeepSeek API key'))
  await fill(document.querySelector('.bt-main-model-key input'), 'fixture-unused-key')
  snapshot.providers.push({ id: 'custom', name: 'Custom', models: [{ model: 'chat' }] })
  snapshot.providers[0].key = { configured: false, writable: false }
  await click(findButton('Settings'))
  const dialog = document.querySelector('[role=dialog]')
  const look = [...dialog.querySelectorAll('.bt-settings-item')]
    .find(button => button.querySelector('.bt-settings-label')?.textContent === 'Look and feel')
  await click(look)
  assert.ok(dialog.querySelector('[aria-label="Theme"]'))
  assert.ok(!document.querySelector('.bt-main-model-key input'))
  await click(findButton('Close settings', dialog))
  assert.ok(findButton('Choose a model'))
})

test('only Main model readiness drives onboarding, independently of the provider key being writable', () => {
  assert.deepEqual(mainModelSetup({ roles: { main }, providers: [official] }), { keyProvider: official.id, canChooseModel: false })
  const configured = { ...official, key: { configured: true, writable: false } }
  assert.equal(mainModelSetup({ roles: { main }, providers: [configured] }), null)
  assert.deepEqual(mainModelSetup({ roles: {}, providers: [configured] }), { keyProvider: null, canChooseModel: true })
  assert.deepEqual(mainModelSetup({ roles: { main }, providers: [] }), { keyProvider: null, canChooseModel: false })
  const local = { id: 'local', key: { configured: false, writable: true }, models: [{ model: 'chat' }] }
  assert.equal(mainModelSetup({ roles: { main: { model: { provider: 'local', model: 'chat' } } }, providers: [local] }), null)
})

test('the model bubble shows a setup action or emphasizes selection from an available catalog', () => {
  const open = () => {}
  const labels = extra => {
    const dom = new JSDOM(renderToStaticMarkup(h(SuperagentModelChoice, {
      setup: { keyProvider: null, canChooseModel: false }, openModels: open, openRoles: open, ...extra,
    })))
    try {
      return [...dom.window.document.querySelectorAll('button')].filter(button => !button.closest('[hidden]')).map(button => button.textContent)
    } finally { dom.window.close() }
  }
  assert.deepEqual(labels(), ['Set up a model'])
  assert.deepEqual(labels({ setup: { keyProvider: official.id, canChooseModel: false }, signIn: open, openCustomModels: open }),
    ['Set up a model'])
  assert.deepEqual(labels({ setup: { keyProvider: null, canChooseModel: true } }), ['Choose a model', 'Set up another model'])
})

test('Escape cancels API key entry, returns to its trigger and preserves the Main draft', async context => {
  const product = await mountProduct(context)
  const { click, document, fill, findButton, key, requests } = product
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep working here')
  await showMethods(product)
  const trigger = findButton('Enter a DeepSeek API key')
  await click(trigger)
  const input = document.querySelector('input[type="password"]')
  assert.ok(input && document.activeElement === input, 'opening the key form focuses its field')
  await click(findButton('Show API key'))
  assert.equal(input.type, 'text')
  await click(findButton('Hide API key'))
  assert.equal(input.type, 'password')
  await key(input, 'Escape')
  assert.ok(!document.querySelector('input[type="password"]'), 'Escape closes the key form')
  assert.ok(document.activeElement === trigger, 'focus returns to the key action')
  assert.equal(draft.value, 'Keep working here')
  assert.ok(!requests.some(({ endpoint }) => endpoint === 'provider-key' || endpoint === 'send'))
})

test('a rejected key stays in the guide and an accepted key returns to the same Main draft', async context => {
  const product = await mountProduct(context)
  const { click, document, fill, findButton, requests, responses, snapshot, window } = product
  const draft = document.querySelector('textarea')
  const fixtureValue = 'fixture-provider-value'
  await fill(draft, 'Continue the same Main conversation')
  await showMethods(product)
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
  const product = await mountProduct(context)
  const { act, click, document, fill, findButton, key, responses, snapshot } = product
  const outdated = structuredClone(snapshot)
  const pending = Promise.withResolvers()
  responses.settings = ({ limit }) => limit === 50 ? pending.promise : snapshot
  await showMethods(product)
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
  assert.ok(findButton('Set up a model'))
  assert.equal(draft.value, 'Continue after retrying')
})

test('the public sign-in slot can hand off to the product API key settings', async context => {
  const product = await mountProduct(context)
  const { act, click, document, fill, findButton, key, requests, slots } = product
  assert.ok(!findButton('Sign in to DeepSeek'))
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep the login draft')
  await act(async () => slots.register({ name: 'settings.models.sign-in' }, ({ complete, useApiKey }) =>
    h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'DeepSeek sign-in fixture' },
      h('button', { type: 'button', onClick: complete }, 'Cancel sign-in'),
      h('button', { type: 'button', onClick: useApiKey }, 'Use API key instead'))))
  await act(async () => slots.register({ name: 'settings.section', id: 'models' }, () => h('p', null, 'Native models fixture')))
  await showMethods(product)

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
  const product = await mountProduct(context)
  const { act, click, document, fill, findButton, key, responses, slots, snapshot } = product
  const draft = document.querySelector('textarea')
  await fill(draft, 'Keep the custom model draft')
  await showMethods(product)
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
  const roles = [...nativeDialog.querySelectorAll('.bt-settings-item')]
    .find(button => button.querySelector('.bt-settings-label')?.textContent === 'Roles')
  await click(roles)
  await click(findButton('Roles', nativeDialog.querySelector('.bt-settings-anchors')))
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
  assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]')?.textContent, 'Scheduled tasks')
  await key(dialog, 'Escape')
  await act(async () => delay(5))
  assert.ok(document.activeElement === account)

  await click(account)
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  assert.equal(account.getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === account)

  await click(connectors)
  const connectorDialog = document.querySelector('[role=dialog]')
  assert.equal(connectorDialog.querySelector('[aria-current=page] .bt-settings-label')?.textContent, 'Connect')
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
