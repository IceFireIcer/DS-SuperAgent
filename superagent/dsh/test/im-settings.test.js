import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ProductImSettings } from '../src/client/im-settings.js'

test('IM settings sign in, approve a scoped pairing and manage a local WeChat QR', async () => {
  const { window } = new JSDOM('<main></main>', { url: 'https://product.invalid/' })
  const { document } = window
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true })
  let refresh
  window.setInterval = callback => { refresh = callback; return 1 }
  window.clearInterval = () => { refresh = undefined }
  const root = createRoot(document.querySelector('main'))
  const calls = []
  const accounts = ['feishu', 'dingtalk', 'wecom', 'qq', 'wechat', 'discord', 'slack', 'telegram']
    .map(platform => ({ platform, state: 'disconnected', configured: false, paired: false,
      fields: platform === 'wechat' ? [] : [{ name: 'token', label: 'Bot token', secret: true }] }))
  const call = async (endpoint, payload) => {
    assert.equal(endpoint, 'im-accounts')
    assert.equal(payload.instanceId, 'profile')
    calls.push(payload)
    if (payload.operation === 'list') return { accounts: accounts.map(account => ({ ...account })) }
    const account = accounts.find(view => view.platform === payload.platform)
    if (payload.operation === 'connect') {
      Object.assign(account, { state: 'connected', configured: true })
    } else if (payload.operation === 'pair-start') {
      account.pairing = { expiresAt: Date.now() + 100_000 }
      return { code: '87654321', expiresAt: account.pairing.expiresAt }
    } else if (payload.operation === 'pair-approve') {
      account.paired = true
      delete account.pairing
    } else if (payload.operation === 'qr-start') {
      Object.assign(account, { qrState: 'waiting', qrExpiresAt: Date.now() + 100_000 })
      return { qrImage: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: account.qrExpiresAt }
    } else if (payload.operation === 'qr-cancel') {
      delete account.qrState
      delete account.qrExpiresAt
    } else {
      assert.fail(`Unexpected platform operation ${payload.operation}`)
    }
    return { ...account }
  }
  const click = async label => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === label)
    assert.ok(button, `Missing ${label}`)
    await act(async () => button.click())
  }
  const select = async value => {
    const select = document.querySelector('select')
    await act(async () => {
      select.value = value
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(h(ProductImSettings, { binding: { instanceId: 'profile' }, call })))
    assert.deepEqual([...document.querySelector('select').options].map(option => option.value), accounts.map(account => account.platform))
    await select('telegram')
    const credential = document.querySelector('input[type=password]')
    credential.value = 'mock-im-value'
    await click('Connect')
    assert.deepEqual(calls.find(request => request.operation === 'connect').credentials, { token: 'mock-im-value' })
    assert.equal(credential.value, '')
    assert.doesNotMatch(document.body.textContent, /mock-im-value/u)
    await click('Start pairing')
    assert.equal(document.querySelector('code').textContent, 'pair 87654321')
    const telegram = accounts.find(account => account.platform === 'telegram')
    telegram.pairing = { ...telegram.pairing, senderId: '42', proposalId: 'candidate' }
    await act(async () => refresh())
    assert.equal(document.querySelector('code'), null)
    await click('Approve pairing')
    assert.equal(calls.find(request => request.operation === 'pair-approve').proposalId, 'candidate')
    assert.match(document.body.textContent, /Paired/u)
    await select('wechat')
    await click('Start WeChat sign-in')
    assert.equal(document.querySelector('img').alt, 'WeChat sign-in QR code')
    await click('Cancel sign-in')
    assert.equal(document.querySelector('img'), null)
    assert.equal(window.localStorage.length, 0)
    assert.equal(window.sessionStorage.length, 0)
  } finally {
    await act(async () => root.unmount())
    globals.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index])
      else delete globalThis[key]
    })
    window.close()
  }
})
