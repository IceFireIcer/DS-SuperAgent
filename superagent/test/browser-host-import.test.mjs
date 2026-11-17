import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HostBrowserAdapter } from '../dist/browser-host.js'

test('the desktop Host bridge sends only profile and pending references for browser import', async t => {
  const original = process.send
  const sent = []
  let responseCode
  process.send = function (message, callback) {
    sent.push(message)
    queueMicrotask(() => {
      callback?.()
      process.emit('message', { type: 'ds-superagent:browser-import-response', id: message.id,
        ...(responseCode ? { code: responseCode } : { report: { stored: 2, dropped: [], failed: [], flushed: true } }) })
    })
    return true
  }
  t.after(() => { process.send = original })
  const adapter = new HostBrowserAdapter()
  const report = await adapter.importProfile({ profileKey: 'session-11111111-1111-4111-8111-111111111111',
    pendingImportId: '11111111-1111-4111-8111-111111111111',
    importId: '33333333-3333-4333-8333-333333333333' })
  assert.equal(report.stored, 2)
  assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'importId', 'pendingImportId', 'profileKey', 'type'])
  assert.equal(JSON.stringify(sent[0]).includes('cookieValue'), false)
  responseCode = 'token=must-not-project'
  await assert.rejects(adapter.importProfile({ profileKey: 'session-11111111-1111-4111-8111-111111111111',
    pendingImportId: '22222222-2222-4222-8222-222222222222',
    importId: '44444444-4444-4444-8444-444444444444' }), { code: 'BROWSER_IMPORT_UNKNOWN' })
})
