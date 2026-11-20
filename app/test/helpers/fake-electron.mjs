// The Electron parts of the app, as a test double: enough of the API for the main process
// of src/main.mjs to run without a display, without DSH and without the user's data.
// The loader (test/helpers/loader.mjs) puts this module in place of "electron".
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The data of the app in this process: a folder of its own, so that a test never writes
// into the data of the user.
const root = mkdtempSync(join(tmpdir(), 'ds-superagent-fake-user-data-'))
export const paths = {
  root,
  appData: join(root, 'appData'),
  userData: join(root, 'appData', 'DS SuperAgent'),
  downloads: join(root, 'downloads'),
  exe: join(root, 'program', 'DS SuperAgent.exe'),
  // The folder of the app itself: the Host's pnpm lives in it.
  appPath: join(root, 'app'),
}
for (const folder of [paths.userData, paths.downloads]) mkdirSync(folder, { recursive: true })

export const state = {
  windows: [],
  menus: [],
  dialogs: [],
  pickers: [],
  notifications: [],
  quits: 0,
  relaunches: [],
  exits: [],
  ipc: new Map(),
  tray: undefined,
  // The tray cannot always be built; a test says so before the app starts.
  trayFails: false,
  // A tray update can fail after startup; that must not strand the app during quit.
  trayUpdatesFail: false,
  // The app is a packaged one: it has an updater. It is set after the app starts, so that
  // the paths of the packaged app do not come into the way of the start.
  packaged: false,
  // No page of the browser comes through.
  rejectLoads: false,
  // The cookies of the browser: the Host's address keeps one after the launch URL was used.
  cookies: [],
  paths: {},
  dock: { setIcon: () => {} },
}

export class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.visible = false
    this.minimized = false
    this.fullScreen = false
    this.destroyed = false
    this.url = ''
    this.loaded = []
    this.shown = 0
    this.focused = 0
    this.webContents = new FakeWebContents(this)
    state.windows.push(this)
  }

  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  isFullScreen() { return this.fullScreen }
  setFullScreen(value) { this.fullScreen = value; if (!value) this.emit('leave-full-screen') }
  show() { this.visible = true; this.shown += 1; this.emit('show') }
  hide() { this.visible = false; this.emit('hide') }
  setOpacity(value) { this.opacity = value }
  focus() { this.focused += 1 }
  restore() { this.minimized = false; this.visible = true; this.emit('restore') }
  minimize() { this.minimized = true }
  destroy() { this.destroyed = true; this.emit('closed') }
  close() { this.emit('close', { preventDefault: () => { this.prevented = true } }) }
  setTitleBarOverlay() {}
  setVibrancy() {}
  setProgressBar() {}
  setMinimumSize() {}
  moveTop() {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 } }
  getNormalBounds() { return this.getBounds() }
  getContentBounds() { return this.getBounds() }
  setBounds() {}
  setContentBounds() {}
  setBackgroundColor() {}
  setSkipTaskbar() {}
  isFocused() { return this.focused > 0 }
  showInactive() { this.visible = true; this.shown += 1; this.emit('show') }
  moveAbove() {}
  getMediaSourceId() { return 'window:1:0' }
  flashFrame() {}
  async loadURL(url) {
    this.url = url
    this.webContents.mainFrame.url = url
    this.loaded.push(url)
    if (state.rejectLoads || this.rejectLoads) throw new Error(`the page ${url} did not load`)
    // The Host trades the token of the launch URL for a cookie of the browser's session.
    try {
      const parsed = new URL(url)
      const token = parsed.searchParams.get('token')
      if (token !== null) state.cookies.push({ name: 'dsh-auth', value: token, domain: parsed.hostname, path: '/' })
    } catch { /* a page without an address of its own */ }
    if (this.url.startsWith('http://127.0.0.1:')) {
      setImmediate(() => {
        const handler = state.ipc.get('ds-superagent:ready')
        if (handler !== undefined) handler({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, undefined)
      })
    }
    // The window is on the screen once its first page is there.
    if (!this.ready) {
      this.ready = true
      setImmediate(() => { if (!this.destroyed) this.emit('ready-to-show') })
    }
  }
}

function answerPicker(contents, request) {
  state.pickers.push(request)
  setImmediate(async () => {
    const event = { sender: contents, senderFrame: contents.mainFrame }
    const shown = state.ipc.get('ds-superagent:app-picker-shown')
    if (shown !== undefined) shown(event, request.id)
    const answer = typeof state.openAnswer === 'function' ? state.openAnswer(request) : (state.openAnswer ?? { canceled: true, filePaths: [] })
    if (answer.canceled || answer.filePaths?.[0] === undefined) {
      state.ipc.get('ds-superagent:app-picker-cancel')?.(event, request.id)
      return
    }
    if (request.mode === 'folder') {
      try { mkdirSync(answer.filePaths[0], { recursive: true }) } catch {}
    }
    const options = request.mode === 'save' ? { name: request.name } : undefined
    const chosen = await state.ipc.get('ds-superagent:app-picker-choose')?.(event, request.id, answer.filePaths[0], options)
    if (chosen?.error !== undefined) state.ipc.get('ds-superagent:app-picker-cancel')?.(event, request.id)
  })
}

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super()
    this.win = win
    this.session = new EventEmitter()
    this.mainFrame = {}
    this.isDestroyed = () => this.win.destroyed
    this.isLoading = () => false
    this.getURL = () => this.win.url
    this.getTitle = () => win.options?.title ?? ''
    this.sent = []
    this.send = (...args) => {
      this.sent.push(args)
      if (args[0] === 'ds-superagent:app-picker') answerPicker(this, args[1])
    }
    this.setWindowOpenHandler = () => {}
    this.insertCSS = async () => {}
    this.toggleDevTools = () => {}
    this.loadURL = async url => { await this.win.loadURL(url) }
    this.reload = () => {}
  }
}

class FakeApp extends EventEmitter {
  constructor() {
    super()
    this.name = 'Electron'
    this.getVersion = () => '0.2.2'
    this.getLocale = () => 'en-US'
    this.getPath = (name) => state.paths[name] ?? paths[name] ?? join(root, String(name))
    this.getAppPath = () => paths.appPath
    this.setPath = (name, value) => { state.paths[name] = value }
    this.setName = (name) => { this.name = name }
    this.setAppUserModelId = (id) => { state.appId = id }
    // The app starts a tick later, so that a test has its say before the app begins.
    this.whenReady = () => new Promise((done) => { setImmediate(done) })
    this.requestSingleInstanceLock = () => true
    this.relaunch = (options) => { state.relaunches.push(options) }
    this.exit = (code) => { state.exits.push(code); this.emit('exit', code) }
    this.quit = () => {
      state.quits += 1
      let prevented = false
      this.emit('before-quit', { preventDefault: () => { prevented = true } })
      state.quitPrevented = prevented
      if (prevented) return
      this.emit('will-quit')
      for (const win of state.windows) if (!win.destroyed) win.destroy()
    }
    this.show = () => { state.appShown = (state.appShown ?? 0) + 1 }
    this.hide = () => { state.appHidden = (state.appHidden ?? 0) + 1 }
    this.focus = () => {}
    this.setAboutPanelOptions = () => {}
    this.setAsDefaultProtocolClient = () => {}
    this.setBadgeCount = (count) => { state.badge = count; return true }
  }

  get isPackaged() { return state.packaged === true }
}

export const app = new FakeApp()
export const autoUpdater = new EventEmitter()

export const BrowserWindow = FakeWindow

export const WebContentsView = class {
  constructor(options) { this.options = options; this.webContents = new FakeWebContents({ destroyed: false, url: '' }) }
  setBounds() {}
  setVisible() {}
}

export const Menu = {
  buildFromTemplate: (template) => ({ template }),
  setApplicationMenu: (menu) => { state.menus.push(menu) },
}

export const Tray = class extends EventEmitter {
  constructor(image) {
    super()
    if (state.trayFails) throw new Error('no system tray here')
    this.image = image
    this.menu = undefined
    state.tray = this
  }
  setToolTip(value) {
    if (state.trayUpdatesFail) throw new Error('the tray could not be updated')
    this.tooltip = value
  }
  setContextMenu(menu) { this.menu = menu }
  destroy() { this.destroyed = true }
}

export const nativeImage = {
  createFromPath: () => ({
    empty: false,
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 32 }),
    toPNG: () => Buffer.alloc(8),
    addRepresentation() {},
    setTemplateImage() {},
  }),
}

export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' })

const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, workAreaSize: { width: 1920, height: 1040 } }
export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => display,
  getDisplayMatching: () => display,
  getPrimaryDisplay: () => display,
}

export const systemPreferences = {
  getAnimationSettings: () => ({ prefersReducedMotion: true }),
  getNotificationSettings: () => ({ authorizationStatus: 'authorized' }),
}

export const Notification = class extends EventEmitter {
  static isSupported() { return true }
  constructor(options) { super(); this.options = options; state.notifications.push(this) }
  show() { this.shown = true }
  close() { this.closed = true; this.emit('close') }
}

export const clipboard = { writeText: () => {} }

export const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 7 })

// The cookies of the browser: the Host's address keeps one after the launch URL was used.
const cookieJar = {
  get: async ({ url } = {}) => {
    if (url === undefined) return state.cookies.map(entry => ({ ...entry }))
    const wanted = new URL(url)
    return state.cookies.filter(entry => entry.domain === wanted.hostname).map(entry => ({ ...entry }))
  },
}

export const session = {
  defaultSession: Object.assign(new EventEmitter(), { cookies: cookieJar }),
  fromPartition: () => Object.assign(new EventEmitter(), { cookies: cookieJar }),
}

export const ipcMain = {
  handle: (channel, handler) => { state.ipc.set(channel, handler) },
  on: (channel, handler) => { state.ipc.set(channel, handler) },
}

export const dialog = {
  showMessageBox: async (...args) => {
    // Electron takes the window as the first argument and the box as the second.
    const options = args.length > 1 ? args[1] : args[0]
    state.dialogs.push(options)
    const answer = state.dialogAnswer ?? { response: 1 }
    return typeof answer === 'function' ? answer(options) : answer
  },
  showErrorBox: (title, message) => { state.dialogs.push({ title, message }) },
  showOpenDialog: async (...args) => {
    const options = args.length > 1 ? args[1] : args[0]
    state.dialogs.push(options)
    const answer = state.openAnswer ?? { canceled: true, filePaths: [] }
    return typeof answer === 'function' ? answer(options) : answer
  },
}

export const shell = {
  openExternal: async (url) => { state.opened = (state.opened ?? []).concat(url) },
}
