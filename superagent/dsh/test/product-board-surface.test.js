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

test('the product surface requires a second confirmation before work-stop and renders the Work board', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  let cleanup
  let root
  try {
    const React = requireHarness('react')
    const { createRoot } = requireHarness('react-dom/client')
    const { outputFiles } = await build({ entryPoints: [join(plugin, 'src/client/product.js')],
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/*'] })
    const module = { exports: {} }
    const requests = []
    const work = {
      brief: { id: 'brief-live', workItemId: 'item-live', goal: 'Keep the active work visible.',
        constraints: 'Stay in the workspace.', acceptanceCriteria: 'Report the result.', target: 'local-only' },
      receipt: { status: 'accepted', ticketId: 'ticket-live' },
      status: 'running',
      control: { workItemId: 'item-live', ticketId: 'ticket-live', ticketVersion: 7,
        permissions: { actorId: 'alice', canStop: true, canResume: false, canRetry: false, canAnswer: false },
        assignment: { id: 'assignment-live', generation: 'generation-live', sessionId: 'worker-live', state: 'running' } },
    }
    const fetch = async (_url, options) => {
      const { endpoint, payload } = JSON.parse(options.body)
      requests.push([endpoint, payload])
      const value = endpoint === 'open' ? { instanceId: 'private', mainSessionId: 'main-session', routerSessionId: 'router-session' }
        : endpoint === 'history' ? { messages: [], sources: [], preparations: [], health: { state: 'ready' },
          binding: { instanceId: 'private', mainSessionId: 'main-session', routerSessionId: 'router-session' },
          works: [structuredClone(work)] }
          : endpoint === 'observe-list' ? { items: [{ id: 'observation-live', role: 'worker', workItemId: 'item-live',
            ticketId: 'ticket-live', sessionId: 'worker-live', current: true, status: 'running',
            summary: 'Running the requested checks.', createdAt: 1 }] }
            : endpoint === 'directory-options' ? { default: { environmentId: 'local', root: '/work' }, directories: [] }
              : endpoint === 'execution-options' ? { policy: { defaultTarget: 'local-only', requiredPermissions: [] }, environments: [] }
                : endpoint === 'settings' ? { roles: { main: { model: { provider: 'mock', model: 'main' } },
                  router: { model: { provider: 'mock', model: 'router' } },
                  worker: { model: { provider: 'mock', model: 'worker' } } }, providers: [] }
                  : endpoint === 'work-stop' ? (() => {
                    work.status = 'stopped'
                    work.control.permissions.canStop = false
                    work.control.stop = { id: 'stop-live', state: 'stopping', pendingDeviceConfirmation: false }
                    return { status: 'stopping' }
                  })()
                    : null
      if (value === null) throw new Error(`Unexpected endpoint: ${endpoint}`)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports,
      require: id => id === 'react' ? React : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : requireHarness(id),
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch,
      crypto: globalThis.crypto, sessionStorage: dom.window.sessionStorage, setTimeout, clearTimeout,
      setInterval, clearInterval, structuredClone, Blob, URL, console })
    let surface
    module.exports.applyProduct({ get: name => name === 'locale' ? 'en-US' : undefined, effect: (effect, label) => {
      if (label === 'superagent: follow the shared Main') cleanup = effect()
    }, slots: { inject: (_name, register) => register(), register: ({ name }, component) => {
      if (name === 'main.conversation') surface = component
    } }, layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'main' }) }, selectPanel() {} } })
    root = createRoot(dom.window.document.querySelector('#root'))
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); root.render(React.createElement(surface)) })
    const document = dom.window.document
    assert.equal(document.querySelectorAll('[data-member-role="main"]').length, 1)
    assert.equal(document.querySelectorAll('[data-member-role="router"]').length, 1)
    assert.equal(document.querySelector('[data-member-role="worker"]')?.dataset.memberSession, 'worker-live')

    const card = document.querySelector('article.bt-main-work[data-ticket-id="ticket-live"]')
    const stop = () => card.querySelector('.bt-main-work-controls button')
    assert.equal(stop().textContent, 'Stop work')
    await React.act(async () => stop().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(requests.some(([endpoint]) => endpoint === 'work-stop'), false)
    assert.equal(stop().textContent, 'Confirm stop')
    await React.act(async () => stop().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const stopped = requests.find(([endpoint]) => endpoint === 'work-stop')?.[1]
    assert.equal(stopped?.workItemId, 'item-live')
    assert.equal(stopped?.ticketId, 'ticket-live')
    assert.equal(stopped?.expectedTicketVersion, 7)
    assert.equal(stopped?.expectedGeneration, 'generation-live')

    const workButton = [...document.querySelectorAll('.bt-main-header button')]
      .find(button => button.textContent === 'Work')
    await React.act(async () => workButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual([...document.querySelectorAll('section[data-board-group] > header h3')]
      .map(heading => heading.textContent), ['Running', 'Waiting for delivery', 'Waiting for a person', 'Delivered', 'Stopped'])
    assert.match(document.querySelector('[data-work-item-id="item-live"]')?.textContent ?? '', /Keep the active work visible\./u)
  } finally {
    cleanup?.()
    if (root) await requireHarness('react').act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    dom.window.close()
  }
})
