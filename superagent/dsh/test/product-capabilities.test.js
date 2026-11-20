import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(plugin, 'dev', 'harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

async function withCapabilities(call, inspect) {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-capabilities.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window,
      document: dom.window.document, crypto: globalThis.crypto, setTimeout, clearTimeout, console })
    const { ProductCapabilitiesSettings } = module.exports
    const root = createRoot(dom.window.document.querySelector('#root'))
    const clickNode = async node => {
      assert.ok(node, 'Missing button')
      assert.equal(node.disabled, false, `${node.textContent} should be enabled`)
      await React.act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    }
    const click = async label => {
      const node = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
      await clickNode(node)
    }
    const change = async (label, value) => React.act(async () => {
      const field = [...dom.window.document.querySelectorAll('input,select,textarea')]
        .find(item => item.getAttribute('aria-label') === label)
      assert.ok(field, `Missing field: ${label}`)
      const prototype = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
        : field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    const article = name => [...dom.window.document.querySelectorAll('.bt-product-capability')]
      .find(node => node.querySelector('.bt-connector-name')?.textContent === name)
    try {
      await React.act(async () => root.render(React.createElement(ProductCapabilitiesSettings,
        { binding: { instanceId: 'personal' }, call })))
      await inspect({ doc: dom.window.document, root, React, click, clickNode, change, article })
    } finally {
      await React.act(async () => root.unmount())
    }
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(globalThis, key, { configurable: true, value })
      else if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

const hasBotId = value => {
  if (!value || typeof value !== 'object') return false
  if (Object.hasOwn(value, 'botId')) return true
  return Object.values(value).some(hasBotId)
}

test('capability settings save, approve, bind, retry revisions and delete without bot authority', async () => {
  const calls = []
  let allowBind = false
  let items = [{
    id: 'review-tools',
    name: 'review-tools',
    kind: 'mcp',
    description: 'Review tools',
    approved: false,
    revision: 1,
    state: 'unbound',
    bindings: [],
    mcp: { resourceId: 'resource-one', serverName: 'review', toolName: 'check', url: 'https://mcp.example.test/mcp' },
    resource: { id: 'resource-one', label: 'Fixture MCP', status: 'active' },
    createdAt: 1,
    updatedAt: 1,
  }]
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'capability-list') return { items: structuredClone(items) }
    if (endpoint === 'resource-list') return { items: [{ id: 'resource-one', label: 'Fixture MCP', status: 'active', revision: 1 }] }
    if (endpoint === 'capability-approve') {
      items = items.map(item => item.name === payload.capabilityId
        ? { ...item, approved: payload.approved, revision: item.revision + 1,
          bindings: item.bindings.map(binding => ({ ...binding, status: payload.approved ? binding.status : 'needs-approval' })) }
        : item)
      return structuredClone(items.find(item => item.name === payload.capabilityId))
    }
    if (endpoint === 'capability-bind') {
      if (!allowBind) {
        throw Object.assign(new Error('The capability changed; review it before binding.'), {
          code: 'CAPABILITY_REVISION_CONFLICT',
        })
      }
      items = items.map(item => {
        if (item.name !== payload.capabilityId) return item
        const existing = item.bindings.find(binding => JSON.stringify(binding.scope) === JSON.stringify(payload.scope))
        const binding = {
          id: existing?.id ?? `binding-${item.bindings.length + 1}`,
          scope: payload.scope,
          active: payload.active,
          status: payload.active ? 'needs-grant' : 'disabled',
          reasons: payload.active ? ['Grant the credential resource for this role and work scope.'] : [],
          updatedAt: 2,
        }
        return { ...item, revision: item.revision + 1,
          bindings: existing ? item.bindings.map(item => item.id === existing.id ? binding : item) : [...item.bindings, binding],
          state: payload.active ? 'blocked' : 'unbound' }
      })
      return structuredClone(items.find(item => item.name === payload.capabilityId))
    }
    if (endpoint === 'capability-save') {
      const saved = {
        id: payload.name,
        name: payload.name,
        kind: payload.kind,
        description: payload.description,
        approved: payload.kind !== 'mcp',
        revision: 1,
        state: 'unbound',
        bindings: [],
        ...(payload.mcp ? { mcp: payload.mcp, resource: { id: 'resource-one', label: 'Fixture MCP', status: 'active' } } : {}),
        ...(payload.content !== undefined ? { content: payload.content } : {}),
        ...(payload.items ? { items: payload.items } : {}),
        createdAt: 2,
        updatedAt: 2,
      }
      items = [...items, saved]
      return structuredClone(saved)
    }
    if (endpoint === 'capability-delete') {
      items = items.filter(item => item.name !== payload.capabilityId)
      return { capabilityId: payload.capabilityId, deleted: true, revision: payload.expectedRevision + 1, affectedPacks: [] }
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }

  await withCapabilities(call, async ({ doc, click, clickNode, change, article }) => {
    assert.match(doc.querySelector('[role="heading"]')?.textContent ?? doc.querySelector('h2').textContent, /Capabilities/u)
    assert.match(doc.body.textContent, /Shared capabilities/u)
    assert.match(doc.body.textContent, /Needs approval/u)
    assert.ok(doc.querySelector('.bt-connector.bt-product-capability'))

    await click('Approve capability')
    const approval = calls.find(([endpoint]) => endpoint === 'capability-approve')[1]
    assert.equal(approval.capabilityId, 'review-tools')
    assert.equal(approval.expectedRevision, 1)
    assert.equal(approval.approved, true)
    assert.match(doc.body.textContent, /Approved/u)

    await change('Work item ID review-tools', 'item-one')
    await click('Bind capability')
    assert.match(doc.querySelector('[role="alert"]').textContent, /capability changed/u)
    assert.ok(article('review-tools'))
    allowBind = true
    await click('Bind capability')
    const binding = calls.filter(([endpoint]) => endpoint === 'capability-bind').at(-1)[1]
    assert.deepEqual(JSON.parse(JSON.stringify(binding.scope)), { role: 'worker', workItemId: 'item-one' })
    assert.equal(binding.active, true)
    assert.match(doc.body.textContent, /Needs credential grant/u)
    assert.match(doc.body.textContent, /Capability bound/u)

    await change('Role review-tools', 'main')
    assert.equal([...doc.querySelectorAll('input')].some(input => input.getAttribute('aria-label') === 'Work item ID review-tools'),
      false)
    await click('Bind capability')
    const mainBinding = calls.filter(([endpoint]) => endpoint === 'capability-bind').at(-1)[1]
    assert.deepEqual(JSON.parse(JSON.stringify(mainBinding.scope)), { role: 'main' })

    await click('Add capability')
    await change('Name', 'new-tool')
    await change('Description', 'New MCP tool')
    await change('Credential resource', 'resource-one')
    await change('MCP endpoint', 'https://mcp.example.test/new')
    await change('Server name', 'new')
    await change('Tool name', 'run')
    await click('Add capability')
    const saved = calls.find(([endpoint]) => endpoint === 'capability-save')[1]
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
      instanceId: 'personal',
      commandId: saved.commandId,
      name: 'new-tool',
      kind: 'mcp',
      description: 'New MCP tool',
      expectedRevision: 0,
      mcp: {
        resourceId: 'resource-one',
        serverName: 'new',
        toolName: 'run',
        url: 'https://mcp.example.test/new',
      },
    })
    assert.match(doc.body.textContent, /Capability added/u)

    await clickNode([...article('review-tools').querySelectorAll('button')].find(button => button.textContent === 'Delete'))
    await clickNode([...article('review-tools').querySelectorAll('button')].find(button => button.textContent === 'Click again to delete'))
    const deletion = calls.find(([endpoint]) => endpoint === 'capability-delete')[1]
    assert.equal(deletion.capabilityId, 'review-tools')
    assert.equal(calls.some(([, payload]) => hasBotId(payload)), false)
  })
})

test('capability settings fail closed when the library is unavailable and recover explicitly', async () => {
  let fail = true
  const calls = []
  const call = async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'capability-list') {
      if (fail) {
        fail = false
        throw Object.assign(new Error('Capability service is offline.'), { code: 'UNAVAILABLE' })
      }
      return { items: [] }
    }
    if (endpoint === 'resource-list') return { items: [] }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withCapabilities(call, async ({ doc, click }) => {
    assert.match(doc.querySelector('[role="alert"]').textContent, /Capability service is offline/u)
    assert.equal([...doc.querySelectorAll('button')].some(button => button.textContent === 'Add capability'), false)
    await click('Retry')
    assert.match(doc.body.textContent, /No capabilities saved/u)
    assert.ok([...doc.querySelectorAll('button')].some(button => button.textContent === 'Add capability'))
  })
})

test('MCP creation is disabled when credential resources cannot be read', async () => {
  const call = async endpoint => {
    if (endpoint === 'capability-list') return { items: [] }
    if (endpoint === 'resource-list') {
      throw Object.assign(new Error('Credential resource service is offline.'), { code: 'UNAVAILABLE' })
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withCapabilities(call, async ({ doc, click }) => {
    await click('Add capability')
    assert.match(doc.body.textContent, /Credential resource service is offline/u)
    assert.equal(doc.querySelector('button[type="submit"]').disabled, true)
    assert.equal(doc.querySelector('select[aria-label="Credential resource"]').disabled, true)
  })
})
