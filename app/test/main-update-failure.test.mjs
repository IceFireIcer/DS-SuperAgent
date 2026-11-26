// A failed Host may report a downloaded candidate, but it must not install that candidate
// behind the user's back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// Exercise the Windows installer on every runner.
Object.defineProperty(process, 'platform', { value: 'win32' })

test('a failed startup reports the candidate without installing it', async (t) => {
  t.after(() => { if (state.tray?.destroyed !== true) app.quit() })
  updaterState.found = {
    isUpdateAvailable: true,
    updateInfo: { version: '9.9.9' },
    downloadPromise: Promise.resolve(['installer.exe']),
  }
  hostState.fail = true
  await startApp()
  await waitFor(() => hostState.starts === 1, 'start the Host')
  hostState.release()

  await waitFor(() => state.dialogs.some(box => String(box.message).includes('9.9.9')), 'report the candidate')
  const candidate = state.dialogs.find(box => String(box.message).includes('9.9.9'))
  assert.match(candidate.message, /is available/u)
  assert.match(candidate.message, /not installed unless you confirm/u)
  assert.equal(updaterState.quitAndInstall.length, 0, 'the failure does not install')

  updater.emit('update-downloaded', { version: '9.9.9' })
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.equal(updaterState.quitAndInstall.length, 0, 'a downloaded candidate still waits for confirmation')

  app.quit()
  await waitFor(() => state.tray?.destroyed === true, 'end the app')
  assert.equal(updaterState.quitAndInstall.length, 0, 'quitting after the failure does not install')
})
