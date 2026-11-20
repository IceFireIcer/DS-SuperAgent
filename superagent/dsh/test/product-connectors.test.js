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

test('connector and mailbox settings expose target, no-auth, custom server, and durable reply controls', async () => {
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
      entryPoints: [join(plugin, 'src/client/product-connectors.js')],
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
      FormData: dom.window.FormData,
      TextEncoder,
      console,
    })
    const { ProductConnectorsSettings } = module.exports
    const calls = []
    let exaConfigured = false
    let replyPending = true
    const target = { role: 'main' }
    const call = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'feishu-status') {
        return { configured: true, sourceInstanceId: 'feishu:tenant:chat:app:cli_fixture' }
      }
      if (endpoint === 'connector-save') {
        if (payload.connectorId === 'exa') exaConfigured = true
        return { id: payload.connectorId, name: 'Exa', category: 'search', about: 'Web search',
          custom: false, auth: { kind: 'none' }, status: 'configured', readOnly: false,
          revision: 1, secretCount: 0 }
      }
      if (endpoint === 'connector-list') {
        return { target, items: [
          { id: 'exa', name: 'Exa', category: 'search', about: 'Web search', custom: false,
            auth: { kind: 'none' }, status: exaConfigured ? 'configured' : 'off', readOnly: false,
            revision: exaConfigured ? 1 : 0, secretCount: 0 },
          { id: 'feishu', name: 'Feishu', category: 'work', about: 'Feishu source',
            custom: false, auth: { kind: 'oauth' }, status: 'off', readOnly: false,
            revision: 0, secretCount: 0, authorizationAvailable: true },
          { id: 'mail', name: 'Mailbox', category: 'mail', about: 'Mailbox',
            custom: false, auth: { kind: 'link' }, status: 'off', readOnly: false,
            revision: 0, secretCount: 0 },
        ] }
      }
      if (endpoint === 'mail-account-list') {
        return { available: true, accounts: [
          { id: 'gmail', address: 'person@gmail.com', provider: 'gmail', state: 'ready', revision: 1 },
          { id: 'custom', address: 'person@example.test', provider: 'other', state: 'ready', revision: 1 },
        ], rule: { mode: 'require-approval', recipients: [] },
        replies: replyPending ? [{ replyId: 'reply-1', status: 'pending-approval',
          to: 'sender@example.test', cc: '', subject: 'Re: question', body: 'A durable draft.' }] : [],
        target }
      }
      if (endpoint === 'mail-search') return { target, items: [{ uid: '7', folder: 'INBOX',
        from: 'sender@example.test', to: 'person@gmail.com', subject: 'Question',
        date: '2026-11-20T00:00:00.000Z' }] }
      if (endpoint === 'mail-reply-send') {
        assert.equal(payload.commandId, 'mail-reply-send:reply-1')
        replyPending = false
        return { replyId: 'reply-1', status: 'sent', to: 'sender@example.test', cc: '',
          subject: 'Re: question', body: 'A durable draft.' }
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const root = createRoot(dom.window.document.querySelector('#root'))
    const click = async button => React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const change = async (input, value) => React.act(async () => {
      input.value = value
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    function Harness() {
      const [activeTarget, setActiveTarget] = React.useState(target)
      return React.createElement(ProductConnectorsSettings, {
        call, target: activeTarget, onTargetChange: setActiveTarget, instanceId: 'personal',
      })
    }
    try {
      await React.act(async () => {
        root.render(React.createElement(Harness))
        await new Promise(resolve => setTimeout(resolve, 30))
      })
      assert.match(dom.window.document.body.textContent, /Connectors and mailbox/u)
      assert.equal(calls.some(call => call.endpoint === 'feishu-status'), true)
      assert.equal(calls.every(call => !call.endpoint.startsWith('/api/bot')), true)
      assert.equal([...dom.window.document.querySelectorAll('.pc-card')]
        .some(card => card.textContent.includes('Mailbox')), false)

      const exa = [...dom.window.document.querySelectorAll('.pc-card')]
        .find(card => card.textContent.includes('Exa'))
      await click([...exa.querySelectorAll('button')].find(button => button.textContent === 'Connect'))
      assert.ok(calls.some(call => call.endpoint === 'connector-save' && call.payload.connectorId === 'exa'))

      await click([...dom.window.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Use Feishu source'))
      const source = [...dom.window.document.querySelectorAll('input')]
        .find(input => input.placeholder === 'Exact source Instance when required')
      assert.equal(source.value, 'feishu:tenant:chat:app:cli_fixture')

      await click([...dom.window.document.querySelectorAll('[role=tab]')]
        .find(button => button.textContent === 'Mailbox'))
      const provider = dom.window.document.querySelector('select[name=provider]')
      await change(provider, 'other')
      assert.ok(dom.window.document.querySelector('input[name=imapHost]'))
      assert.ok(dom.window.document.querySelector('input[name=smtpHost]'))
      assert.match(dom.window.document.body.textContent, /A durable draft\./u)

      const account = [...dom.window.document.querySelectorAll('select')]
        .find(select => [...select.options].some(option => option.textContent.includes('person@gmail.com')))
      await change(account, 'gmail')
      await click([...dom.window.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Search'))
      assert.ok(calls.some(call => call.endpoint === 'mail-search' && call.payload.accountId === 'gmail'))

      await click([...dom.window.document.querySelectorAll('button')]
        .find(button => button.textContent === 'Send'))
      assert.equal(replyPending, false)
      assert.equal(dom.window.document.body.textContent.includes('A durable draft.'), false)
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
