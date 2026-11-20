// A Host that does not start is not the end of the app: the error box offers another try on
// the same data, so that a directory or an account can be fixed and checked again.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { START_ACT } from '../src/start-window.mjs'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startWindows, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  hostState.fail = true
  await startApp({ packaged: false })
})

test('a failed start offers another try on the same data, and the app goes on', async () => {
  hostState.release()
  await waitFor(() => startWindows().length === 1, 'open the startup window')
  const start = startWindows()[0]
  await waitFor(() => start.webContents.sent.some(([channel, snapshot]) =>
    channel === 'ds-superagent:start-state' && snapshot.view === 'failed'), 'show the startup recovery page')
  hostState.fail = false
  const event = { sender: start.webContents, senderFrame: start.webContents.mainFrame }
  assert.equal(await state.ipc.get(START_ACT)(event, 'retry'), true)
  await waitFor(() => hostState.starts === 2, 'start the Host again')
  const win = window()
  await waitFor(() => win.loaded.some(url => url.includes('token=')), 'reach the retried Host')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('the app ends when the user says so', async () => {
  state.tray.menu.template.at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
})
