import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { DICTIONARY, NAMESPACE, installLocale, t } from '../src/client/i18n.js'
import { ROLE_IDS, ROLE_NAMES, roleName } from '../src/client/roles.js'
import { SettingsOverview } from '../src/client/settings-overview.js'
import { WorkMemberDock } from '../src/client/work-board.js'

function fakeLocale(active = 'zh') {
  const dictionaries = new Map()
  const catalog = new Map([['en', { id: 'en' }], ['zh', { id: 'zh', fallback: 'en' }]])
  const lookup = (namespace, key) => {
    for (let id = active.toLowerCase(); id !== undefined; id = catalog.get(id)?.fallback) {
      const dictionary = dictionaries.get(`${namespace}:${id}`)
      if (dictionary && Object.hasOwn(dictionary, key)) return dictionary[key]
    }
    return key
  }
  return {
    register(namespace, id, dictionary) {
      dictionaries.set(`${namespace}:${id.toLowerCase()}`, dictionary)
      return () => dictionaries.delete(`${namespace}:${id.toLowerCase()}`)
    },
    addLanguage(definition) {
      catalog.set(definition.id.toLowerCase(), definition)
      return () => catalog.delete(definition.id.toLowerCase())
    },
    bind: namespace => (key, params) => {
      const text = lookup(namespace, key)
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active, locales: [...catalog.values()] }),
  }
}

const mount = component => new JSDOM(renderToStaticMarkup(component)).window.document

test('role names are product names in every interface language', () => {
  const off = installLocale(fakeLocale())
  try {
    assert.deepEqual(ROLE_IDS.map(roleName), ['Main', 'Router', 'Worker'])
    assert.equal(roleName('main'), 'Main')
    assert.equal(roleName({ id: 'router', label: '路由角色' }), 'Router')
    assert.equal(t('Main'), 'Main')
    assert.equal(t('Router'), 'Router')
    assert.equal(t('Worker'), 'Worker')
    assert.equal(t('Model'), '模型')
    const names = Object.values(ROLE_NAMES)
    for (const [language, dictionary] of Object.entries(DICTIONARY)) {
      for (const name of names) assert.equal(Object.hasOwn(dictionary, name), false, `${language}: ${name}`)
    }

    const dock = mount(h(WorkMemberDock, {
      activeTurn: { status: 'running' }, routing: true,
      workers: [{ sessionId: 'worker-1', state: 'running', item: { goal: 'Check the export' } }],
    }))
    assert.deepEqual([...dock.querySelectorAll('[data-role-name]')].map(node => node.textContent),
      ['Main', 'Router', 'Worker'])

    const overview = mount(h(SettingsOverview, { overview: { roles: [
      { id: 'main', label: '主角色' },
      { id: 'router', label: '路由角色' },
      { id: 'worker', label: '执行角色' },
    ] } }))
    assert.equal(overview.querySelector('.bt-ov-section h3').textContent, '角色')
    assert.deepEqual([...overview.querySelectorAll('.bt-ov-bot-name')].map(node => node.textContent),
      ['Main', 'Router', 'Worker', '配置模型'])
  } finally {
    off()
  }
  assert.equal(NAMESPACE, 'ds-superagent')
})
