// A downloaded update belongs to the user's explicit install decision. Saying Later must
// survive the app's own quit as well.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { startApp, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// Exercise the Windows installer on every runner.
Object.defineProperty(process, 'platform', { value: 'win32' })

test('the update chosen for Later is not installed when the app quits', async () => {
  await startApp()
  await waitFor(() => hostState.starts === 1, 'start the Host')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  await waitFor(() => win.visible === true, 'show the window')

  state.dialogAnswer = { response: 1 }
  updater.emit('update-downloaded', { version: '9.9.9' })
  await waitFor(() => state.dialogs.length === 1, 'ask about the downloaded update')
  const readUpdateState = state.ipc.get('ds-superagent:app-update-state')
  assert.deepEqual(await readUpdateState({ sender: win.webContents, senderFrame: win.webContents.mainFrame }),
    { phase: 'downloaded', version: '9.9.9' })
  assert.equal(updaterState.quitAndInstall.length, 0, 'Later does not install')

  trayQuit().click()
  await waitFor(() => state.tray?.destroyed === true, 'end the app')
  assert.equal(hostState.stops, 1, 'the ordinary quit stops the Host')
  assert.equal(updaterState.quitAndInstall.length, 0, 'quitting does not install an update')
})
