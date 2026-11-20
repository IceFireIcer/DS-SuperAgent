// Modified by DS SuperAgent from the DS Bot v0.3.8 Electron shell (Apache-2.0).
// Electron main process: a start window while DS SuperAgent's Host boots, then one window served
// by the app's own DSH Host.
// The window loads the Host's loopback address as DSH Web does: DSH's sign-in sends the page's
// origin as the address the browser comes back to, and accepts only a loopback one.
import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, WebContentsView, dialog, ipcMain, Menu, nativeImage,
  nativeTheme, Notification, powerMonitor, screen, session, shell as electronShell, systemPreferences, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { backupBeforeProfileChange, completeProductRestore, createProductBackup, listProductBackups, pendingProductRestore, recordProfileVersion,
  recoverInterruptedProductRestore, restoreProductBackup } from './product-backups.mjs'
import { createOperationsLog } from './operations-log.mjs'
import electronUpdater from 'electron-updater'
import { BotBrowserGuests, partitionOf } from './bot-browser.mjs'
import { BotViews, isBotId } from './bot-views.mjs'
import { importFromBrowser, listSources } from './browser-sources.mjs'
import { applyCookies, CookieImports, isProductBrowserImportId, ProductCookieImports } from './cookie-import.mjs'
import { CredentialImports } from './credential-import.mjs'
import { parseCookieFile } from './cookie-parse.mjs'
import { userDshHome } from './dsh-home.mjs'
import { downloadSaver } from './downloads.mjs'
import { canonicalExecPath } from './canonical-path.mjs'
import { checkPlaces, chooseLocations, lang, localeText, pickerLabels, pickRoot, placeProblem, programFolder,
  saveLocations, text, tx } from './first-run.mjs'
import { hostPort } from './host-port.mjs'
import { assertHostLockFree, hostLockPath, releaseHostLock, writeHostLock } from './host-lock.mjs'
import { HostProcess } from './host-process.mjs'
import { badgeCount, createNotifications } from './notifications.mjs'
import { captureStdio, LogFile } from './logs.mjs'
import { copyData, moveProblem } from './move-data.mjs'
import { Pickers } from './picker-host.mjs'
import { freeSpace, pickFrom, placeOf, rootOf, runningLow } from './place.mjs'
import { ARTIFACT_PREFIX, PRODUCT_NAME, configureIdentity } from './product.mjs'
import { SUPERAGENT_PROFILE, assertLocalBackupProfile, profileHome } from './profile.mjs'
import { RemoteProductClient } from './remote-product-client.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { readStartFrame, writeStartFrame } from './start-frame.mjs'
import { explainOf, StartWindow } from './start-window.mjs'
import { UPDATE_TEXT, isNewer, watchReleases, watchUpdates } from './updates.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { createComputerCursor } from './computer-cursor.mjs'
import { createComputerIndicator, indicatorHtml } from './computer-indicator.mjs'
import { CAPTION_HEIGHT, cssColor, frameOptions, keepVibrancy, materialOf, nativeThemeSource } from './window-frame.mjs'

const IPC = {
  caption: 'ds-superagent:caption-colors', nativeTheme: 'ds-superagent:native-theme', fullscreen: 'ds-superagent:fullscreen',
  dataLocation: 'ds-superagent:data-location', moveData: 'ds-superagent:move-data', teamWorkspace: 'ds-superagent:team-workspace',
  browserAcquire: 'ds-superagent:browser-acquire', browserRelease: 'ds-superagent:browser-release', browserForget: 'ds-superagent:browser-forget',
  browserViewChanged: 'ds-superagent:browser-view-changed', browserViewCreate: 'ds-superagent:browser-view-create',
  browserViewSync: 'ds-superagent:browser-view-sync', browserViewPlace: 'ds-superagent:browser-view-place',
  browserViewNavigate: 'ds-superagent:browser-view-navigate', browserViewCommand: 'ds-superagent:browser-view-command',
  browserViewFocus: 'ds-superagent:browser-view-focus', browserViewRead: 'ds-superagent:browser-view-read',
  browserViewClose: 'ds-superagent:browser-view-close', browserViewHold: 'ds-superagent:browser-view-hold',
  browserImportSources: 'ds-superagent:browser-import-sources', browserImportPick: 'ds-superagent:browser-import-pick',
  browserImportLive: 'ds-superagent:browser-import-live', browserImportApply: 'ds-superagent:browser-import-apply',
  browserImportCancel: 'ds-superagent:browser-import-cancel',
  credentialImportPick: 'ds-superagent:credential-import-pick', credentialImportCancel: 'ds-superagent:credential-import-cancel',
  appUpdateState: 'ds-superagent:app-update-state', appUpdateCheck: 'ds-superagent:app-update-check',
  appUpdateInstall: 'ds-superagent:app-update-install', appUpdateOpen: 'ds-superagent:app-update-open',
  appUpdateChanged: 'ds-superagent:app-update-changed',
  ready: 'ds-superagent:ready', handoffReady: 'ds-superagent:handoff-ready',
  motion: 'ds-superagent:motion', effects: 'ds-superagent:effects',
  notify: 'ds-superagent:notify', notifyStatus: 'ds-superagent:notify-status',
  badge: 'ds-superagent:badge', openSession: 'ds-superagent:open-session',
  idleSeconds: 'ds-superagent:idle-seconds', computer: 'ds-superagent:computer',
  computerAction: 'ds-superagent:computer-action', computerCursor: 'ds-superagent:computer-cursor',
  backupList: 'ds-superagent:backup-list', backupCreate: 'ds-superagent:backup-create',
  backupRestore: 'ds-superagent:backup-restore', diagnosticsRead: 'ds-superagent:diagnostics-read',
  productConnect: 'ds-superagent:client-connect', productDisconnect: 'ds-superagent:client-disconnect',
  productStatus: 'ds-superagent:client-status', productCall: 'ds-superagent:client-call', productEvents: 'ds-superagent:client-events',
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
// Windows 11 draws Mica behind the page; macOS draws sidebar vibrancy. material.css lets it
// through the sidebar.
const material = materialOf(process.platform, release())
let frameFile
let identityError
try {
  configureIdentity(app)
  frameFile = join(app.getPath('userData'), 'start-frame.json')
} catch (error) {
  identityError = error
}

let mainWindow
let mainCreated
let startWindow
let logs
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
// Quitting while a first-run dialog is open stops the first run, and during the copy (of the
// first run or of a data move) it waits for the copy to stop at a safe point, so that it leaves
// no half team and no temporary copy.
let choosing
let copying
let startPlaces
let proposed
let startSettling = false
const copyAbort = new AbortController()
const pickers = new Pickers({ ipcMain, getPath: name => app.getPath(name) })
const notifications = createNotifications({ Notification, systemPreferences, platform: process.platform, log: console })
let computerIndicator
let computerCursor
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
const operationsLog = createOperationsLog(join(app.getPath('userData'), 'logs', 'operations.jsonl'))
const productBackupRoot = join(app.getPath('userData'), 'backups')
const note = (area, code, version) => void operationsLog.record(area, code, version).catch(() => {})
const managed = () => Boolean(process.env.DS_SUPERAGENT_POSTGRES?.trim())
logs = new LogFile({ dir: join(app.getPath('userData'), 'logs') })
captureStdio(logs)
app.once('will-quit', () => { logs?.flush(); logs?.close() })
console.log(`${PRODUCT_NAME} ${app.getVersion()} (${process.platform} ${process.arch}), Electron ${process.versions.electron}`)

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
  window: () => mainWindow,
  // While the start window is up it is the way back: no hidden product window is built
  // before the Host has a page to show.
  build: () => (startWindow?.focus() ? undefined : rebuildWindow()),
  reveal: (target) => {
    if (startWindow?.focus() || failed) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
  },
  quit: () => { app.quit() },
  status: () => hostState,
  onSuspend: () => { suspended = true },
  onResume: () => resumeHost(),
  busy: () => choosing !== undefined || copying !== undefined || startSettling,
  // Before the first run has chosen its places there is no window to show, and before the
  // first load of the Host there is no address to load.
  ready: () => startWindow !== undefined || (places !== undefined && origin !== undefined && bootstrap !== undefined),
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: (options) => dialog.showMessageBox(options) },
  // Without a tray the close asks whether the app should end.
  fallback: { show: (options) => dialog.showMessageBox(options) },
})
// The tray icon goes away with the app, and a late answer to the close notice hides nothing.
app.once('will-quit', () => { shell.dispose(); botViews.dispose(); computerIndicator?.dispose(); computerCursor?.dispose(); updates?.stop() })

const startKind = () => (process.env.DS_SUPERAGENT_HOME || existsSync(join(app.getPath('userData'), 'locations.json')) ? 'later' : 'first')

function createStartWindow() {
  const frame = readStartFrame(frameFile)
  startWindow = new StartWindow({
    electron: { BrowserWindow, ipcMain, screen, shell: electronShell, clipboard, nativeTheme, systemPreferences },
    page: join(here, 'start', 'start.html'),
    preload: join(here, 'preload.cjs'),
    icon: iconFile,
    material,
    devTools: !app.isPackaged,
    css: readFileSync(join(here, 'page-card.css'), 'utf8'),
    lang,
    motion: frame.motion,
    effects: frame.effects,
    version: app.getVersion(),
    program: [dirname(process.execPath), process.resourcesPath, app.getAppPath()],
    log: logs,
    mainWindow: () => mainWindow,
    saveAs: (win, name) => askPicker(win, { mode: 'save', title: tx('dialog.saveLog'), start: knownFolder('desktop'), name }),
    onRetry: () => { retryStart().catch(error => { failed = false; fail(error) }) },
    onReload: () => { mainWindow?.webContents.reload() },
    onClose: () => { app.quit() },
    onPick: () => { askStartPlace().catch(fail) },
    onAnswer: value => { answerStart(value).catch(fail) },
    canPick: () => startPlaces !== undefined && !process.env.DS_SUPERAGENT_HOME
      && (startWindow.kind === 'first' || !existsSync(startPlaces.dataDir)),
    onUpdate: name => { updateStart(name).catch(fail) },
    onRollback: () => { retryStart({ rollback: true }).catch(error => { failed = false; fail(error) }) },
  })
  computerIndicator ??= createComputerIndicator({
    BrowserWindow, screen, html: indicatorHtml, ipcMain,
    preload: join(here, 'computer-indicator-preload.cjs'),
    onAction: (kind, holderId) => { mainWindow?.webContents.send(IPC.computerAction, { kind, holderId }) },
  })
  computerCursor ??= createComputerCursor({ BrowserWindow, screen, platform: process.platform, log: console })
}

function knownFolder(name) {
  try { return app.getPath(name) } catch { return undefined }
}

async function askPicker(target, request) {
  const contents = target?.webContents ?? target
  return await pickers.ask(contents, { ...request, labels: pickerLabels() })
}

async function askStartPlace() {
  const fixed = Boolean(process.env.DS_SUPERAGENT_HOME)
  if (fixed || startPlaces === undefined || startSettling || copying !== undefined) return false
  const missingCurrentData = !existsSync(startPlaces.dataDir)
  const picked = startWindow.kind === 'later'
    ? await startWindow.asking(askPicker(startWindow.owner(), {
      mode: 'folder', title: text().pickMove, start: pickFrom(startPlaces.dataDir),
    }))
    : await pickRoot(pickFrom(startPlaces.dataDir), undefined, {
      asking: promise => startWindow.asking(promise),
      pick: request => askPicker(startWindow.owner(), request),
    })
  if (typeof picked !== 'string') return false
  if (missingCurrentData) {
    const replacement = rootOf(picked, {
      dshHome: userDshHome(),
      program: app.isPackaged ? programFolder() : undefined,
      current: startPlaces,
    })
    if (replacement.same === true) {
      startWindow.card(undefined)
      return false
    }
    if (replacement.reason !== undefined) {
      startWindow.card({ kind: 'rejected', reason: replacement.reason, path: replacement.at })
      return false
    }
    proposed = { ...replacement, newLocation: true }
    startWindow.card({ kind: 'picked', path: replacement.root })
    return true
  }
  if (startWindow.kind === 'later') {
    const target = resolve(picked)
    const isolation = placeProblem(text(), target)
    const problem = isolation === undefined ? moveProblem({
      from: startPlaces.dataDir,
      to: target,
      workspace: startPlaces.workspace,
      dshHome: userDshHome(),
      program: app.isPackaged ? programFolder() : undefined,
    }) : undefined
    if (isolation !== undefined || problem !== undefined) {
      const reason = problem === 'dsh' ? 'dsh' : problem === 'program' ? 'program'
        : problem === 'notEmpty' ? 'foreign' : problem === 'workspace' ? 'workspace'
          : problem === 'drive' ? 'drive' : 'nested'
      startWindow.card({ kind: 'rejected', reason, path: target })
      return false
    }
    proposed = { dataDir: target, workspace: startPlaces.workspace }
    startWindow.card({ kind: 'move', path: target, dataDir: startPlaces.dataDir })
    return true
  }
  const result = rootOf(picked, {
    dshHome: userDshHome(),
    program: app.isPackaged ? programFolder() : undefined,
    current: startPlaces,
  })
  if (result.same === true) {
    startWindow.card(undefined)
    return false
  }
  if (result.reason !== undefined) {
    startWindow.card({ kind: 'rejected', reason: result.reason, path: result.at })
    return false
  }
  const problem = placeProblem(tx, result.dataDir, result.workspace)
  if (problem !== undefined) {
    startWindow.card({ kind: 'rejected', reason: 'foreign', path: result.at })
    return false
  }
  proposed = result
  startWindow.card({ kind: 'picked', path: result.root })
  return true
}

async function answerStart(value) {
  if (proposed === undefined) {
    startWindow.card(undefined)
    return
  }
  if (value === 'cancel') {
    proposed = undefined
    startWindow.card(undefined)
    return
  }
  if ((startWindow.kind !== 'later' || proposed.newLocation === true) && value === 'use') {
    startSettling = true
    saveLocations({ dataDir: proposed.dataDir, workspace: proposed.workspace })
    app.relaunch()
    app.quit()
    return
  }
  if (startWindow.kind === 'later' && value === 'move') {
    await moveFromStart(proposed.dataDir)
  }
}

async function moveFromStart(to) {
  if (copying !== undefined || startSettling) return
  startSettling = true
  startWindow.moving()
  const signal = copyAbort.signal
  copying = (async () => {
    try {
      if (host !== undefined) await stopHost()
      await copyData(startPlaces.dataDir, to, signal)
      saveLocations({ dataDir: to, workspace: startPlaces.workspace })
      app.relaunch()
    } catch (error) {
      if (signal.aborted) return
      startWindow.fail(error, 'moving')
      return
    } finally {
      startSettling = false
    }
    app.quit()
  })()
  await copying
  copying = undefined
}

async function retryStart({ rollback = false } = {}) {
  if (places === undefined || hostFactory === undefined) {
    await start()
    return
  }
  if (host !== undefined && !stopped) {
    await stopHost()
    resetStoppedHost()
  } else if (stopped) resetStoppedHost()
  failed = false
  stopped = false
  stopping = false
  hostReady = false
  tokenSpent = false
  launchUrl = undefined
  bootstrap = undefined
  hostState = HOST_STATE.starting
  shell.refresh()
  const ready = startProductHost(profileHome(places.dataDir), { rollback })
  void ready.catch(fail)
  bootstrap = connectBootstrap(ready)
}

async function connectBootstrap(ready) {
  let url
  try {
    ({ url } = await ready)
  } catch {
    // The Host failure is reported by fail(), once, with its retry and rollback actions.
    return false
  }
  try {
    launchUrl = url
    const win = mainWindow
    if (win === undefined || win.isDestroyed()) return false
    tokenSpent = true
    startWindow.teamLoading()
    await win.loadURL(url)
    hostReady = true
    return true
  } catch (error) {
    void fail(error)
    return false
  }
}

async function updateStart(name) {
  const state = updates?.state()
  if (name === 'manualDownload' || (state?.phase === 'available' && state.page)) {
    await openUpdatePage()
    return
  }
  if (state?.phase === 'downloaded') await installUpdate()
}

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
  app.on('second-instance', () => { if (!startWindow?.focus()) shell.open() })
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
      if (startup) void startup.finally(() => app.quit()).catch(() => {})
      return
    }
    if (installOnQuit && !stopping && hostState === HOST_STATE.running && updates?.install && updates.state().phase === 'downloaded') {
      event.preventDefault()
      void installUpdate().catch(() => { shell.cancelQuit(); showUpdateFailure() })
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
    createStartWindow()
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
  note('host', 'HOST_FAILED', app.getVersion())
  if (suspended) { deferredFailure = error; return }
  void fail(error)
}

// A Host that the shell listens to: the browser resource endpoint and a failure both arrive here.
function wireHost(instance) {
  instance.onMessage(message => {
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
  return starting
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
    const answer = await launchHost(hostFactory())
    if (answer?.url !== undefined) {
      await finishProfileStart(home)
      hostState = HOST_STATE.running
      shell.refresh()
      startWindow?.done('engine')
      note('host', 'HOST_READY', app.getVersion())
    }
    return answer
  })().finally(() => { startup = undefined })
  return startup
}

async function start() {
  setMenu()
  nativeTheme.themeSource = readStartFrame(frameFile).themeSource
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  startWindow.open(startKind())
  const where = chooseLocations()
  const hostHome = profileHome(where.dataDir)
  const workspace = where.workspace ?? join(hostHome, 'workspace')
  places = { dataDir: where.dataDir, workspace }
  startPlaces = places
  const fixed = Boolean(process.env.DS_SUPERAGENT_HOME)
  const free = freeSpace(places.dataDir)
  const showPlace = !fixed && (startWindow.kind === 'first'
    || runningLow(free, where.freeAtStart))
  startWindow.explain(explainOf())
  startWindow.place(showPlace ? placeOf(places.dataDir, { free, lang: lang() }) : undefined)
  const placeError = checkPlaces({ dataDir: where.dataDir, workspace }, { saved: where.saved === true })
  if (placeError instanceof Error) throw placeError
  if (placeError !== undefined) throw new Error(placeError)
  // A link can be made after the first run's check: the folders the Host will write to are
  // checked again, as the file system has them, before anything starts.
  const layoutError = placeProblem(text(), where.dataDir, workspace)
  if (layoutError !== undefined) throw new Error(layoutError)
  for (const path of new Set([where.dataDir, hostHome, workspace])) {
    const problem = placeProblem(text(), path)
    if (problem !== undefined) throw new Error(problem)
  }
  if (!fixed) saveLocations(places)
  startWindow.done('data')
  const port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
  hostPortNumber = port
  origin = `http://127.0.0.1:${String(port)}`
  const pnpm = join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const runtimeDir = app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime')
  const profileDir = join(hostHome, 'profiles', SUPERAGENT_PROFILE)
  hostLock = hostLockPath(hostHome)
  const newHost = () => {
    mkdirSync(profileDir, { recursive: true })
    return new HostProcess({
      entry: join(here, 'host.mjs'),
      cwd: profileDir,
      env: { ...process.env, DSH_HOME: hostHome, DS_SUPERAGENT_PORT: String(port), DS_SUPERAGENT_APP: '1',
        DS_SUPERAGENT_RUNTIME_DIR: runtimeDir, DS_SUPERAGENT_USER_DSH_HOME: userDshHome(), DS_SUPERAGENT_WORKSPACE: workspace },
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
    if (failed && startWindow !== undefined && !startWindow.revealed && ['available', 'downloading', 'downloaded', 'installing'].includes(state.phase)) {
      startWindow.update({
        state: state.phase === 'downloaded' ? 'installing' : state.phase,
        version: state.version,
        ...(state.page === undefined ? {} : { page: true }),
        ...(state.percent === undefined ? {} : { percent: state.percent }),
      })
    }
    if (!['checking', 'installing'].includes(state.phase)) note('update', `UPDATE_${state.failure ?? state.phase}`.toUpperCase(), state.version)
  })
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  ipcMain.handle(IPC.productConnect, (event, connection) => { assertWindow(event); return remoteProduct.connect(connection) })
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
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    const path = await askPicker(mainWindow, { mode: 'file', title: tx('dialog.pickCookies'),
      start: knownFolder('downloads'), extensions: ['txt', 'json', 'cookies'] })
    if (typeof path !== 'string') return { canceled: true }
    const buffer = await readFile(path)
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(path) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
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
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error(`${PRODUCT_NAME}: a browser resource storage key is required`)
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error(`${PRODUCT_NAME}: this import is no longer pending`)
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  ipcMain.handle(IPC.credentialImportPick, async event => {
    assertWindow(event)
    const path = await askPicker(mainWindow, { mode: 'file',
      title: lang() === 'zh' || lang() === 'zh-TW' ? '选择凭据导出文件' : 'Choose credential export',
      start: knownFolder('downloads'), extensions: ['json'] })
    if (typeof path !== 'string') return { canceled: true }
    try {
      if ((await stat(path)).size > CREDENTIAL_IMPORT_FILE_MAX) return { error: 'too-large' }
      const bytes = await readFile(path)
      if (bytes.length > CREDENTIAL_IMPORT_FILE_MAX) return { error: 'too-large' }
      const pending = credentialImports.store(bytes, basename(path))
      return pending
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
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await installUpdate()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
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
      hostState, backupsAvailable: !managed(), events: (await operationsLog.read()).slice(-50).reverse(),
      log: { file: join(app.getPath('userData'), 'logs', 'main.log'), tail: logs.tail(80) } }
  })
  ipcMain.on(IPC.ready, (event, report) => {
    if (fromWindow(event)) startWindow?.ready(report)
  })
  ipcMain.on(IPC.handoffReady, event => {
    if (fromWindow(event)) startWindow?.teamReady()
  })
  ipcMain.on(IPC.motion, (event, value) => {
    if (fromWindow(event) && ['quiet', 'normal', 'lively'].includes(value)) writeStartFrame(frameFile, { motion: value })
  })
  ipcMain.on(IPC.effects, (event, value) => {
    if (fromWindow(event) && ['full', 'reduced', 'off'].includes(value)) writeStartFrame(frameFile, { effects: value })
  })
  ipcMain.handle(IPC.notifyStatus, event => {
    assertWindow(event)
    return notifications.status()
  })
  ipcMain.handle(IPC.notify, (event, notice) => {
    assertWindow(event)
    const sessionId = typeof notice?.sessionId === 'string' ? notice.sessionId.slice(0, 120) : undefined
    return notifications.show({
      title: String(notice?.title ?? ''),
      body: String(notice?.body ?? ''),
    }, {
      focused: () => mainWindow?.isFocused?.() === true,
      open: () => {
        shell.open()
        if (sessionId !== undefined) mainWindow?.webContents.send(IPC.openSession, sessionId)
      },
    })
  })
  ipcMain.on(IPC.badge, (event, count) => {
    if (!fromWindow(event)) return
    const value = badgeCount(count)
    try { app.setBadgeCount?.(value) } catch {}
  })
  ipcMain.handle(IPC.idleSeconds, event => {
    assertWindow(event)
    return Math.max(0, Number(powerMonitor.getSystemIdleTime?.()) || 0)
  })
  ipcMain.on(IPC.computer, (event, entries) => {
    if (fromWindow(event)) computerIndicator?.update(entries)
  })
  ipcMain.on(IPC.computerCursor, (event, cursor) => {
    if (fromWindow(event)) void computerCursor?.update(cursor)
  })
  // The product keeps the workspace; the app remembers it for path and data-move checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
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

  createWindow()
  const ready = startProductHost(hostHome)
  void ready.catch(fail)
  // The launch URL trades its token for the Host's cookie and goes on to the page. The cookie
  // is there once that load came through. The token is good for one browser only: it is spent
  // as soon as a window carries it.
  bootstrap = connectBootstrap(ready)
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (copying !== undefined || maintenance || stopping || mainWindow === undefined) return false
  const t = text()
  const owner = mainWindow
  const picked = await askPicker(owner, { mode: 'folder', title: t.pickMove, start: dirname(places.dataDir) })
  if (typeof picked !== 'string') return false
  const to = resolve(picked)
  const dshHome = userDshHome()
  // The workspace can move while a dialog is open; the window tells the latest one.
  const refused = async () => {
    for (const current of new Set([workspace, places.workspace])) {
      const isolation = placeProblem(t, to)
      const problem = isolation === undefined ? moveProblem({ from: places.dataDir, to, workspace: current,
        dshHome, program: app.isPackaged ? programFolder() : undefined }) : undefined
      const message = isolation ?? (problem === 'dsh' ? t.inDsh : t[MOVE_PROBLEMS[problem]])
      if (message === undefined) continue
      await dialog.showMessageBox(owner, { type: 'warning', title: PRODUCT_NAME, message, buttons: ['OK'] })
      return true
    }
    return false
  }
  if (await refused()) return false
  const { response } = await dialog.showMessageBox(owner, { type: 'question', title: PRODUCT_NAME, noLink: true, message: t.moveConfirm(to), detail: t.moveDetail(places.dataDir), buttons: [t.move, t.cancel], defaultId: 0, cancelId: 1 })
  if (response !== 0 || stopping || await refused()) return false
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the workspace from here on.
    void mainWindow?.loadURL(notePage(t.moving)).catch(() => {})
    try {
      await stopHost()
    } catch (error) {
      await dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
      return
    }
    // The app may have heard of a workspace change while the Host stopped.
    if (await refused()) {
      app.relaunch()
      return
    }
    mainWindow?.setProgressBar(2)
    try {
      await copyData(places.dataDir, to, signal)
      try {
        saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
      } catch (error) {
        // Unused, the copy would only keep the folder from being chosen again.
        await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
        throw error
      }
    } catch (error) {
      if (signal.aborted) return
      console.error(error)
      await dialog.showMessageBox({ type: 'warning', title: PRODUCT_NAME, message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
    } finally {
      mainWindow?.setProgressBar(-1)
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
  return true
}

const notePage = message => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText">${message.replace(/[&<>]/gu, char => `&#${String(char.charCodeAt(0))};`)}</body>`)}`

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
  return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
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
async function installUpdate() { await updates?.install() }

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

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const frameless = process.platform === 'win32' || process.platform === 'darwin'
  const sidebarFill = () => (nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb')
  const win = new BrowserWindow({
    // The window never squeezes the chat: RAIL_WIDTH + MIN_CHAT from the product client's
    // src/client/frame-layout.js is the avatar rail plus the smallest chat column.
    width: 1320, height: 860, minWidth: 508, minHeight: 480,
    title: PRODUCT_NAME, show: false, icon: iconFile,
    backgroundColor: material ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the caption buttons overlay the page's band. They keep the
    // sidebar's colors until the page sends the colors of the surface under them.
    ...frameOptions(process.platform, material, { color: sidebarFill(), symbolColor: dark ? '#f9fafb' : '#0f1115' }),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-superagent-origin=${origin}`,
        ...(frameless ? [`--ds-superagent-caption=${String(CAPTION_HEIGHT)}`, ...(material ? [`--ds-superagent-material=${material}`] : [])] : [])],
    },
  })
  if (material === 'vibrancy') keepVibrancy(win, sidebarFill)
  mainWindow = win
  startWindow?.placeMain(win)
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
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
  // The session is the same for every window of the app, so the handler is bound once.
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({
      window: () => mainWindow,
      ask: (name, folder) => askPicker(mainWindow, { mode: 'save', title: tx('dialog.saveAs'), start: folder, name }),
      staging: () => join(app.getPath('userData'), 'downloading'),
      getPath: name => app.getPath(name),
      log: console,
    }))
  }
  if (frameless) {
    // Fullscreen hides the caption buttons, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  for (const [on, file] of [[material !== undefined, 'material.css'], [process.platform === 'darwin', 'macos.css']]) {
    if (!on) continue
    const css = readFileSync(join(here, file), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(fonts) })
  const card = readFileSync(join(here, 'page-card.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(card) })
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
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  // The window that is shown again asks for the update that waited for it. A window that was
  // minimized asks for it when it comes back.
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('focus', () => { notifications.clear() })
  void win.loadURL(notePage(text().starting)).catch(() => {})
  return win
}

// The window is gone for good: a new one takes its place and talks to the Host that runs.
function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch((error) => { console.error(error) })
  return win
}

// The window talks to the Host that runs. The first one trades the launch URL for the Host's
// cookie; the later ones use the plain address, which that cookie carries. The launch URL is
// used again only when no browser carried it at all, so that a token is never spent twice.
async function connectHost(win) {
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load of the Host decides how this window comes in.
  if (bootstrap !== undefined) await bootstrap
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load never came through. The cookie may be there anyway: it belongs to the
  // session of the browser, which outlives the window.
  if (await hostCookie()) {
    hostReady = true
    await win.loadURL(`${origin}/`)
    return
  }
  // There is no cookie: the launch URL is the one way in, and only while it was not used.
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    await win.loadURL(launchUrl)
    hostReady = true
    return
  }
  await win.loadURL(`${origin}/`)
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
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error(`${PRODUCT_NAME}: rejected IPC from an unknown page`)
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
  const buttons = hostFactory ? [t.tryAgain, t.quit] : [t.quit]
  if (canRollback) buttons.push(localeText(UPDATE_TEXT).rollbackRestore)
  const { response } = await dialog.showMessageBox({
    type: 'error', title: PRODUCT_NAME, noLink: true,
    message: t.notStarted,
    detail: [String(error?.message ?? error) + next, diagnostics.join('\n')].filter(Boolean).join('\n\n'),
    buttons, defaultId: 0, cancelId: hostFactory ? 1 : 0,
  })
  if (canRollback && response === 2) return 'rollback'
  return hostFactory && response === 0 ? 'retry' : 'quit'
}

async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  hostState = HOST_STATE.failed
  shell.refresh()
  const found = installOnQuit && await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS, null, { ref: false })])
  const throwaway = Boolean(process.env.DS_SUPERAGENT_HOME)
  const t = localeText(UPDATE_TEXT)
  const next = found ? `\n\n${found.page ? t.onFailurePage(found.version) : t.onFailure(found.version)}` : ''
  const canRollback = !managed() && places !== undefined
    && await pendingProductRestore({ home: profileHome(places.dataDir) }).catch(() => false)
  if (startWindow !== undefined && !startWindow.revealed) {
    startWindow.fail(error, startKind(), { restoreRollback: canRollback })
    if (found) {
      startWindow.update({ state: 'available', version: found.version, page: Boolean(found.page) })
      if (!throwaway) {
        void found.downloaded.then(done => {
          if (done && startWindow !== undefined && !startWindow.revealed) {
            startWindow.update({ state: 'downloading', version: found.version, percent: 100 })
          }
        }).catch(() => {})
      }
    }
    return
  }
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
  if (hostState === HOST_STATE.running) return
  const action = await askStartupAction(error, next)
  if (action !== 'quit') { await relaunchHost(undefined, { rollback: action === 'rollback' }); return }
  app.quit()
}
