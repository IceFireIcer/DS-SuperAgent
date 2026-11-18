import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(join(plugin, 'dev/harness/package.json'))
const { JSDOM } = requireHarness('jsdom')

test('product execution settings save a policy, pair a device and revoke it', async () => {
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
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product-execution.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: id => id === 'react' ? React : requireHarness(id),
      window: dom.window, document: dom.window.document, crypto: globalThis.crypto, structuredClone,
      setInterval, clearInterval, setTimeout, clearTimeout, console })
    const { ProductExecutionSettings } = module.exports
    const calls = []
    let pairAttempts = 0
    let revokeAttempts = 0
    let unknownPairCommand
    let revision = 0
    let environments = [{ id: 'local-work', kind: 'local', root: '/work', permissions: ['read', 'write'],
      target: 'local-only', capabilities: { attachments: { supported: true }, skills: { supported: false } } }]
    let changes = 0
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'execution-options') return { policy: { revision, defaultTarget: 'local', requiredPermissions: ['read'] },
        environments }
      if (endpoint === 'execution-policy-save') {
        revision++
        return { revision, ...payload.policy }
      }
      if (endpoint === 'remote-environment-pair') {
        pairAttempts++
        if (pairAttempts === 1) {
          unknownPairCommand = payload.commandId
          throw Object.assign(new Error('The device pairing result is unknown. Inspect the device before issuing a new pairing.'),
            { code: 'PAIRING_UNKNOWN' })
        }
        environments = [...environments, { id: payload.environmentId, label: payload.label, kind: 'remote',
          root: '/device', deviceId: payload.expectedDeviceId, permissions: payload.permissions, online: true,
          capabilities: { attachments: { supported: true }, skills: { supported: true } } }]
        return { id: payload.environmentId }
      }
      if (endpoint === 'remote-environment-pair-read') return { commandId: payload.commandId, status: 'unknown',
        active: false, canAbandon: true }
      if (endpoint === 'remote-environment-pair-abandon') return { commandId: payload.commandId, abandoned: true }
      if (endpoint === 'remote-environment-revoke') {
        revokeAttempts++
        if (revokeAttempts === 1) throw Object.assign(new Error('The device revocation command is still running.'),
          { code: 'REVOKE_PENDING' })
        if (revokeAttempts === 2) {
          environments = environments.filter(environment => environment.id !== payload.environmentId)
          return { revoked: true, deviceConfirmed: true, secretCleanupPending: true }
        }
        return { revoked: true, deviceConfirmed: true }
      }
      throw new Error(`Unexpected product endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const click = async node => React.act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const change = async (field, value) => React.act(async () => {
      const type = field.tagName === 'SELECT' ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(field, value)
      field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    try {
      await React.act(async () => { root.render(React.createElement(ProductExecutionSettings,
        { binding: { instanceId: 'private' }, call, onChanged: () => { changes++ } })) })
      const document = dom.window.document
      const defaultTarget = document.querySelectorAll('select')[0]
      await change(defaultTarget, 'auto')
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Save execution policy'))
      assert.equal(calls.find(([endpoint]) => endpoint === 'execution-policy-save')[1].policy.defaultTarget, 'auto')
      assert.equal(calls.find(([endpoint]) => endpoint === 'execution-policy-save')[1].policy.preferredEnvironmentId, null)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Pair a device'))
      const fillPairForm = async () => {
        const form = document.querySelector('form')
        const inputs = [...form.querySelectorAll('input[type="text"], input[type="password"], input:not([type])')]
        await change(inputs[0], 'Build device')
        await change(inputs[1], 'remote-build')
        await change(inputs[2], 'https://device.example')
        await change(inputs[3], 'device-one')
        await change(inputs[4], 'a'.repeat(64))
        await change(inputs[5], '12345678')
      }
      await fillPairForm()
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Pair device'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Check pairing status'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Abandon uncertain pairing'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm abandon pairing'))
      assert.equal(calls.some(([endpoint, payload]) => endpoint === 'remote-environment-pair-abandon'
        && payload.commandId === unknownPairCommand), true)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Pair a device'))
      await fillPairForm()
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Pair device'))
      const pairCalls = calls.filter(([endpoint]) => endpoint === 'remote-environment-pair').map(([, payload]) => payload)
      assert.equal(pairCalls.length, 2)
      assert.notEqual(pairCalls[0].commandId, pairCalls[1].commandId)
      const paired = pairCalls.at(-1)
      assert.equal(paired.environmentId, 'remote-build')
      assert.equal(paired.expectedDeviceKey, 'a'.repeat(64))
      assert.equal(document.body.textContent.includes('Build device'), true)
      const revoke = [...document.querySelectorAll('button')].find(button => button.textContent === 'Revoke device')
      await click(revoke)
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm revoke device'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm revoke device'))
      await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Retry credential cleanup'))
      const revokeCalls = calls.filter(([endpoint]) => endpoint === 'remote-environment-revoke').map(([, payload]) => payload)
      assert.equal(revokeCalls.length, 3)
      assert.equal(new Set(revokeCalls.map(payload => payload.commandId)).size, 1)
      assert.equal(document.body.textContent.includes('Build device'), false)
      assert.equal(changes >= 3, true)
    } finally { await React.act(async () => root.unmount()) }
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    dom.window.close()
  }
})
