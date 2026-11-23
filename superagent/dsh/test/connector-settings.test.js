import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { ConnectorSettings } from '../src/client/connector-settings.js'

test('connector and mailbox settings submit Main-scoped product requests and hold replies for confirmation', async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/' })
  const view = dom.window
  const previous = { window: globalThis.window, document: globalThis.document,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: view, document: view.document, HTMLElement: view.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  let root
  try {
    const { createRoot } = await import('react-dom/client')
    const calls = []
    let github = { provider: 'github', state: 'not-configured', hasClientSecret: false, revision: 0, authorization: null,
      redirectUri: 'http://127.0.0.1:53682/superagent/oauth/callback' }
    const mailbox = { id: 'mailbox', email: 'reader@example.com', label: 'Inbox account', revision: 1 }
    const call = async (endpoint, input) => {
      calls.push({ endpoint, input })
      assert.equal(input.instanceId, 'bound-instance')
      assert.deepEqual(input.scope, { role: 'main' })
      if (endpoint === 'connector-registry') return { items: [github], canStoreCredentials: true, canImport: false }
      if (endpoint === 'connector-save') {
        github = { ...github, state: 'configured', hasClientSecret: true, revision: 1, clientId: input.clientId }
        return github
      }
      if (endpoint === 'connector-auth') return { provider: 'github', loginId: 'sample-login', state: 'pending',
        expiresAt: Date.now() + 60_000, openUrl: 'http://127.0.0.1:53682/superagent/oauth/open/11d05b1a-7e29-48a9-a5bf-5ca2a41c631c' }
      if (endpoint === 'mailbox-account') return { items: [mailbox], canStoreCredentials: true }
      if (endpoint === 'mailbox-rule') return { items: [] }
      if (endpoint === 'mailbox-reply' && input.action === 'inbox') return { items: [{ key: 'opaque-message', subject: 'Fixture message',
        from: 'sender@example.com', replyTo: 'reply@example.com', receivedAt: null, preview: '<i>Message text</i>', rules: [], canReply: true }] }
      if (endpoint === 'mailbox-reply' && input.action === 'send') return { status: 'sent' }
      throw new Error('Unexpected product request.')
    }
    const main = view.document.querySelector('main')
    const button = name => [...main.querySelectorAll('button')].find(node => node.textContent === name)
    const input = label => [...main.querySelectorAll('label')].find(node => node.textContent.startsWith(label))?.querySelector('input,textarea')
    const click = async name => {
      const node = button(name)
      assert.ok(node, `Missing ${name}`)
      await act(async () => node.click())
    }
    const enter = async (node, value) => {
      assert.ok(node)
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value)
        node.dispatchEvent(new view.Event('input', { bubbles: true }))
      })
    }

    root = createRoot(main)
    await act(async () => root.render(createElement(ConnectorSettings, { binding: { instanceId: 'bound-instance' }, call })))
    assert.equal(button('Authorize').disabled, true)
    await click('Configure OAuth')
    await enter(input('OAuth client ID'), 'fixture_app_id')
    const secret = input('OAuth client secret')
    assert.equal(secret.type, 'password')
    await enter(secret, 'fixture-app-secret')
    await click('Save')
    const saved = calls.find(item => item.endpoint === 'connector-save').input
    assert.equal(saved.clientId, 'fixture_app_id')
    assert.equal(saved.clientSecret, 'fixture-app-secret')
    assert.equal(saved.expectedRevision, 0)
    assert.equal(main.innerHTML.includes('fixture-app-secret'), false)
    await click('Authorize')
    assert.ok(main.querySelector('a[href^="http://127.0.0.1:"]'))
    await click('Mailbox')
    await click('Refresh inbox')
    assert.equal(main.querySelector('i'), null)
    assert.ok(main.textContent.includes('<i>Message text</i>'))
    await click('Reply')
    assert.ok(main.textContent.includes('reply@example.com'))
    await enter(input('Reply text'), 'Fixture reply.')
    await click('Review reply')
    assert.equal(calls.some(({ input: body }) => body.action === 'send'), false)
    await click('Confirm send reply')
    const reply = calls.find(({ input: body }) => body.action === 'send')
    assert.equal(reply.endpoint, 'mailbox-reply')
    assert.equal(reply.input.messageKey, 'opaque-message')
    assert.equal(reply.input.text, 'Fixture reply.')
    assert.equal(Object.hasOwn(reply.input, 'to'), false)
    assert.ok(main.textContent.includes('Reply sent.'))
  } finally {
    if (root) await act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, previous)
  }
})
