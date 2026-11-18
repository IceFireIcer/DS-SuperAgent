// The update of the app belongs to the window: while the window is hidden or minimized, the
// box waits, and the answer the user gives when the window is back does the work itself.
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { before, test } from 'node:test'
import { app, autoUpdater, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { startApp, trayOpen, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// Exercise the Windows installer on every runner; macOS and Linux debs open a release page.
Object.defineProperty(process, 'platform', { value: 'win32' })

let database
before(async () => {
  const { home } = await startApp()
  await waitFor(() => hostState.starts === 1, 'start the Host')
  const core = join(home, 'superagent', 'core')
  mkdirSync(core, { recursive: true })
  database = join(core, 'state.sqlite')
  using db = new DatabaseSync(database)
  db.exec('CREATE TABLE records(instance_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(instance_id, kind, id)); PRAGMA user_version=2;')
})

test('the update waits for the window and is installed when the window comes back', async () => {
  await waitFor(() => state.windows.length > 0, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  await waitFor(() => win.visible === true, 'show the window')
  // The window goes away, and the update is downloaded while it is gone.
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  updater.emit('update-downloaded', { version: '9.9.9' })
  await new Promise(resolve => { setTimeout(resolve, 50) })
  assert.equal(state.dialogs.length, 0, 'the box waits for the window')

  // The user dismisses the deferred prompt and installs from Settings.
  state.dialogAnswer = { response: 1 }
  trayOpen().click()
  await waitFor(() => state.dialogs.length === 1, 'ask about the update when the window is back')
  using db = new DatabaseSync(database)
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run('local', 'effect', 'pending-action', '{"state":"pending"}')
  const install = state.ipc.get('ds-superagent:app-update-install')
  await assert.rejects(install({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), { code: 'BACKUP_UNRESOLVED_WORK' })
  assert.equal(updaterState.quitAndInstall.length, 0, 'the installer waits for a restorable backup')
  await waitFor(() => hostState.starts === 2 && hostState.running, 'restart the Host after the failed backup')
  db.prepare('DELETE FROM records WHERE kind=?').run('effect')
  await install({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  await waitFor(() => updaterState.quitAndInstall.length === 1, 'install the update')
  assert.equal(hostState.stops, 2, 'the Host stops before each install attempt')
  assert.equal(updaterState.quitAndInstall[0].length, 2, 'the installer takes over')
  const manifests = readdirSync(join(paths.userData, 'backups')).map(id => JSON.parse(readFileSync(join(paths.userData, 'backups', id, 'manifest.json'), 'utf8')))
  assert.ok(manifests.some(item => item.purpose === 'upgrade' && item.business.schema === 2 && item.sessions.count === 0))
  assert.equal(updater.autoInstallOnAppQuit, false)
})

test('an installer error is recorded and the Host can restart', async () => {
  autoUpdater.emit('before-quit-for-update')
  app.quit()
  assert.equal(state.quitPrevented, true, 'the app stays available for an asynchronous installer error')
  updater.emit('error', new Error('installer could not start'))
  const path = join(paths.userData, 'logs', 'operations.jsonl')
  await waitFor(() => hostState.starts === 3 && hostState.running && /UPDATE_INSTALL_FAILED/u.test(readFileSync(path, 'utf8')), 'restart the Host and log the failure')
  const lines = readFileSync(path, 'utf8')
  assert.match(lines, /UPDATE_INSTALL_REQUESTED/u)
  assert.match(lines, /UPDATE_INSTALL_FAILED/u)
  assert.notEqual(state.tray?.destroyed, true)
})

test('the app ends after the update recovery', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
