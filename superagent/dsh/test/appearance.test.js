import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { AppearanceSettings, installAppearance, normalizeAppearance, setAppearance } from '../src/client/appearance.js'
import { ACCENT_INKS, INKS } from '../src/client/inks.js'
import { CONVERSATION_CSS, SHELL_CSS } from '../src/client/styles.js'
import { allThemes, themeCss } from '../src/client/themes.js'

function browser(context, body = '') {
  const { window } = new JSDOM(`<!doctype html>${body}`, { url: 'https://appearance.test', pretendToBeVisual: true })
  const globals = {
    window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  }
  const previous = Object.fromEntries(Object.keys(globals).map(name => [name, globalThis[name]]))
  Object.assign(globalThis, globals)
  context.after(() => {
    Object.assign(globalThis, previous)
    window.close()
  })
  return window
}

test('every theme and preset declares both palettes on the document root', () => {
  const themes = allThemes()
  assert.deepEqual(Object.keys(themes), ['deepseek', 'mono', 'paper', 'moonlight'])
  assert.equal(ACCENT_INKS.length, 7)
  for (const theme of Object.values(themes)) {
    for (const ink of ACCENT_INKS) {
      const [light, dark] = themeCss(theme, INKS[ink][0]).split('\n')
      assert.ok(light.startsWith(':root{'))
      assert.ok(dark.startsWith(':root:has(> body[data-ds-dark-theme]){'))
      assert.ok(light.includes(`--bt-main:${theme.light.bg};`))
      assert.ok(dark.includes(`--bt-main:${theme.dark.bg};`))
      assert.ok(light.includes(`--bt-accent:${INKS[ink][0]};`))
      assert.ok(dark.includes(`--bt-accent:${INKS[ink][1]};`))
      assert.match(dark, /--bt-glass-bg:color-mix\(in srgb,var\(--bt-main\) 74%/)
    }
  }
  assert.doesNotMatch(themeCss(themes.deepseek, '#fff;}'), /#fff;}/)
})

test('the shared component styles consume font, radius and color tokens', () => {
  const css = `${SHELL_CSS.slice(SHELL_CSS.indexOf('body{-webkit'))}${CONVERSATION_CSS}`
  assert.doesNotMatch(css, /(?:font-size|border(?:-[\w-]+)?-radius):\s*\d/)
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\brgba?\(/i)
  assert.match(css, /\.bt-bubble\{[^}]*font-size:var\(--dsh-content-font-size,var\(--bt-font-control\)\)/)
})

test('appearance restores saved settings, updates root colors, and cleans up', (context) => {
  const window = browser(context, '<body data-bt-motion="normal"></body>')
  const storage = window.localStorage
  storage.setItem('ds-superagent:appearance', JSON.stringify({ theme: 'paper', accent: INKS.charcoal[0], motion: 'quiet' }))
  const calls = []
  const cleanup = installAppearance({ overrideTokens(id, tokens) {
    calls.push({ id, tokens })
    return () => calls.push('released')
  } })
  let cleaned = false
  context.after(() => { if (!cleaned) cleanup() })
  const { document } = window
  const rootInk = () => window.getComputedStyle(document.documentElement).getPropertyValue('--bt-accent').trim()
  assert.equal(rootInk(), INKS.charcoal[0])
  document.body.setAttribute('data-ds-dark-theme', '')
  assert.equal(rootInk(), INKS.charcoal[1])
  assert.equal(document.body.dataset.btMotion, 'quiet')
  setAppearance({ theme: 'moonlight', accent: null, motion: 'lively' })
  assert.equal(rootInk(), allThemes().moonlight.dark.accent)
  assert.equal(document.body.dataset.btMotion, 'lively')
  assert.deepEqual(JSON.parse(storage.getItem('ds-superagent:appearance')), { theme: 'moonlight', accent: null, motion: 'lively' })
  assert.deepEqual(normalizeAppearance({ theme: 'constructor', accent: 'red', motion: 'off' }), { theme: 'deepseek', accent: null, motion: 'normal' })
  assert.equal(calls[1].id, 'ds-superagent')
  assert.equal(calls[2], 'released')
  cleanup()
  cleaned = true
  assert.equal(document.body.dataset.btMotion, 'normal')
  assert.equal(document.head.querySelector('style'), null)
  assert.equal(calls[3], 'released')
})

test('the settings selectors write through the DSH theme service and follow its events', async (context) => {
  const window = browser(context, '<div id="settings"></div>')
  const root = createRoot(window.document.getElementById('settings'))
  const listeners = new Set()
  let snapshot = { preference: 'system', fontSizes: { text: 14 } }
  const publish = next => { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(snapshot) }
  const service = {
    getTheme: () => snapshot,
    setTheme: preference => publish({ preference }),
    setFontSize: (role, size) => publish({ fontSizes: { ...snapshot.fontSizes, [role]: size } }),
  }
  const ctx = {
    get: (id) => { assert.equal(id, 'theme'); return service },
    on: (event, listener) => {
      assert.equal(event, 'theme/change')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  try {
    await act(() => root.render(createElement(AppearanceSettings, { ctx })))
    const { document } = window
    const modeButton = label => [...document.querySelectorAll('button')].find(button => button.textContent === label)
    assert.equal(modeButton('Follow system').getAttribute('aria-pressed'), 'true')
    await act(() => modeButton('Dark mode').click())
    assert.equal(snapshot.preference, 'dark')
    assert.equal(modeButton('Dark mode').getAttribute('aria-pressed'), 'true')
    await act(() => service.setTheme('light'))
    assert.equal(modeButton('Light mode').getAttribute('aria-pressed'), 'true')
    const range = document.querySelector('input[type=range]')
    assert.deepEqual([range.min, range.max, range.value], ['12', '18', '14'])
    await act(() => service.setFontSize('text', 18))
    assert.equal(range.value, '18')
    assert.equal(range.getAttribute('aria-valuetext'), '18px')
  } finally {
    await act(() => root.unmount())
    assert.equal(listeners.size, 0)
  }
})
