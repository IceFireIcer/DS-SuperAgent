// Electron main process: one window for DS SuperAgent, served by the app's own DSH Host.
// The window loads the Host's loopback address as DSH Web does: DSH's sign-in sends the page's
// origin as the address the browser comes back to, and accepts only a loopback one.
import { app, autoUpdater as nativeUpdater, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, session, shell as electronShell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { backupBeforeProfileChange, completeProductRestore, createProductBackup, listProductBackups, pendingProductRestore, recordProfileVersion,
  recoverInterruptedProductRestore, restoreProductBackup } from './product-backups.mjs'
import { createOperationsLog } from './operations-log.mjs'
import { createComputerCursor } from './computer-cursor.mjs'
import electronUpdater from 'electron-updater'
import { BotBrowserGuests, partitionOf } from './bot-browser.mjs'
import { BotViews, isBotId } from './bot-views.mjs'
import { importFromBrowser, listSources } from './browser-sources.mjs'
import { CookieImports, isProductBrowserImportId, ProductCookieImports } from './cookie-import.mjs'
import { CredentialImports } from './credential-import.mjs'
import { parseCookieFile } from './cookie-parse.mjs'
import { userDshHome, userDshHomes } from './dsh-home.mjs'
import { real, within } from './copy-tree.mjs'
import { downloadSaver } from './downloads.mjs'
import { canonicalExecPath } from './canonical-path.mjs'
import { chooseLocations, localeText, placeProblem, programFolder, saveLocations, text } from './first-run.mjs'
import { hostPort } from './host-port.mjs'
import { assertHostLockFree, hostLockPath, releaseHostLock, writeHostLock } from './host-lock.mjs'
import { HostProcess } from './host-process.mjs'
import { copyData, moveProblem } from './move-data.mjs'
import { createNativeNotifications } from './native-notifications.mjs'
import { pickDirectory, readImportFile } from './native-place.mjs'
import { ARTIFACT_PREFIX, PRODUCT_NAME, configureIdentity, formerDataFolders } from './product.mjs'
import { SUPERAGENT_PROFILE, assertLocalBackupProfile, profileHome } from './profile.mjs'
import { RemoteProductClient } from './remote-product-client.mjs'
import { createDesktopClassicAgent } from './classic-agent.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { handoffMain, waitForMainView } from './startup-handoff.mjs'
import { createComputerIndicator, createStartupScreen, statusPage } from './status-window.mjs'
import { UPDATE_TEXT, isNewer, watchReleases, watchUpdates } from './updates.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { CAPTION_HEIGHT, cssColor, micaAvailable, nativeThemeSource } from './window-frame.mjs'

const IPC = {
  caption: 'ds-superagent:caption-colors', nativeTheme: 'ds-superagent:native-theme', fullscreen: 'ds-superagent:fullscreen',
  dataLocation: 'ds-superagent:data-location', moveData: 'ds-superagent:move-data', teamWorkspace: 'ds-superagent:team-workspace',
  directoryPick: 'ds-superagent:directory-pick',
  browserAcquire: 'ds-superagent:browser-acquire', browserRelease: 'ds-superagent:browser-release', browserForget: 'ds-superagent:browser-forget',
  browserViewChanged: 'ds-superagent:browser-view-changed', browserViewCreate: 'ds-superagent:browser-view-create',
  browserViewSync: 'ds-superagent:browser-view-sync', browserViewPlace: 'ds-superagent:browser-view-place',
  browserViewNavigate: 'ds-superagent:browser-view-navigate', browserViewCommand: 'ds-superagent:browser-view-command',
  browserViewFocus: 'ds-superagent:browser-view-focus', browserViewRead: 'ds-superagent:browser-view-read',
  browserViewClose: 'ds-superagent:browser-view-close', browserViewHold: 'ds-superagent:browser-view-hold',
  browserImportSources: 'ds-superagent:browser-import-sources', browserImportPick: 'ds-superagent:browser-import-pick',
  browserImportLive: 'ds-superagent:browser-import-live',
  browserImportCancel: 'ds-superagent:browser-import-cancel',
  credentialImportPick: 'ds-superagent:credential-import-pick', credentialImportCancel: 'ds-superagent:credential-import-cancel',
  appUpdateState: 'ds-superagent:app-update-state', appUpdateCheck: 'ds-superagent:app-update-check',
  appUpdateInstall: 'ds-superagent:app-update-install', appUpdateOpen: 'ds-superagent:app-update-open',
  appUpdateChanged: 'ds-superagent:app-update-changed',
  backupList: 'ds-superagent:backup-list', backupCreate: 'ds-superagent:backup-create',
  backupRestore: 'ds-superagent:backup-restore', diagnosticsRead: 'ds-superagent:diagnostics-read',
  notify: 'ds-superagent:notify', setBadge: 'ds-superagent:badge',
  notificationTake: 'ds-superagent:notification-take', notificationOpen: 'ds-superagent:notification-open',
  productConnect: 'ds-superagent:client-connect', productDisconnect: 'ds-superagent:client-disconnect',
  productStatus: 'ds-superagent:client-status', productCall: 'ds-superagent:client-call', productEvents: 'ds-superagent:client-events',
  classicAgent: 'ds-superagent:classic-agent',
}
// A cookie export larger than this is not a cookie export.
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const CREDENTIAL_IMPORT_FILE_MAX = 1024 * 1024
const PRODUCT_BROWSER_IMPORT_ERRORS = new Set(['BROWSER_IMPORT_NOT_FOUND', 'BROWSER_IMPORT_CONFLICT'])
const MOVE_PROBLEMS = { drive: 'moveDrive', nested: 'moveNested', workspace: 'moveWorkspace', program: 'inProgram', notEmpty: 'moveNotEmpty' }
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
const packageInfo = createRequire(import.meta.url)
const dshVersion = packageInfo('@deepseek-ai/dsh/package.json').version
const productVersion = packageInfo('ds-superagent/package.json').version
const profileVersion = () => `${app.getVersion()}/${productVersion}/${dshVersion}`
const assets = join(here, '..', 'assets')
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// The tray icon of this platform: Windows takes the .ico, macOS the template and its @2x,
// Linux the plain png.
const trayIconFile = () => join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
// Windows 11 draws Mica behind the page; mica.css lets it through the sidebar.
const mica = micaAvailable(process.platform, release())
let identityError
try { configureIdentity(app) }
catch (error) { identityError = error }

let mainWindow
const loadedWindows = new WeakSet()
let host
// The Host's loopback origin, which the window loads.
let origin
let hostStop
let updates
let maintenance
let startup
let updateLaunchPending = false
let updateExitAllowed = false
let updateExitCommitted = false
let updateExitTimer
let installOnQuit = true
let stopping = false
let stopped = false
let failed = false
// What the Host is doing, for the tray: a hidden window never looks like a stopped service.
const HOST_STATE = { starting: 'starting', running: 'running', stopped: 'stopped', failed: 'failed' }
let hostState = HOST_STATE.starting
// A Host that failed while the computer slept is replaced when it wakes, not before.
let suspended = false
let deferredFailure
// The way back to the same Host data after a failed or interrupted Host.
let hostFactory
let hostLock
let hostLockPid
let hostPortNumber
let places
// The Host answered and the window may talk to it without the launch URL.
let hostReady = false
// The Host's launch URL: the first window trades it for the Host's cookie.
let launchUrl
// The first load of the Host, which mints that cookie. It ends when the first load came
// through (true) or when it never did (false).
let bootstrap
// The launch URL is good for one use only: once a browser has carried it, no browser
// carries it again.
let tokenSpent = false
// The download handler of the app's session is bound once, not once per window.
let downloadsBound = false
let badge = false
let directoryDialog = false
let moveDialog = false
// Quitting while a first-run dialog is open stops the first run, and during the copy (of the
// first run or of a data move) it waits for the copy to stop at a safe point, so that it leaves
// no half team and no temporary copy.
let choosing
let copying
const copyAbort = new AbortController()
const browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
const botViews = new BotViews({
  window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
  statePath: join(app.getPath('userData'), 'bot-views.json'),
  onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
})
const cookieImports = new CookieImports()
const productCookieImports = new ProductCookieImports()
const credentialImports = new CredentialImports()
const remoteProduct = new RemoteProductClient()
const classicAgent = createDesktopClassicAgent({ window: () => mainWindow, remote: () => remoteProduct.status().connected })
const operationsLog = createOperationsLog(join(app.getPath('userData'), 'logs', 'operations.jsonl'))
const productBackupRoot = join(app.getPath('userData'), 'backups')
const note = (area, code, version) => void operationsLog.record(area, code, version).catch(() => {})
const managed = () => Boolean(process.env.DS_SUPERAGENT_POSTGRES?.trim())
const language = () => app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
const indicator = createComputerIndicator({ BrowserWindow, screen, icon: iconFile, lang: language, message: () => text().computerActive })
const computerCursor = createComputerCursor({ BrowserWindow, screen, platform: process.platform })
let activeComputer
const computerApprovals = new Map()
const computerControlId = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(value)
const notifications = createNativeNotifications({ Notification, icon: iconFile, onOpen: () => {
  shell.open()
  if (loadedWindows.has(mainWindow)) mainWindow.webContents.send(IPC.notificationOpen)
} })

function assertBackupLocation() {
  const problem = placeProblem(text(), productBackupRoot)
  if (problem !== undefined) throw Object.assign(new Error(problem), { code: 'BACKUP_LOCATION_UNAVAILABLE' })
}

// The window and the tray: closing the window hides it, the tray is the way back to it and
// the tray's Quit is the one ordinary way out.
const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => localeText(SHELL_TEXT),
  trayImage: () => trayImage(),
  window: () => !failed && loadedWindows.has(mainWindow) ? mainWindow : startupScreen.window() ?? mainWindow,
  build: () => rebuildWindow(),
  reveal: (target) => {
    const start = startupScreen.window()
    if (target !== start && (failed || !loadedWindows.has(target))) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
    if (target === start && !failed && !mainWindow && bootstrap) rebuildWindow()
  },
  quit: () => { app.quit() },
  locations: () => {
    if (!places || !loadedWindows.has(mainWindow) || hostState !== HOST_STATE.running) return
    shell.open()
    void showLocations().catch(() => note('shell', 'LOCATIONS_UNAVAILABLE'))
  },
  computerStop: { active: () => activeComputer !== undefined, run: () => clearComputer(true) },
  status: () => hostState,
  onSuspend: () => { suspended = true; clearComputer(true) },
  onResume: () => resumeHost(),
  busy: () => choosing !== undefined || copying !== undefined,
  // Before the first run has chosen its places there is no window to show, and before the
  // first load of the Host there is no address to load.
  ready: () => places !== undefined && origin !== undefined && (bootstrap !== undefined || hostState === HOST_STATE.running),
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: (options) => dialog.showMessageBox(options) },
  // Without a tray the close asks whether the app should end.
  fallback: { show: (options) => dialog.showMessageBox(options) },
})
const startupScreen = createStartupScreen({ BrowserWindow, ipcMain, icon: iconFile, lang: language,
  screen, nativeTheme, mica, quitting: shell.isQuitting, quit: shell.quit })
// The tray icon goes away with the app, and a late answer to the close notice hides nothing.
app.once('will-quit', () => { startupScreen.close(); clearComputer(true); notifications.dispose(); shell.dispose(); botViews.dispose(); updates?.stop() })

// A packaged app started through an 8.3 short path or a junction restarts once on the
// canonical path: the lock below and every path the Host sees then agree with the long
// form, and the profile patch layer stops mixing the two.
const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (identityError !== undefined) {
  dialog.showErrorBox(PRODUCT_NAME, identityError.message)
  app.exit(1)
} else if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => { shell.open() })
  nativeUpdater?.on('before-quit-for-update', () => { updateLaunchPending = updates?.state().phase === 'installing' })
  app.on('before-quit', (event) => {
    if (updateLaunchPending && !updateExitAllowed) {
      event.preventDefault()
      if (!updateExitTimer) {
        // NSIS reports a failed detached spawn after quitAndInstall has returned.
        updateExitTimer = setTimeout(() => {
          updateExitTimer = undefined
          updateExitAllowed = true
          app.quit()
        }, 1000)
        updateExitTimer.unref()
      }
      return
    }
    if (updateLaunchPending && updateExitAllowed) updateExitCommitted = true
    if (choosing !== undefined) {
      // A first-run dialog is open: the quit waits for it, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      choosing.abort()
      return
    }
    if (copying !== undefined) {
      // A copy is under way: it stops at a safe point, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    if (maintenance || startup) {
      event.preventDefault()
      if (startup) {
        shell.beginQuit()
        if (host) void stopHost().catch(() => {})
        void startup.catch(() => {}).then(() => hostStop).catch(() => {}).then(() => app.quit())
      }
      return
    }
    if (installOnQuit && !stopping && hostState === HOST_STATE.running && updates?.install && updates.state().phase === 'downloaded') {
      event.preventDefault()
      void installUpdate({ restart: false }).catch(() => { shell.cancelQuit(); showUpdateFailure() })
      return
    }
    // The app is on its way out: the window may close for good.
    shell.beginQuit()
    if (stopped || host === undefined) return
    event.preventDefault()
    // The Host is already stopping: the quit follows it.
    const leave = () => { stopped = true; app.quit() }
    if (stopping) { void (hostStop ?? Promise.resolve()).then(() => { app.quit() }, leave); return }
    void stopHost().then(() => { app.quit() }, leave)
  })
  app.whenReady().then(async () => {
    shell.install()
    powerMonitor.on('lock-screen', () => clearComputer(true))
    await start()
  }).catch(fail)
}

function lockProductData() {
  assertHostLockFree(hostLock)
  writeHostLock(hostLock, { pid: process.pid, port: hostPortNumber })
  hostLockPid = process.pid
}

function unlockProductData() {
  releaseHostLock(hostLock, hostLockPid)
  hostLockPid = undefined
}

function stopHost({ forBackup = false, holdLock = forBackup } = {}) {
  stopping = true
  clearComputer(true)
  const confirmedExit = () => {
    stopped = true
    hostState = HOST_STATE.stopped
    if (holdLock) {
      writeHostLock(hostLock, { pid: process.pid, port: hostPortNumber })
      hostLockPid = process.pid
    } else unlockProductData()
  }
  hostStop ??= Promise.resolve().then(() => host?.stop({ forBackup })).then(checkpoint => {
    confirmedExit()
    return checkpoint
  }, (error) => {
    console.error(error)
    // A Host that did not confirm its exit still owns the data: its lock stays, and nothing
    // may start on or replace that data.
    if (error?.code !== 'STOP_UNKNOWN') confirmedExit()
    else hostState = HOST_STATE.failed
    throw error
  })
  shell.refresh()
  return hostStop
}

// The Host is gone while the computer sleeps: the app hears it when it wakes, and replaces it
// then. Outside a sleep the failure is the user's now, with a chance to try again.
function hostFailure(error) {
  clearComputer(false)
  note('host', 'HOST_FAILED', app.getVersion())
  if (suspended) { deferredFailure = error; return }
  void fail(error)
}

// A Host that the shell listens to: the browser resource endpoint and a failure both arrive here.
function wireHost(instance) {
  instance.onMessage(message => {
    if (instance !== host || stopping) return
    if (message?.type === 'ds-superagent:computer-shell-cancel' && computerControlId(message.id)) {
      computerApprovals.get(message.id)?.abort()
      return
    }
    const indicatorRequest = message?.type === 'ds-superagent:computer-indicator'
    if ((message?.type === 'ds-superagent:computer-shell' || indicatorRequest && message.active === true) && computerControlId(message.id)) {
      void computerRequest(indicatorRequest ? { ...message, kind: 'indicator' } : message).catch(() => false).then(ok => {
        if (instance === host && !stopping && instance.isRunning()) {
          instance.send({ type: 'ds-superagent:computer-shell-response', id: message.id, ok })
        }
      }).catch(() => {})
      return
    }
    if (indicatorRequest) {
      if (message.active === false && message.controlId === activeComputer) clearComputer(false)
      return
    }
    if (message?.type === 'ds-superagent:credential-import-read' && typeof message.id === 'string'
      && typeof message.pendingId === 'string' && /^[\da-f-]{36}$/iu.test(message.pendingId)
      && typeof message.credentialId === 'string' && typeof message.sourceRef === 'string'
      && /^[a-f0-9]{64}$/u.test(message.sourceRef)) {
      try {
        const result = credentialImports.read(message.pendingId, message.sourceRef, message.credentialId)
        instance.send({ type: 'ds-superagent:credential-import-response', id: message.id,
          credentialId: result.id, sourceRef: result.sourceRef, value: result.value })
      } catch (error) {
        const code = error?.code === 'CREDENTIAL_IMPORT_NOT_FOUND' ? error.code : 'CREDENTIAL_IMPORT_UNAVAILABLE'
        instance.send({ type: 'ds-superagent:credential-import-response', id: message.id, code })
      }
      return
    }
    if (message?.type === 'ds-superagent:credential-import-cancel' && typeof message.pendingId === 'string'
      && /^[\da-f-]{36}$/iu.test(message.pendingId)
      && typeof message.sourceRef === 'string' && /^[a-f0-9]{64}$/u.test(message.sourceRef)) {
      credentialImports.cancel(message.pendingId, message.sourceRef)
      return
    }
    if (message?.type === 'ds-superagent:credential-import-finish' && typeof message.pendingId === 'string'
      && /^[\da-f-]{36}$/iu.test(message.pendingId)
      && typeof message.sourceRef === 'string' && /^[a-f0-9]{64}$/u.test(message.sourceRef)) {
      credentialImports.finish(message.pendingId, message.sourceRef)
      return
    }
    if (message?.type === 'ds-superagent:browser-import' && typeof message.id === 'string'
      && isBotId(message.profileKey)
      && typeof message.pendingImportId === 'string' && /^[\da-f-]{36}$/iu.test(message.pendingImportId)
      && isProductBrowserImportId(message.importId)) {
      const storage = session.fromPartition(partitionOf(`bot:${message.profileKey}`))
      void productCookieImports.apply(storage, message.pendingImportId, message.importId,
        message.profileKey, cookieImports).then(report => {
        instance.send({ type: 'ds-superagent:browser-import-response', id: message.id, report })
      }).catch(error => {
        const code = PRODUCT_BROWSER_IMPORT_ERRORS.has(error?.code) ? error.code : 'BROWSER_IMPORT_UNKNOWN'
        instance.send({ type: 'ds-superagent:browser-import-response', id: message.id,
          code })
      })
      return
    }
    if (message?.type === 'ds-superagent:browser-hold' && typeof message.id === 'string'
      && isBotId(message.profileKey) && typeof message.held === 'boolean'
      && typeof message.controlId === 'string' && /^[\da-f-]{36}$/iu.test(message.controlId)) {
      void botViews.hold(message.profileKey, message.held, true, message.controlId).then(() => {
        instance.send({ type: 'ds-superagent:browser-hold-response', id: message.id, held: message.held })
      }).catch(() => instance.send({ type: 'ds-superagent:browser-hold-response', id: message.id }))
      return
    }
    if (message?.type !== 'ds-superagent:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
    const downloadRoots = message.downloadRoots
    if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
      instance.send({ type: 'ds-superagent:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
      return
    }
    void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
      instance.send({ type: 'ds-superagent:browser-endpoint-response', id: message.id, url })
    }).catch(() => instance.send({ type: 'ds-superagent:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
  })
}

function clearComputer(notify) {
  const id = activeComputer
  activeComputer = undefined
  for (const approval of computerApprovals.values()) approval.abort()
  indicator.hide()
  computerCursor.clear()
  if (id !== undefined) {
    if (notify) {
      try { host?.send({ type: 'ds-superagent:computer-stop', controlId: id }) } catch {}
    }
    shell.refresh()
  }
}

async function computerRequest(message) {
  if (suspended || hostState !== HOST_STATE.running || stopping || shell.isQuitting() || remoteProduct.status().connected) return false
  const idle = powerMonitor.getSystemIdleState(3)
  if (idle !== 'active' && idle !== 'idle') return false
  if (message.kind === 'approve' || message.kind === 'reconcile') {
    const reconcile = message.kind === 'reconcile'
    if (!windowShown() || !reconcile && !shell.hasTray() || activeComputer || computerApprovals.size || busyWithData()) return false
    const { app: target, level, workItemId, generation } = message.request ?? {}
    if (!/^[\w-]{1,128}$/u.test(workItemId)) return false
    if (reconcile) {
      if (!computerControlId(message.request.operationId) || !/^app-[a-f0-9]{64}$/u.test(message.request.appId)
        || typeof message.request.appName !== 'string' || !message.request.appName.length || message.request.appName.length > 100
        || /[\p{C}]/u.test(message.request.appName)
        || !['click', 'type', 'activate'].includes(message.request.action)) return false
    } else if (!/^[\w-]{1,128}$/u.test(generation) || !/^app-[a-f0-9]{64}$/u.test(target?.id)
      || typeof target.name !== 'string' || target.name.length > 100 || /[\p{C}]/u.test(target.name)
      || !['view', 'background', 'foreground'].includes(level)) return false
    const owner = mainWindow
    const controller = new AbortController()
    computerApprovals.set(message.id, controller)
    const t = text()
    try {
      const { response } = await dialog.showMessageBox(owner, { type: 'warning', title: PRODUCT_NAME,
        message: reconcile ? t.computerReconcile : t.computerApproval(target.name),
        detail: reconcile ? t.computerReconcileDetail(message.request.appName, workItemId) : t.computerApprovalDetail(level, workItemId, generation),
        buttons: reconcile ? [t.cancel, t.computerReviewed] : [t.computerDeny, t.computerAllow],
        defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal })
      return response === 1 && !controller.signal.aborted && owner === mainWindow && windowShown() && !stopping && !suspended
        && !shell.isQuitting() && !remoteProduct.status().connected
    } finally { computerApprovals.delete(message.id) }
  }
  const id = message.controlId
  if (!computerControlId(id)) return false
  if (message.kind === 'indicator') {
    if (activeComputer || !shell.hasTray()) return false
    activeComputer = id
    const shown = await indicator.show().catch(() => false)
    if (!shown || activeComputer !== id || suspended || stopping) {
      if (activeComputer === id) clearComputer(false)
      note('shell', 'COMPUTER_INDICATOR_UNAVAILABLE')
      return false
    }
    shell.refresh()
    return true
  }
  if (activeComputer !== id) return false
  if (message.kind === 'active') return true
  if (message.kind === 'foreground') return idle === 'idle'
  if (message.kind === 'cursor') return computerCursor.show(message.point)
  return false
}

function busyWithData() { return choosing || copying || maintenance || startup || stopping || moveDialog }

function workspaceProblem(path) {
  const t = text()
  const shellData = real(app.getPath('userData'))
  if (within(path, shellData) || within(shellData, path)) return t.inDesktopData
  return path === real(places.workspace) ? placeProblem(t, path) : placeProblem(t, places.dataDir, path)
}

function readWorkspace() {
  const instance = host
  if (!instance || hostState !== HOST_STATE.running) return Promise.resolve(null)
  const id = randomUUID()
  return new Promise(resolve => {
    const finish = path => { clearTimeout(timer); unlisten(); resolve(path) }
    const timer = setTimeout(() => finish(null), 2000)
    const unlisten = instance.onMessage(message => {
      if (message?.type === 'ds-superagent:workspace-read-result' && message.id === id) {
        finish(typeof message.path === 'string' && isAbsolute(message.path) ? message.path : null)
      }
    })
    try { instance.send({ type: 'ds-superagent:workspace-read', id }) }
    catch { finish(null) }
  })
}

async function pickWorkspace(event) {
  assertLocalWindow(event)
  if (!windowShown() || directoryDialog || busyWithData()) return null
  directoryDialog = true
  try {
    const path = await pickDirectory(dialog, mainWindow, { title: text().pickWorkspace, defaultPath: places.workspace })
    if (!path || !fromWindow(event) || remoteProduct.status().connected || busyWithData()) return null
    const message = workspaceProblem(path)
    if (message) {
      await dialog.showMessageBox(mainWindow, { type: 'warning', title: PRODUCT_NAME, message, buttons: ['OK'] })
      return null
    }
    return path
  } finally { directoryDialog = false }
}

async function chooseImport(event, limit, options) {
  assertLocalWindow(event)
  if (!windowShown() || busyWithData()) return { canceled: true }
  try {
    const picked = await dialog.showOpenDialog(mainWindow, options)
    const path = picked.filePaths[0]
    if (picked.canceled || typeof path !== 'string' || !isAbsolute(path) || !fromWindow(event)
      || remoteProduct.status().connected || busyWithData()) return { canceled: true }
    const roots = [...userDshHomes(), ...formerDataFolders(app), places.dataDir, app.getPath('userData')]
    if (app.isPackaged) roots.push(programFolder())
    const result = await readImportFile(path, limit, roots)
    if (!fromWindow(event) || remoteProduct.status().connected || busyWithData()) return { canceled: true }
    if (result.error) note('shell', 'IMPORT_FILE_REJECTED')
    return result.bytes ? { ...result, label: basename(path) } : result
  } catch {
    note('shell', 'IMPORT_FILE_REJECTED')
    return { error: 'unreadable' }
  }
}

// A new Host takes the data lock before it starts. The lock names the Host child, not the
// shell, so a Host that outlives its shell still blocks a second Router.
function launchHost(instance) {
  host = instance
  wireHost(instance)
  const starting = instance.start()
  if (instance.pid() !== undefined) {
    hostLockPid = instance.pid()
    writeHostLock(hostLock, { pid: hostLockPid, port: hostPortNumber })
  }
  return starting.then(answer => {
    if (host === instance && answer?.url) classicAgent.replaceHost(instance, answer.url)
    return answer
  })
}

function startProductHost(home, { rollback = false } = {}) {
  startup = (async () => {
    lockProductData()
    try {
      if (rollback) assertLocalBackupProfile(home)
      const recovered = await recoverInterruptedProductRestore({ home, rollback })
      if (recovered.status === 'rolled-back') note('backup', 'RESTORE_ROLLED_BACK')
      if (!managed()) {
        const saved = await backupBeforeProfileChange({ home, backupRoot: productBackupRoot, version: profileVersion(), assertProfile: () => {
          assertBackupLocation()
          assertLocalBackupProfile(home)
        } })
        if (saved) note('backup', saved.restorable ? 'UPGRADE_BACKUP_CREATED' : 'UPGRADE_BACKUP_RESTORE_BLOCKED', app.getVersion())
      }
    } catch (error) {
      unlockProductData()
      note('backup', error?.code === 'UNSUPPORTED_SCHEMA' ? 'BACKUP_SCHEMA_UNSUPPORTED' : 'PROFILE_PREPARATION_FAILED', app.getVersion())
      throw error
    }
    if (shell.isQuitting() && !maintenance) { unlockProductData(); return undefined }
    const answer = await launchHost(hostFactory())
    if (answer?.url !== undefined) {
      await finishProfileStart(home)
      hostState = HOST_STATE.running
      shell.refresh()
      note('host', 'HOST_READY', app.getVersion())
    }
    return answer
  })().finally(() => { startup = undefined })
  return startup
}

async function start() {
  void startupScreen.show(text().starting)
  choosing = new AbortController()
  const where = await chooseLocations(choosing.signal, startupScreen.window()).finally(() => { choosing = undefined })
  if (where.quit) { startupScreen.close(); app.quit(); return }
  const hostHome = profileHome(where.dataDir)
  const workspace = where.workspace ?? join(hostHome, 'workspace')
  // A link can be made after the first run's check: the folders the Host will write to are
  // checked again, as the file system has them, before anything starts.
  for (const path of new Set([where.dataDir, hostHome, workspace])) {
    const problem = placeProblem(text(), path)
    if (problem !== undefined) throw new Error(problem)
  }
  places = { dataDir: where.dataDir, workspace }
  const port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
  if (shell.isQuitting()) return
  hostPortNumber = port
  origin = `http://127.0.0.1:${String(port)}`
  const pnpm = join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const runtimeDir = app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime')
  const profileDir = join(hostHome, 'profiles', SUPERAGENT_PROFILE)
  hostLock = hostLockPath(hostHome)
  const newHost = () => {
    const problem = placeProblem(text(), profileDir)
    if (problem !== undefined) throw new Error(problem)
    mkdirSync(profileDir, { recursive: true })
    return new HostProcess({
      entry: join(here, 'host.mjs'),
      cwd: profileDir,
      env: { ...process.env, DSH_HOME: hostHome, DS_SUPERAGENT_PORT: String(port), DS_SUPERAGENT_APP: '1',
        DS_SUPERAGENT_RUNTIME_DIR: runtimeDir, DS_SUPERAGENT_USER_DSH_HOME: userDshHome(), DS_SUPERAGENT_WORKSPACE: places.workspace,
        DS_SUPERAGENT_PROTECTED_PATHS: JSON.stringify([app.getPath('userData'), ...formerDataFolders(app)]) },
      pnpm,
      onFailure: hostFailure,
    })
  }
  // After a failed or interrupted Host the shell starts another one on the same profile and
  // port, rather than sending the user back through the first run.
  hostFactory = newHost
  await checkLastInstall().catch(() => {})
  updates = startUpdates()
  updates?.subscribe((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.appUpdateChanged, state)
    if (!['checking', 'installing'].includes(state.phase)) note('update', `UPDATE_${state.failure ?? state.phase}`.toUpperCase(), state.version)
  })
  // A throwaway run (DS_SUPERAGENT_HOME) keeps its folders where it was told.
  const fixed = Boolean(process.env.DS_SUPERAGENT_HOME)
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertLocalWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  ipcMain.handle(IPC.directoryPick, pickWorkspace)
  classicAgent.install(session.defaultSession)
  ipcMain.handle(IPC.classicAgent, (event, endpoint, payload) => { assertWindow(event); return classicAgent.call(event.sender, endpoint, payload) })
  ipcMain.handle(IPC.productConnect, (event, connection) => {
    assertWindow(event)
    clearComputer(true)
    classicAgent.revoke()
    return remoteProduct.connect(connection)
  })
  ipcMain.handle(IPC.productDisconnect, (event) => { assertWindow(event); return remoteProduct.disconnect() })
  ipcMain.handle(IPC.productStatus, (event) => { assertWindow(event); return remoteProduct.status() })
  ipcMain.handle(IPC.productCall, (event, endpoint, payload) => { assertWindow(event); return remoteProduct.call(endpoint, payload) })
  ipcMain.handle(IPC.productEvents, (event) => { assertWindow(event); return remoteProduct.events() })
  // Product browser resources: one webview per lease, in the storage of the resource key.
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  // Cookie imports: a file or an installed browser's profile is parsed or harvested into a
  // pending set first; only apply (the user's confirm) writes into the resource partition.
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertLocalWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    const picked = await chooseImport(event, IMPORT_FILE_MAX, {
      properties: ['openFile'],
      filters: [{ name: 'Cookie files', extensions: ['txt', 'json', 'cookies'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (!picked.bytes) return picked
    const parsed = parseCookieFile(picked.bytes)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: picked.label })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertLocalWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error(`${PRODUCT_NAME}: an unknown browser profile`)
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    if (!fromWindow(event) || remoteProduct.status().connected) return { canceled: true }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  ipcMain.handle(IPC.credentialImportPick, async event => {
    const picked = await chooseImport(event, CREDENTIAL_IMPORT_FILE_MAX, { properties: ['openFile'],
      filters: [{ name: 'Credential export', extensions: ['json'] }] })
    if (!picked.bytes) return picked
    try {
      return credentialImports.store(picked.bytes, picked.label)
    } catch {
      return { error: 'unreadable' }
    }
  })
  ipcMain.handle(IPC.credentialImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') credentialImports.drop(id)
  })
  // The app's own update state, for the About row. `updates` exists once the ready block
  // created it; before that (and in runs without an updater) the state is null.
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertLocalWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertLocalWindow(event)
    if (updates?.state().phase === 'downloaded') await installUpdate()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertLocalWindow(event)
    return openUpdatePage()
  })
  ipcMain.handle(IPC.backupList, event => {
    assertWindow(event)
    if (managed()) return []
    assertBackupLocation()
    return listProductBackups(productBackupRoot)
  })
  ipcMain.handle(IPC.backupCreate, event => {
    assertWindow(event)
    return maintainProduct('backup', async options => createProductBackup(options))
  })
  ipcMain.handle(IPC.backupRestore, (event, backupId) => {
    assertWindow(event)
    return maintainProduct('restore', options => restoreProductBackup({ ...options, backupId }))
  })
  ipcMain.handle(IPC.diagnosticsRead, async event => {
    assertWindow(event)
    return { product: PRODUCT_NAME, appVersion: app.getVersion(), dshVersion, platform: process.platform, arch: process.arch,
      hostState, backupsAvailable: !managed(), events: (await operationsLog.read()).slice(-50).reverse() }
  })
  ipcMain.handle(IPC.notify, (event, notice) => { assertWindow(event); notifications.show(notice) })
  ipcMain.handle(IPC.notificationTake, event => { assertWindow(event); return notifications.takeOpen() })
  ipcMain.on(IPC.setBadge, (event, count) => {
    if (!fromWindow(event) || count !== 0 && count !== 1) return
    badge = count === 1
    updateBadge(mainWindow)
  })
  // The product keeps the workspace; the app remembers it for path and data-move checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || remoteProduct.status().connected || typeof path !== 'string' || !isAbsolute(path)) return
    try {
      const workspace = real(path)
      if (workspaceProblem(workspace)) return
      const next = { ...places, workspace }
      saveLocations(next)
      places = next
    } catch { note('shell', 'WORKSPACE_LOCATION_NOT_SAVED') }
  })
  if (process.platform === 'win32') {
    // Windows ignores the alpha of the caption buttons' color, so they take the opaque color
    // of the surface under them, which the page measures.
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
    // Mica and the caption buttons follow the app's theme, not only the system's.
    ipcMain.on(IPC.nativeTheme, (event, source) => {
      const value = nativeThemeSource(source)
      if (fromWindow(event) && value !== undefined) nativeTheme.themeSource = value
    })
  }

  setMenu()
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  createWindow()
  const ready = startProductHost(hostHome)
  void ready.catch(fail)
  // The launch URL trades its token for the Host's cookie and goes on to the page. The cookie
  // is there once that load came through. The token is good for one browser only: it is spent
  // as soon as a window carries it.
  bootstrap = (async () => {
    const { url } = await ready ?? {}
    if (!url) return false
    launchUrl = url
    const win = mainWindow
    if (win === undefined) return false
    tokenSpent = true
    hostReady = await loadProductPage(win, url)
    return hostReady
  })().catch(error => {
    if (hostState === HOST_STATE.running && !shell.isQuitting()) void fail(error)
    return false
  })
}

async function showLocations() {
  if (busyWithData() || remoteProduct.status().connected || !windowShown()) return
  const t = text()
  const fixed = Boolean(process.env.DS_SUPERAGENT_HOME)
  const owner = mainWindow
  const current = await readWorkspace()
  if (!windowShown() || mainWindow !== owner) return
  const buttons = fixed || !current ? [t.closeLocations] : [t.closeLocations, t.changeData]
  const { response } = await dialog.showMessageBox(owner, { type: 'info', title: PRODUCT_NAME, message: t.locations,
    detail: t.places(places.dataDir, current ?? places.workspace), buttons, defaultId: 0, cancelId: 0, noLink: true })
  if (response === 1 && buttons.length > 1 && mainWindow === owner) await moveData(current)
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (busyWithData() || !windowShown() || remoteProduct.status().connected) return false
  moveDialog = true
  try { return await chooseDataMove(workspace) }
  finally { moveDialog = false }
}

async function chooseDataMove(workspace) {
  const t = text()
  const owner = mainWindow
  const to = await pickDirectory(dialog, owner, { title: t.pickMove, defaultPath: dirname(places.dataDir), create: true })
  if (!to || owner !== mainWindow || stopping || shell.isQuitting() || remoteProduct.status().connected) return false
  const dshHome = userDshHome()
  const refused = async actual => {
    const shellData = real(app.getPath('userData'))
    for (const current of new Set([workspace, places.workspace, actual])) {
      const isolation = within(to, shellData) || within(shellData, to) ? t.inDesktopData : placeProblem(t, to)
      const problem = isolation === undefined ? moveProblem({ from: places.dataDir, to, workspace: current,
        dshHome, program: app.isPackaged ? programFolder() : undefined }) : undefined
      const message = isolation ?? (problem === 'dsh' ? t.inDsh : t[MOVE_PROBLEMS[problem]])
      if (message === undefined) continue
      await dialog.showMessageBox(owner, { type: 'warning', title: PRODUCT_NAME, message, buttons: ['OK'] })
      return true
    }
    return false
  }
  const current = await readWorkspace()
  if (!current || await refused(current)) return false
  const { response } = await dialog.showMessageBox(owner, { type: 'question', title: PRODUCT_NAME, noLink: true, message: t.moveConfirm(to), detail: t.moveDetail(places.dataDir), buttons: [t.move, t.cancel], defaultId: 0, cancelId: 1 })
  if (response !== 0) return false
  const latest = await readWorkspace()
  if (!latest || await refused(latest) || owner !== mainWindow || stopping || shell.isQuitting() || remoteProduct.status().connected) return false
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the workspace from here on.
    void mainWindow?.loadURL(statusPage(t.moving, { lang: language() })).catch(() => {})
    try {
      await stopHost({ holdLock: true })
    } catch (error) {
      await dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
      return
    }
    // The app may have heard of a workspace change while the Host stopped.
    if (await refused(latest)) {
      unlockProductData()
      app.relaunch()
      return
    }
    mainWindow?.setProgressBar(2)
    try {
      await copyData(places.dataDir, to, signal, () => saveLocations({ dataDir: to, workspace: latest }))
      note('shell', 'DATA_LOCATION_MOVED')
    } catch (error) {
      if (signal.aborted) return
      note('shell', 'DATA_LOCATION_MOVE_FAILED')
      console.error(error)
      await dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
    } finally {
      mainWindow?.setProgressBar(-1)
      unlockProductData()
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
  return true
}

// Windows and a Linux AppImage update themselves; macOS and a Linux deb ask to download the new
// version. Throwaway runs check only a given feed and never ask.
function startUpdates() {
  const feed = process.env.DS_SUPERAGENT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_SUPERAGENT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
      asset: version => `${ARTIFACT_PREFIX}-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    // The update ends the app: the window closes for good, and the Host stops before the
    // installer replaces its files.
    return watchUpdates({
      updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : (version) => restartPrompt.prompt(version),
      beforeInstall: () => maintainProduct('upgrade', options => createProductBackup({ ...options, requireRestorable: true })),
      beforeLaunch: async version => {
        await operationsLog.record('update', 'UPDATE_INSTALL_REQUESTED', version)
        shell.beginQuit()
      },
      onInstallFailure: async ({ asynchronous }) => {
        installOnQuit = false
        clearTimeout(updateExitTimer)
        updateExitTimer = undefined
        updateLaunchPending = false
        if (updateExitCommitted) {
          app.relaunch()
          return
        }
        updateExitAllowed = false
        shell.cancelQuit()
        if (failed && !asynchronous) {
          resetStoppedHost()
        } else if (stopped) {
          await restartAfterMaintenance()
        }
      },
    })
  }
  return undefined
}

// A prompt that belongs to a window is not asked while the window is hidden or minimized: it
// waits for the window to be on the screen again.
function windowShown() {
  return startupScreen.window() === undefined && loadedWindows.has(mainWindow)
    && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}

async function askRestartNow(version) {
  // After a failed start, fail() installs the update itself.
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: PRODUCT_NAME, message: t.ready(version), detail: t.readyDetail, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

async function askDownloadNow(version) {
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: PRODUCT_NAME, message: t.available(version), detail: t.availableDetail, buttons: [t.download, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

// What the updater does when the user says yes. The answer may come later, when the window
// is shown again; then the work is done here.
async function installUpdate(options) { await updates?.install(options) }

function showUpdateFailure() {
  const message = localeText(UPDATE_TEXT).installFailed
  void dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message }).catch(() => {})
}

async function checkLastInstall() {
  const events = await operationsLog.read()
  const last = events.findLast(event => event.area === 'update'
    && ['UPDATE_INSTALL_REQUESTED', 'UPDATE_INSTALL_FAILED', 'UPDATE_INSTALLED', 'UPDATE_INSTALL_UNCONFIRMED'].includes(event.code))
  if (last?.code !== 'UPDATE_INSTALL_REQUESTED' || !last.version) return
  const current = app.getVersion()
  const installed = current === last.version || isNewer(current, last.version)
  await operationsLog.record('update', installed ? 'UPDATE_INSTALLED' : 'UPDATE_INSTALL_UNCONFIRMED', last.version)
}

async function finishProfileStart(home) {
  if (!managed() && await stat(join(home, 'core', 'state.sqlite')).then(value => value.isFile(), () => false)) {
    await recordProfileVersion(home, profileVersion())
  }
  if (await completeProductRestore({ home })) note('backup', 'RESTORE_READY')
}

function resetStoppedHost() {
  if (!stopped) return
  unlockProductData()
  host = undefined
  hostStop = undefined
  stopped = false
  stopping = false
}

async function restartAfterMaintenance() {
  if (!stopped || !stopping) return
  resetStoppedHost()
  shell.cancelQuit()
  await relaunchHost()
}

function maintainProduct(purpose, operation) {
  if (managed()) throw new Error('Use your PostgreSQL deployment backup procedure for this Host.')
  const running = hostState === HOST_STATE.running
  if (maintenance || startup || !places || copying || stopping || suspended
    || (!running && !(purpose === 'upgrade' && failed))) {
    throw new Error('The product is busy or its data is unavailable for maintenance.')
  }
  const home = profileHome(places.dataDir)
  const code = purpose === 'restore' ? 'RESTORE' : 'BACKUP'
  const attempt = (async () => {
    note('backup', `${code}_STARTED`)
    let done = false
    try {
      assertBackupLocation()
      assertLocalBackupProfile(home)
      if (!host) lockProductData()
      const expectedSessions = await stopHost({ forBackup: running, holdLock: true })
      if (!running) {
        const restore = await recoverInterruptedProductRestore({ home })
        if (restore.status === 'installed') throw Object.assign(new Error('Complete or roll back the pending restore before installing an update.'), { code: 'RESTORE_PENDING' })
      }
      const result = await operation({ home, backupRoot: productBackupRoot, expectedSessions, purpose })
      done = true
      note('backup', `${code}_SAVED`)
      return result
    } catch (error) {
      const code = error?.code ?? ''
      note('backup', /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : `${purpose.toUpperCase()}_FAILED`)
      if (/^(BACKUP_|RESTORE_|UNSUPPORTED_)/u.test(code)) throw error
      throw new Error('Product maintenance failed. Check the diagnostics log.')
    } finally {
      if (!done || purpose !== 'upgrade') {
        if (running) await restartAfterMaintenance()
        else resetStoppedHost()
      }
    }
  })()
  maintenance = attempt.finally(() => { maintenance = undefined })
  return maintenance
}

async function openUpdatePage() {
  const state = updates?.state()
  if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
    await electronShell.openExternal(state.page)
  }
}

const restartPrompt = createDeferredPrompt({ ask: askRestartNow, shown: windowShown, onYes: installUpdate })
const downloadPrompt = createDeferredPrompt({ ask: askDownloadNow, shown: windowShown, onYes: openUpdatePage })

async function flushDeferredUpdate() {
  await restartPrompt.flush()
  await downloadPrompt.flush()
}

function updateBadge(win) {
  if (process.platform !== 'win32') {
    app.setBadgeCount(badge ? 1 : 0)
  } else if (win && !win.isDestroyed()) {
    win.setOverlayIcon(badge ? nativeImage.createFromPath(trayIconFile()) : null, badge ? text().unread : '')
  }
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win32 = process.platform === 'win32'
  const win = new BrowserWindow({
    // The window never squeezes the chat: RAIL_WIDTH + MIN_CHAT from the product client's
    // src/client/frame-layout.js is the avatar rail plus the smallest chat column.
    width: 1320, height: 860, minWidth: 508, minHeight: 480,
    title: PRODUCT_NAME, show: false, icon: iconFile,
    backgroundColor: mica ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the caption buttons overlay the page's band. They keep the
    // sidebar's colors until the page sends the colors of the surface under them.
    ...(win32 ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: CAPTION_HEIGHT, color: dark ? '#1b1b1c' : '#f9fafb', symbolColor: dark ? '#f9fafb' : '#0f1115' },
      ...(mica ? { backgroundMaterial: 'mica' } : {}),
    } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-superagent-origin=${origin}`, ...(win32 ? [`--ds-superagent-caption=${String(CAPTION_HEIGHT)}`, ...(mica ? ['--ds-superagent-mica'] : [])] : [])],
    },
  })
  mainWindow = win
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
    classicAgent.revoke({ navigation: true })
    mainWindow = undefined
    // Browser resource tabs belonged to this window; they wait for the next one.
    botViews.release()
  })
  // The window hides instead of closing; the shell decides when it really goes.
  shell.watch(win)
  browserGuests.bind(win)
  // The tabs that outlived the last window join this one.
  botViews.attach(win)
  const contents = win.webContents
  contents.on('did-start-navigation', event => {
    if (mainWindow === win && event.isMainFrame && !event.isSameDocument) classicAgent.revoke({ navigation: true })
  })
  contents.on('render-process-gone', () => { if (mainWindow === win) classicAgent.revoke({ navigation: true }) })
  // The session is the same for every window of the app, so the handler is bound once.
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({ window: () => mainWindow, dialog, downloads: app.getPath('downloads'),
      report: code => note('shell', code) }))
  }
  if (win32) {
    // Fullscreen hides the caption buttons, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  if (mica) {
    const css = readFileSync(join(here, 'mica.css'), 'utf8')
    contents.on('dom-ready', () => {
      if (trustedPage(contents.getURL())) void contents.insertCSS(css).catch(() => {})
    })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => {
    if (trustedPage(contents.getURL())) void contents.insertCSS(fonts).catch(() => {})
  })
  contents.setWindowOpenHandler(({ url }) => {
    // DSH's sign-in opens a blank window during the click and sends it to the sign-in page later.
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (trustedPage(url)) return
    event.preventDefault()
    openOutside(url)
  })
  contents.on('will-redirect', (event, url) => { if (!trustedPage(url)) event.preventDefault() })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  // The window that is shown again asks for the update that waited for it. A window that was
  // minimized asks for it when it comes back.
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  return win
}

// The window is gone for good: a new one takes its place and talks to the Host that runs.
function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch(fail)
  return win
}

async function loadProductPage(win, url) {
  if (win.isDestroyed() || shell.isQuitting()) return false
  if (!trustedPage(url)) throw new Error('The Host returned an invalid local launch address.')
  try { await win.loadURL(url) }
  catch {
    if (win.isDestroyed() || win !== mainWindow || shell.isQuitting()) return false
    note('shell', 'PRODUCT_WINDOW_LOAD_FAILED')
    throw new Error('The product window could not load. Check the local Host and try again.')
  }
  if (win.isDestroyed() || win !== mainWindow || shell.isQuitting()) return false
  const firstLoad = !loadedWindows.has(win)
  const start = startupScreen.window()
  if (start && !shell.isHidden(win)) {
    const current = () => !failed && !win.isDestroyed() && win === mainWindow && !shell.isQuitting()
    const state = await waitForMainView(win.webContents).catch(error => { if (current()) throw error })
    if (!current()) return false
    loadedWindows.add(win)
    if (!shell.isHidden(win)) {
      if (state && start === startupScreen.window()) {
        await handoffMain(win, start, state.reducedMotion, () => current() && !shell.isHidden(win))
      } else win.show()
    }
    if (!current()) return false
  } else {
    loadedWindows.add(win)
    if (firstLoad && !shell.isHidden(win)) win.show()
  }
  startupScreen.close()
  updateBadge(win)
  if (start) void flushDeferredUpdate().catch(error => console.error(error))
  return true
}

// The window talks to the Host that runs. The first one trades the launch URL for the Host's
// cookie; the later ones use the plain address, which that cookie carries. The launch URL is
// used again only when no browser carried it at all, so that a token is never spent twice.
async function connectHost(win) {
  if (bootstrap !== undefined) await bootstrap
  if (win.isDestroyed() || win !== mainWindow) return
  if (hostReady) {
    await loadProductPage(win, `${origin}/`)
    return
  }
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    hostReady = await loadProductPage(win, launchUrl)
    return
  }
  const hasCookie = await hostCookie()
  const loaded = await loadProductPage(win, `${origin}/`)
  hostReady = hasCookie && loaded
}

// The Host's cookie: the launch URL trades its token for it. The app does not need to know
// its name, only whether the browser holds one for the Host's address.
async function hostCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${origin}/` })
    return cookies.length > 0
  } catch (error) {
    console.error(error)
    return false
  }
}

// The mark of the tray: the file of this platform, and on macOS the template that follows the
// colour of the menu bar.
function trayImage() {
  const file = trayIconFile()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
  if (process.platform === 'darwin') {
    const retina = nativeImage.createFromPath(join(assets, 'trayTemplate@2x.png'))
    const size = retina.getSize()
    if (!retina.isEmpty() && size.width > image.getSize().width) {
      image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG(), width: size.width, height: size.height })
    }
    image.setTemplateImage(true)
  }
  return image
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const t = localeText(SHELL_TEXT)
  // The application menu of macOS, without its Quit: the tray's Quit is the one ordinary way
  // out. Only when the tray is not there does the menu carry one, so that the app can still
  // be ended.
  const items = [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
  ]
  if (!shell.hasTray()) {
    items.push({ type: 'separator' }, { label: t.quit, click: () => { shell.quit() } })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: items },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !trustedPage(event.senderFrame?.url)) throw new Error(`${PRODUCT_NAME}: rejected IPC from an unknown page`)
}

function trustedPage(url) { return origin !== undefined && typeof url === 'string' && url.startsWith(`${origin}/`) }

function assertLocalWindow(event) {
  assertWindow(event)
  if (remoteProduct.status().connected) throw new Error('This action is available on the local desktop Host only.')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void electronShell.openExternal(url)
}

// The computer woke: the Host may have survived, or it may have to be replaced. A window that
// was closed while SuperAgent worked loads what it missed.
async function resumeHost() {
  suspended = false
  if (stopping || failed || host === undefined) return
  const interrupted = deferredFailure
  deferredFailure = undefined
  if (interrupted !== undefined) {
    await relaunchHost(interrupted)
    return
  }
  if (host.isRunning?.() === false) {
    await relaunchHost(new Error('The DSH Host stopped while this computer was asleep.'))
    return
  }
  // The Host runs: the window reads the state it kept while it was closed.
  const win = mainWindow
  if (win !== undefined && !win.isDestroyed()) {
    try { await connectHost(win) } catch (error) { console.error(error) }
  }
}

// Another Host on the same profile and port: after a failure or an interrupted sleep, without
// sending the user back through the first run. The old Host goes first, so a replaced Host can
// never overlap the new one; the old launch URL goes with it.
async function relaunchHost(cause, { rollback = false } = {}) {
  if (stopping || hostFactory === undefined) return
  if (cause !== undefined) console.warn(`${PRODUCT_NAME}: replacing the Host: ${cause instanceof Error ? cause.message : String(cause)}`)
  let confirmed = true
  await host?.stop().catch((error) => {
    console.error(error)
    if (error?.code === 'STOP_UNKNOWN') confirmed = false
  })
  if (!confirmed) {
    hostState = HOST_STATE.failed
    shell.refresh()
    return
  }
  unlockProductData()
  host = undefined
  hostStop = undefined
  failed = false
  hostState = HOST_STATE.starting
  shell.refresh()
  if (startupScreen.window() || !loadedWindows.has(mainWindow)) void startupScreen.show(text().starting)
  hostReady = false
  tokenSpent = false
  launchUrl = undefined
  bootstrap = undefined
  try {
    const answer = await startProductHost(profileHome(places.dataDir), { rollback })
    if (answer?.url !== undefined) launchUrl = answer.url
    const win = mainWindow
    if (win !== undefined && !win.isDestroyed()) await connectHost(win)
    else if (places !== undefined) rebuildWindow()
  } catch (error) {
    hostState = HOST_STATE.failed
    shell.refresh()
    await fail(error)
  }
}

// A directory or an account can be fixed without starting the whole app again: offer the same
// Host on the same data again, and say what went wrong.
async function askStartupAction(error, next) {
  const t = text()
  const canRollback = !managed() && places
    && await pendingProductRestore({ home: profileHome(places.dataDir) }).catch(() => false)
  const log = (await operationsLog.read().catch(() => [])).slice(-6)
  const diagnostics = log.map(event => `${new Date(event.at).toLocaleString()}  ${event.code}${event.version ? ` · ${event.version}` : ''}`)
  const actions = []
  if (hostFactory) actions.push({ action: 'retry', label: t.tryAgain })
  actions.push({ action: 'quit', label: t.quit })
  if (canRollback) actions.push({ action: 'rollback', label: localeText(UPDATE_TEXT).rollbackRestore })
  const detail = [String(error?.message ?? error) + next, diagnostics.join('\n')].filter(Boolean).join('\n\n')
  const action = await startupScreen.show(t.notStarted, { detail, actions })
  if (action || shell.isQuitting()) return action ?? 'quit'
  const { response } = await dialog.showMessageBox({
    type: 'error', title: PRODUCT_NAME, noLink: true,
    message: t.notStarted, detail, buttons: actions.map(choice => choice.label), defaultId: 0, cancelId: hostFactory ? 1 : 0,
  })
  return actions[response]?.action ?? 'quit'
}

async function fail(error) {
  if (failed || stopping || shell.isQuitting()) return
  console.error(error)
  failed = true
  hostState = HOST_STATE.failed
  shell.refresh()
  const found = installOnQuit && await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS, null, { ref: false })])
  const throwaway = Boolean(process.env.DS_SUPERAGENT_HOME)
  const t = localeText(UPDATE_TEXT)
  const next = found ? `\n\n${found.page ? t.onFailurePage(found.version) : t.onFailure(found.version)}` : ''
  if (found?.page) {
    dialog.showErrorBox(PRODUCT_NAME, `${text().notStarted}\n\n${error instanceof Error ? error.message : String(error)}${next}`)
    if (!throwaway) await electronShell.openExternal(found.page)
    app.quit()
    return
  }
  if (found) {
    dialog.showErrorBox(PRODUCT_NAME, `${text().notStarted}\n\n${error instanceof Error ? error.message : String(error)}${next}`)
    mainWindow?.hide()
    if (await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS, false, { ref: false })])) {
      try { await installUpdate(); return }
      catch { showUpdateFailure() }
    }
  }
  const action = await askStartupAction(error, next)
  if (shell.isQuitting()) return
  if (action !== 'quit') { await relaunchHost(undefined, { rollback: action === 'rollback' }); return }
  app.quit()
}
