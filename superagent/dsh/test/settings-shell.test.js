import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import { installSettingsSections, SETTINGS_CHILDREN, SettingsShell } from '../src/client/settings-shell.js'
import { SETTINGS_SECTIONS } from '../src/client/settings-navigation.js'

const readySections = () => Object.fromEntries(SETTINGS_SECTIONS.map(({ id }) => [id, {
  render: () => h('p', { 'data-section': id }, `Section ${id}`),
}]))

async function withShell(run) {
  const dom = new JSDOM('<button id="launcher">Settings</button><main id="root"></main>')
  const { window } = dom
  const { document } = window
  const restore = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true })
  window.matchMedia = () => ({ matches: true })
  window.HTMLElement.prototype.attachEvent = () => {}
  window.HTMLElement.prototype.detachEvent = () => {}
  const errors = []
  const root = createRoot(document.querySelector('#root'), { onCaughtError: error => errors.push(error) })
  const clickLabel = async (label, within = '[role=dialog]') => {
    const button = [...document.querySelectorAll(`${within} button`)].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label)
    assert.ok(button, `Missing button: ${label}`)
    await act(async () => button.click())
    return button
  }
  const clickNav = async label => {
    const button = [...document.querySelectorAll('.bt-settings-item')]
      .find(item => item.querySelector('.bt-settings-label')?.textContent === label)
    assert.ok(button, `Missing settings group: ${label}`)
    await act(async () => button.click())
    return button
  }
  const clickAnchor = async label => clickLabel(label, '.bt-settings-anchors')
  const keyDown = (element, key, init = {}) => act(async () =>
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })))
  const search = value => act(async () => {
    const input = document.querySelector('.bt-set-palette .bt-set-search-input')
    assert.ok(input, 'settings search is open')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  try {
    await run({ document, errors, clickLabel, clickNav, clickAnchor, keyDown, search,
      render: props => act(async () => root.render(h(SettingsShell, { onClose: () => {}, ...props }))),
      resize: width => act(async () => { window.innerWidth = width; window.dispatchEvent(new window.Event('resize')) }),
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(restore)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    window.close()
  }
}

test('opens on Overview and keeps a domain and all of its parts together', async () => withShell(async ({ document, clickNav, clickAnchor, render }) => {
  await render({ sections: readySections() })
  const dialog = document.querySelector('.bt-superagent-settings')
  assert.equal(dialog.querySelector('h2').textContent, 'Overview')
  assert.deepEqual([...dialog.querySelectorAll('.bt-settings-item .bt-settings-label')].map(node => node.textContent),
    ['Overview', 'General', 'Look and feel', 'Models', 'Team', 'Work', 'Connect', 'Tools', 'Usage', 'About DS SuperAgent'])
  assert.equal(dialog.querySelector('[aria-current=page] .bt-settings-label').textContent, 'Overview')
  assert.ok(dialog.querySelector('.bt-ov-page'))

  await clickNav('Models')
  assert.equal(dialog.querySelector('h2').textContent, 'Models')
  assert.deepEqual([...dialog.querySelectorAll('.bt-anchor')].map(node => node.textContent),
    ['Providers', 'Agent presets', 'Built-in plugins'])
  const text = dialog.querySelector('.bt-settings-scroll').textContent
  for (const id of ['models', 'presets', 'built-in-plugins']) assert.match(text, new RegExp(`Section ${id}`, 'u'))
  await clickAnchor('Agent presets')
  assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]').textContent, 'Agent presets')
  assert.ok(dialog.querySelector('[data-part=presets]'))
}))

test('deep links select their group and part', async () => withShell(async ({ document, render }) => {
  await render({ initialPage: 'roles', sections: readySections() })
  const dialog = document.querySelector('.bt-superagent-settings')
  assert.equal(dialog.querySelector('h2').textContent, 'Team')
  assert.equal(dialog.querySelector('[aria-current=page] .bt-settings-label').textContent, 'Team')
  assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]').textContent, 'Roles')
  assert.match(dialog.querySelector('[data-part=roles]').textContent, /Section roles/u)
  assert.match(dialog.querySelector('[data-part=memory]').textContent, /Section memory/u)
}))

test('search is a command palette and opens a group part directly', async () => withShell(async ({ document, clickLabel, keyDown, render, search }) => {
  await render({ sections: readySections() })
  const dialog = document.querySelector('.bt-superagent-settings')
  await clickLabel('Search', '.bt-settings-rail')
  await search('OAuth')
  assert.ok(document.querySelector('.bt-set-palette'))
  const hit = [...document.querySelectorAll('.bt-set-search-hit')]
    .find(item => /Connectors|连接器/u.test(item.textContent))
  assert.ok(hit, 'connector search result is present')
  await act(async () => hit.click())
  assert.equal(dialog.querySelector('h2').textContent, 'Connect')
  assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]').textContent, 'Connectors')
  assert.equal(document.querySelector('.bt-set-palette'), null)

  await keyDown(dialog, 'k', { ctrlKey: true })
  assert.ok(document.activeElement.matches('.bt-set-search-input'))
  await search('nothing matches this')
  assert.equal(document.querySelector('.bt-set-search-empty').textContent, 'No matching settings')
  await keyDown(dialog, 'Escape')
  assert.equal(document.querySelector('.bt-set-palette'), null)
  assert.ok(dialog.isConnected, 'Escape closes search before Settings')
}))

test('a failing part reports its own state without taking down the group', async () => withShell(async ({ document, clickAnchor, render }) => {
  await render({ initialPage: 'browser-resources', sections: {
    ...readySections(),
    'browser-resources': { status: 'error' },
  } })
  const dialog = document.querySelector('.bt-superagent-settings')
  assert.equal(dialog.querySelector('[role=alert]').textContent, 'Could not load this setting.')
  await clickAnchor('Browser plugin')
  assert.equal(dialog.querySelector('.bt-anchor[aria-current=location]').textContent, 'Browser plugin')
  assert.match(dialog.querySelector('[data-part=browser-plugin]').textContent, /Section browser-plugin/u)
}))

test('compact settings use the chooser and keep focus on it after a group change', async () => withShell(async ({ document, clickLabel, clickNav, render, resize }) => {
  await resize(508)
  let closes = 0
  await render({ onClose: () => { closes++ }, sections: readySections() })
  const chooser = () => document.querySelector('[aria-label="Choose a page"]')
  assert.equal(chooser()?.getAttribute('aria-expanded'), 'false')
  assert.equal(document.querySelector('.bt-settings-nav').hidden, true)
  await act(async () => chooser().click())
  assert.equal(document.querySelector('.bt-settings-nav').hidden, false)
  await clickNav('Usage')
  assert.equal(document.querySelector('.bt-superagent-settings h2').textContent, 'Usage')
  assert.equal(chooser().getAttribute('aria-expanded'), 'false')
  await clickLabel('Close settings')
  assert.equal(closes, 1)
}))

test('leaving Team preserves or discards an edited role draft', async () => withShell(async ({ document, clickLabel, clickNav, render }) => {
  let discarded = 0
  await render({ initialPage: 'roles', sections: readySections(),
    roleDraft: { dirty: true, saving: () => false, discard: () => { discarded++ } } })
  await clickNav('General')
  assert.ok(document.querySelector('[role=alertdialog]'))
  await clickLabel('Keep editing')
  assert.equal(document.querySelector('.bt-superagent-settings h2').textContent, 'Team')
  assert.equal(discarded, 0)
  await clickNav('General')
  await clickLabel('Discard changes')
  assert.equal(discarded, 1)
  assert.equal(document.querySelector('.bt-superagent-settings h2').textContent, 'General')
}))

test('settings routes through the public section slot', async () => {
  const registered = new Map()
  const slots = {
    inject: (name, install) => {
      assert.deepEqual(SETTINGS_CHILDREN[name], { kind: 'list', scope: 'root' })
      return install()
    },
    register: ({ name, id }, Section) => {
      assert.equal(name, 'settings.section')
      registered.set(id, Section)
      return () => registered.delete(id)
    },
  }
  const dispose = installSettingsSections(slots)
  assert.ok(registered.has('superagent-models'))
  assert.ok(registered.has('superagent-appearance'))
  dispose()
  assert.equal(registered.size, 0)
})
