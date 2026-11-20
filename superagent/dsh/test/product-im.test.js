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

test('WeChat pairing renders a scannable QR SVG and IM actions use only product endpoints', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({
      entryPoints: [join(plugin, 'src/client/product-im.js')],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, {
      module,
      exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id),
      window: dom.window,
      document: dom.window.document,
      crypto: globalThis.crypto,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      console,
    })
    const { ProductImSettings, createProductImApi } = module.exports
    const calls = []
    let loggedIn = false
    let registries = 0
    let finishLogin
    const loginFinished = new Promise(resolve => { finishLogin = resolve })
    const binding = { instanceId: 'private' }
    const api = createProductImApi(async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'im-registry') {
        registries += 1
        return { platforms: [
          { id: 'weixin', name: 'WeChat', fields: [], login: 'qr' },
        ], connections: loggedIn ? [{
          id: 'im-1', platform: 'weixin', account: { id: 'wechat-bot', name: 'WeChat' }, enabled: true,
          state: 'ready', secretFields: ['token'], paired: [], pairRequests: [], chats: [], createdAt: 1, updatedAt: 2,
        }] : [] }
      }
      if (endpoint === 'im-login') {
        if (payload.op === 'wait') {
          await loginFinished
          loggedIn = true
          return { status: 'done', expiresAt: Date.now() + 60_000 }
        }
        return {
          loginId: 'login-1', platform: 'weixin', qr: 'weixin://fixture/scan?code=ABCDEFG123456',
          status: 'waiting', expiresAt: Date.now() + 60_000,
        }
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }, { instanceId: 'private' })
    const call = (endpoint, payload) => {
      if (endpoint === 'im-registry') return api.registry()
      if (payload.op === 'wait') return api.loginWait({ loginId: payload.loginId })
      return api.loginStart({ platform: payload.platform, commandId: payload.commandId })
    }
    assert.equal(typeof api.registry, 'function')
    assert.equal(typeof api.loginStart, 'function')
    const root = createRoot(dom.window.document.querySelector('#root'))
    const click = async button => React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    try {
      await React.act(async () => {
        root.render(React.createElement(ProductImSettings, {
          binding,
          call,
          loginPollMs: 20,
          registryPollMs: 5000,
        }))
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      assert.match(dom.window.document.body.textContent, /WeChat/u)
      await click([...dom.window.document.querySelectorAll('button')].find(button => button.textContent.includes('Pair')))
      await click([...dom.window.document.querySelectorAll('button')].find(button => button.textContent.includes('Start login')))
      for (let attempt = 0; attempt < 50 && !dom.window.document.querySelector('.bt-im-qr-rendered svg'); attempt += 1) {
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      }
      const svg = dom.window.document.querySelector('.bt-im-qr-rendered svg')
      assert.ok(svg, 'QR login must render a matrix, not the URI text')
      assert.ok(svg.querySelector('path[d^="M"]'))
      assert.match(svg.getAttribute('viewBox'), /^0 0 \d+ \d+$/u)
      finishLogin()
      for (let attempt = 0; attempt < 100 && !dom.window.document.body.textContent.includes('Connected'); attempt += 1) {
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      }
      assert.ok(registries >= 2, 'a completed QR login must reload the registry')
      assert.match(dom.window.document.body.textContent, /Connected/u)
      assert.equal(calls.some(call => call.endpoint.startsWith('/api/bot')), false)
      assert.ok(calls.every(call => ['im-registry', 'im-login'].includes(call.endpoint)))
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
})

test('IM settings poll new pairing requests and approve them without another page load', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({
      entryPoints: [join(plugin, 'src/client/product-im.js')],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, {
      module,
      exports: module.exports,
      require: id => id === 'react' ? React : requireHarness(id),
      window: dom.window,
      document: dom.window.document,
      crypto: globalThis.crypto,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      console,
    })
    const { ProductImSettings } = module.exports
    const calls = []
    let registries = 0
    const connection = {
      id: 'im-1', platform: 'telegram', account: { id: 'bot-1', name: '@fixture' }, enabled: true,
      state: 'ready', secretFields: ['token'],
      paired: [],
      pairRequests: [{ id: 'pair-1', name: 'Ada', chatKey: 'u1', createdAt: 1, expiresAt: Date.now() + 60_000 }],
      chats: [], createdAt: 1, updatedAt: 2,
    }
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'im-registry') {
        registries += 1
        return { platforms: [{ id: 'telegram', name: 'Telegram', fields: [], buttons: true, groups: true }],
          connections: registries === 1 ? [] : [connection] }
      }
      if (endpoint === 'im-pair') return connection
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    try {
      await React.act(async () => {
        root.render(React.createElement(ProductImSettings, {
          binding: { instanceId: 'private' }, call, registryPollMs: 20,
        }))
      })
      for (let attempt = 0; attempt < 50 && !dom.window.document.body.textContent.includes('Ada'); attempt += 1) {
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      }
      const allow = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Allow')
      assert.ok(allow, 'a pairing request must appear without leaving and reopening the page')
      await React.act(async () => {
        allow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      const approval = calls.find(call => call.endpoint === 'im-pair')
      assert.ok(approval)
      assert.deepEqual({ ...approval.payload, commandId: 'ignored' }, {
        instanceId: 'private', commandId: 'ignored', id: 'im-1',
        op: 'pair', senderId: 'pair-1', allow: true,
      })
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
})
