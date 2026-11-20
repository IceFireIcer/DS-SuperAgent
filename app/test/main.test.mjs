// The main process of the app: the window hides instead of closing, the tray is the way
// back to it, and a window that is gone for good is built anew and talks to the Host that
// runs. The Electron parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, test } from 'node:test'
import { hostLockPath } from '../src/host-lock.mjs'
import { profileHome } from '../src/profile.mjs'
import { app, paths, powerMonitor, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { productWindows, startApp, startWindows, trayOpen, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

let home
let workspace
let personalDsh
before(async () => {
  ({ home, workspace, personalDsh } = await startApp({
    async prepare(_home, { personalDsh: userDsh }) {
      mkdirSync(join(userDsh, 'bot'), { recursive: true })
      writeFileSync(join(userDsh, 'bot', 'state.json'), '{ this is not a legacy team')
    },
  }))
})

test('the app starts with a window and a tray', async () => {
  await waitFor(() => window() !== undefined, 'open the product window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  await waitFor(() => hostState.options !== undefined, 'start the product Host')
  assert.equal(startWindows().length, 1, 'a separate startup window opens')
  assert.equal(startWindows()[0].url.startsWith('file:'), true, 'the startup window loads its local page')
  const snapshots = startWindows()[0].webContents.sent
    .filter(([channel]) => channel === 'ds-superagent:start-state')
    .map(([, snapshot]) => snapshot)
  assert.equal(snapshots.some(snapshot => snapshot.explain?.mode === 'import'
    || snapshot.card?.kind === 'import' || snapshot.phases?.includes('import')), false,
  'the startup window does not offer the legacy Bot team import')
  assert.equal(existsSync(join(paths.userData, 'logs', 'main.log')), true, 'the shell writes a private log')
  assert.equal(hostState.options.env.DSH_HOME, profileHome(home))
  assert.equal(hostState.options.env.DSH_HOME.includes('personal-dsh-fixture'), false)
  assert.equal(readFileSync(join(home, '..', 'personal-dsh-fixture', 'preserve-marker.txt'), 'utf8'), 'do-not-touch',
    'the separate personal DSH fixture remains untouched')
  assert.equal(readFileSync(join(personalDsh, 'bot', 'state.json'), 'utf8'), '{ this is not a legacy team',
    'the malformed legacy team was not read or rewritten')
  assert.equal(hostState.options.env.DS_SUPERAGENT_WORKSPACE, workspace)
  assert.match(state.tray.tooltip, /^DS SuperAgent — /u, 'the tray says what the Host is doing')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('the first window trades the launch URL for the Host\'s cookie', async () => {
  const win = window()
  hostState.release()
  await waitFor(() => win.loaded.some(url => url.includes('token=')), 'reach the Host')
  assert.equal(win.loaded.filter(url => url.includes('token=')).length, 1, 'the token is used once')
  assert.equal(state.cookies.length, 1, 'the Host left a cookie for its address')
  await waitFor(() => startWindows()[0].destroyed, 'hand the startup window over to the product window')
  assert.equal(win.visible, true, 'the product window becomes visible after the Host view reports ready')
})

test('browser-cookie import uses the isolated shell picker and leaves the selected file unchanged', async () => {
  const win = window()
  const cookieFile = join(home, 'cookie-export.txt')
  const source = '# Netscape HTTP Cookie File\nexample.test\tFALSE\t/\tFALSE\t0\tsession\tfake-cookie-value\n'
  writeFileSync(cookieFile, source)
  state.openAnswer = request => {
    assert.equal(request.mode, 'file')
    return { canceled: false, filePaths: [cookieFile] }
  }
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const imported = await state.ipc.get('ds-superagent:browser-import-pick')(event)
  assert.equal(imported.preview.cookies, 1)
  assert.equal(JSON.stringify(imported.preview).includes('fake-cookie-value'), false)
  assert.equal(state.pickers.at(-1).mode, 'file')
  assert.equal(readFileSync(cookieFile, 'utf8'), source)
  state.openAnswer = undefined
})

test('credential export picker returns a value-free preview and preserves its source bytes', async () => {
  const win = window()
  const credentialFile = join(home, 'credential-export.json')
  const source = JSON.stringify({
    schema: 'ds-superagent-credential-export', version: 1,
    origin: { label: 'Isolated fixture', instanceId: 'fixture-instance' },
    credentials: [{ id: 'fixture-key', label: 'Fixture key', type: 'api-key', value: 'fictional-secret-value',
      originalScope: { kind: 'main' } }],
  })
  writeFileSync(credentialFile, source)
  state.openAnswer = request => {
    assert.equal(request.mode, 'file')
    assert.match(request.title, /credential export/u)
    return { canceled: false, filePaths: [credentialFile] }
  }
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const preview = await state.ipc.get('ds-superagent:credential-import-pick')(event)
  assert.equal(JSON.stringify(preview).includes('fictional-secret-value'), false)
  assert.equal(readFileSync(credentialFile, 'utf8'), source)
  assert.equal(state.pickers.at(-1).mode, 'file')
  state.openAnswer = undefined
})

test('notifications open Main and the session download handler routes through the shell picker', async () => {
  const win = window()
  const notice = state.ipc.get('ds-superagent:notify')
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  assert.equal(await notice(event, { sessionId: 'main', title: 'DS SuperAgent', body: 'A reply is ready' }), true)
  const notification = state.notifications.at(-1)
  notification.emit('click')
  assert.ok(win.webContents.sent.some(([channel, id]) => channel === 'ds-superagent:open-session' && id === 'main'))

  const destination = paths.downloads
  state.openAnswer = request => ({ canceled: false, filePaths: [destination] })
  const save = win.webContents.session.listeners('will-download')[0]
  assert.equal(typeof save, 'function')
  const item = Object.assign(new (await import('node:events')).EventEmitter(), {
    savePath: undefined,
    getFilename: () => 'shell-download.txt',
    setSavePath(path) { this.savePath = path },
    cancel() { this.emit('done', {}, 'cancelled') },
    finish() { mkdirSync(dirname(this.savePath), { recursive: true }); writeFileSync(this.savePath, 'download fixture'); this.emit('done', {}, 'completed') },
  })
  const downloadEvent = { prevented: false, preventDefault() { this.prevented = true } }
  save(downloadEvent, item, win.webContents)
  assert.equal(downloadEvent.prevented, false)
  await waitFor(() => state.pickers.at(-1)?.mode === 'save', 'open the download picker')
  item.finish()
  const file = join(destination, 'shell-download.txt')
  await waitFor(() => existsSync(file), 'move the staged download')
  assert.equal(readFileSync(file, 'utf8'), 'download fixture')
  state.openAnswer = undefined
})

test('a window that is gone for good is built anew and talks to the same Host', async () => {
  const first = window()
  first.destroy()
  trayOpen().click()
  await waitFor(() => productWindows().length === 2, 'build a new product window')
  const second = window()
  await waitFor(() => second.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the Host')
  assert.equal(second.loaded.filter(url => url.includes('token=')).length, 0, 'the token is not used again')
  assert.equal(hostState.starts, 1, 'no second Host was started')
})

test('closing the window hides it; the app goes on', async () => {
  const win = window()
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  assert.equal(win.isDestroyed(), false, 'the window is there')
  assert.equal(state.quits, 0, 'the app goes on')
  assert.equal(hostState.stops, 0, 'the Host goes on')
  assert.equal(state.dialogs.length, 0, 'the notice was answered already')
})

test('the tray opens the window again', async () => {
  const win = window()
  trayOpen().click()
  await waitFor(() => win.visible === true, 'show the window')
  assert.equal(win.focused > 0, true, 'the window has the focus')
})

test('a second launch brings the running window back and starts no second Host', async () => {
  const win = window()
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  // The second copy hands itself to the one that runs.
  app.emit('second-instance')
  await waitFor(() => win.visible === true, 'open the running window')
  assert.equal(hostState.starts, 1, 'no second Host was started')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('a sleep pauses the status, and a wake reads the same Host again', async () => {
  const win = window()
  const loads = win.loaded.length
  powerMonitor.emit('suspend')
  assert.equal(state.tray.menu.template[0].label, 'Paused while this computer sleeps')
  win.close()
  await waitFor(() => win.visible === false, 'hide the window during the sleep')
  assert.equal(state.quits, 0, 'the sleep does not end the app')
  powerMonitor.emit('resume')
  await waitFor(() => win.loaded.length > loads, 'read the Host again after the wake')
  assert.equal(state.tray.menu.template[0].label, 'Host running')
  assert.equal(hostState.starts, 1, 'the same Host runs')
  assert.equal(hostState.stops, 0, 'the Host was not stopped for the sleep')
})

test('a Host that dies during the sleep is replaced when the computer wakes', async () => {
  const win = window()
  powerMonitor.emit('suspend')
  hostState.die(new Error('the power was lost'))
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.equal(state.quits, 0, 'the app waits for the wake')
  assert.equal(state.dialogs.length, 0, 'no error box during the sleep')
  powerMonitor.emit('resume')
  await waitFor(() => hostState.starts === 2, 'start another Host after the wake')
  await waitFor(() => win.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the new Host')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('Host stop and tray refresh failures do not strand quit or leave the Host lock behind', async () => {
  const lock = hostLockPath(profileHome(home))
  assert.equal(existsSync(lock), true, 'the running Host owns its lock')
  hostState.stopFails = true
  state.trayUpdatesFail = true
  trayQuit().click()
  await waitFor(() => state.quits > 1, 'end the app after stopping the Host')
  await waitFor(() => hostState.stops > 0, 'stop the Host')
  await waitFor(() => !existsSync(lock), 'release the Host lock')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
