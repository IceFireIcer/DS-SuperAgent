import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createElement as h, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'

export const official = { id: 'deepseek-official', key: { configured: false, writable: true }, models: [{ model: 'chat' }] }
export const main = { model: { provider: official.id, model: 'chat' } }
const require = createRequire(import.meta.url)

export async function mountProduct(context, { connection = { connected: false }, settings, native, classicNavigationError, extensions,
  responses: overrides, remotes = {} } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  Object.assign(globalThis, globals)
  window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' })
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.Blob.prototype.arrayBuffer ??= function () {
    return new Promise((resolve, reject) => {
      const reader = new window.FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
  extensions?.(window)
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const root = createRoot(document.querySelector('main'))
  const cleanups = []
  context.after(async () => {
    await act(async () => root.unmount())
    for (const cleanup of cleanups.reverse()) cleanup?.()
    dom.window.close()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })

  const requests = []
  const sessionId = 'main-fixture'
  const role = { ...main, name: 'Main', instructions: '', skills: [] }
  const snapshot = { revision: 1, roles: { main: role, router: role, worker: role }, uses: [], history: [],
    providers: [{ ...official, name: 'DeepSeek', models: [{ ...official.models[0], name: 'Chat', ref: 'deepseek-official/chat' }] }] }
  const providersView = () => ({ available: true, revision: snapshot.revision, addable: [], protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    providers: snapshot.providers.map(provider => ({
      id: provider.id, name: provider.name, key: provider.key,
      models: provider.models.map(model => ({ id: model.model, ref: model.ref, name: model.name })),
      declaredModels: provider.models.map(model => ({ id: model.model, ref: model.ref, name: model.name })),
      refreshable: false, removable: false, custom: false,
    })) })
  const responses = {
    open: () => ({ instanceId: 'fixture', mainId: 'main', mainSessionId: sessionId }),
    history: () => ({ mainSessionId: sessionId, messages: [], works: [], health: { state: 'ready' } }),
    settings: () => settings ? settings(snapshot) : snapshot,
    'work-members': () => ({ workers: [] }),
    'work-board': () => ({ items: [] }),
    'feishu-status': () => ({ configured: false, state: 'unavailable' }),
    'scheduled-task-list': () => ({ items: [] }),
    'scheduled-task-source-read': () => ({ enabled: true }),
    'connector-registry': () => ({ items: [], canStoreCredentials: true }),
    'directory-options': () => ({ directories: [] }),
    'execution-options': () => ({ policy: { defaultTarget: 'local-only', requiredPermissions: [] }, environments: [] }),
    'observe-list': () => ({ items: [] }),
    'settings-efforts': () => ({ efforts: [] }),
    providers: () => providersView(),
    ...overrides,
  }
  const call = async (endpoint, payload) => {
    requests.push({ endpoint, payload })
    if (!Object.hasOwn(responses, endpoint)) throw new Error(`Unexpected endpoint: ${endpoint}`)
    return structuredClone(await responses[endpoint](payload))
  }
  const fetch = async (_url, options) => {
    const { endpoint, payload } = JSON.parse(options.body)
    try {
      const value = await call(endpoint, payload)
      return { ok: true, json: async () => ({ ok: true, value }) }
    } catch (error) {
      return { ok: false, json: async () => ({ ok: false, error: { code: error.code, message: error.message } }) }
    }
  }
  window.dsSuperagentApp = { productClient: { status: async () => connection, call, events: async () => [] } }
  let visibleSession = sessionId
  let classicWorkspace
  if (native) window.dsSuperagentApp.classicAgent = { async call(endpoint, payload) {
    try {
      const value = await call(endpoint, payload)
      if (endpoint === 'classic-open') {
        visibleSession = value.sessionId
        classicWorkspace = value.workspaceId
      }
      if (endpoint === 'classic-close') visibleSession = sessionId
      return { ok: true, value }
    } catch (error) { return { ok: false, error: { message: error.message } } }
  } }
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../src/client/product.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/*'] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports,
    require: name => name.startsWith('@deepseek-ai/') ? { MarkdownText: ({ text }) => h('p', null, text) } : require(name),
    window, document, fetch, console, crypto: globalThis.crypto, sessionStorage: window.sessionStorage,
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, AbortController, btoa, TextEncoder,
    navigator: window.navigator, MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame, performance: window.performance })

  const entries = new Map()
  const versions = new Map()
  const listeners = new Set()
  let version = 0
  let selectedSession
  let withdrawnViews = 0
  const navigations = []
  const notify = () => { version += 1; for (const listener of listeners) listener() }
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const slots = {
    entries: name => entries.get(name) ?? [],
    getVersion: name => versions.get(name) ?? 0,
    subscribe(_name, listener) { return subscribe(listener) },
    inject(_name, install) { return install() },
    register(options, component) {
      entries.set(options.name, [...slots.entries(options.name), { options, component }])
      versions.set(options.name, slots.getVersion(options.name) + 1)
      notify()
      return () => {
        entries.set(options.name, slots.entries(options.name).filter(entry => entry.component !== component))
        if (options.name === 'conversation.view') {
          withdrawnViews += 1
          void Promise.resolve().then(() => { withdrawnViews -= 1 })
        }
        versions.set(options.name, slots.getVersion(options.name) + 1)
        notify()
      }
    },
  }
  const renderSlot = (name, props, options) => {
    const entry = slots.entries(name).find(item => (!options?.only || item.options.id === options.only)
      && (!item.options.select || item.options.select(props)))
    return entry ? h(entry.component, { ...props, renderSlot }) : options?.fallback
  }
  function Surface({ wide }) {
    useSyncExternalStore(subscribe, () => version)
    return h('div', null, renderSlot('sidebar.workspaces', { wide }), renderSlot('sidebar.footer.action', { wide }),
      renderSlot('main.conversation') ?? (selectedSession ? renderSlot('conversation.composer', { sessionId: selectedSession }, {
        fallback: h('section', { 'aria-label': `Native session ${selectedSession}` }),
      }) : null), renderSlot('shell.overlay'))
  }
  const render = wide => root.render(h(Surface, { wide }))
  let listedSession = sessionId
  const sessionListeners = new Set()
  const nativeContext = native ? {
    sessions: { binding: () => undefined, list: { getSnapshot: () => ({ phase: 'ready', byId: { [listedSession]: {} } }),
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener) } },
      async refresh() {
        await Promise.resolve()
        if (listedSession === visibleSession) return
        listedSession = visibleSession
        for (const listener of sessionListeners) listener()
      } },
    uiWorkspace: { openSession(id) {
      if (id !== listedSession) throw new Error('The native Session is still absent from the catalog.')
      if (id === visibleSession && id !== sessionId && (withdrawnViews || slots.entries('conversation.view').length)) {
        throw new Error('The product views must finish detaching before native navigation.')
      }
      if (id !== sessionId && classicNavigationError) throw classicNavigationError
      selectedSession = id
      navigations.push(id)
      for (const listener of sessionListeners) listener()
      notify()
    } },
    layout: { beginNavigation() {}, selectPanel() {} },
  } : {}
  const workspaceList = { getSnapshot: () => ({ items: classicWorkspace ? [{ workspaceId: classicWorkspace, sessionIds: [visibleSession] }] : [] }),
    subscribe: () => () => {} }
  await act(async () => {
    module.exports.applyProduct({ get: name => name === 'workspaces' && native ? { list: workspaceList } : remotes[name],
      effect: effect => cleanups.push(effect()), on: () => () => {}, slots, ...nativeContext })
    render(true)
  })

  const findButton = (name, within = document) => [...within.querySelectorAll('button')].find(button =>
    (button.getAttribute('aria-label') ?? button.textContent) === name && !button.closest('[inert], [hidden]'))
  const click = target => act(async () => { target.focus(); target.click() })
  const key = (target, value) => act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true,
  })))
  const fill = (target, value) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set.call(target, value)
    target.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const setWide = wide => act(async () => render(wide))
  return { act, click, document, fill, findButton, key, requests, responses, setWide, slots, snapshot, window, navigations }
}
