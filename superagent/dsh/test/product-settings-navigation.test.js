import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mountProduct } from './helpers/mount-product.js'

const theme = { preference: 'system', fontSizes: { text: 14 } }
const remotes = { theme: { getTheme: () => theme, overrideTokens: () => () => {} } }

test('settings shortcuts select their destination and return focus to their launcher', async context => {
  const { act, click, document, findButton, key } = await mountProduct(context, { remotes })
  const openAndClose = async (open, launcher, group, part) => {
    await click(open)
    const dialog = document.querySelector('[role=dialog]')
    const selected = dialog.querySelector('[aria-current=page]')
    assert.equal(selected.querySelector('.bt-settings-label').textContent, group)
    assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]')?.textContent ?? part, part)
    assert.ok(document.activeElement === selected, 'the selected destination receives focus')
    await key(selected, 'Escape')
    await act(async () => delay(5))
    assert.equal(document.querySelector('[role=dialog]'), null)
    assert.ok(document.activeElement === launcher, 'focus returns to the launcher')
  }
  const settings = findButton('Settings')
  await openAndClose(settings, settings, 'Overview')
  const account = findButton('Account')
  for (const [label, group, part] of [
    ['Automation tasks', 'Work', 'Scheduled tasks'], ['Usage', 'Usage', 'Usage'],
    ['Models and API keys', 'Models', 'Providers'], ['Connectors', 'Connect', 'Connectors'],
  ]) {
    await click(account)
    const menu = document.querySelector('[role=menu]')
    await openAndClose(findButton(label, menu), account, group, part)
  }
  await click(findButton('Set up a model'))
  const guide = findButton('Open Models settings')
  await openAndClose(guide, guide, 'Models', 'Providers')
})

test('closing settings returns to the Main composer when the initiating control becomes disabled', async context => {
  const { act, click, document, findButton, key } = await mountProduct(context)
  await click(findButton('Set up a model'))
  const guide = findButton('Open Models settings')
  await click(guide)
  guide.disabled = true
  await key(document.querySelector('[role=dialog]'), 'Escape')
  await act(async () => delay(5))
  assert.ok(document.activeElement === document.querySelector('#main-message'), 'focus returns to the Main composer')
})

test('the model chooser opens Roles for an instance with a usable catalog', async context => {
  const { act, click, document, findButton, key } = await mountProduct(context, { settings: snapshot => ({
    ...snapshot, roles: { ...snapshot.roles, main: { ...snapshot.roles.main,
      model: { ...snapshot.roles.main.model, model: 'not-in-catalog' } } },
    providers: snapshot.providers.map(provider => ({ ...provider, key: { ...provider.key, configured: true } })),
  }) })
  const chooser = findButton('Choose a model')
  await click(chooser)
  const selected = document.querySelector('[role=dialog] [aria-current=page]')
  assert.equal(selected.querySelector('.bt-settings-label').textContent, 'Team')
  assert.equal(document.querySelector('.bt-anchor[aria-current=location]').textContent, 'Roles')
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Main model')
  await key(document.activeElement, 'Escape')
  await act(async () => delay(5))
  assert.ok(document.activeElement === chooser)
})

test('reopening settings during its exit starts a new visit and restores the new launcher', async context => {
  const { act, click, document, findButton, key } = await mountProduct(context, {
    remotes, extensions: window => { window.matchMedia = () => ({ matches: false }) },
  })
  const settings = findButton('Settings')
  const account = findButton('Account')
  await click(settings)
  const dialog = () => document.querySelector('[role=dialog]')
  const team = [...dialog().querySelectorAll('.bt-settings-item')]
    .find(button => button.querySelector('.bt-settings-label')?.textContent === 'Team')
  await click(team)
  await key(dialog(), 'Escape')
  assert.ok(dialog()?.closest('[data-leaving]'), 'the exit animation is still active')
  await click(account)
  await click(findButton('Settings', document.querySelector('[role=menu]')))
  const selected = dialog().querySelector('[aria-current=page]')
  assert.equal(selected.querySelector('.bt-settings-label').textContent, 'Overview')
  assert.ok(document.activeElement === selected)
  await key(selected, 'Escape')
  await act(async () => delay(175))
  assert.equal(dialog(), null)
  assert.ok(document.activeElement === account)
})
