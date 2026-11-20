import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the product Host exposes connectors, IM and capabilities with local and remote authorization boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-product-extensions-'))
  const work = join(directory, 'work')
  const core = join(directory, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  const native = await nativeContext(join(directory, 'sessions'), () => textResponse('Ready.'))
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })
  const host = await createProductHost(native, { databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  t.after(async () => { await host.close(); await native.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })

  const local = { instanceId: 'personal' }
  const connectors = await host.dispatch('connector-list', { ...local, target: { role: 'main' } })
  assert.ok(Array.isArray(connectors.items))
  assert.ok(connectors.items.some(item => item.id === 'github'))
  const im = await host.dispatch('im-registry', local)
  assert.equal(im.platforms.length, 8)
  assert.deepEqual((await host.dispatch('capability-list', local)).items, [])

  const remote = { id: 'remote-reader', label: 'Remote reader',
    grants: [{ instanceId: 'personal', capabilities: ['read'] }], createdAt: 1 }
  assert.ok(Array.isArray((await host.dispatch('connector-list', { ...local, target: { role: 'main' } }, remote)).items))
  await assert.rejects(host.dispatch('connector-save', { ...local, commandId: 'remote-save',
    connectorId: 'github', target: { role: 'main' } }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('im-registry', local, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('capability-list', local, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
})
