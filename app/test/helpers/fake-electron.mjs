// The Electron parts of the app, as a test double: enough of the API for the main process
// of src/main.mjs to run without a display, without DSH and without the user's data.
// The loader (test/helpers/loader.mjs) puts this module in place of "electron".
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

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
  showInactive() { this.show() }
  hide() { this.visible = false; this.emit('hide') }
  focus() { this.focused += 1 }
  isFocused() { return this.visible && !this.minimized }
  setOpacity(value) { (this.opacities ??= []).push(value) }
  restore() { this.minimized = false; this.visible = true; this.emit('restore') }
  minimize() { this.minimized = true }
  destroy() { this.destroyed = true; this.emit('closed') }
  close() { this.emit('close', { preventDefault: () => { this.prevented = true } }) }
  setTitleBarOverlay() {}
  setProgressBar() {}
  setMinimumSize() {}
  setOverlayIcon(image, description) { state.badge = { image, description } }
  setIgnoreMouseEvents(value) { this.ignoresMouse = value }
  moveTop() {}
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 } }
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
    // The window is on the screen once its first page is there.
    if (!this.ready) {
      this.ready = true
      setImmediate(() => { if (!this.destroyed) this.emit('ready-to-show') })
    }
  }
}

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super()
    this.win = win
    this.session = session.defaultSession
    this.mainFrame = {}
    this.isDestroyed = () => this.win.destroyed
    this.getURL = () => this.win.url
    this.getTitle = () => win.options?.title ?? ''
    this.messages = []
    this.animations = []
    this.send = (...message) => this.messages.push(message)
    this.setWindowOpenHandler = () => {}
    this.insertCSS = async () => {}
    this.focus = () => { this.focused = true }
    this.executeJavaScript = async script => {
      if (!script.includes('.animate(')) return { ready: true, reducedMotion: state.reducedMotion === true }
      const animate = () => {
        const animation = { finished: false, visibleAtFinish: false }
        this.animations.push(animation)
        return { finished: new Promise(resolve => setImmediate(() => {
          animation.finished = true
          animation.visibleAtFinish = this.win.isVisible()
          resolve()
        })) }
      }
      return runInNewContext(script, { document: { documentElement: { animate } } })
    }
    this.toggleDevTools = () => {}
    this.loadURL = async url => { await this.win.loadURL(url) }
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
    this.setBadgeCount = (count) => { state.badgeCount = count }
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
      if (!prevented) this.emit('will-quit')
    }
    this.show = () => { state.appShown = (state.appShown ?? 0) + 1 }
    this.hide = () => { state.appHidden = (state.appHidden ?? 0) + 1 }
    this.focus = () => {}
    this.setAboutPanelOptions = () => {}
    this.setAsDefaultProtocolClient = () => {}
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
    resize: () => nativeImage.createFromPath(),
    toPNG: () => Buffer.alloc(8),
    addRepresentation() {},
    setTemplateImage() {},
  }),
}

export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
export const Notification = class extends EventEmitter {
  static isSupported() { return state.notificationsUnavailable !== true }
  constructor(options) { super(); this.options = options }
  show() { state.notifications ??= []; state.notifications.push(this) }
  close() { this.emit('close') }
}

export const powerMonitor = new EventEmitter()
powerMonitor.getSystemIdleState = () => state.desktopIdleState ?? 'active'

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
  showSaveDialogSync: (_owner, options) => { state.dialogs.push(options); return state.saveAnswer },
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
