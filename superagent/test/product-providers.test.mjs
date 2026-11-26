import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProductProviders } from '../dist/product-providers.js'

test('custom providers are added, discovered, saved and removed through the DSH settings seams', async () => {
  const user = { providers: {} }
  const base = {}
  const keys = new Map()
  let revision = 4
  const mutations = []
  const known = { provider: 'relay-known', displayName: 'Relay Known', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay-known'] }
  const mock = { provider: 'mock', displayName: 'Mock Provider', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mock'] }
  const providers = () => {
    const declared = Object.keys(user.providers).filter(id => id !== 'mock').map(id => ({ provider: id,
      displayName: user.providers[id].displayName ?? id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true }))
    return [known, mock, ...declared]
  }
  const value = () => ({ providers: { ...base.providers, ...user.providers, mock: { apiKeyEnv: 'MOCK_API_KEY' } } })
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: value(), user, base, revision }],
    mutate: async (ns, operations, expected) => {
      mutations.push({ ns, operations, expected })
      if (expected !== undefined && expected !== revision) throw new Error('stale')
      for (const operation of operations) {
        const target = operation.path[0] === 'providers' ? user.providers : undefined
        const id = operation.path[1]
        if (!target || !id) continue
        if (operation.op === 'unset') delete target[id]
        else if (operation.path.length === 2) target[id] = operation.value
        else target[id] = { ...(target[id] ?? {}), [operation.path[2]]: operation.value }
      }
      revision += 1
    },
  }
  const credentials = {
    describe: async reference => ({ configured: keys.has(reference), writable: true }),
    set: async (reference, secret) => keys.set(reference, secret),
    unset: async reference => keys.delete(reference),
  }
  const llm = {
    listConfigurableProviders: providers,
    listModels: async provider => provider === 'mock' ? [{ id: 'main' }] : provider === 'my-gateway'
      ? [{ id: 'relay-large', name: 'Relay Large' }] : [],
    discoverModels: async (_ns, request) => {
      assert.equal(request.baseURL, 'https://relay.example/v1')
      assert.equal(request.api, 'openai-completions')
      assert.equal(request.apiKey, 'sk-relay-test')
      return [{ id: 'relay-large', name: 'Relay Large' }, { id: 'relay-small', name: 'Relay Small' }]
    },
  }
  const context = { get: name => name === 'settings' ? settings : name === 'credentials' ? credentials : name === 'llm' ? llm : undefined }
  const product = createProductProviders(context)

  const initial = await product.providersView()
  assert.equal(initial.available, true)
  assert.deepEqual(initial.addable.map(entry => entry.id), ['relay-known'])
  assert.equal(initial.providers.find(entry => entry.id === 'mock').key.configured, false)

  const discovered = await product.discoverModels({ baseURL: 'https://relay.example/v1', api: 'openai-completions', key: 'sk-relay-test' })
  assert.deepEqual(discovered.map(model => model.id), ['relay-large', 'relay-small'])

  const added = await product.addProvider({ custom: true, provider: 'my-gateway', name: 'My Gateway',
    baseURL: 'https://relay.example/v1', api: 'openai-completions', key: 'sk-relay-test',
    models: [{ id: 'relay-large', name: 'Relay Large' }] })
  assert.equal(added.providers.find(entry => entry.id === 'my-gateway').name, 'My Gateway')
  assert.equal(user.providers['my-gateway'].apiKeyEnv, 'MY_GATEWAY_API_KEY')
  assert.equal(keys.get('MY_GATEWAY_API_KEY'), 'sk-relay-test')
  assert.equal(mutations[0].operations[0].path.join('.'), 'providers.my-gateway')

  const saved = await product.saveProviderModels({ provider: 'my-gateway', revision: added.revision,
    models: [{ id: 'relay-large', name: 'Relay Large' }, { id: 'relay-small', name: 'Relay Small' }] })
  assert.deepEqual(user.providers['my-gateway'].models.map(model => model.id), ['relay-large', 'relay-small'])
  assert.equal(saved.providers.find(entry => entry.id === 'my-gateway').models.length, 2)

  const removed = await product.removeProvider('my-gateway')
  assert.equal(removed.providers.some(entry => entry.id === 'my-gateway'), false)
  assert.equal('my-gateway' in user.providers, false)
  assert.equal(keys.has('MY_GATEWAY_API_KEY'), false)
})

test('provider input refuses a credential-shaped key and an invalid endpoint', async () => {
  const context = {
    get: name => name === 'settings' ? {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, user: { providers: {} }, revision: 1 }],
      mutate: async () => {},
    } : name === 'credentials' ? {
      describe: async () => ({ configured: false, writable: true }), set: async () => {}, unset: async () => {},
    } : name === 'llm' ? { listConfigurableProviders: () => [], listModels: async () => [], discoverModels: async () => [] } : undefined,
  }
  const product = createProductProviders(context)
  await assert.rejects(product.addProvider({ provider: 'relay', custom: true, baseURL: 'not-a-url',
    api: 'openai-completions', key: 'sk-good', models: [{ id: 'a' }] }), /http or https/u)
  await assert.rejects(product.addProvider({ provider: 'relay', custom: true, baseURL: 'https://relay.example/v1',
    api: 'openai-completions', key: 'NAME=value', models: [{ id: 'a' }] }), /NAME=value/u)
})
