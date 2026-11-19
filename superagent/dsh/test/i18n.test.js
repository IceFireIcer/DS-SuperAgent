import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, NAMESPACE, dateLocale, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(active, extras = []) {
  const dicts = new Map()
  const catalog = new Map([['en', { id: 'en' }], ['zh', { id: 'zh', fallback: 'en' }],
    ...['de', 'es', 'fr', 'ja'].map(id => [id, { id, fallback: 'en' }]), ...extras.map(item => [item.id.toLowerCase(), item])])
  const calls = { registered: [], added: [] }
  const lookup = (ns, key) => {
    for (let id = active.toLowerCase(); id !== undefined; id = catalog.get(id)?.fallback) {
      const dictionary = dicts.get(`${ns}:${id}`)
      if (dictionary && Object.hasOwn(dictionary, key)) return dictionary[key]
    }
    return key
  }
  return {
    calls,
    register(ns, id, dictionary) {
      const key = `${ns}:${id.toLowerCase()}`
      assert.ok(!dicts.has(key), `duplicate dictionary ${key}`)
      calls.registered.push({ ns, id })
      dicts.set(key, dictionary)
      return () => dicts.delete(key)
    },
    addLanguage(definition) {
      const id = definition.id.toLowerCase()
      assert.ok(!catalog.has(id), `duplicate language ${id}`)
      assert.ok(catalog.has(definition.fallback))
      calls.added.push(definition)
      catalog.set(id, definition)
      return () => {
        catalog.delete(id)
        if (active.toLowerCase() === id) active = 'en'
      }
    },
    bind: ns => (key, params) => {
      const text = lookup(ns, key)
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active, locales: [...catalog.values()] }),
    setLocale(id) {
      assert.ok(catalog.has(id.toLowerCase()), `missing language ${id}`)
      active = catalog.get(id.toLowerCase()).id
    },
  }
}

test('every literal the client translates has a Chinese entry', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'")
      if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(t('This conversation is outside the authorized workspace.'), '这个对话不在已授权的工作区内。')
    assert.equal(t('The product Host is closed.'), '产品 Host 已关闭。')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})

test('the same locale binding follows all product languages and preserves fallback', () => {
  const locale = fakeLocale('en')
  const off = installLocale(locale)
  try {
    assert.deepEqual(locale.calls.added.map(({ id }) => id), ['ko', 'zh-TW'])
    assert.deepEqual(locale.calls.registered, Object.keys(DICTIONARY).map(id => ({ ns: NAMESPACE, id })))
    const modeLabels = { de: 'Hell', es: 'Claro', fr: 'Clair', ja: 'ライト', ko: '라이트', 'zh-TW': '淺色模式' }
    for (const [id, expected] of Object.entries(modeLabels)) {
      locale.setLocale(id)
      assert.equal(language(), id)
      assert.equal(t('Light mode'), expected, id)
      assert.equal(t('Unknown setting for {name}', { name: 'Main' }), 'Unknown setting for Main', id)
      assert.notEqual(dateLocale(), 'en-US', id)
    }
    assert.equal(dateLocale(), 'zh-TW')
    assert.equal(t('The product Host is closed.'), DICTIONARY['zh-TW']['The product Host is closed.'] ?? DICTIONARY.zh['The product Host is closed.'])
    locale.setLocale('en')
    assert.equal(t('Light mode'), 'Light mode')
  } finally {
    off()
  }
  assert.deepEqual(locale.getLocale().locales.map(({ id }) => id), ['en', 'zh', 'de', 'es', 'fr', 'ja'])
  assert.equal(locale.bind(NAMESPACE)('Light mode'), 'Light mode')
  assert.equal(language(), 'en')
})

test('an existing external language definition survives product locale teardown', () => {
  const existing = { id: 'zh-tw', label: '繁體中文', fallback: 'zh' }
  const locale = fakeLocale(existing.id, [existing])
  const off = installLocale(locale)
  try {
    assert.deepEqual(locale.calls.added.map(({ id }) => id), ['ko'])
    assert.equal(t('Light mode'), '淺色模式')
  } finally {
    off()
  }
  assert.ok(locale.getLocale().locales.includes(existing))
})

test('the imported catalogs keep product keys and their parameter names', () => {
  const tokens = text => [...text.matchAll(/\{\w+\}/g)].map(([token]) => token).sort()
  for (const [id, dictionary] of Object.entries(DICTIONARY)) {
    if (id === 'zh') continue
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(Object.hasOwn(DICTIONARY.zh, key), `${id}: ${key}`)
      assert.deepEqual(tokens(value), tokens(key), `${id}: ${key}`)
    }
    for (const key of ['Android beta', 'Group chats', 'New Bots', 'appearance.title']) {
      assert.equal(Object.hasOwn(dictionary, key), false, `${id}: ${key}`)
    }
  }
})
