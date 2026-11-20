import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { downloadSaver } from '../src/downloads.mjs'

const root = mkdtempSync(join(tmpdir(), 'ds-superagent-downloads-'))
test.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
let serial = 0
function fixture() {
  const base = join(root, String(++serial))
  const downloads = join(base, 'downloads')
  const staging = join(base, 'staging')
  mkdirSync(downloads, { recursive: true })
  return { base, downloads, staging }
}

function item(name = 'chart.png') {
  return Object.assign(new EventEmitter(), {
    path: undefined,
    cancelled: false,
    getFilename: () => name,
    setSavePath(path) { this.path = path },
    cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') },
    finish(text = 'bytes') {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, text)
      this.emit('done', {}, 'completed')
    },
  })
}

const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
const settle = () => new Promise(resolve => setImmediate(resolve))
const waitFor = async predicate => {
  for (let turn = 0; turn < 100 && !predicate(); turn += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(predicate(), true)
}

function saver(paths, ask, window = { webContents: {} }) {
  const contents = window.webContents
  const save = downloadSaver({
    window: () => window,
    ask,
    staging: () => paths.staging,
    getPath: name => name === 'downloads' ? paths.downloads : paths.base,
    log: { warn() {} },
  })
  return { contents, save, setWindow: value => { window = value } }
}

test('the download is staged until the app picker confirms a destination', async () => {
  const paths = fixture()
  let answer
  const { contents, save } = saver(paths, (name, folder) => {
    assert.equal(name, 'chart.png')
    assert.equal(folder, paths.downloads)
    return new Promise(resolve => { answer = resolve })
  })
  const download = item()
  const request = event()
  save(request, download, contents)
  assert.equal(request.prevented, false)
  assert.ok(download.path.startsWith(paths.staging))
  await settle()
  download.finish('fixture bytes')
  answer(join(paths.downloads, 'chart.png'))
  const target = join(paths.downloads, 'chart.png')
  await waitFor(() => existsSync(target))
  assert.equal(readFileSync(target, 'utf8'), 'fixture bytes')
})

test('cancelling the app picker cancels and removes the staged download', async () => {
  const paths = fixture()
  const { contents, save } = saver(paths, async () => null)
  const download = item()
  save(event(), download, contents)
  await waitFor(() => download.cancelled)
  await waitFor(() => !existsSync(download.path))
  const entries = await (await import('node:fs/promises')).readdir(paths.staging).catch(() => [])
  assert.deepEqual(entries, [])
})

test('downloads from other contents pass through unchanged', () => {
  const paths = fixture()
  let asked = false
  const owner = { webContents: {} }
  const { save } = saver(paths, async () => { asked = true; return null }, owner)
  const download = item()
  const request = event()
  save(request, download, {})
  assert.equal(asked, false)
  assert.equal(request.prevented, false)
  assert.equal(download.path, undefined)
})

test('the destination is requested from the current product window', async () => {
  const paths = fixture()
  let resolveAnswer
  const contents = {}
  const first = { webContents: {} }
  const { save, setWindow } = saver(paths, () => new Promise(resolve => { resolveAnswer = resolve }), first)
  const current = { webContents: contents }
  setWindow(current)
  const download = item()
  save(event(), download, contents)
  await settle()
  assert.equal(typeof resolveAnswer, 'function')
  resolveAnswer(null)
  await waitFor(() => download.cancelled)
})

test('a missing product window does not intercept downloads', () => {
  const paths = fixture()
  const save = downloadSaver({ window: () => undefined, ask: async () => null,
    staging: () => paths.staging, getPath: name => name === 'downloads' ? paths.downloads : paths.base })
  const download = item()
  const request = event()
  save(request, download, {})
  assert.equal(request.prevented, false)
  assert.equal(download.path, undefined)
})
