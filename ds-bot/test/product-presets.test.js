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

async function withPresets(call, settingsRevision, inspect) {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16)
  dom.window.cancelAnimationFrame = clearTimeout
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-presets.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id), window: dom.window, document: dom.window.document,
      crypto: globalThis.crypto, Intl, Date, setTimeout, clearTimeout,
      requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame, console })
    const root = createRoot(dom.window.document.querySelector('#root'))
    const applied = []
    const render = async revision => React.act(async () => {
      root.render(React.createElement(module.exports.ProductPresetSettings, { binding: { instanceId: 'personal' },
        call, settingsRevision: revision, onApplied: result => applied.push(result) }))
    })
    const clickNode = async button => React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const click = async label => {
      const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, `Missing button: ${label}`)
      assert.equal(button.disabled, false, `${label} should be enabled`)
      await clickNode(button)
    }
    const change = async (label, value) => React.act(async () => {
      const field = [...dom.window.document.querySelectorAll('input,select,textarea')].find(item => item.getAttribute('aria-label') === label)
      assert.ok(field, `Missing field: ${label}`)
      const prototype = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
        : field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    try {
      await render(settingsRevision)
      await inspect({ doc: dom.window.document, click, clickNode, change, render, applied })
    } finally { await React.act(async () => root.unmount()) }
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(globalThis, key, { configurable: true, value })
      else if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

test('new presets retain the draft and command ID on failure, then apply only after a revision receipt', async () => {
  const calls = []
  let fail = true
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'preset-list') return { items: fail ? [] : [{ id: payload.preset?.id ?? 'preset-one',
      revision: 1, status: 'active', preset: { id: 'preset-one', name: 'Reviewer', model: { provider: 'mock', model: 'one' },
        instructions: 'Check evidence.', skills: ['review'] } }] }
    if (endpoint === 'preset-create') {
      if (fail) { fail = false; throw new Error('Host unavailable') }
      return { id: payload.preset.id, revision: 1, status: 'active', preset: payload.preset }
    }
    if (endpoint === 'preset-apply') return { revision: 8 }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withPresets(call, 7, async ({ doc, click, change, applied }) => {
    await click('New preset')
    await change('Name', 'Reviewer')
    await change('Model provider', 'mock')
    await change('Model ID', 'one')
    await change('Instructions', 'Check evidence.')
    await change('Skills', 'review')
    await click('Create preset')
    assert.match(doc.querySelector('[role="alert"]').textContent, /Host unavailable/u)
    assert.equal(doc.querySelector('[aria-label="Name"]').value, 'Reviewer')
    assert.doesNotMatch(doc.body.textContent, /Preset created/u)
    await click('Create preset')
    const creates = calls.filter(([endpoint]) => endpoint === 'preset-create').map(([, payload]) => payload)
    assert.equal(creates.length, 2)
    assert.equal(creates[0].commandId, creates[1].commandId)
    assert.deepEqual(JSON.parse(JSON.stringify(creates[1].preset)), {
      id: creates[1].preset.id, name: 'Reviewer', model: { provider: 'mock', model: 'one' },
      instructions: 'Check evidence.', skills: ['review'],
    })
    assert.match(doc.querySelector('[role="status"]').textContent, /Preset created/u)
    await change('Apply to', 'router')
    await click('Apply preset')
    const application = calls.find(([endpoint]) => endpoint === 'preset-apply')[1]
    assert.equal(application.instanceId, 'personal')
    assert.equal(application.presetId, 'preset-one')
    assert.equal(application.targetRole, 'router')
    assert.equal(application.expectedRevision, 7)
    assert.equal(applied[0].revision, 8)
    assert.match(doc.body.textContent, /Configuration v8 is active for new turns/u)
  })
})

test('preset activity shows decisions and applications, and an unknown apply result is reconciled', async () => {
  const calls = []
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'preset-list') return { items: [{ id: 'preset-one', revision: 1, status: 'active',
      preset: { id: 'preset-one', name: 'Reviewer', model: { provider: 'mock', model: 'one' }, instructions: '', skills: [] } }] }
    if (endpoint === 'preset-imports') return { items: [{ id: 'decision-one', status: 'skipped',
      source: { identity: 'copy-one', botId: 'old-bot', digest: 'abc' }, targetRole: 'worker' }] }
    if (endpoint === 'preset-applications') return { items: [{ commandId: 'previous', sourceInstanceId: 'desktop', actorId: 'user',
      presetId: 'preset-one', presetRevision: 1, targetRole: 'router', revision: 3 }] }
    if (endpoint === 'preset-apply') throw Object.assign(new Error('Commit outcome unknown'), { code: 'COMMIT_UNKNOWN' })
    if (endpoint === 'preset-application-read') return { commandId: payload.commandId, presetId: 'preset-one',
      targetRole: 'worker', revision: 4 }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withPresets(call, 3, async ({ doc, click, applied }) => {
    await click('Preset activity')
    assert.match(doc.body.textContent, /copy-one \/ old-bot → worker: skipped/u)
    assert.match(doc.body.textContent, /preset-one v1 → router: Configuration v3/u)
    await click('Apply preset')
    assert.equal(applied[0].revision, 4)
    assert.match(doc.body.textContent, /Configuration v4 is active for new turns/u)
    assert.equal(calls.filter(([endpoint]) => endpoint === 'preset-apply').length, 1)
    assert.equal(calls.find(([endpoint]) => endpoint === 'preset-application-read')[1].commandId,
      calls.find(([endpoint]) => endpoint === 'preset-apply')[1].commandId)
  })
})

test('old copy review excludes permissions and history, reports conflict, and persists explicit skip', async () => {
  const calls = []
  const digest = 'abcdef0123456789abcdef0123456789'
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'preset-list') return { items: [] }
    if (endpoint === 'preset-preview') return { id: 'preview-1', preview: {
      source: { identity: 'old-export', botId: 'bot-a', digest }, targetRole: 'worker',
      draft: { name: 'Old reviewer', model: { provider: 'mock', model: 'legacy' },
        instructions: '{{goal}} {{constraints}}', skills: ['review'], appearance: { shape: 'star', color: 'blue' } },
      fields: [{ from: 'bot.name', to: 'preset.name' }], ignored: [], issues: [],
    } }
    if (endpoint === 'preset-select') return { id: payload.decision === 'skip' ? 'skip-1' : 'conflict-1',
      previewId: 'preview-1', status: payload.decision === 'skip' ? 'skipped' : 'conflict',
      ...(payload.decision === 'skip' ? {} : { reason: 'PRESET_CONTENT_CONFLICT' }) }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withPresets(call, 3, async ({ doc, click, clickNode, change }) => {
    await click('Review old configuration')
    await change('Copy identity', 'old-export')
    await change('Old Bot ID', 'bot-a')
    await change('Old configuration copy', JSON.stringify({ mainBotIds: ['bot-a'], bots: { 'bot-a': {
      name: 'Old reviewer', model: 'mock/legacy', instructions: '{{goal}} {{constraints}}', skills: ['review'],
      avatar: { shape: 'star', secret: 'private' }, color: 'blue', admin: true,
      permissions: { command: true }, history: ['private'],
    } } }))
    await click('Preview')
    const preview = calls.find(([endpoint]) => endpoint === 'preset-preview')[1]
    assert.equal(preview.copy.targetRole, 'worker')
    assert.deepEqual(JSON.parse(JSON.stringify(preview.copy.state)), { bots: { 'bot-a': {
      name: 'Old reviewer', model: 'mock/legacy', instructions: '{{goal}} {{constraints}}', skills: ['review'],
      avatar: { shape: 'star' }, color: 'blue',
    } } })
    assert.match(doc.body.textContent, /old-export \/ bot-a → worker/u)
    assert.match(doc.body.textContent, /bot\.admin/u)
    assert.match(doc.body.textContent, /bot\.history/u)
    assert.match(doc.body.textContent, /bot\.avatar\.secret/u)
    await change('Name', 'Reviewed worker')
    await click('Choose character')
    const moon = doc.querySelector('button.bt-shape[aria-label="Moon"]')
    assert.ok(moon)
    await clickNode(moon)
    await click('Select preset')
    const selection = calls.find(([endpoint, payload]) => endpoint === 'preset-select' && payload.decision === 'select')[1]
    assert.equal(selection.previewId, 'preview-1')
    assert.equal(selection.preset.name, 'Reviewed worker')
    assert.equal(selection.preset.appearance.shape, 'moon')
    assert.match(doc.querySelector('[role="alert"]').textContent, /PRESET_CONTENT_CONFLICT/u)
    assert.doesNotMatch(doc.body.textContent, /Preset selected from the reviewed copy/u)
    await click('Skip import')
    const skip = calls.find(([endpoint, payload]) => endpoint === 'preset-select' && payload.decision === 'skip')[1]
    assert.equal(skip.previewId, 'preview-1')
    assert.equal(Object.hasOwn(skip, 'copy'), false)
    assert.equal(Object.hasOwn(skip, 'preset'), false)
    assert.match(doc.body.textContent, /Import skipped/u)
  })
})

test('a confirmed selection creates one preset; repeating the same source reports the recorded duplicate', async () => {
  const calls = []
  const items = []
  let previewCount = 0
  let selectCount = 0
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'preset-list') return { items: [...items] }
    if (endpoint === 'preset-preview') return { id: `preview-${++previewCount}`, preview: {
      source: { identity: 'old-export', botId: 'bot-a', digest: '1234567890abcdef' }, targetRole: 'main',
      draft: { name: 'Imported', model: { provider: 'mock', model: 'one' }, instructions: '', skills: [] },
      fields: [], ignored: [], issues: [],
    } }
    if (endpoint === 'preset-select') {
      selectCount++
      if (selectCount === 1) return undefined
      if (selectCount === 2) {
        items.push({ id: payload.preset.id, preset: payload.preset, status: 'active', revision: 1 })
        return { id: 'import-one', previewId: payload.previewId, status: 'selected', presetId: payload.preset.id }
      }
      return { id: 'import-two', previewId: payload.previewId, status: 'duplicate', duplicateOf: 'import-one', presetId: items[0].id }
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withPresets(call, 5, async ({ doc, click, change }) => {
    const source = JSON.stringify({ bots: { 'bot-a': { name: 'Imported', model: 'mock/one', instructions: '', skills: [] } } })
    await click('Review old configuration')
    await change('Copy identity', 'old-export')
    await change('Old Bot ID', 'bot-a')
    await change('Target role', 'main')
    await change('Old configuration copy', source)
    await click('Preview')
    await click('Select preset')
    assert.match(doc.querySelector('[role="alert"]').textContent, /not confirmed/u)
    assert.equal(items.length, 0)
    await click('Select preset')
    const selects = calls.filter(([endpoint]) => endpoint === 'preset-select').map(([, payload]) => payload)
    assert.equal(selects[0].commandId, selects[1].commandId)
    assert.equal(items.length, 1)
    assert.match(doc.body.textContent, /Preset selected from the reviewed copy/u)
    assert.equal(calls.some(([endpoint]) => endpoint === 'preset-apply'), false)
    await click('Review old configuration')
    await change('Old configuration copy', source)
    await click('Preview')
    await click('Select preset')
    assert.equal(selects[1].preset.id, calls.filter(([endpoint]) => endpoint === 'preset-select')[2][1].preset.id)
    assert.equal(items.length, 1)
    assert.match(doc.body.textContent, /already recorded/u)
  })
})

test('unavailable list and conflicting application stay visible without a success claim', async () => {
  let available = false
  const calls = []
  const preset = { id: 'saved', name: 'Ready', model: { provider: 'mock', model: 'one' },
    instructions: '', skills: [] }
  const call = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'preset-list') {
      if (!available) throw new Error('Endpoint not connected')
      return { items: [{ id: 'saved', preset, revision: 1, status: 'active' }] }
    }
    if (endpoint === 'preset-apply') throw Object.assign(new Error('Configuration changed'), { code: 'CONFIG_REVISION_CONFLICT' })
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
  await withPresets(call, 2, async ({ doc, click, applied }) => {
    assert.match(doc.querySelector('[role="alert"]').textContent, /Endpoint not connected/u)
    assert.equal([...doc.querySelectorAll('button')].find(button => button.textContent === 'New preset').disabled, true)
    available = true
    await click('Retry')
    await click('Apply preset')
    assert.match(doc.body.textContent, /Configuration changed/u)
    assert.equal([...doc.querySelectorAll('button')].find(button => button.textContent === 'Apply preset').disabled, true)
    assert.equal(applied.length, 0)
    assert.doesNotMatch(doc.body.textContent, /active for new turns/u)
  })
})
