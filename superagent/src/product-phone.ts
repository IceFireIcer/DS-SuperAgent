import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { toDataURL } from 'qrcode'
import type { ClientIdentity } from './client-access.js'
import { CoreError, identifier } from './model.js'
import { DeviceRegistry, HostLink, LINK_PATH, deviceIdFor, generateKeyPair, pairingUri, randomToken,
  type PairedDevice, type DeviceIdentity, type HandshakeHello } from './phone-link/src/index.js'
import type { ProductCredentialVault } from './product-credential-vault.js'
import type { AsyncTx, Storage } from './storage.js'

const reads = new Set(['open', 'history', 'work-board'])
type PhoneDevice = PairedDevice & { command: boolean }
interface PhoneSettings { on: boolean; server: string; identityRef?: string; phones: PhoneDevice[] }
type PhoneIdentity = DeviceIdentity & { accessToken: string }

export const phoneFields: Record<string, readonly string[]> = {
  'phone-status': ['instanceId'], 'phone-set': ['instanceId', 'server', 'on'],
  'phone-pair': ['instanceId', 'command'], 'phone-pair-cancel': ['instanceId'], 'phone-remove': ['instanceId', 'id'],
}

function relayUrl(value: unknown) {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 512) throw new CoreError('INVALID_INPUT', 'Enter a relay server URL.')
  let parsed: URL
  try { parsed = new URL(value.trim()) } catch { throw new CoreError('INVALID_INPUT', 'Enter a relay server URL.') }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && loopback) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CoreError('INVALID_INPUT', 'Use a WSS relay or a loopback WS relay.')
  }
  if (parsed.pathname === '/') parsed.pathname = LINK_PATH
  return parsed.href
}

export class ProductPhone {
  private state: PhoneSettings = { server: '', on: false, phones: [] }
  private registry = new DeviceRegistry()
  private identity: PhoneIdentity | undefined
  private link: HostLink | undefined
  private pairing: { command: boolean; qrImage: string; uri: string; expiresAt: number } | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly vault: ProductCredentialVault, private readonly call: (endpoint: string, payload: Record<string, unknown>,
      client: ClientIdentity, authorizeSend?: (tx: AsyncTx) => Promise<void>) => Promise<unknown>) {}

  private serial<Result>(action: () => Promise<Result>) {
    const task = this.tail.then(action)
    this.tail = task.catch(() => {})
    return task
  }

  private async save(state: PhoneSettings) {
    await this.storage.transaction(this.instanceId, async tx => {
      if (!await tx.replace('phone-link-settings', 'link', state)) await tx.insert('phone-link-settings', 'link', state)
    })
    this.state = state
  }

  async restore() {
    const saved = await this.storage.transaction(this.instanceId, tx => tx.get<PhoneSettings>('phone-link-settings', 'link'))
    if (saved) this.state = saved
    this.registry = new DeviceRegistry(this.state.phones)
    if (this.state.on) await this.start()
  }

  private async start() {
    this.link = undefined
    this.identity = undefined
    if (!this.state.on || !this.state.server || this.closed) return
    if (!this.state.identityRef) {
      const keys = generateKeyPair()
      const identity: PhoneIdentity = { ...keys, deviceId: deviceIdFor(keys.publicKey), accessToken: randomToken() }
      const identityRef = await this.vault.create(this.instanceId, JSON.stringify(identity), `phone-identity:${randomUUID()}`)
      try { await this.save({ ...this.state, identityRef }) }
      catch (error) { await this.vault.ensureRevoked(this.instanceId, identityRef).catch(() => {}); throw error }
    }
    const identity = await this.vault.withSecret(this.instanceId, this.state.identityRef!, async secret => JSON.parse(secret) as PhoneIdentity)
    this.identity = identity
    this.link = new HostLink({ url: this.state.server, identity, accessToken: identity.accessToken, name: hostname().slice(0, 64),
      admits: (id, key) => this.registry.admits(id, key), authorize: (id, key, hello) => this.authorize(id, key, hello),
      handle: (method, params, { deviceId, signal }) => this.receive(method, params, deviceId, signal) })
    this.link.start()
  }

  private authorize(deviceId: string, identityKey: string, hello: HandshakeHello) {
    return this.serial(async () => {
      if (this.closed || !this.state.on) return false
      const existing = this.state.phones.find(phone => phone.deviceId === deviceId)
      if (existing) return existing.identityKey === identityKey
      if (this.state.phones.length >= 16 || !this.pairing || !this.registry.authorize(deviceId, identityKey, hello)) return false
      const entry = this.registry.list().find(phone => phone.deviceId === deviceId)
      if (!entry) return false
      const command = this.pairing.command
      this.pairing = undefined
      try { await this.save({ ...this.state, phones: [...this.state.phones, { ...entry, command }] }) }
      catch { this.registry.revoke(deviceId); return false }
      return true
    })
  }

  private async receive(method: string, params: unknown, id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const device = this.state.phones.find(phone => phone.deviceId === id)
    if (!this.state.on || !device || this.closed || method !== 'product' || !params || typeof params !== 'object') {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The phone is not authorized for this operation.')
    }
    const { endpoint, payload } = params as { endpoint?: string; payload?: Record<string, unknown> }
    if (typeof endpoint !== 'string' || !reads.has(endpoint) && !(device.command && endpoint === 'send')
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || (endpoint === 'open' ? Object.keys(payload).length !== 0 : payload.instanceId !== this.instanceId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The phone request is outside its allowed product scope.')
    }
    if (endpoint === 'send' && Object.keys(payload).some(key => !['instanceId', 'commandId', 'text'].includes(key))) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A phone message accepts text only.')
    }
    await this.storage.transaction(this.instanceId, async () => {})
    signal.throwIfAborted()
    if (!this.state.on || !this.state.phones.includes(device)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The phone was revoked.')
    const authorizeSend = async (tx: AsyncTx) => {
      signal.throwIfAborted()
      const current = await tx.get<PhoneSettings>('phone-link-settings', 'link')
      if (!current?.on || !current.phones.some(phone => phone.deviceId === id && phone.identityKey === device.identityKey
        && phone.pairedAt === device.pairedAt && phone.command)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The phone no longer has permission to send messages.')
      }
      signal.throwIfAborted()
    }
    try {
      return await this.call(endpoint, payload, { id: `phone:${id}`, label: device.name,
        grants: [{ instanceId: this.instanceId, capabilities: device.command ? ['read', 'command'] : ['read'] }], createdAt: device.pairedAt },
      endpoint === 'send' ? authorizeSend : undefined)
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('UNAVAILABLE', 'The Host could not complete this phone request.')
    }
  }

  private view() {
    if (!this.registry.pairingOpen()) this.pairing = undefined
    const connected = new Set(this.link?.connectedDevices() ?? [])
    return { on: this.state.on, server: this.state.server, status: this.link?.status ?? 'off',
      phones: this.state.phones.map(phone => ({ id: phone.deviceId, name: phone.name, pairedAt: phone.pairedAt,
        command: phone.command, connected: connected.has(phone.deviceId) })),
      pairing: this.pairing ? { qrImage: this.pairing.qrImage, uri: this.pairing.uri, expiresAt: this.pairing.expiresAt } : null }
  }

  dispatch(endpoint: string, payload: Record<string, unknown>) {
    return this.serial(async () => {
      if (this.closed) throw new CoreError('UNAVAILABLE', 'Phone access is stopped.')
      if (endpoint === 'phone-set') {
        if (payload.on !== undefined && typeof payload.on !== 'boolean') throw new CoreError('INVALID_INPUT', 'Choose whether phone access is on.')
        const server = payload.server === undefined ? this.state.server : relayUrl(payload.server)
        const on = payload.on === undefined ? this.state.on : payload.on as boolean
        if (on && !server) throw new CoreError('INVALID_INPUT', 'Save the relay server before enabling phone access.')
        await this.save({ ...this.state, server, on })
        this.registry.closePairing(); this.pairing = undefined
        await this.link?.stop()
        await this.start()
      } else if (endpoint === 'phone-pair') {
        if (payload.command !== undefined && typeof payload.command !== 'boolean') throw new CoreError('INVALID_INPUT', 'Choose the phone access level.')
        if (this.link?.status !== 'online' || !this.identity) throw new CoreError('UNAVAILABLE', 'Connect the Host to its relay first.')
        if (this.state.phones.length >= 16) throw new CoreError('INVALID_INPUT', 'Remove a phone before pairing another one.')
        const { code, expiresAt } = this.registry.openPairing()
        const uri = pairingUri({ server: this.state.server, hostDeviceId: this.identity.deviceId,
          hostKey: this.identity.publicKey, code, name: hostname().slice(0, 64) })
        this.pairing = { qrImage: await toDataURL(uri, { errorCorrectionLevel: 'M', width: 256 }), uri, expiresAt, command: payload.command === true }
      } else if (endpoint === 'phone-pair-cancel') {
        this.registry.closePairing(); this.pairing = undefined
      } else if (endpoint === 'phone-remove') {
        identifier(payload.id, 'id')
        const phones = this.state.phones.filter(phone => phone.deviceId !== payload.id)
        if (phones.length === this.state.phones.length) throw new CoreError('NOT_FOUND', 'This phone is not paired.')
        await this.save({ ...this.state, phones })
        this.registry.revoke(payload.id)
        this.link?.disconnect(payload.id)
      }
      return this.view()
    })
  }

  async close() {
    this.closed = true
    this.registry.closePairing()
    this.pairing = undefined
    await this.link?.stop()
    await this.tail
    this.identity = undefined
    this.link = undefined
  }
}
