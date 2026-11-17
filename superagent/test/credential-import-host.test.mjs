import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HostCredentialImportAdapter } from '../dist/credential-import-host.js'

test('the desktop credential bridge sends references and returns only the selected item value', async t => {
  const original = process.send
  const sent = []
  process.send = function (message, callback) {
    sent.push(message)
    queueMicrotask(() => {
      callback?.()
      process.emit('message', { type: 'ds-superagent:credential-import-response', id: message.id,
        credentialId: 'credential-a', sourceRef: 'a'.repeat(64), value: 'fictional-secret-value' })
    })
    return true
  }
  t.after(() => { process.send = original })
  const adapter = new HostCredentialImportAdapter()
  const value = await adapter.read('11111111-1111-4111-8111-111111111111', 'credential-a', 'a'.repeat(64))
  assert.deepEqual(value, { id: 'credential-a', sourceRef: 'a'.repeat(64), value: 'fictional-secret-value' })
  assert.equal(JSON.stringify(sent[0]).includes('fictional-secret-value'), false)
  assert.deepEqual(Object.keys(sent[0]).sort(), ['credentialId', 'id', 'pendingId', 'sourceRef', 'type'])

  await adapter.finish('11111111-1111-4111-8111-111111111111', 'a'.repeat(64))
  assert.equal(sent[1].type, 'ds-superagent:credential-import-finish')
  assert.equal(process.listenerCount('message'), 0, 'the response listener is removed after the one-item read')
})

test('the desktop credential bridge maps untrusted error codes to a fixed allowlist', async t => {
  const original = process.send
  process.send = function (message, callback) {
    queueMicrotask(() => {
      callback?.()
      process.emit('message', { type: 'ds-superagent:credential-import-response', id: message.id,
        code: 'fictional-secret-value' })
    })
    return true
  }
  t.after(() => { process.send = original })
  await assert.rejects(new HostCredentialImportAdapter().read(
    '11111111-1111-4111-8111-111111111111', 'credential-a', 'a'.repeat(64)),
  { code: 'CREDENTIAL_IMPORT_UNKNOWN', message: 'The selected credential could not be received.' })
  assert.equal(process.listenerCount('message'), 0)
})
