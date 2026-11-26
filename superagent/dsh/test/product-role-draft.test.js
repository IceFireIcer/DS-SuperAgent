import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mountProduct } from './helpers/mount-product.js'

const theme = { preference: 'system', fontSizes: { text: 14 } }
const remotes = { theme: { getTheme: () => theme, overrideTokens: () => () => {} } }

test('leaving a changed Roles form asks before losing the draft or its destination', async context => {
  const { act, click, document, fill, findButton, key, requests, window } = await mountProduct(context, { remotes })
  const launcher = findButton('Settings')
  await click(launcher)
  const dialog = () => document.querySelector('[role=dialog]')
  const openGroup = async label => {
    const button = [...dialog().querySelectorAll('.bt-settings-item')]
      .find(item => item.querySelector('.bt-settings-label')?.textContent === label)
    await click(button)
  }
  const openRoles = async () => {
    await openGroup('Team')
    await click(findButton('Roles', dialog().querySelector('.bt-settings-anchors')))
  }
  await openRoles()
  const field = () => dialog().querySelector('[aria-label="Main instructions"]')
  await fill(field(), 'Review the draft before leaving.')
  const scrim = document.querySelector('.bt-settings-layer > .bt-scrim')
  for (const leave of [
    () => click(findButton('Close settings', dialog())),
    () => click(scrim),
    () => key(field(), 'Escape'),
    () => click(findButton('Cancel', dialog())),
    () => openGroup('Models'),
    () => click(launcher),
  ]) {
    await leave()
    const confirm = document.querySelector('[role=alertdialog]')
    assert.ok(confirm, 'the leave action is guarded')
    assert.equal(document.activeElement.textContent, 'Keep editing')
    await key(document.activeElement, 'Escape')
    assert.ok(!document.querySelector('[role=alertdialog]'))
    assert.equal(field().value, 'Review the draft before leaving.')
    assert.ok(dialog().contains(document.activeElement))
  }
  await click(findButton('Search', dialog().querySelector('.bt-settings-rail')))
  const search = dialog().querySelector('.bt-set-palette .bt-set-search-input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, 'backup')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const result = [...dialog().querySelectorAll('.bt-set-search-hit')]
    .find(item => /Status|状态/u.test(item.textContent))
  await click(result)
  await click(findButton('Keep editing'))
  assert.ok(document.activeElement === result)
  assert.equal(search.value, 'backup')
  await click(result)
  await click(findButton('Discard changes'))
  assert.equal(dialog().querySelector('.bt-anchor[aria-current=location]').textContent, 'Status')
  await openRoles()
  assert.equal(field().value, '')
  await fill(field(), 'Draft before a sidebar jump.')
  await openGroup('Models')
  await click(findButton('Discard changes'))
  assert.equal(document.activeElement.textContent, 'Models')
  await openRoles()
  assert.equal(field().value, '')
  await key(field(), 'Escape')
  await act(async () => delay(5))
  assert.equal(dialog(), null)
  assert.ok(document.activeElement === launcher)
  assert.equal(requests.filter(({ endpoint }) => endpoint === 'settings-save').length, 0)
})
