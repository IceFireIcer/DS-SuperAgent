import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createComputerDriver } from '../src/computer-driver.mjs'

const writePngHeader = () => {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(160, 16)
  bytes.writeUInt32BE(80, 20)
  return bytes.toString('base64')
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'cua-fixture-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'fixture-editor.exe')
  await writeFile(path, 'not an executable')
  const state = { permissions: true, foreground: false, owner: 11, calls: [], launches: 0 }
  const replies = {
    check_permissions: () => ({ uia: state.permissions, post_message: true, elevated: false }),
    list_apps: () => ({ apps: [{ name: 'Fixture Editor', pid: 11, launch_path: path },
      { name: 'PowerShell', pid: 12, launch_path: path }, { name: 'Browser', pid: 13, launch_path: './unknown' }] }),
    list_windows: () => ({ windows: [{ pid: state.owner, window_id: 27, title: 'private window title',
      is_on_screen: true, bounds: { x: 30, y: 40, width: 160, height: 80 } }] }),
    get_window_state: () => null,
    click: () => null,
    type_text: () => null,
    bring_to_front: () => null,
  }
  const driver = createComputerDriver({ platform: 'win32', ownPids: new Set(), canUseForeground: async () => state.foreground,
    load: async () => ({ CuaDriver: { create: () => ({
      listToolsJson: async () => JSON.stringify({ tools: Object.keys(replies).map(name => ({ name, inputSchema: {
        properties: { foreground: { type: 'boolean' }, include_screenshot: { type: 'boolean' } },
      } })) }),
      callTool: async (name, input) => {
        state.calls.push([name, JSON.parse(input)])
        const body = replies[name]()
        return { rawJson: JSON.stringify(name === 'get_window_state'
          ? { content: [{ type: 'image', mimeType: 'image/png', data: writePngHeader() }, { type: 'text', text: 'Fixture state' }] }
          : { structuredContent: body }) }
      },
      shutdown: async () => {},
    }) } }) })
  context.after(() => driver.close())
  const signal = new AbortController().signal
  const status = () => driver.status(signal)
  const apps = () => driver.apps(signal)
  const execute = (operation, id, fields = {}) => driver.execute({ action: operation, appId: id, windowId: 27, ...fields }, signal, async () => {},
    async dispatch => { state.launches += 1; return dispatch() })
  return { state, status, apps, execute }
}

test('native computer actions stay scoped to the exact discovered window and fresh screenshot bounds', async context => {
  const { state, status, apps, execute } = await fixture(context)
  assert.equal(await status(), 'ready')
  const [editor, ...other] = await apps()
  assert.match(editor.id, /^app-[a-f0-9]{64}$/u)
  assert.deepEqual(other, [])
  assert.deepEqual(await execute('windows', editor.id), { windows: [{ windowId: 27, onScreen: true }] })
  await assert.rejects(execute('click', editor.id, { point: { x: 1, y: 1 } }), /fresh snapshot/u)
  const shot = await execute('snapshot', editor.id)
  assert.deepEqual(shot, { screenshot: { mimeType: 'image/png', data: writePngHeader() } })
  state.owner = 34
  await assert.rejects(execute('click', editor.id, { point: { x: 1, y: 1 } }), /does not own/u)
  state.owner = 11
  await assert.rejects(execute('click', editor.id, { point: { x: 160, y: 1 } }), /out-of-window/u)
  assert.equal(state.launches, 0)
  await execute('snapshot', editor.id)
  await execute('click', editor.id, { point: { x: 1, y: 1 } })
  assert.deepEqual(state.calls.filter(([name]) => name === 'click'), [['click', { pid: 11, window_id: 27, x: 1, y: 1, foreground: false }]])
  await execute('snapshot', editor.id)
  await assert.rejects(execute('activate', editor.id), /user is using/u)
  assert.equal(state.launches, 1)
  state.foreground = true
  await execute('snapshot', editor.id)
  await execute('activate', editor.id)
  assert.deepEqual(state.calls.filter(([name]) => name === 'bring_to_front'), [['bring_to_front', { pid: 11, window_id: 27 }]])
  state.permissions = false
  assert.equal(await status(), 'permission-required')
  const count = state.calls.filter(([name]) => name === 'get_window_state').length
  await assert.rejects(execute('snapshot', editor.id), /permissions/u)
  assert.equal(state.calls.filter(([name]) => name === 'get_window_state').length, count)
  assert.equal(state.launches, 2)
})
