import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startupPage, startupWindowBounds } from '../src/status-window.mjs'

const decode = url => decodeURIComponent(url.slice(url.indexOf(',') + 1))
const page = (...args) => decode(startupPage(...args))

test('the startup page is the whale launch surface without persistent loading copy', () => {
  const html = page('Starting DS SuperAgent', { lang: 'en', image: 'ignored' })
  assert.match(html, /data-status="loading"/)
  assert.match(html, /class="pond"/)
  assert.match(html, /class="ring"/)
  assert.match(html, /class="whale-svg"/)
  assert.match(html, /<p class="sr" role="status">Starting DS SuperAgent<\/p>/)
  assert.match(html, /class="status-panel" role="alert" hidden/)
  assert.doesNotMatch(html, /<img\b/u)
  assert.doesNotMatch(html, /<progress\b/u)
})

test('a failed start keeps its detail and actions on the same launch surface', () => {
  const html = page('the Host did not start', { lang: 'en', detail: 'DSH Host stopped', actions: [
    { action: 'retry', label: 'Try again' }, { action: 'open-data', label: 'Open data folder' },
  ] })
  assert.match(html, /data-status="failure"/)
  assert.match(html, /<section class="status-panel" role="alert">/)
  assert.match(html, /the Host did not start/)
  assert.match(html, /DSH Host stopped/)
  assert.match(html, /<button type="button" data-startup-action="retry" autofocus>Try again<\/button>/)
  assert.match(html, /data-startup-action="open-data"/)
  assert.doesNotMatch(html, /<p class="sr" role="status">/)
})

test('the startup window is centred at the launch-page size and shortens on low work areas', () => {
  const area = { x: 100, y: 40, width: 1920, height: 1080 }
  assert.deepEqual(startupWindowBounds(area), { x: 700, y: 310, width: 720, height: 540 })
  assert.deepEqual(startupWindowBounds({ x: 0, y: 0, width: 1366, height: 587 }),
    { x: 323, y: 44, width: 720, height: 500 })
  assert.deepEqual(startupWindowBounds({ x: -1280, y: 0, width: 700, height: 500 }),
    { x: -1280, y: 0, width: 700, height: 500 })
})
