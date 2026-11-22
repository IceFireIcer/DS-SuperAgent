import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startEmptyUpdateFeed, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

let updateFeed
before(async () => {
  updateFeed = await startEmptyUpdateFeed()
  hostState.fail = true
  state.reducedMotion = true
  await startApp()
  if (process.platform !== 'win32') await waitFor(() => updateFeed.requests() > 0, 'check the update feed')
})
after(async () => { await updateFeed.close() })

test('the startup window offers retry, keeps the same data, and hands over to the existing Main window', async () => {
  const isStartup = win => win.visible && win.url.startsWith('data:text/html;')
  await waitFor(() => state.windows.some(isStartup), 'show startup status')
  const startWindow = state.windows.find(isStartup)
  const readStartup = () => decodeURIComponent(startWindow.url.slice(startWindow.url.indexOf(',') + 1))
  assert.match(readStartup(), /Starting DS SuperAgent/)
  await waitFor(() => window() !== undefined && hostState.starts === 1, 'prepare Main and start the Host')
  const main = window()
  const workspace = hostState.options.env.DS_SUPERAGENT_WORKSPACE
  hostState.release()
  await waitFor(() => readStartup().includes('Try again'), 'offer a retry on the startup surface')
  assert.match(readStartup(), /the Host did not start/)
  assert.match(readStartup(), /<button[^>]+autofocus[^>]*>Try again<\/button>/)
  assert.equal(main.visible, false)
  const retry = state.ipc.get('ds-superagent:startup-action')
  retry({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'retry')
  assert.equal(hostState.starts, 1)
  hostState.fail = false
  retry({ sender: startWindow.webContents, senderFrame: startWindow.webContents.mainFrame }, 'retry')
  retry({ sender: startWindow.webContents, senderFrame: startWindow.webContents.mainFrame }, 'retry')
  await waitFor(() => hostState.starts === 2, 'start the Host again')
  await waitFor(() => main.visible && startWindow.destroyed, 'hand over to Main')
  assert.equal(window(), main)
  assert.ok(main.loaded.some(url => url.startsWith('http://127.0.0.1:')))
  assert.equal(hostState.options.env.DS_SUPERAGENT_WORKSPACE, workspace)
  assert.equal(hostState.starts, 2)
  assert.ok(main.focused > 0)
  assert.equal(main.webContents.focused, true)
  assert.equal(main.opacities, undefined, 'a reduced-motion handoff skips the fade')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('the app ends when the user says so', async () => {
  state.tray.menu.template.at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
})
