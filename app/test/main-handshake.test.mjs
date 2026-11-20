// A failed bootstrap consumes its one-use token. Retrying starts a new Host/token generation.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { START_ACT } from '../src/start-window.mjs'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startWindows, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  state.rejectLoads = true
  await startApp()
})

test('failed bootstrap retries with a newly issued token', async () => {
  await waitFor(() => window() !== undefined, 'open the product window')
  const first = window()
  hostState.release()
  await waitFor(() => first.loaded.some(url => url.includes('token=')), 'try the first one-use token')
  const firstUrl = first.loaded.find(url => url.includes('token='))
  assert.equal(state.cookies.length, 0, 'failed navigation left no session cookie')

  const start = startWindows()[0]
  await waitFor(() => start.webContents.sent.some(([channel, snapshot]) =>
    channel === 'ds-superagent:start-state' && snapshot.view === 'failed'), 'show the startup recovery page')
  state.rejectLoads = false
  const event = { sender: start.webContents, senderFrame: start.webContents.mainFrame }
  assert.equal(await state.ipc.get(START_ACT)(event, 'retry'), true)
  await waitFor(() => hostState.starts === 2, 'restart the Host after bootstrap failure')
  await waitFor(() => first.loaded.filter(url => url.includes('token=')).length === 2, 'use the new Host token')
  const tokens = first.loaded.filter(url => url.includes('token='))
  assert.notEqual(tokens[0], tokens[1], 'the consumed launch URL is never reused')
  await waitFor(() => start.destroyed, 'hand the startup window to the recovered product page')
  assert.equal(state.cookies.length, 1, 'the second Host token establishes a session cookie')
})

test('the app ends through the tray', async () => {
  trayQuit().click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
