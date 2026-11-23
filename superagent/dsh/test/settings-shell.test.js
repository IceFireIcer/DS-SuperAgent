import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import metadata from '../../package.json' with { type: 'json' }
import { installSettingsSections, SETTINGS_CHILDREN, SettingsShell } from '../src/client/settings-shell.js'

const navigation = [
  ['General', ['General']],
  ['Models', ['Models', 'Roles', 'Agent presets', 'Built-in plugins']],
  ['Connections and capabilities', ['Connectors', 'IM', 'Phone', 'Browser', 'Computer control', 'Capability library']],
  ['SuperAgent', ['Execution policy', 'Scheduled tasks', 'Proactive preparation', 'Supervision', 'Memory', 'Usage', 'Secrets', 'Remote clients']],
  ['Help', ['Feedback', 'About']],
]

const tabPages = new Map([
  ['Browser', ['Browser resources', 'Browser plugin']],
  ['Scheduled tasks', ['Calendar', 'Scheduled tasks']],
  ['Usage', ['Usage', 'Status']],
  ['Secrets', ['Secrets', 'Credential resources']],
])

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
  const click = async (label, within = '[role=dialog]') => {
    const button = [...document.querySelectorAll(`${within} button`)].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label)
    assert.ok(button, `Missing button: ${label}`)
    await act(async () => button.click())
    return button
  }
  try {
    await run({ document, errors, click,
      render: props => act(async () => root.render(h(SettingsShell, { onClose: () => {}, ...props }))),
      keyDown: (element, key) => act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))),
      resize: width => act(async () => { window.innerWidth = width; window.dispatchEvent(new window.Event('resize')) }),
      search: value => act(async () => {
        const input = document.querySelector('input[type=search]')
        assert.ok(input, 'settings search is available')
        input.value = value
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      }),
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

test('opens every approved settings page in order and keeps each conflict inside one page', async () => withShell(async ({ document, click, render, keyDown }) => {
  await render({ initialPage: 'bots', sections: {
    bots: { render: () => assert.fail('excluded settings must never mount') },
  } })
  const nav = document.querySelector('nav')
  assert.deepEqual([...nav.querySelectorAll('[role=group]')].map(group => [
    document.getElementById(group.getAttribute('aria-labelledby')).textContent,
    [...group.querySelectorAll('button')].map(button => button.textContent),
  ]), navigation)
  assert.equal(nav.querySelector('[aria-current=page]').textContent, 'General')
  for (const label of navigation.flatMap(([, labels]) => labels)) {
    await click(label, 'nav')
    const tabs = [...document.querySelectorAll('[role=tab]')]
    assert.equal(document.querySelector('[role=dialog] h2').textContent, label)
    assert.equal(nav.querySelector('[aria-current=page]').textContent, label)
    assert.deepEqual(tabs.map(tab => tab.textContent), tabPages.get(label) ?? [])
    if (label === 'About') {
      assert.match(document.querySelector('.bt-settings-scroll').textContent, /DS SuperAgent/u)
      assert.ok(document.querySelector('.bt-settings-scroll').textContent.includes(metadata.name))
      assert.ok(document.querySelector('.bt-settings-scroll').textContent.includes(metadata.author))
      assert.ok(document.querySelector('.bt-settings-scroll').textContent.includes(metadata.version))
      assert.equal(document.querySelector('.bt-settings-scroll a').href, metadata.homepage)
      continue
    }
    assert.match(document.querySelector('[role=status]').textContent, /unavailable/u)
    if (!tabs.length) continue
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
    await click(tabs[1].textContent, '[role=tablist]')
    const panel = document.getElementById(tabs[1].getAttribute('aria-controls'))
    assert.equal(panel.hidden, false)
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[1].id)
    assert.equal(document.querySelectorAll('[role=tabpanel]:not([hidden])').length, 1)
    await keyDown(tabs[1], 'ArrowRight')
    assert.equal(document.activeElement, tabs[0])
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
    assert.equal(tabs[1].tabIndex, -1)
  }
}))

test('switching between Usage and Status preserves the open usage filters', async () => withShell(async ({ document, click, render }) => {
  await render({ initialPage: 'usage', sections: {
    'usage-overview': { render: () => h('label', null, 'Model filter', h('input', { defaultValue: '' })) },
    status: { render: () => h('span', null, 'Product health') },
  } })
  const model = document.querySelector('[role=tabpanel]:not([hidden]) input')
  model.value = 'approved-model'
  await click('Status', '[role=tablist]')
  assert.equal(document.querySelector('[role=tabpanel]:not([hidden])').textContent, 'Product health')
  await click('Usage', '[role=tablist]')
  assert.equal(document.querySelector('[role=tabpanel]:not([hidden]) input').value, 'approved-model')
}))

test('routes through settings.section and leaves page chrome usable after section failure', async () => withShell(async ({ document, click, errors, render, keyDown }) => {
  const registered = new Map()
  const requests = []
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
  const renderSlot = (name, owner, { only, fallback }) => {
    requests.push(only)
    assert.equal(name, 'settings.section')
    assert.deepEqual(Object.keys(owner), ['close'])
    const Section = registered.get(only)
    return Section ? h(Section, owner) : fallback
  }
  let closes = 0
  const sections = {
    models: { render: ({ navigate }) => h('button', { onClick: () => navigate('roles') }, 'Provider catalog') },
    roles: { render: () => h('div', null, 'Main, Router and Worker') },
    'browser-resources': { status: 'unavailable', render: () => assert.fail('unavailable action mounted') },
    'browser-plugin': { status: 'loading' },
    feedback: { render: () => { throw new Error('Private section failure') } },
  }
  const launcher = document.querySelector('#launcher')
  launcher.focus()
  await render({ sections, renderSlot, initialPage: 'models', onClose: () => { closes++ } })
  await click('Provider catalog')
  assert.match(document.querySelector('.bt-settings-scroll').textContent, /^Main, Router and Worker$/u)
  assert.equal(document.activeElement.textContent, 'Roles')
  assert.deepEqual(requests.slice(0, 2), ['superagent-models', 'superagent-roles'])
  await click('Browser', 'nav')
  assert.equal(document.querySelector('[role=status]').textContent, 'Loading settings…')
  await click('Browser resources', '[role=tablist]')
  assert.match(document.querySelector('[role=status]').textContent, /unavailable/u)
  await click('Browser plugin', '[role=tablist]')
  assert.equal(document.querySelector('[role=status]').textContent, 'Loading settings…')
  await click('Feedback', 'nav')
  assert.equal(document.querySelector('[role=alert]').textContent, 'Could not load this setting.')
  assert.equal(errors[0].message, 'Private section failure')
  await click('Phone', 'nav')
  assert.match(document.querySelector('[role=status]').textContent, /unavailable/u)
  await keyDown(document.querySelector('[role=dialog]'), 'Escape')
  assert.equal(closes, 1)
  await render({ open: false })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  assert.equal(document.querySelector('[role=dialog]'), null)
  assert.equal(document.activeElement, launcher)
  dispose()
  assert.equal(registered.size, 0)
}))

test('a direct section can change readiness independently of the other pages', async () => withShell(async ({ document, click, render }) => {
  const sections = {
    'browser-resources': { status: 'unavailable', render: () => assert.fail('unavailable action mounted') },
    roles: { status: 'loading' },
    models: { render: () => h('span', null, 'Provider catalog') },
  }
  await render({ initialPage: 'browser-plugin', sections })
  assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent, 'Browser plugin')
  await click('Browser resources', '[role=tablist]')
  assert.match(document.querySelector('[role=status]').textContent, /unavailable/u)
  await click('Roles', 'nav')
  assert.equal(document.querySelector('[role=status]').textContent, 'Loading settings…')
  await render({ sections: { ...sections, roles: { status: 'error' } } })
  assert.equal(document.querySelector('[role=alert]').textContent, 'Could not load this setting.')
  await click('Models', 'nav')
  assert.equal(document.querySelector('.bt-settings-scroll').textContent, 'Provider catalog')
  await click('Roles', 'nav')
  await render({ sections: { ...sections, roles: { render: () => h('span', null, 'Main, Router and Worker') } } })
  assert.equal(document.querySelector('.bt-settings-scroll').textContent, 'Main, Router and Worker')
}))

test('a parent selects the first available tab while an explicit unavailable tab explains itself', async () => withShell(async ({ document, click, render }) => {
  await render({ initialPage: 'browser', sections: {
    'browser-resources': { status: 'unavailable' },
    'browser-plugin': { render: () => h('span', null, 'Browser mode') },
  } })
  assert.equal(document.querySelector('nav [aria-current=page]').textContent, 'Browser')
  assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent, 'Browser plugin')
  await click('Browser resources', '[role=tablist]')
  assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent, 'Browser resources')
  assert.match(document.querySelector('[role=tabpanel]:not([hidden])').textContent, /unavailable/u)
}))

test('an invalid section link reports the unavailable destination without leaving the current page', async () => withShell(async ({ document, click, render }) => {
  await render({ initialPage: 'models', sections: {
    models: { render: ({ navigate }) => h('button', { onClick: () => navigate('missing-setting') }, 'Open setting') },
  } })
  await click('Open setting')
  assert.equal(document.querySelector('nav [aria-current=page]').textContent, 'Models')
  assert.equal(document.querySelector('[role=status]').textContent, 'This setting is unavailable here.')
}))

test('settings search uses bilingual destinations and clears back to all groups', async () => withShell(async ({ document, click, render, search }) => {
  const ready = { render: () => h('p', null, 'Synthetic editor contents') }
  await render({ sections: { models: ready, connectors: ready, calendar: ready, 'scheduled-tasks': ready,
    'usage-overview': ready, status: ready, feedback: { status: 'unavailable' } } })
  const results = () => [...document.querySelectorAll('[aria-label="Settings search results"] button')].map(button => button.textContent)
  for (const [query, result] of [['API KEY', 'Models'], ['OAuth', 'Connectors'], ['schedule', 'Scheduled tasks › Scheduled tasks'], ['用量', 'Usage › Usage']]) {
    await search(query)
    assert.ok(results().includes(result), query)
  }
  document.querySelector('input[type=search]').focus()
  await search('backup')
  assert.deepEqual(results(), ['Usage › Status'])
  await click('Usage › Status')
  assert.equal(document.querySelector('[aria-current=page]').textContent, 'Usage')
  assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent, 'Status')
  assert.equal(document.activeElement.textContent, 'Usage')
  for (const query of ['Feedback', 'Synthetic editor contents']) {
    await search(query)
    assert.deepEqual(results(), [])
    assert.ok([...document.querySelectorAll('[role=status]')].some(item => item.textContent === 'No matching settings'))
  }
  await click('Clear search')
  assert.equal(document.querySelectorAll('nav [role=group]').length, 5)
  assert.equal(document.activeElement.type, 'search')
}))

test('the compact page chooser returns focus after navigation and Escape', async () => withShell(async ({ document, click, render, resize, search, keyDown }) => {
  await resize(508)
  let closes = 0
  await render({ onClose: () => { closes++ }, sections: { status: { render: () => h('p', null, 'Status contents') } } })
  const chooser = () => document.querySelector('[aria-label="Choose a page"]')
  assert.equal(chooser()?.getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === chooser())
  await click(chooser().textContent)
  assert.equal(document.activeElement.type, 'search')
  await search('备份')
  await click('Usage › Status')
  assert.equal(document.querySelector('[aria-selected=true]').textContent, 'Status')
  assert.equal(chooser().getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === chooser())
  await click(chooser().textContent)
  await keyDown(document.activeElement, 'Escape')
  assert.equal(closes, 0)
  assert.ok(document.activeElement === chooser())
  await keyDown(chooser(), 'Escape')
  assert.equal(closes, 1)
  await resize(721)
  assert.equal(chooser(), null)
  assert.equal(document.activeElement.textContent, 'Usage')
}))
