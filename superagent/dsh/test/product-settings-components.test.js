import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from 'esbuild'

const requireHarness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
const clientDir = new URL('../src/client/', import.meta.url)

test('the settings page renders field names, help, status, details, statistics and actions', async () => {
  const { createElement: h } = requireHarness('react')
  const { renderToStaticMarkup } = requireHarness('react-dom/server')
  const { JSDOM } = requireHarness('jsdom')
  const { outputFiles } = await build({ stdin: { contents: readFileSync(new URL('product-settings-components.js', clientDir), 'utf8') },
    bundle: true, format: 'cjs', external: ['react'], write: false })
  const module = { exports: {} }
  new Function('module', 'require', outputFiles[0].text)(module, requireHarness)
  const { SettingsPage, FieldRow, SectionCard, EmptyState, InlineNotice, StatusChip, DetailList, StatGrid } = module.exports
  const out = renderToStaticMarkup(h(SettingsPage, { title: 'Execution', actions: h('button', null, 'Reload') },
    h(SectionCard, { title: 'Targets', description: 'Choose where work runs.' },
      h(FieldRow, { label: 'Device name', hint: 'The label on this Host.', control: h('input') }),
      h(FieldRow, { label: 'Actions', control: h('button', null, 'Pair') }),
      h(EmptyState, { title: 'No devices', detail: 'Pair a device to begin.' })),
    h(StatGrid, { items: [{ label: 'Online', value: 0, detail: 'Paired devices' }] }),
    h(InlineNotice, { title: 'Pairing failed', tone: 'danger', action: h('button', null, 'Retry') }, 'Check the pairing code.'),
    h(DetailList, { items: [{ label: 'Environment', value: 'local', mono: true },
      { label: 'Status', value: h(StatusChip, { tone: 'success' }, 'Ready') }] })))
  const dom = new JSDOM(out)
  try {
    const { document } = dom.window
    assert.equal(document.querySelector('h2').textContent, 'Execution')
    assert.equal(document.querySelector('header button').textContent, 'Reload')
    const field = document.querySelector('input')
    assert.equal(field.labels.length, 1)
    assert.equal(document.getElementById(field.getAttribute('aria-labelledby')).textContent, 'Device name')
    assert.equal(document.getElementById(field.getAttribute('aria-describedby')).textContent, 'The label on this Host.')
    assert.equal(document.querySelector('label button'), null)
    assert.match(document.body.textContent, /No devices.*Pair a device to begin\./u)
    assert.equal(document.querySelector('dl dd').textContent, '0')
    assert.match(document.querySelector('[role=alert]').textContent, /Pairing failed.*Check the pairing code.*Retry/u)
    assert.equal(document.querySelector('dd code').textContent, 'local')
    assert.equal(document.querySelector('dd [data-tone=success]').textContent, 'Ready')
  } finally { dom.window.close() }
})

test('migrated page styles source size and color from shared tokens', () => {
  for (const page of ['execution', 'schedules', 'proactive', 'presets', 'memory', 'browser-settings', 'browser-import',
    'supervision', 'operations', 'credentials', 'settings-css']) {
    const source = readFileSync(new URL(`product-${page}.js`, clientDir), 'utf8')
    const stylesheet = source.split('export const PRODUCT_').slice(1).join('')
    assert.doesNotMatch(stylesheet, /(?:font-size|border-radius)\s*:\s*\d+(?:px|rem|em|%)|#[\da-f]{3,8}\b|rgba?\(/iu, page)
  }
})
