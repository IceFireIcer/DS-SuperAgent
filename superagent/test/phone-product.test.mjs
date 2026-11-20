import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'
import { createProductHost } from '../dist/index.js'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair,
  parsePairingUri, randomToken, startRelayServer } from '../dist/phone-link-api.js'

async function until(read) {
  const deadline = Date.now() + 5000
  do {
    const result = await read()
    if (result) return result
    await sleep(25)
  } while (Date.now() < deadline)
  assert.fail('The phone and Host did not reach the expected state.')
}

function phone(offer, name) {
  const keys = generateKeyPair()
  const self = { ...keys, deviceId: deviceIdFor(keys.publicKey) }
  const accessToken = randomToken()
  const makeConnection = (pairingCode) => {
    const transport = new RelayTransport(offer.server, { deviceId: self.deviceId, identityKey: self.publicKey,
      accessToken, targetDeviceId: offer.hostDeviceId, handshakeTimeoutMs: 1500 })
    return new RpcClient(new SecureTransport(transport, self, { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }, {
      handshakeTimeoutMs: 1500, hello: { name, ...(pairingCode ? { pairingCode } : {}) },
    }), 1800)
  }
  return { makeConnection, id: self.deviceId }
}

test('a paired phone reaches Main through encrypted link, with explicit send permission and revocation', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-superagent-phone-'))
  const workspaceRoot = join(root, 'work')
  const stateRoot = join(root, 'state')
  await Promise.all([mkdir(workspaceRoot), mkdir(stateRoot)])
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('The phone reached Main.'))
  const relay = await startRelayServer()
  const connections = []
  let host
  t.after(async () => {
    for (const client of connections) await client.close()
    await host?.close()
    await relay.close()
    await native.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await native.plugin(LocalCredentials, { path: join(root, 'credentials.yaml'), watch: false })
  const instanceId = 'personal'
  const config = { instanceId, actorId: 'owner', workspaceRoot, databasePath: join(stateRoot, 'business.sqlite'),
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } }
  host = await createProductHost(native, config)
  const local = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId, ...payload })
  const rpc = (client, endpoint, payload = {}) => client.rpc('product', { endpoint, payload })
  const link = async () => until(async () => (await local('phone-status')).status === 'online')
  const connect = async command => {
    const { pairing } = await local('phone-pair', command ? { command } : {})
    assert.equal(pairing?.qrImage.startsWith('data:image/png;base64,'), true)
    const offer = parsePairingUri(pairing.uri)
    const device = phone(offer, command ? 'Writer' : 'Reader')
    const client = device.makeConnection(offer.code)
    connections.push(client)
    await client.connect()
    assert.equal((await local('phone-status')).pairing, null)
    return { ...device, client }
  }

  await assert.rejects(local('phone-set', { on: true }), { code: 'INVALID_INPUT' })
  await local('phone-set', { server: relay.url, on: true })
  await link()
  const reader = await connect(false)
  assert.equal((await rpc(reader.client, 'open')).instanceId, instanceId)
  assert.equal((await local('phone-status')).phones.find(item => item.id === reader.id).command, false)
  const send = { instanceId, commandId: 'from-phone', text: 'Please acknowledge this phone message.' }
  await assert.rejects(rpc(reader.client, 'send', send), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(rpc(reader.client, 'phone-status', { instanceId }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(rpc(reader.client, 'history', { instanceId: 'wrong' }), { code: 'SOURCE_NOT_AUTHORIZED' })

  const writer = await connect(true)
  await assert.rejects(rpc(writer.client, 'send', { ...send, attachments: ['local-ref'] }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await rpc(writer.client, 'send', send)
  const history = await until(async () => {
    const result = await local('history')
    return result.messages.some(item => item.text === 'The phone reached Main.') && result
  })
  assert.equal(history.messages.filter(item => item.text === send.text).length, 1)
  assert.ok((await rpc(writer.client, 'history', { instanceId })).messages.some(item => item.text === send.text))

  const closed = new Promise(resolve => writer.client.onClose(resolve))
  await local('phone-remove', { id: writer.id })
  await closed
  await assert.rejects(rpc(writer.client, 'send', { ...send, commandId: 'after-revoke' }))
  const revoked = writer.makeConnection()
  connections.push(revoked)
  await assert.rejects(revoked.connect())
  await reader.client.close()

  await host.close()
  host = await createProductHost(native, config)
  await link()
  const restored = reader.makeConnection()
  connections.push(restored)
  await restored.connect()
  assert.equal((await rpc(restored, 'open')).instanceId, instanceId)
  assert.deepEqual((await local('phone-status')).phones.map(item => item.id), [reader.id])
})
