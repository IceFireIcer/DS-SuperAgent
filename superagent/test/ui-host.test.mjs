import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import * as Profile from '../dist/profile.js'
import { installProduct } from '../../ds-bot/src/host/product.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the product HTTP boundary chats with Main and refuses cross-scope and unavailable operations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-http-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const models = []
  const native = await nativeContext(join(directory, 'sessions'), function* (request) {
    models.push(request.model)
    yield* textResponse('Main answered through the product boundary.')
  })
  t.after(async () => {
    await native.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(directory, { recursive: true, force: true })
  })
  const routes = new Map()
  let providerKey = ''
  let credentialFailure = false
  const settingsMutations = []
  native.llm.listProviders = () => [{ id: 'mock', name: 'Mock' }]
  native.llm.listModels = async provider => {
    assert.equal(provider, 'mock')
    return [{ id: 'main' }, { id: 'router' }, { id: 'worker' }]
  }
  native.llm.resolveModelInfo = async () => ({ reasoning: { efforts: [] } })
  native.llm.listConfigurableProviders = () => [{ provider: 'mock', displayName: 'Mock', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mock'] }]
  native.provide('settings', {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { mock: {} } }, revision: 3 }],
    mutate: async (ns, operations, revision) => { settingsMutations.push({ ns, operations, revision }) },
  })
  native.provide('credentials', {
    describe: async reference => ({ configured: providerKey !== '' && reference === 'MOCK_API_KEY', writable: true }),
    set: async (reference, value) => {
      if (credentialFailure) throw new Error(`provider rejected ${value}`)
      assert.equal(reference, 'MOCK_API_KEY'); providerKey = value
    },
    unset: async reference => { assert.equal(reference, 'MOCK_API_KEY'); providerKey = '' },
  })
  native.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  await native.plugin(Profile, { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  await native.plugin({ name: 'product-http', inject: ['connection', 'superagentProduct'], apply: installProduct })
  assert.deepEqual([...routes.keys()], ['/api/product'])
  assert.equal(native.get('botExecutionAdapter'), undefined)
  assert.equal(native.get('superagentUi'), undefined)
  const call = async (endpoint, payload = {}) => {
    const response = await routes.get('/api/product').fetch(new Request('http://fixture/api/product', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }),
    }))
    return { status: response.status, ...await response.json() }
  }
  const opened = await call('open')
  const instanceId = opened.value.instanceId
  assert.deepEqual((await call('open')).value, opened.value)
  assert.equal((await call('send', { instanceId, commandId: 'hello', text: 'Hello Main.' })).value.status, 'completed')
  const history = await call('history', { instanceId })
  assert.deepEqual(history.value.messages.map(message => [message.role, message.text]), [
    ['user', 'Hello Main.'], ['main', 'Main answered through the product boundary.'],
  ])
  const scheduled = await call('schedule-create', { instanceId, commandId: 'schedule-http', title: 'Review', text: 'Check the release.',
    timezone: 'UTC', when: { kind: 'at', at: Date.now() + 60_000 }, target: { kind: 'main' } })
  assert.equal(scheduled.ok, true, JSON.stringify(scheduled))
  const ruleId = scheduled.value.ruleId
  assert.deepEqual((await call('schedule-list', { instanceId })).value.items.map(rule => rule.ruleId), [ruleId])
  assert.deepEqual((await call('schedule-read', { instanceId, ruleId })).value.occurrences, [])
  assert.equal((await call('schedule-read', { instanceId: 'another-private-scope', ruleId })).status, 403)
  assert.equal((await call('schedule-create', { instanceId, commandId: 'wrong-target', title: 'Wrong', text: 'Guess another Ticket.',
    timezone: 'UTC', when: { kind: 'every', minutes: 1 }, target: { kind: 'work', workItemId: 'guess', ticketId: 'guess' } })).error.code,
  'SOURCE_NOT_AUTHORIZED')
  assert.equal((await call('schedule-cancel', { instanceId, commandId: 'cancel-http', ruleId })).value.status, 'cancelled')
  assert.equal((await call('schedule-read', { instanceId, ruleId })).value.status, 'cancelled')
  assert.equal((await call('schedule-source-set', { instanceId, commandId: 'close-source', enabled: false })).value.enabled, false)
  assert.equal((await call('schedule-source-read', { instanceId })).value.enabled, false)
  assert.equal((await call('schedule-source-set', { instanceId, commandId: 'open-source', enabled: true })).value.enabled, true)
  const settings = await call('settings', { instanceId })
  assert.equal(settings.value.revision, 1)
  assert.ok(settings.value.providers.some(provider => provider.id === 'mock'))
  assert.ok(settings.value.uses.some(use => use.role === 'main' && use.revision === 1))
  const changed = {
    ...settings.value.roles,
    router: { ...settings.value.roles.router, instructions: 'Route {{goal}} within the current constraints.' },
    worker: { ...settings.value.roles.worker, instructions: '{{goal}} under {{constraints}}; cite {{evidence}}.' },
  }
  const saved = await call('settings-save', { instanceId, commandId: 'save-settings', expectedRevision: 1, roles: changed })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.value.revision, 2)
  assert.equal((await call('settings', { instanceId })).value.roles.worker.instructions, changed.worker.instructions)
  const conflict = await call('settings-save', { instanceId, commandId: 'stale-settings', expectedRevision: 1, roles: changed })
  assert.equal(conflict.error.code, 'CONFIG_REVISION_CONFLICT')
  const invalidTemplate = await call('settings-save', { instanceId, commandId: 'invalid-template', expectedRevision: 2,
    roles: { ...changed, router: { ...changed.router, instructions: 'No required placeholder.' } } })
  assert.equal(invalidTemplate.error.code, 'INVALID_CONFIG')
  const invalidEffort = await call('settings-save', { instanceId, commandId: 'invalid-effort', expectedRevision: 2,
    roles: { ...changed, main: { ...changed.main, model: { ...changed.main.model, effort: 'not-served' } } } })
  assert.equal(invalidEffort.error.code, 'INVALID_CONFIG')
  const missingMain = await call('settings-save', { instanceId, commandId: 'missing-main', expectedRevision: 2,
    roles: { router: changed.router, worker: changed.worker } })
  assert.equal(missingMain.error.code, 'INVALID_CONFIG')
  assert.equal((await call('settings', { instanceId })).value.revision, 2)
  const secret = 'sk-test-never-return-this'
  const keyResult = await call('provider-key', { instanceId, provider: 'mock', value: secret })
  assert.deepEqual(keyResult.value, { provider: 'mock', configured: true })
  assert.equal(providerKey, secret)
  assert.deepEqual(settingsMutations, [{ ns: 'llm-pi-ai', revision: 3,
    operations: [{ op: 'set', path: ['providers', 'mock', 'apiKeyEnv'], value: 'MOCK_API_KEY' }] }])
  assert.equal(JSON.stringify(keyResult).includes(secret), false)
  assert.equal(JSON.stringify(await call('settings', { instanceId })).includes(secret), false)
  credentialFailure = true
  const failedSecret = 'sk-test-provider-error'
  const failedKey = await call('provider-key', { instanceId, provider: 'mock', value: failedSecret })
  assert.equal(failedKey.error.code, 'INVALID_CONFIG')
  assert.equal(JSON.stringify(failedKey).includes(failedSecret), false)
  assert.doesNotMatch(JSON.stringify(failedKey), /provider rejected/u)
  assert.equal((await call('history', { instanceId, limit: 100 })).value.works.length, 0)
  for (const endpoint of ['history', 'send']) {
    const denied = await call(endpoint, { instanceId: 'another-private-scope', commandId: 'guess', text: 'Guessing does not authorize access.' })
    assert.equal(denied.status, 403)
    assert.equal(denied.error.code, 'SOURCE_NOT_AUTHORIZED')
  }
  const unsupported = await call('delegate', { instanceId })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'UNAVAILABLE')
  const missingReconcile = await call('reconcile-delivery', { instanceId, commandId: 'missing-reconcile',
    ticketId: 'missing-ticket', deliveryId: 'missing-delivery' })
  assert.equal(missingReconcile.ok, false)
  assert.equal(missingReconcile.error.code, 'NOT_FOUND')
  const missingSourceReceipts = await call('source-deliveries', { instanceId, sourceId: 'missing-source', limit: 1 })
  assert.equal(missingSourceReceipts.ok, false)
  assert.equal(missingSourceReceipts.error.code, 'NOT_FOUND')
  assert.deepEqual(models, ['main'])
})
