import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNotifications } from '../src/notifications.mjs'
import { rootOf } from '../src/place.mjs'
import { Pickers, PICKER_IPC } from '../src/picker-host.mjs'
import { LogFile, redactor } from '../src/logs.mjs'
import { downloadSaver } from '../src/downloads.mjs'
import { createComputerCursor, cursorHtml } from '../src/computer-cursor.mjs'
import { createComputerIndicator, indicatorHtml } from '../src/computer-indicator.mjs'
import { acceptsAct, START_ACTS, mainRect, startSize } from '../src/start-window.mjs'

const root = mkdtempSync(join(tmpdir(), 'ds-superagent-shell-features-'))
test.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

test('place selection refuses a throwaway DSH path without consulting user data', () => {
  const dshHome = join(root, 'personal-dsh-fixture')
  mkdirSync(dshHome)
  const result = rootOf(join(dshHome, 'candidate'), { dshHome, env: {}, probe: false })
  assert.equal(result.reason, 'dsh')
  assert.equal(result.at, join(dshHome, 'candidate'))
  assert.equal(rootOf(join(root, 'new-place'), { dshHome, env: {}, probe: false }).reason, undefined)
})

test('picker IPC accepts a choice only from its owning page', { timeout: 3000 }, async () => {
  const calls = new Map()
  const ipcMain = {
    on: (channel, listener) => calls.set(channel, listener),
    handle: (channel, listener) => calls.set(channel, listener),
  }
  const pickers = new Pickers({ ipcMain, getPath: () => root, platform: 'linux', shownMs: 100 })
  const page = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => false,
    send(channel, request) { this.emit('picker-open', channel, request) },
  })
  const folder = join(root, 'picked-folder')
  mkdirSync(folder)
  const opened = once(page, 'picker-open', { signal: AbortSignal.timeout(2000) })
  const pending = pickers.ask(page, { mode: 'folder', title: 'Choose folder', start: root, labels: {} })
  const [channel, request] = await opened
  calls.get(PICKER_IPC.shown)({ sender: page }, request.id)
  assert.equal(channel, PICKER_IPC.open)
  const other = new EventEmitter()
  assert.equal(await calls.get(PICKER_IPC.choose)({ sender: other }, request.id, folder), undefined)
  assert.deepEqual(await calls.get(PICKER_IPC.choose)({ sender: page }, request.id, folder), { path: folder })
  assert.equal(await pending, folder)
})

test('log output redacts secrets and home paths before persistence', () => {
  const dir = join(root, 'logs')
  const userHome = join(root, 'private-user')
  const personalDsh = join(root, 'personal-dsh-fixture')
  const log = new LogFile({ dir, redact: redactor({ home: userHome, extraHomes: [personalDsh], platform: 'win32' }), now: () => new Date(0) })
  log.write('main', `launch ${userHome} DSH_HOME=${personalDsh} token=secret sk-test-key API_KEY="api-secret" password: pass-secret\n`)
  log.close()
  const contents = readFileSync(join(dir, 'main.log'), 'utf8')
  assert.match(contents, /%USERPROFILE%/u)
  assert.match(contents, /token=<hidden>/u)
  assert.match(contents, /sk-<hidden>/u)
  assert.doesNotMatch(contents, /private-user|personal-dsh-fixture|secret|sk-test-key|pass-secret/u)
  const windows = redactor({ home: 'C:\\Users\\ICEFIR~1', extraHomes: ['C:\\Users\\IceFire_Icer'], platform: 'win32' })
  assert.equal(windows('profile C:\\Users\\ICEFIR~1\\.dsh'), 'profile %USERPROFILE%\\.dsh')
  assert.equal(windows('profile C:\\Users\\IceFire_Icer\\.dsh'), 'profile %USERPROFILE%\\.dsh')
})

test('notification clicks open the requested session once and suppress focused notices', () => {
  const shown = []
  class FakeNotification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; shown.push(this) }
    show() { this.visible = true }
    close() { this.closed = true; this.emit('close') }
  }
  const notifications = createNotifications({
    Notification: FakeNotification,
    systemPreferences: { getNotificationSettings: () => ({ authorizationStatus: 'authorized' }) },
    platform: 'win32',
    log: { warn() {} },
  })
  assert.equal(notifications.show({ title: 'Main', body: 'Reply ready' }, { focused: () => true }), false)
  let opened = 0
  assert.equal(notifications.show({ title: 'Main', body: 'Reply ready' }, {
    focused: () => false,
    open: () => { opened += 1 },
  }), true)
  shown[0].emit('click')
  shown[0].emit('click')
  assert.equal(opened, 1)
  notifications.show({ title: 'Router', body: 'A work item needs you' }, { focused: () => false })
  notifications.clear()
  assert.equal(shown[1].closed, true)
})

test('main-window downloads stage first, then move to the app-picker destination', async () => {
  const downloads = join(root, 'downloads')
  const staging = join(root, 'staging')
  mkdirSync(downloads)
  const contents = {}
  const item = Object.assign(new EventEmitter(), {
    path: undefined,
    getFilename: () => 'report.txt',
    setSavePath(path) { this.path = path },
    finish() {
      writeFileSync(this.path, 'fixture')
      this.emit('done', {}, 'completed')
    },
  })
  const save = downloadSaver({
    window: { webContents: contents },
    ask: async (name, folder) => {
      assert.equal(name, 'report.txt')
      assert.equal(folder, downloads)
      return join(downloads, name)
    },
    staging: () => staging,
    getPath: name => ({ downloads, home: root })[name],
    log: { warn() {} },
  })
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  save(event, item, contents)
  assert.equal(event.prevented, false)
  assert.ok(item.path.startsWith(staging))
  await new Promise(resolve => setImmediate(resolve))
  item.finish()
  const target = join(downloads, 'report.txt')
  for (let turn = 0; turn < 50 && !existsSync(target); turn += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(readFileSync(target, 'utf8'), 'fixture')
  assert.deepEqual(await (await import('node:fs/promises')).readdir(staging), [])
})

test('startup and product windows have stable display geometry', () => {
  assert.deepEqual(startSize({ height: 600 }), { width: 720, height: 540 })
  assert.deepEqual(mainRect({ x: 600, y: 250, width: 720, height: 540 }, { x: 0, y: 0, width: 1920, height: 1040 }),
    { x: 300, y: 90, width: 1320, height: 860 })
})

test('the startup page refuses the legacy team import and accepts the restore rollback', () => {
  assert.equal(acceptsAct('importModel', 'card'), false)
  assert.equal(acceptsAct('importOption', 'card'), false)
  assert.equal(START_ACTS.includes('importModel'), false)
  assert.equal(acceptsAct('rollback', 'failed'), true)
  assert.equal(acceptsAct('rollback', 'boot'), false)
})

test('computer indicator is non-focusing and accepts actions only from its own window', () => {
  const listeners = new Map()
  const windows = []
  const actions = []
  class FakeWindow {
    constructor(options) {
      this.options = options
      this.webContents = { loadURL: async () => {}, executeJavaScript: async () => 140 }
      this.handlers = new Map()
      windows.push(this)
    }
    loadURL(url) { this.url = url; return Promise.resolve() }
    on(name, run) { this.handlers.set(name, run) }
    once(name, run) { this.handlers.set(name, run) }
    setContentProtection(value) { this.protected = value }
    setVisibleOnAllWorkspaces() {}
    setBounds(bounds) { this.bounds = bounds }
    showInactive() { this.visible = true }
    close() { this.handlers.get('closed')?.() }
  }
  const indicator = createComputerIndicator({
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0 }, workAreaSize: { width: 1200, height: 800 } }) },
    html: indicatorHtml,
    ipcMain: { on: (channel, run) => listeners.set(channel, run) },
    onAction: (kind, holder) => actions.push([kind, holder]),
    log: { warn() {} },
  })
  indicator.update({ rows: [{ holderId: 'worker-1', label: 'Worker' }], labels: {} })
  const [win] = windows
  assert.equal(win.options.focusable, false)
  assert.equal(win.protected, true)
  assert.match(win.url, /data:text\/html/u)
  const action = listeners.get('ds-superagent:computer-indicator:act')
  action({ sender: {} }, 'stop', 'worker-1')
  action({ sender: win.webContents }, 'stop', 'worker-1')
  assert.deepEqual(actions, [['stop', 'worker-1']])
  indicator.dispose()
})

test('computer cursor fails closed where foreground-window proof is unavailable', async () => {
  let windows = 0
  class FakeWindow { constructor() { windows += 1 } }
  const cursor = createComputerCursor({ BrowserWindow: FakeWindow, screen: {}, platform: 'linux', log: { warn() {} } })
  await cursor.update({ holderId: 'worker-1', x: 10, y: 20, pid: process.pid })
  cursor.dispose()
  assert.equal(windows, 0)
  assert.match(cursorHtml({ color: 'url(javascript:alert(1))' }), /#4d6bfe/u)
})
