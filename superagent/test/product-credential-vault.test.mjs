import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { ResourceCredentials } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

// Compile the standalone Host adapter without adding it to the shared product entry.
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/product-credential-vault.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, target: 'node24' })
const { ProductCredentialVault } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)

function records() {
  const stored = new Map()
  return {
    stored,
    async readRecord(key) { return stored.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(stored.get(key))
      if (next !== undefined) stored.set(key, next)
      return next ?? stored.get(key)
    },
    async deleteRecord(key) { stored.delete(key) },
    async resolve() { throw new Error('Ambient credential resolution must never run.') },
  }
}

test('an Instance owns a record reference; revocation denies later use without ambient fallback', async () => {
  const service = records()
  const vault = new ProductCredentialVault(service)
  const reference = await vault.create('personal', 'fictional-private-value')
  assert.match(reference, /^ds-superagent-profile\/vault-[a-f0-9]{64}-[a-f0-9-]{36}$/u)
  await vault.assertReference('personal', reference)
  assert.equal(await vault.withSecret('personal', reference, async secret => secret === 'fictional-private-value'), true)
  await assert.rejects(vault.assertReference('team', reference), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(vault.withSecret('team', reference, async () => {}), { code: 'RESOURCE_UNAVAILABLE' })
  await vault.revoke('personal', reference)
  await assert.rejects(vault.assertReference('personal', reference), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(vault.withSecret('personal', reference, async () => {}), { code: 'RESOURCE_UNAVAILABLE' })
  assert.equal(service.stored.has(reference), false)
})

test('rotation changes the next use while a revoked reference cannot be rotated back into service', async () => {
  const vault = new ProductCredentialVault(records())
  const reference = await vault.create('personal', 'fictional-old-value')
  await assert.rejects(vault.rotate('team', reference, 'fictional-other-value'), { code: 'RESOURCE_UNAVAILABLE' })
  await vault.rotate('personal', reference, 'fictional-new-value')
  assert.equal(await vault.withSecret('personal', reference, async secret => secret === 'fictional-new-value'), true)
  await vault.revoke('personal', reference)
  await assert.rejects(vault.rotate('personal', reference, 'fictional-again-value'), { code: 'RESOURCE_UNAVAILABLE' })
})

test('malformed, missing, foreign and ambient-only credentials are unavailable', async () => {
  const service = records()
  const vault = new ProductCredentialVault(service)
  const reference = await vault.create('personal', 'fictional-private-value')
  for (const other of ['MOCK_API_KEY', 'ds-superagent-profile/vault-not-a-record', reference.replace('ds-superagent-profile/', 'other-plugin/')]) {
    await assert.rejects(vault.assertReference('personal', other), { code: 'RESOURCE_UNAVAILABLE' })
  }
  service.stored.set(reference, { kind: 'api-key', env: { MOCK_API_KEY: 'fictional-ambient-value' } })
  await assert.rejects(vault.assertReference('personal', reference), { code: 'RESOURCE_UNAVAILABLE' })
  service.stored.delete(reference)
  await assert.rejects(vault.withSecret('personal', reference, async () => {}), { code: 'RESOURCE_UNAVAILABLE' })
})

test('creation does not acknowledge a provider that saved a different value', async () => {
  const service = records()
  service.modifyRecord = async (key, mutate) => {
    await mutate(undefined)
    service.stored.set(key, { kind: 'api-key', key: 'fictional-other-value' })
    return service.stored.get(key)
  }
  const vault = new ProductCredentialVault(service)
  await assert.rejects(vault.create('personal', 'fictional-intended-value'), { code: 'CREDENTIAL_WRITE_FAILED' })
})

test('a repeated creation command recovers its one stored record after a lost response', async () => {
  const service = records()
  const vault = new ProductCredentialVault(service)
  const first = await vault.create('personal', 'fictional-private-value', 'create-one')
  const retry = await vault.create('personal', 'fictional-private-value', 'create-one')
  assert.equal(first, retry)
  assert.equal(service.stored.size, 1)
  await assert.rejects(vault.create('personal', 'fictional-other-value', 'create-one'), { code: 'CREDENTIAL_WRITE_FAILED' })
  assert.equal(await vault.withSecret('personal', first, async value => value), 'fictional-private-value')
})

test('the public DSH local credential record provider persists one Instance-scoped reference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-vault-provider-'))
  const path = join(directory, 'credentials.yaml')
  let context = new Context()
  t.after(async () => { await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await context.plugin(LocalCredentials, { path, watch: false })
  const first = new ProductCredentialVault(context.credentials)
  const reference = await first.create('personal', 'fictional-provider-value', 'one-command')
  assert.equal(await first.withSecret('personal', reference, async value => value === 'fictional-provider-value'), true)
  await context.fiber.dispose()
  context = new Context()
  await context.plugin(LocalCredentials, { path, watch: false })
  const resumed = new ProductCredentialVault(context.credentials)
  assert.equal(await resumed.create('personal', 'fictional-provider-value', 'one-command'), reference)
  await assert.rejects(resumed.assertReference('other', reference), { code: 'RESOURCE_UNAVAILABLE' })
  await resumed.revoke('personal', reference)
  await assert.rejects(resumed.assertReference('personal', reference), { code: 'RESOURCE_UNAVAILABLE' })
  await resumed.ensureRevoked('personal', reference)
})

test('provider and consumer failures cannot return secret-bearing diagnostics', async () => {
  const sensitive = 'fictional-private-value'
  const service = records()
  const vault = new ProductCredentialVault(service)
  async function masked(operation, code) {
    await assert.rejects(operation, error => {
      assert.equal(error.code, code)
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /fictional-private-value/u)
      assert.equal(error.cause, undefined)
      return true
    })
  }
  const originalModify = service.modifyRecord
  service.modifyRecord = async () => { throw new Error(`modify rejected ${sensitive}`) }
  await masked(vault.create('personal', sensitive), 'CREDENTIAL_WRITE_FAILED')
  service.modifyRecord = originalModify
  const reference = await vault.create('personal', sensitive)
  await masked(vault.withSecret('personal', reference, async secret => { throw new Error(`consumer rejected ${secret}`) }), 'CREDENTIAL_USE_FAILED')
  service.modifyRecord = async () => { throw new Error(`rotate rejected ${sensitive}`) }
  await masked(vault.rotate('personal', reference, 'fictional-next-value'), 'CREDENTIAL_WRITE_FAILED')
  const originalRead = service.readRecord
  service.readRecord = async () => { throw new Error(`read rejected ${sensitive}`) }
  await masked(vault.assertReference('personal', reference), 'RESOURCE_UNAVAILABLE')
  service.readRecord = originalRead
  service.deleteRecord = async () => { throw new Error(`delete rejected ${sensitive}`) }
  await masked(vault.revoke('personal', reference), 'CREDENTIAL_WRITE_FAILED')
})

test('the existing resource core checks grants before consuming a product vault reference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-product-vault-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const vault = new ProductCredentialVault(records())
  const credentials = new ResourceCredentials(storage, 'personal', vault)
  const reference = await vault.create('personal', 'fictional-private-value')
  const resource = await credentials.create({ instanceId: 'personal', commandId: 'create', label: 'Mock tool', vaultReference: reference })
  const use = { instanceId: 'personal', resourceId: resource.id, role: 'worker', workItemId: 'work-1', purpose: 'tool' }
  await assert.rejects(credentials.use(use, async () => {}), { code: 'GRANT_DENIED' })
  const grant = await credentials.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    expectedRevision: 1, scope: { role: 'worker', workItemId: 'work-1' }, purposes: ['tool'] })
  assert.equal(await credentials.use(use, async secret => secret === 'fictional-private-value'), true)
  assert.equal(JSON.stringify(grant).includes(reference), false)
  await vault.revoke('personal', reference)
  await assert.rejects(credentials.use(use, async () => {}), { code: 'CREDENTIAL_USE_FAILED' })
})
