import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CredentialImports, credentialImportSourceRef, parseCredentialExport } from '../src/credential-import.mjs'

const exported = () => Buffer.from(JSON.stringify({
  schema: 'ds-superagent-credential-export', version: 1,
  origin: { label: 'Legacy profile', instanceId: 'legacy-instance' },
  credentials: [{ id: 'service-key', label: 'Example service', type: 'api-key', value: 'fictional-secret-value',
    originalScope: { kind: 'work', role: 'Legacy Worker', work: 'Old task' } }],
}))

test('credential export preview omits values and parsing leaves the selected file bytes unchanged', () => {
  const bytes = exported()
  const original = Buffer.from(bytes)
  const parsed = parseCredentialExport(bytes)
  assert.equal(parsed.preview.owner.label, 'Legacy profile')
  assert.deepEqual(parsed.preview.entries[0].originalScope, { kind: 'work', role: 'Legacy Worker', work: 'Old task' })
  assert.equal(parsed.preview.entries[0].sourceRef,
    '595d5b2f0f4fe2ffb1e7b760606be561be229bb2e1b76c0f820fc3ed0b2a7a7e')
  assert.equal(JSON.stringify(parsed.preview).includes('fictional-secret-value'), false)
  assert.equal(bytes.equals(original), true)
})

test('a selected export item can be retried until finished or cancelled', () => {
  const imports = new CredentialImports()
  const pending = imports.store(exported())
  const ref = credentialImportSourceRef(pending.preview.owner, 'service-key')
  assert.equal(pending.preview.entries[0].sourceRef, ref)
  assert.equal(JSON.stringify(pending.preview).includes('fictional-secret-value'), false)
  assert.deepEqual(imports.read(pending.id, ref), {
    id: 'service-key', sourceRef: ref, value: 'fictional-secret-value',
  })
  assert.deepEqual(imports.read(pending.id, ref), {
    id: 'service-key', sourceRef: ref, value: 'fictional-secret-value',
  }, 'the same item can be reconciled after a Host restart')
  imports.finish(pending.id, ref)
  assert.throws(() => imports.read(pending.id, ref), { code: 'CREDENTIAL_IMPORT_NOT_FOUND' })
})

test('cancelling a selected file clears every remaining pending value', () => {
  const imports = new CredentialImports()
  const pending = imports.store(exported())
  imports.cancel(pending.id)
  assert.equal(imports.peek(pending.id), null)
})

test('an invalid export at capacity does not evict a valid pending selection', () => {
  const imports = new CredentialImports()
  const pending = Array.from({ length: 16 }, () => imports.store(exported()))
  const sourceRef = pending[0].preview.entries[0].sourceRef
  assert.throws(() => imports.store(Buffer.from('{')), /not valid JSON/u)
  assert.throws(() => imports.store(exported(), 'password=fictional'), /invalid/u)
  assert.equal(imports.read(pending[0].id, sourceRef).value, 'fictional-secret-value')
  const next = imports.store(exported())
  assert.equal(imports.peek(pending[0].id), null)
  assert.equal(imports.read(pending[1].id, sourceRef).value, 'fictional-secret-value')
  assert.equal(imports.peek(next.id) !== null, true)
})

test('credential exports reject unknown schema fields and duplicate item ids', () => {
  const document = JSON.parse(exported().toString())
  assert.throws(() => parseCredentialExport(JSON.stringify({ ...document, unexpected: true })), /unsupported fields/u)
  document.credentials.push({ ...document.credentials[0] })
  assert.throws(() => parseCredentialExport(JSON.stringify(document)), /IDs must be unique/u)
  assert.throws(() => parseCredentialExport(Buffer.concat([exported(), Buffer.from([0xff])])), /valid UTF-8/u)
})
