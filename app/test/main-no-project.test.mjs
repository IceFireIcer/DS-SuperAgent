import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { profileHome } from '../src/profile.mjs'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
let home

before(async () => { ({ home } = await startApp({ packaged: false, project: false })) })
after(async () => {
  if (state.quits > 0) return
  trayQuit()?.click()
  await waitFor(() => state.quits > 0, 'end the app', 5000).catch(() => {})
})

test('a desktop start without a project starts Main and no implicit work directory', async () => {
  await waitFor(() => window() !== undefined && hostState.options !== undefined, 'prepare Main')
  assert.equal(Object.hasOwn(hostState.options.env, 'DS_SUPERAGENT_WORKSPACE'), false)
  assert.equal(existsSync(join(profileHome(home), 'workspace')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')), { dataDir: home })

  hostState.release()
  const main = window()
  await waitFor(() => main.visible && main.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'show Main')
  assert.equal(state.quits, 0)
})

test('canceling project selection keeps Main running without a fallback folder', async () => {
  const main = window()
  const before = JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8'))
  state.openAnswer = { canceled: true, filePaths: [] }

  assert.equal(await state.ipc.get('ds-superagent:directory-pick')(eventFor(main)), null)
  assert.equal(Object.hasOwn(hostState.options.env, 'DS_SUPERAGENT_WORKSPACE'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')), before)
  assert.equal(hostState.starts, 1)
  assert.equal(main.visible, true)
})
