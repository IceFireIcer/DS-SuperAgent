import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { RemoteProductClient } from '../../app/src/remote-product-client.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'r5-product-client-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'r5-product-client-workspace-'))
  const native = await nativeContext(join(directory, 'sessions'), function* (request) {
    if (request.model !== 'main') throw new Error('Only Main may answer the client.')
    yield* textResponse('The same Main is here.')
  })
  const product = await createProductHost(native, {
    databasePath: join(directory, 'business.sqlite'), instanceId: 'personal', workspaceRoot,
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' }, clientGateway: { port: 0 },
  })
  t.after(async () => {
    await product.close(); await native.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  })
  return { product, address: product.clientGateway.url }
}

async function direct(address, token, path, body) {
  const response = await fetch(`${address}/instances/personal/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

test('an authorized desktop reconnects to the same Main and catches up without replaying commands', { timeout: 60000 }, async t => {
  const { product, address } = await fixture(t)
  const first = await product.clients.enroll({ commandId: 'enroll-one', label: 'Desktop one',
    grants: [{ instanceId: 'personal', capabilities: ['read', 'command'] }] })
  const second = await product.clients.enroll({ commandId: 'enroll-two', label: 'Desktop two',
    grants: [{ instanceId: 'personal', capabilities: ['read', 'command'] }] })
  const client = new RemoteProductClient()
  const snapshot = await client.connect({ address, instanceId: 'personal', credential: first.token })
  assert.equal(snapshot.binding.mainId, (await product.dispatch('open')).mainId)
  assert.equal(snapshot.history.messages.length, 0)
  assert.equal(client.status().capabilities.includes('command'), true)
  assert.equal(JSON.stringify(client.status()).includes(first.token), false)
  await product.clients.record([{ key: 'legacy:private-ticket', kind: 'state', ticketId: 'private-ticket',
    data: { private: 'Legacy Ticket details must not enter the product feed.' } }])

  const command = { instanceId: 'personal', commandId: 'same-id', text: 'Stay with this conversation.' }
  const reply = await client.call('send', command)
  assert.equal(reply.status, 'completed')
  assert.deepEqual(await client.call('send', command), reply)
  const otherClient = new RemoteProductClient()
  await otherClient.connect({ address, instanceId: 'personal', credential: second.token })
  await otherClient.call('send', { ...command, text: 'I am another authorized client.' })
  const history = await client.call('history', { instanceId: 'personal' })
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.text),
    ['Stay with this conversation.', 'I am another authorized client.'])
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.source),
    [{ kind: 'client', clientId: first.client.id }, { kind: 'client', clientId: second.client.id }])
  const events = await client.events()
  assert.ok(events.some(event => event.kind === 'main'))
  assert.ok(events.some(event => event.kind === 'product-receipt'))
  assert.equal(events.some(event => event.key === 'legacy:private-ticket'), false)
  assert.deepEqual(await client.events(), [])
  await assert.rejects(client.call('work-stop', { instanceId: 'personal', commandId: 'stop-guessed',
    workItemId: 'guessed', ticketId: 'guessed', expectedTicketVersion: 1, reason: 'No work exists.' }),
  error => error.code === 'NOT_FOUND')
  await assert.rejects(client.call('work-answer', { instanceId: 'personal', commandId: 'answer-guessed',
    workItemId: 'guessed', ticketId: 'guessed', expectedGeneration: 'guessed', attentionId: 'guessed',
    attentionVersion: 1, text: 'No.' }), error => error.code === 'NOT_FOUND')
  client.disconnect()
  assert.equal(client.status().connected, false)
  const reconnected = await client.connect({ address, instanceId: 'personal', credential: first.token })
  assert.deepEqual(reconnected.binding, snapshot.binding)
  assert.equal(reconnected.history.messages.length, history.messages.length)
  assert.equal((await product.dispatch('history', { instanceId: 'personal' })).messages.length, history.messages.length,
    'disconnecting a desktop does not close the product Host')
})

test('read-only client routes cannot write, guessed routes cannot bypass product access, and revocation applies immediately', { timeout: 60000 }, async t => {
  const { product, address } = await fixture(t)
  const viewer = await product.clients.enroll({ commandId: 'viewer', label: 'Observer',
    grants: [{ instanceId: 'personal', capabilities: ['read'] }] })
  const client = new RemoteProductClient()
  await client.connect({ address, instanceId: 'personal', credential: viewer.token })
  assert.deepEqual((await client.call('observe-list', { instanceId: 'personal' })).items, [])
  await assert.rejects(client.call('send', { instanceId: 'personal', commandId: 'blocked', text: 'No.' }), /not authorized/u)
  for (const endpoint of ['send', 'stop-main', 'work-stop', 'work-answer', 'work-resume', 'work-retry', 'reconcile-delivery']) {
    assert.equal((await direct(address, viewer.token, `product/${endpoint}`, { instanceId: 'personal', commandId: 'no' })).status, 403)
  }
  assert.equal((await direct(address, viewer.token, 'product/settings-save', {})).status, 404)
  assert.equal((await direct(address, viewer.token, 'product/client-enroll', {})).status, 404)
  assert.equal((await direct(address, viewer.token, 'product/client-revoke', {})).status, 404)
  assert.equal((await direct(address, viewer.token, 'product/schedule-list', { instanceId: 'personal' })).status, 404)
  assert.equal((await direct(address, viewer.token, 'product/schedule-create', { instanceId: 'personal' })).status, 404)
  assert.equal((await direct(address, viewer.token, 'commands/submit', {})).status, 404)
  assert.equal((await direct(address, viewer.token, 'product/observe-read', { instanceId: 'personal', observationId: 'guessed', text: 'write' })).status, 400)
  const other = await fetch(`${address}/instances/other/product/snapshot`, { headers: { authorization: `Bearer ${viewer.token}` } })
  assert.equal(other.status, 403)
  await product.clients.revoke({ commandId: 'revoke-viewer', clientId: viewer.client.id, reason: 'Access withdrawn.' })
  assert.equal((await direct(address, viewer.token, 'product/snapshot')).status, 401)
  await assert.rejects(client.events(), error => error.code === 'CLIENT_REVOKED')
  assert.equal((await direct(address, viewer.token, 'product/send', { instanceId: 'personal', commandId: 'no' })).status, 401)
})

test('a snapshot cursor replays a fact committed during the snapshot window', { timeout: 30000 }, async t => {
  const { product, address } = await fixture(t)
  const viewer = await product.clients.enroll({ commandId: 'cursor-viewer', label: 'Observer',
    grants: [{ instanceId: 'personal', capabilities: ['read'] }] })
  const dispatch = product.dispatch.bind(product)
  let committed = false
  product.dispatch = async (endpoint, payload, client) => {
    const result = await dispatch(endpoint, payload, client)
    if (endpoint === 'history' && !committed) {
      committed = true
      await product.clients.record([{ key: 'main:during-snapshot', kind: 'main', data: { id: 'during-snapshot' } }])
    }
    return result
  }
  const client = new RemoteProductClient()
  await client.connect({ address, instanceId: 'personal', credential: viewer.token })
  const events = await client.events()
  assert.equal(events.filter(event => event.key === 'main:during-snapshot').length, 1)
  assert.deepEqual(await client.events(), [])
  await assert.rejects(client.call('settings', { instanceId: 'personal' }), /not authorized/u)
  await assert.rejects(new RemoteProductClient().connect({ address: 'http://example.com:8080', instanceId: 'personal', credential: viewer.token }),
    /HTTPS Host/u)
})

test('trusted local settings issue and revoke a credential while the remote gateway stays online', { timeout: 30000 }, async t => {
  const { product, address } = await fixture(t)
  const enrollment = { instanceId: 'personal', commandId: 'client-enroll-1', label: 'Travel laptop', capabilities: ['read', 'command'] }
  const issued = await product.dispatch('client-enroll', enrollment)
  assert.match(issued.token, /^sc1\./u)
  assert.equal((await product.dispatch('client-enroll', enrollment)).token, undefined, 'the credential is shown once')
  const listed = await product.dispatch('clients-list', { instanceId: 'personal' })
  assert.equal(listed[0].id, issued.client.id)
  assert.equal(JSON.stringify(listed).includes(issued.token), false)
  const client = new RemoteProductClient()
  await client.connect({ address, instanceId: 'personal', credential: issued.token })
  assert.equal((await direct(address, issued.token, 'product/clients-list', { instanceId: 'personal' })).status, 404)
  const revoked = await product.dispatch('client-revoke', { instanceId: 'personal', commandId: 'client-revoke-1',
    clientId: issued.client.id, reason: 'The operator revoked this client.' })
  assert.equal(revoked.id, issued.client.id)
  await assert.rejects(client.call('history', { instanceId: 'personal' }), error => error.code === 'CLIENT_REVOKED')
  await assert.rejects(client.call('send', { instanceId: 'personal', commandId: 'after-revocation', text: 'No.' }),
    error => error.code === 'CLIENT_REVOKED')
})
