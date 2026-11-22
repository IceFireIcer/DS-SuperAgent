import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { powerMonitor, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startEmptyUpdateFeed, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

let win
let updateFeed
before(async () => {
  updateFeed = await startEmptyUpdateFeed()
  await startApp()
  hostState.release()
  await waitFor(() => window()?.visible === true, 'open the window')
  if (process.platform !== 'win32') await waitFor(() => updateFeed.requests() > 0, 'check the update feed')
  win = window()
})
after(async () => { await updateFeed.close() })

test('a Host that dies after the wake is reported, not deferred as a sleep', async () => {
  const loads = win.loaded.length
  powerMonitor.emit('suspend')
  powerMonitor.emit('resume')
  await waitFor(() => win.loaded.length > loads, 'read the Host after the wake')
  hostState.die(new Error('the Host stopped after the wake'))
  const retryScreen = () => state.windows.find(target => target.visible && target.url.includes('Try%20again'))
  await waitFor(() => retryScreen() !== undefined, 'ask for another try')
  const { webContents } = retryScreen()
  state.ipc.get('ds-superagent:startup-action')({ sender: webContents, senderFrame: webContents.mainFrame }, 'retry')
  await waitFor(() => hostState.starts === 2, 'start the Host again')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('the app ends when the user says so', async () => {
  state.tray.menu.template.at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
})
