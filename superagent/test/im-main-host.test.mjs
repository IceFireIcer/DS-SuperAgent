import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

async function waitFor(read) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(25)
  }
  throw new Error('The messaging contract did not settle.')
}

test('a paired messaging account delivers an isolated Main turn and replies to the same chat', { timeout: 30000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'ds-im-host-'))
  const state = join(root, 'state')
  const workspaceRoot = join(root, 'work')
  await Promise.all([mkdir(state), mkdir(workspaceRoot)])
  const privateText = 'Use the local conversation to discuss my private draft.'
  const messageText = 'Is the IM connection ready?'
  const reply = 'The paired connection is ready.'
  const observed = []
  const native = await nativeContext(join(state, 'sessions'), options => {
    const messages = JSON.stringify(options.messages)
    if (!messages.includes(messageText)) return textResponse('Private Main reply.')
    observed.push(messages.includes(privateText))
    return textResponse(reply)
  })
  await native.plugin(LocalCredentials, { path: join(state, 'credentials.yaml'), watch: false })
  const received = []
  const sent = []
  let host
  context.after(async () => {
    await host?.close()
    await native.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  host = await createProductHost(native, { databasePath: join(state, 'business.sqlite'), workspaceRoot, instanceId: 'personal', actorId: 'owner',
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    im: { fetch: async (url, request) => {
      const verb = new URL(url).pathname.split('/').at(-1)
      const input = JSON.parse(request.body)
      if (verb === 'getMe') return Response.json({ ok: true, result: { id: 17, is_bot: true } })
      if (verb === 'getUpdates') return Response.json({ ok: true, result: received.filter(update => update.update_id >= input.offset) })
      assert.equal(verb, 'sendMessage')
      sent.push(input)
      return Response.json({ ok: true, result: { message_id: 123 } })
    } },
  })
  const active = { instanceId: 'personal' }
  const call = (operation, data = {}) => host.dispatch('im-accounts', { ...active, operation, platform: 'telegram', ...data })
  const status = async () => (await host.dispatch('im-accounts', { ...active, operation: 'list' })).accounts.find(item => item.platform === 'telegram')
  function inbound(sender, text) {
    const messageId = received.length + 1
    received.push({ update_id: messageId, message: { message_id: messageId, from: { id: sender, is_bot: false },
      chat: { id: sender, type: 'private' }, text } })
  }
  await host.dispatch('send', { ...active, commandId: 'private-note', text: privateText })
  await assert.rejects(host.dispatch('im-accounts', { ...active, operation: 'list' }, { id: 'remote', grants: [] }),
    { code: 'SOURCE_NOT_AUTHORIZED' })
  const reader = { id: 'remote', grants: [{ instanceId: 'personal', capabilities: ['read'] }] }
  const remote = await host.dispatch('im-accounts', { ...active, operation: 'list' }, reader)
  assert.equal(remote.accounts.length, 8)
  assert.deepEqual(Object.keys(remote.accounts[0]).sort(), ['configured', 'paired', 'platform', 'state'])
  await assert.rejects(host.dispatch('im-accounts', { ...active, operation: 'pair-start', platform: 'telegram' }, reader),
    { code: 'SOURCE_NOT_AUTHORIZED' })
  await call('connect', { credentials: { botToken: ['4242', 'fixture'.repeat(5)].join(':') } })
  await waitFor(async () => (await status()).state === 'connected')
  const pairing = await call('pair-start')
  const challenge = pairing.pairing ?? pairing
  inbound(42, `pair ${challenge.code}`)
  const candidate = await waitFor(async () => {
    const { pairing: current } = await status()
    return current?.senderId === '42' && current
  })
  await call('pair-approve', { proposalId: candidate.proposalId })
  inbound(77, 'Message from another chat.')
  inbound(42, messageText)
  await waitFor(() => sent.length).catch(async error => {
    const timeline = await host.dispatch('history', active)
    const effects = timeline.sources?.map(source => ({ state: source.state, error: source.lastError,
      deliveries: source.deliveries.map(delivery => ({ state: delivery.state, reason: delivery.reason })) }))
    throw new Error(`The paired reply did not settle. ${JSON.stringify(effects)}`, { cause: error })
  })
  assert.deepEqual(observed, [false])
  assert.equal(sent.length, 1)
  assert.equal(String(sent[0].chat_id), '42')
  assert.equal(sent[0].text, reply)
  const history = await host.dispatch('history', active)
  assert.equal(history.messages.filter(message => message.source?.kind === 'im' && message.text === messageText).length, 1)
  assert.ok(history.messages.some(message => message.text === reply))
  assert.equal(history.messages.some(message => message.text === 'Message from another chat.'), false)
})
