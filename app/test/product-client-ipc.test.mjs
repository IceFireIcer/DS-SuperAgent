import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, trayQuit, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('the existing desktop window bridges one authenticated remote product without exposing the credential', { timeout: 15000 }, async t => {
  const credential = `sc1.12345678.${'x'.repeat(43)}`
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    if (request.url.endsWith('/snapshot')) {
      response.end(JSON.stringify({ instanceId: 'personal', binding: { instanceId: 'personal', mainId: 'main-one' },
        history: { messages: [] }, observations: { items: [] }, cursor: '0',
        client: { id: 'client-one', label: 'Laptop', grants: [{ instanceId: 'personal', capabilities: ['read', 'command'] }] } }))
    } else if (request.url.includes('/events?')) response.end(JSON.stringify({ items: [], cursor: '0', hasMore: false }))
    else response.end(JSON.stringify({ mainId: 'main-one', messages: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    trayQuit()?.click()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await startApp()
  hostState.release()
  await waitFor(() => window()?.loaded.some(value => value.startsWith('http://127.0.0.1:')), 'load the local product UI')
  const contents = window().webContents
  contents.mainFrame.url = contents.getURL()
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (channel, ...args) => state.ipc.get(`ds-superagent:client-${channel}`)(event, ...args)
  const address = `http://127.0.0.1:${server.address().port}`
  const connected = await invoke('connect', { address, instanceId: 'personal', credential })
  assert.equal(connected.binding.mainId, 'main-one')
  assert.equal(JSON.stringify(connected).includes(credential), false)
  assert.equal(JSON.stringify(await invoke('status')).includes(credential), false)
  assert.equal((await invoke('call', 'history', { instanceId: 'personal' })).mainId, 'main-one')
  assert.deepEqual(await invoke('events'), [])
  assert.ok(requests.every(item => item.authorization === `Bearer ${credential}`))
  await assert.rejects(invoke('call', 'provider-key', { instanceId: 'personal' }), /not authorized/u)
  assert.throws(() => state.ipc.get('ds-superagent:client-status')({ sender: {}, senderFrame: contents.mainFrame }),
    /unknown page/u)
  assert.equal((await invoke('disconnect')).connected, false)
  assert.equal(server.listening, true, 'disconnect does not stop the remote Host')
})
