import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { paths, powerMonitor, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
const invoke = (channel, ...args) => state.ipc.get(`ds-superagent:${channel}`)(eventFor(window()), ...args)

test('the desktop hands off to the local Host and keeps native actions on that window', async context => {
  const formerDsh = join(paths.root, 'personal-dsh')
  mkdirSync(formerDsh)
  process.env.DSH_HOME = formerDsh
  context.after(() => { delete process.env.DSH_HOME })
  const { home } = await startApp({ packaged: false })
  context.after(() => trayQuit()?.click())
  const root = realpathSync.native(home)
  await waitFor(() => window() !== undefined, 'prepare the product window')
  const startup = state.windows[0]
  const main = window()
  assert.notEqual(startup, main)
  assert.equal(startup.visible, true)
  assert.notEqual(startup.options.webPreferences.preload, main.options.webPreferences.preload)
  assert.equal(startup.options.webPreferences.sandbox, true)
  assert.equal(main.visible, false)
  hostState.release()
  await waitFor(() => main.visible && startup.isDestroyed(), 'hand off the startup window')
  assert.equal(main.loaded.filter(url => url.includes('token=')).length, 1)
  assert.equal(main.opacities?.[0], 0)
  assert.ok(main.opacities?.some(opacity => opacity > 0 && opacity < 1))
  assert.equal(main.opacities?.at(-1), 1)

  const picker = state.ipc.get('ds-superagent:directory-pick')
  await assert.rejects(picker(eventFor(startup)), /unknown page/u)
  state.openAnswer = { canceled: false, filePaths: [join(root, 'workspace')] }
  assert.equal(await invoke('directory-pick'), join(root, 'workspace'))
  state.openAnswer = { canceled: false, filePaths: [join(root, 'superagent')] }
  assert.equal(await invoke('directory-pick'), null)
  state.openAnswer = { canceled: true, filePaths: [] }
  assert.equal(await invoke('directory-pick'), null)

  const data = JSON.stringify({ schema: 'ds-superagent-credential-export', version: 1,
    origin: { label: 'Fixture' }, credentials: [{ id: 'fixture', label: 'Sample', type: 'api-key', value: 'unshared-fixture-value' }] })
  const isolated = join(formerDsh, 'export.json')
  writeFileSync(isolated, data)
  const alias = join(paths.root, 'personal-alias')
  symlinkSync(formerDsh, alias, process.platform === 'win32' ? 'junction' : 'dir')
  state.openAnswer = { canceled: false, filePaths: [join(alias, 'export.json')] }
  assert.deepEqual(await invoke('credential-import-pick'), { error: 'unreadable' })
  assert.equal(readFileSync(isolated, 'utf8'), data)
  const exported = join(paths.root, 'explicit-export.json')
  writeFileSync(exported, data)
  state.openAnswer = { canceled: false, filePaths: [exported] }
  const imported = await invoke('credential-import-pick')
  assert.equal(imported.preview.entries[0].id, 'fixture')
  assert.ok(!JSON.stringify(imported).includes('unshared-fixture-value'))
  assert.equal(state.ipc.has('ds-superagent:browser-import-apply'), false)
  const oversized = join(paths.root, 'too-big.json')
  writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1))
  state.openAnswer = { canceled: false, filePaths: [oversized] }
  assert.deepEqual(await invoke('credential-import-pick'), { error: 'too-large' })

  invoke('notify', { sessionId: 'main', body: 'A new reply is waiting', title: 'an external title' })
  const notification = state.notifications.at(-1)
  assert.equal(notification.options.title, 'DS SuperAgent')
  main.close()
  await waitFor(() => !main.visible, 'hide Main to the tray')
  notification.emit('click')
  assert.equal(main.visible, true)
  assert.deepEqual(main.webContents.messages.at(-1), ['ds-superagent:notification-open'])
  assert.equal(invoke('notification-take'), 'main')
  assert.equal(invoke('notification-take'), null)
  assert.throws(() => invoke('notify', { sessionId: 'main', body: 'session contents' }), /Unknown product notification/u)
  invoke('badge', 1)
  assert.equal(process.platform === 'win32' ? !!state.badge.image : state.badgeCount === 1, true)
  invoke('badge', 0)
  assert.equal(process.platform === 'win32' ? state.badge.image === null : state.badgeCount === 0, true)

  const controlId = randomUUID()
  hostState.emit({ type: 'ds-superagent:computer-indicator', id: randomUUID(), active: true, controlId })
  const indicator = state.windows.at(-1)
  await waitFor(() => indicator.visible, 'show the active control indicator')
  assert.equal(indicator.options.focusable, false)
  assert.equal(indicator.ignoresMouse, true)
  assert.equal(indicator.options.alwaysOnTop, true)
  hostState.emit({ type: 'ds-superagent:computer-indicator', active: false, controlId })
  assert.equal(indicator.isDestroyed(), true)
  const resumedControl = randomUUID()
  hostState.emit({ type: 'ds-superagent:computer-indicator', id: randomUUID(), active: true, controlId: resumedControl })
  const resumed = state.windows.at(-1)
  powerMonitor.emit('suspend')
  assert.equal(resumed.isDestroyed(), true)
  assert.ok(hostState.sent.some(message => message.type === 'ds-superagent:computer-stop' && message.controlId === resumedControl))

  const destination = join(root, 'preview.txt')
  state.saveAnswer = destination
  const item = Object.assign(new EventEmitter(), { getFilename: () => 'preview.txt', setSavePath: path => { item.path = path } })
  main.webContents.session.emit('will-download', { preventDefault: () => assert.fail('save was canceled') }, item, main.webContents)
  assert.equal(item.path, destination)
  item.emit('done', {}, 'completed')
  const diagnostic = await invoke('diagnostics-read')
  assert.ok(diagnostic.events.some(event => event.code === 'DOWNLOAD_COMPLETED'))
  assert.ok(!JSON.stringify(diagnostic).includes(destination))
  assert.ok(!JSON.stringify(diagnostic).includes(exported))
})
