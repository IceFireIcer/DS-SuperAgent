import { createHash, randomUUID } from 'node:crypto'
import { ImServiceError, redactSecretText, retryDelay, retryable, safeError } from './errors.js'
import { IM_PLATFORMS, adapters as builtInAdapters, platformById } from './platforms/index.js'
import { IM_SOURCE_INSTANCE_ID, imRequesterId, imThreadId, parseImThread, type ImThreadRoute } from './main.js'
import { IM_PLATFORM_IDS } from './types.js'
import type {
  ImAccount,
  ImAdapter,
  ImAdapterConnection,
  ImAdapterEnvironment,
  ImButton,
  ImChat,
  ImChatView,
  ImConnectionState,
  ImConnectionView,
  ImFailedSendView,
  ImInbound,
  ImInboundResult,
  ImLoginStartView,
  ImLoginWaitView,
  ImLoginStart,
  ImLoginWait,
  ImMainEvent,
  ImMainSink,
  ImPairRequestView,
  ImPairingView,
  ImPlatformDescriptor,
  ImPlatformId,
  ImPersistence,
  ImRegistryView,
  ImRetryView,
  ImSendView,
  ImSocketConstructor,
  ImStoredConnection,
} from './types.js'

interface PairedAccount {
  id: string
  name: string
  pairedAt: number
}

interface PairRequest {
  id: string
  senderId: string
  name: string
  chatKey: string
  createdAt: number
  expiresAt: number
}

interface ChatState extends ImChat {
  lastMessageAt: number
}

interface FailedSend {
  id: string
  chat: ImChat
  text: string
  buttons?: ImButton[]
  attempts: number
  reason: string
  createdAt: number
}

interface StoredConnection {
  id: string
  platform: ImPlatformId
  fields: Record<string, string>
  runtime: Record<string, unknown>
  account: ImAccount
  enabled: boolean
  state: ImConnectionState
  lastError: string | undefined
  paired: PairedAccount[]
  pairRequests: PairRequest[]
  chats: Map<string, ChatState>
  failed: FailedSend[]
  createdAt: number
  updatedAt: number
  lastInboundAt: number | undefined
  transport: ImAdapterConnection | undefined
  starting: Promise<void> | undefined
  generation: number
}

interface LoginState {
  loginId: string
  platform: ImPlatformId
  state: unknown
  createdAt: number
  expiresAt: number
  commandId: string
}

interface CommandReceipt {
  fingerprint: string
  result: unknown
}

export interface ImServiceOptions {
  instanceId: string
  main?: ImMainSink
  adapters?: readonly ImAdapter[]
  fetch?: typeof fetch
  WebSocket?: ImSocketConstructor
  config?: Partial<Record<ImPlatformId, Readonly<Record<string, unknown>>>>
  log?: { warn?(template: string, ...args: unknown[]): void }
  now?: () => number
  createId?: () => string
  sleep?: (ms: number) => Promise<void>
  pairingTtlMs?: number
  loginTtlMs?: number
  dedupTtlMs?: number
  maxAttempts?: number
  retryDelaysMs?: readonly number[]
  maxPairRequests?: number
  maxFailedSends?: number
  maxCommands?: number
  persistence?: ImPersistence
  authorizeSend?: (request: { connectionId: string; platform: ImPlatformId; accountId: string;
    requesterId: string; threadId: string }) => Promise<void>
}

export interface ImSaveInput {
  instanceId: string
  op: 'add' | 'update' | 'remove'
  id?: string
  platform?: string
  fields?: Record<string, unknown>
  enabled?: boolean
}

export interface ImPairInput {
  instanceId: string
  id: string
  op: 'pair' | 'unpair' | 'chat' | 'retry' | 'send'
  chatKey?: string
  senderId?: string
  allow?: boolean
  remove?: boolean
  body?: Record<string, unknown>
}

export interface ImLoginInput {
  instanceId: string
  op: 'start' | 'wait'
  loginId?: string
  platform?: string
  fields?: Record<string, unknown>
}

export interface ImDispatcher {
  dispatch(endpoint: string, payload?: Record<string, unknown>): Promise<unknown>
}

export const IM_ENDPOINT_FIELDS = Object.freeze({
  'im-registry': ['instanceId'],
  'im-save': ['instanceId', 'commandId', 'op', 'id', 'platform', 'fields', 'enabled'],
  'im-pair': ['instanceId', 'commandId', 'id', 'op', 'chatKey', 'senderId', 'allow', 'remove', 'body'],
  'im-login': ['instanceId', 'commandId', 'op', 'loginId', 'platform', 'fields'],
} as const)

export type ImEndpoint = keyof typeof IM_ENDPOINT_FIELDS
export const IM_ENDPOINTS = Object.freeze(Object.keys(IM_ENDPOINT_FIELDS) as ImEndpoint[])

function fail(code: string, message: string, permanent = true): never {
  throw new ImServiceError(message, { code, permanent, retryable: !permanent })
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail('IM_INVALID_INPUT', `${label} is required.`)
  return value.trim()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numericVersion(timestamp: number, messageId: string): string {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return String(BigInt(`0x${createHash('sha256').update(messageId).digest('hex').slice(0, 30)}`) + 1n)
  }
  const tail = Number.parseInt(createHash('sha256').update(messageId).digest('hex').slice(0, 6), 16) % 1000
  const version = String(BigInt(timestamp) * 1000n + BigInt(tail))
  if (version.length > 40) fail('IM_INVALID_INPUT', 'The platform timestamp exceeds the Engine version limit.')
  return version
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class ImService {
  private readonly instanceId: string
  private readonly adapters = new Map<ImPlatformId, ImAdapter>()
  private readonly connections = new Map<string, StoredConnection>()
  private readonly logins = new Map<string, LoginState>()
  private readonly runtimes = new Map<string, Record<string, unknown>>()
  private readonly persistenceTails = new Map<string, Promise<void>>()
  private readonly seen = new Map<string, number>()
  private readonly commands = new Map<string, CommandReceipt>()
  private readonly now: () => number
  private readonly createId: () => string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pairingTtlMs: number
  private readonly loginTtlMs: number
  private readonly dedupTtlMs: number
  private readonly maxAttempts: number
  private readonly retryDelaysMs: readonly number[]
  private readonly maxPairRequests: number
  private readonly maxFailedSends: number
  private readonly maxCommands: number
  private readonly fetchImpl: typeof fetch
  private readonly environment: Omit<ImAdapterEnvironment, 'runtime'>
  private readonly persistence: ImPersistence | undefined
  private main: ImMainSink | undefined
  private initialized = false

  constructor(private readonly options: ImServiceOptions) {
    this.instanceId = nonempty(options.instanceId, 'instanceId')
    for (const adapter of options.adapters ?? Object.values(builtInAdapters)) this.adapters.set(adapter.id, adapter)
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.sleep = options.sleep ?? (ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    }))
    this.pairingTtlMs = this.bounded(options.pairingTtlMs ?? 10 * 60_000, 30_000, 24 * 60 * 60_000, 'pairingTtlMs')
    this.loginTtlMs = this.bounded(options.loginTtlMs ?? 5 * 60_000, 30_000, 60 * 60_000, 'loginTtlMs')
    this.dedupTtlMs = this.bounded(options.dedupTtlMs ?? 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000, 'dedupTtlMs')
    this.maxAttempts = this.bounded(options.maxAttempts ?? 4, 1, 10, 'maxAttempts')
    this.maxPairRequests = this.bounded(options.maxPairRequests ?? 100, 1, 1000, 'maxPairRequests')
    this.maxFailedSends = this.bounded(options.maxFailedSends ?? 20, 1, 200, 'maxFailedSends')
    this.maxCommands = this.bounded(options.maxCommands ?? 1000, 1, 10_000, 'maxCommands')
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 500, 1000, 2000]
    if (this.retryDelaysMs.length === 0 || this.retryDelaysMs.some(value => !Number.isFinite(value) || value < 0 || value > 60_000)) {
      fail('IM_INVALID_CONFIG', 'Retry delays must be bounded non-negative milliseconds.')
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.persistence = options.persistence
    this.environment = {
      fetch: this.fetchImpl,
      ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.log === undefined ? {} : { log: options.log }),
      now: this.now,
    }
    this.main = options.main
  }

  private bounded(value: number, minimum: number, maximum: number, name: string): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      fail('IM_INVALID_CONFIG', `${name} must be an integer from ${minimum} to ${maximum}.`)
    }
    return value
  }

  setMainSink(sink: ImMainSink | undefined): void {
    this.main = sink
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.persistence) {
      const stored = await this.persistence.load()
      for (const value of stored) {
        if (value.version !== 1 || !IM_PLATFORM_IDS.includes(value.platform) || this.connections.has(value.id)) continue
        const now = this.now()
        const connection: StoredConnection = {
          id: value.id,
          platform: value.platform,
          fields: { ...value.fields },
          runtime: structuredClone(value.runtime ?? {}),
          account: { ...value.account },
          enabled: value.enabled === true,
          state: 'off',
          lastError: undefined,
          paired: value.paired.map(account => ({ ...account })),
          pairRequests: value.pairRequests
            .filter(request => request.expiresAt > now)
            .map(request => ({ ...request })),
          chats: new Map(value.chats.map(chat => [chat.key, { ...chat }])),
          failed: value.failedSends.map(job => ({
            ...job,
            chat: { ...job.chat },
            ...(job.buttons === undefined ? {} : { buttons: clone(job.buttons) }),
          })),
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          lastInboundAt: value.lastInboundAt,
          transport: undefined,
          starting: undefined,
          generation: 0,
        }
        this.connections.set(connection.id, connection)
        this.runtimes.set(connection.id, connection.runtime)
        if (connection.pairRequests.length !== value.pairRequests.length) await this.persist(connection)
      }
    }
    this.initialized = true
  }

  async startAll(instanceId: string): Promise<ImRegistryView> {
    this.authorize(instanceId)
    await this.initialize()
    for (const connection of this.connections.values()) {
      if (!connection.enabled) continue
      await this.startConnection(connection).catch(error => {
        connection.state = 'error'
        connection.lastError = safeError(error, this.secretValues(connection.platform, connection.fields)).message
      })
    }
    return this.registry(instanceId)
  }

  registry(instanceId: string): ImRegistryView {
    this.authorize(instanceId)
    this.prune()
    return {
      platforms: clone(IM_PLATFORMS),
      connections: [...this.connections.values()].map(connection => this.view(connection)),
    }
  }

  async save(input: ImSaveInput): Promise<ImConnectionView> {
    this.authorize(input.instanceId)
    if (input.op === 'add') return await this.add(input)
    const id = nonempty(input.id, 'connection id')
    const connection = this.connections.get(id)
    if (!connection) fail('IM_NOT_FOUND', 'The IM connection does not exist.')
    if (input.op === 'remove') {
      const wasEnabled = connection.enabled
      await this.close(connection)
      await this.persistenceTails.get(id)?.catch(() => {})
      try {
        await this.persistence?.remove(id)
      } catch (error) {
        connection.enabled = wasEnabled
        if (wasEnabled) await this.startConnection(connection).catch(() => {})
        connection.state = 'error'
        connection.lastError = 'IM_PERSISTENCE_FAILED'
        throw new ImServiceError('The IM connection could not be removed durably.', {
          code: 'IM_PERSISTENCE_FAILED', permanent: true, cause: error,
        })
      }
      this.connections.delete(id)
      this.runtimes.delete(id)
      return this.view(connection)
    }
    if (input.op !== 'update') fail('IM_INVALID_INPUT', 'Unknown IM save operation.')
    const prior = {
      fields: connection.fields,
      account: connection.account,
      enabled: connection.enabled,
      lastError: connection.lastError,
    }
    if (input.fields !== undefined) {
      const platform = platformById(connection.platform)
      if (!platform) fail('IM_INVALID_CONFIG', 'The IM platform is no longer available.')
      const fields = this.normalizeFields(platform, input.fields, connection.fields)
      const nextFields = this.mergeHiddenFields(connection, fields)
      const adapter = this.adapter(connection.platform)
      let checkedAccount: ImAccount
      try {
        const checked = await adapter.check(nextFields, this.environmentFor(id))
        checkedAccount = checked.account
      } catch (error) {
        throw safeError(error, this.secretValues(connection.platform, nextFields))
      }
      connection.fields = nextFields
      connection.account = checkedAccount
      connection.lastError = undefined
    }
    if (input.enabled !== undefined) {
      connection.enabled = input.enabled
    }
    connection.updatedAt = this.now()
    try {
      await this.persist(connection)
    } catch (error) {
      connection.fields = prior.fields
      connection.account = prior.account
      connection.enabled = prior.enabled
      connection.lastError = prior.lastError
      throw error
    }
    if (input.fields !== undefined || input.enabled === false) await this.close(connection)
    if (connection.enabled) await this.startConnection(connection)
    return this.view(connection)
  }

  private async add(input: ImSaveInput): Promise<ImConnectionView> {
    const platform = platformById(nonempty(input.platform, 'platform'))
    if (!platform) fail('IM_INVALID_PLATFORM', 'The IM platform is not supported.')
    if (platform.login === 'qr') fail('IM_LOGIN_REQUIRED', 'This platform signs in with a pairing code.')
    const adapter = this.adapter(platform.id)
    const fields = this.normalizeFields(platform, asRecord(input.fields))
    let account: ImAccount
    try {
      account = (await adapter.check(fields, this.environmentFor('check'))).account
    } catch (error) {
      throw safeError(error, Object.values(fields))
    }
    const id = this.newId('im')
    const connection: StoredConnection = {
      id,
      platform: platform.id,
      fields,
      runtime: {},
      account,
      enabled: input.enabled ?? true,
      state: 'off',
      lastError: undefined,
      paired: [],
      pairRequests: [],
      chats: new Map(),
      failed: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      lastInboundAt: undefined,
      transport: undefined,
      starting: undefined,
      generation: 0,
    }
    this.connections.set(id, connection)
    try {
      await this.persist(connection)
    } catch (error) {
      this.connections.delete(id)
      throw error
    }
    if (connection.enabled) {
      await this.startConnection(connection).catch(error => {
        connection.state = 'error'
        connection.lastError = safeError(error, this.secretValues(platform.id, fields)).message
      })
    }
    return this.view(connection)
  }

  private normalizeFields(
    platform: ImPlatformDescriptor,
    raw: Record<string, unknown>,
    prior: Record<string, string> = {},
  ): Record<string, string> {
    const allowed = new Set(platform.fields.map(item => item.key))
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) fail('IM_INVALID_INPUT', `Field ${key} is not accepted for ${platform.name}.`)
    }
    const fields: Record<string, string> = {}
    for (const item of platform.fields) {
      const provided = raw[item.key]
      const previous = prior[item.key]
      let value = provided === undefined ? previous ?? item.defaultValue ?? '' : String(provided).trim()
      if (item.secret && value === '' && previous !== undefined) value = previous
      if (item.options && value !== '' && !item.options.some(option => option.value === value)) {
        fail('IM_INVALID_INPUT', `${item.label} is not a supported choice.`)
      }
      if (value === '') value = item.defaultValue ?? ''
      if ((item.required || item.secret) && value === '') fail('IM_INVALID_INPUT', `${item.label} is required.`)
      fields[item.key] = value
    }
    return fields
  }

  private mergeHiddenFields(connection: StoredConnection, next: Record<string, string>): Record<string, string> {
    const fields = { ...next }
    for (const key of ['baseUrl', 'ilinkBotId']) {
      const value = connection.fields[key]
      if (value !== undefined) fields[key] = value
    }
    return fields
  }

  async start(instanceId: string, id: string): Promise<ImConnectionView> {
    this.authorize(instanceId)
    const connection = this.connection(id)
    if (!connection.enabled) fail('IM_DISABLED', 'Enable the IM connection before starting it.')
    await this.ensureTransport(connection)
    return this.view(connection)
  }

  async stop(instanceId: string, id: string): Promise<ImConnectionView> {
    this.authorize(instanceId)
    const connection = this.connection(id)
    await this.close(connection)
    return this.view(connection)
  }

  private async startConnection(connection: StoredConnection): Promise<void> {
    if (!connection.enabled || connection.transport) return
    if (connection.starting) return connection.starting
    const operation = this.connectWithRetry(connection, connection.generation)
    connection.starting = operation
    try {
      await operation
    } finally {
      if (connection.starting === operation) connection.starting = undefined
    }
  }

  private async ensureTransport(connection: StoredConnection): Promise<void> {
    if (connection.state === 'error' && connection.transport) await this.close(connection)
    if (!connection.transport) await this.startConnection(connection)
  }

  private async connectWithRetry(connection: StoredConnection, generation: number): Promise<void> {
    const adapter = this.adapter(connection.platform)
    const current = () => this.connections.get(connection.id) === connection
      && connection.generation === generation && connection.enabled
    if (!current()) return
    connection.state = 'connecting'
    let last: unknown
    for (let attempt = 0; attempt < Math.min(3, this.maxAttempts); attempt += 1) {
      if (!current()) return
      try {
        const transport = await adapter.connect(connection.fields, this.environmentFor(connection.id), {
          onMessage: async message => {
            if (!current()) return
            await this.receive(connection.id, message).catch(error => {
              this.options.log?.warn?.('im inbound failed: %s',
                safeError(error, this.secretValues(connection.platform, connection.fields)).message)
            })
          },
          onAction: async action => {
            if (!current()) return
            await this.receive(connection.id, { ...action, text: action.data }).catch(error => {
              this.options.log?.warn?.('im action failed: %s',
                safeError(error, this.secretValues(connection.platform, connection.fields)).message)
            })
          },
          onStatus: status => {
            if (!current()) return
            connection.state = status.state
            if (status.account) connection.account = status.account
            connection.lastError = status.error === undefined
              ? undefined
              : redactSecretText(status.error, this.secretValues(connection.platform, connection.fields))
            connection.updatedAt = this.now()
          },
        })
        if (!current()) {
          await transport.stop()
          return
        }
        connection.transport = transport
        connection.updatedAt = this.now()
        return
      } catch (error) {
        if (!current()) return
        last = safeError(error, this.secretValues(connection.platform, connection.fields))
        if (!retryable(last) || attempt + 1 >= Math.min(3, this.maxAttempts)) break
        connection.state = 'retrying'
        connection.lastError = (last as Error).message
        await this.sleep(this.delay(attempt, last))
      }
    }
    if (!current()) return
    const error = last instanceof ImServiceError ? last
      : safeError(last, this.secretValues(connection.platform, connection.fields))
    connection.state = 'error'
    connection.lastError = error.message
    connection.updatedAt = this.now()
    throw error
  }

  private async close(connection: StoredConnection): Promise<void> {
    connection.generation += 1
    connection.starting = undefined
    const transport = connection.transport
    connection.transport = undefined
    connection.state = 'off'
    connection.lastError = undefined
    connection.updatedAt = this.now()
    if (transport) {
      try {
        await transport.stop()
      } catch (error) {
        this.options.log?.warn?.('im transport stop failed: %s',
          safeError(error, this.secretValues(connection.platform, connection.fields)).message)
      }
    }
  }

  async loginStart(input: { instanceId: string; commandId: string; platform: string }): Promise<ImLoginStartView> {
    this.authorize(input.instanceId)
    const platform = platformById(nonempty(input.platform, 'platform'))
    if (!platform?.login) fail('IM_LOGIN_UNSUPPORTED', 'This IM platform does not use pairing-code login.')
    const adapter = this.adapter(platform.id)
    if (!adapter.login) fail('IM_LOGIN_UNSUPPORTED', 'Pairing-code login is unavailable for this platform.')
    this.prune()
    let started: ImLoginStart
    try {
      started = await adapter.login.start(this.environmentFor('login'))
    } catch (error) {
      throw safeError(error, [])
    }
    const expiresAt = Math.min(
      this.now() + this.loginTtlMs,
      started.expiresAt !== undefined && Number.isFinite(started.expiresAt) ? started.expiresAt : Number.POSITIVE_INFINITY,
    )
    if (started.qr.trim() === '' || expiresAt <= this.now()) {
      fail('IM_LOGIN_FAILED', 'The platform returned an expired or empty login code.')
    }
    const loginId = this.newId('login')
    this.logins.set(loginId, {
      loginId,
      platform: platform.id,
      state: started.state,
      createdAt: this.now(),
      expiresAt,
      commandId: input.commandId,
    })
    return { loginId, platform: platform.id, qr: started.qr, status: 'waiting', expiresAt }
  }

  async loginWait(input: { instanceId: string; loginId: string }): Promise<ImLoginWaitView> {
    this.authorize(input.instanceId)
    const login = this.logins.get(nonempty(input.loginId, 'loginId'))
    if (!login) return { status: 'expired', expiresAt: this.now() }
    if (this.now() >= login.expiresAt) {
      this.logins.delete(login.loginId)
      return { status: 'expired', expiresAt: login.expiresAt }
    }
    const adapter = this.adapter(login.platform)
    if (!adapter.login) fail('IM_LOGIN_UNSUPPORTED', 'Pairing-code login is unavailable for this platform.')
    let result: ImLoginWait
    try {
      result = await adapter.login.wait(login.state, this.environmentFor('login'))
    } catch (error) {
      throw safeError(error, [])
    }
    if (this.now() >= login.expiresAt) {
      this.logins.delete(login.loginId)
      return { status: 'expired', expiresAt: login.expiresAt }
    }
    if (result.status === 'expired') {
      this.logins.delete(login.loginId)
      return { status: 'expired', expiresAt: login.expiresAt }
    }
    if (result.status !== 'done') return { status: result.status, expiresAt: login.expiresAt }
    if (!result.connection) {
      this.logins.delete(login.loginId)
      fail('IM_LOGIN_FAILED', 'The platform completed login without connection credentials.')
    }
    const connection = await this.connectionFromLogin(login.platform, result.connection.fields, result.connection.account, result.owner)
    this.logins.delete(login.loginId)
    if (connection.enabled) {
      await this.startConnection(connection).catch(error => {
        connection.state = 'error'
        connection.lastError = safeError(error, this.secretValues(connection.platform, connection.fields)).message
      })
    }
    return { status: 'done', expiresAt: login.expiresAt, connection: this.view(connection) }
  }

  private async connectionFromLogin(
    platform: ImPlatformId,
    fields: Record<string, string>,
    account: ImAccount,
    owner?: { id: string; name: string },
  ): Promise<StoredConnection> {
    const now = this.now()
    const connection: StoredConnection = {
      id: this.newId('im'),
      platform,
      fields: { ...fields },
      runtime: {},
      account,
      enabled: true,
      state: 'off',
      lastError: undefined,
      paired: owner === undefined ? [] : [{ id: owner.id, name: owner.name, pairedAt: now }],
      pairRequests: [],
      chats: new Map(),
      failed: [],
      createdAt: now,
      updatedAt: now,
      lastInboundAt: undefined,
      transport: undefined,
      starting: undefined,
      generation: 0,
    }
    this.connections.set(connection.id, connection)
    try {
      await this.persist(connection)
    } catch (error) {
      this.connections.delete(connection.id)
      this.runtimes.delete(connection.id)
      throw error
    }
    return connection
  }

  async receive(connectionId: string, inbound: ImInbound): Promise<ImInboundResult> {
    const connection = this.connections.get(connectionId)
    if (!connection) return { status: 'failed', reason: 'IM_NOT_FOUND' }
    try {
      await this.persistenceTails.get(connection.id)
    } catch {
      return { status: 'failed', reason: 'IM_PERSISTENCE_FAILED' }
    }
    this.prune()
    if (!inbound.sender.id.trim()) return { status: 'filtered', reason: 'IM_SENDER_MISSING' }
    if (!inbound.chat.key.trim()) return { status: 'filtered', reason: 'IM_CHAT_MISSING' }
    if (Buffer.byteLength(inbound.sender.id) > 112 || Buffer.byteLength(inbound.chat.key) > 112
      || Buffer.byteLength(inbound.messageId) > 112) return { status: 'filtered', reason: 'IM_ID_TOO_LONG' }
    if (Buffer.byteLength(inbound.text) > 65536) return { status: 'filtered', reason: 'IM_MESSAGE_TOO_LARGE' }
    const eventKey = createHash('sha256').update(JSON.stringify([connection.id, inbound.chat.key, inbound.messageId])).digest('hex')
    if (inbound.messageId !== '' && this.seen.has(eventKey)) return { status: 'duplicate', reason: 'IM_REPLAY' }
    const nativeTimestamp = Number.isSafeInteger(inbound.timestamp) && inbound.timestamp! > 0 ? inbound.timestamp! : 0
    const markSeen = () => {
      if (inbound.messageId !== '') this.seen.set(eventKey, this.now() + this.dedupTtlMs)
    }
    const timestamp = nativeTimestamp || this.now()
    const previousChat = connection.chats.get(inbound.chat.key)
    const chatAdded = previousChat === undefined
    connection.chats.set(inbound.chat.key, {
      ...inbound.chat,
      ...(previousChat?.title !== undefined && inbound.chat.title === undefined ? { title: previousChat.title } : {}),
      lastMessageAt: timestamp,
    })
    connection.lastInboundAt = timestamp
    connection.updatedAt = this.now()
    if (inbound.chat.kind === 'group' && !inbound.mentioned) {
      markSeen()
      if (chatAdded) await this.persist(connection).catch(() => {})
      return { status: 'filtered', reason: 'IM_NOT_ADDRESSED' }
    }
    if (!inbound.text.trim() && !inbound.images?.length && !inbound.files?.length) {
      markSeen()
      if (chatAdded) await this.persist(connection).catch(() => {})
      return { status: 'filtered', reason: 'IM_EMPTY' }
    }
    const paired = connection.paired.find(account => account.id === inbound.sender.id)
    if (!paired) {
      const request = this.requestPair(connection, inbound)
      try {
        await this.persist(connection)
      } catch {
        connection.pairRequests = connection.pairRequests.filter(item => item.id !== request.id)
        return { status: 'failed', reason: 'IM_PERSISTENCE_FAILED' }
      }
      markSeen()
      return { status: 'pairing-required', request: clone(request) }
    }
    if (chatAdded) await this.persist(connection).catch(() => {})
    if (!this.main) {
      connection.lastError = 'IM_MAIN_UNAVAILABLE'
      return { status: 'failed', reason: 'IM_MAIN_UNAVAILABLE' }
    }
    const text = inbound.text.trim() || '[IM media message]'
    const messageIdentity = createHash('sha256').update(JSON.stringify([
      connection.platform, connection.id, inbound.chat.key, inbound.messageId || this.newId('message'),
    ])).digest('hex')
    const event: ImMainEvent = {
      commandId: `im-receive:${messageIdentity}`,
      platform: connection.platform,
      connectionId: connection.id,
      sourceInstanceId: IM_SOURCE_INSTANCE_ID,
      threadId: imThreadId({
        platform: connection.platform,
        accountId: connection.account.id,
        connectionId: connection.id,
        chatKind: inbound.chat.kind,
        chatKey: inbound.chat.key,
      }),
      objectId: `im-message:${messageIdentity}`,
      version: numericVersion(nativeTimestamp, inbound.messageId || text),
      chat: { ...inbound.chat },
      sender: { ...inbound.sender },
      requesterId: imRequesterId(connection.platform, connection.id, inbound.sender.id),
      text,
      addressing: inbound.chat.kind === 'direct' ? 'direct' : 'mention',
      messageId: inbound.messageId,
      timestamp,
    }
    try {
      const receipt = await this.main.accept(event)
      markSeen()
      return {
        status: receipt.status,
        ...(receipt.eventId === undefined ? {} : { eventId: receipt.eventId }),
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      }
    } catch (error) {
      const message = safeError(error, this.secretValues(connection.platform, connection.fields)).message
      connection.lastError = message
      return { status: 'failed', reason: message }
    }
  }

  private requestPair(connection: StoredConnection, inbound: ImInbound): PairRequest {
    const now = this.now()
    connection.pairRequests = connection.pairRequests.filter(request => request.expiresAt > now)
    const existing = connection.pairRequests.find(request => request.senderId === inbound.sender.id && request.chatKey === inbound.chat.key)
    if (existing) return existing
    if (connection.pairRequests.length >= this.maxPairRequests) {
      connection.pairRequests.shift()
    }
    const request: PairRequest = {
      id: this.newId('pair'),
      senderId: inbound.sender.id,
      name: inbound.sender.name || inbound.sender.id,
      chatKey: inbound.chat.key,
      createdAt: now,
      expiresAt: now + this.pairingTtlMs,
    }
    connection.pairRequests.push(request)
    connection.updatedAt = now
    return request
  }

  async pair(input: ImPairInput): Promise<ImConnectionView | ImRetryView | ImSendView | ImChatView[]> {
    this.authorize(input.instanceId)
    const connection = this.connection(input.id)
    if (input.op === 'pair') {
      const senderId = nonempty(input.senderId, 'senderId')
      const index = connection.pairRequests.findIndex(request => request.senderId === senderId || request.id === senderId)
      if (index < 0) fail('IM_PAIRING_NOT_FOUND', 'That pairing request is no longer waiting.')
      const request = connection.pairRequests[index]!
      if (request.expiresAt <= this.now()) {
        connection.pairRequests.splice(index, 1)
        fail('IM_PAIRING_EXPIRED', 'That pairing request has expired.')
      }
      const previousPairs = connection.paired.map(account => ({ ...account }))
      const previousRequests = connection.pairRequests.map(pairRequest => ({ ...pairRequest }))
      if (input.allow === false) {
        connection.pairRequests.splice(index, 1)
      } else {
        if (!connection.paired.some(account => account.id === request.senderId)) {
          connection.paired.push({ id: request.senderId, name: request.name, pairedAt: this.now() })
        }
        connection.pairRequests.splice(index, 1)
      }
      connection.updatedAt = this.now()
      try {
        await this.persist(connection)
      } catch (error) {
        connection.paired = previousPairs
        connection.pairRequests = previousRequests
        throw error
      }
      return this.view(connection)
    }
    if (input.op === 'unpair') {
      const senderId = nonempty(input.senderId, 'senderId')
      const previousPairs = connection.paired.map(account => ({ ...account }))
      connection.paired = connection.paired.filter(account => account.id !== senderId)
      connection.updatedAt = this.now()
      try {
        await this.persist(connection)
      } catch (error) {
        connection.paired = previousPairs
        throw error
      }
      return this.view(connection)
    }
    if (input.op === 'retry') return await this.retryFailed(connection)
    if (input.op === 'chat') {
      if (input.chatKey !== undefined) {
        const key = nonempty(input.chatKey, 'chatKey')
        if (input.remove) connection.chats.delete(key)
        else {
          const chat = connection.chats.get(key)
          if (!chat) fail('IM_NOT_FOUND', 'That IM chat is not recorded.')
          return [this.chatView(chat)]
        }
        connection.updatedAt = this.now()
        await this.persist(connection)
        return this.view(connection)
      }
      return [...connection.chats.values()].sort((left, right) => right.lastMessageAt - left.lastMessageAt).map(chat => this.chatView(chat))
    }
    if (input.op === 'send') {
      const chatKey = nonempty(input.chatKey, 'chatKey')
      const chat = connection.chats.get(chatKey)
      if (!chat) fail('IM_NOT_FOUND', 'The IM chat is not known yet; wait for an inbound message.')
      const body = asRecord(input.body)
      const text = nonempty(body.text, 'message text')
      if (Buffer.byteLength(text) > 65536) fail('IM_INVALID_INPUT', 'The IM message is too large.')
      const buttons = Array.isArray(body.buttons) ? body.buttons.map(item => {
        const value = asRecord(item)
        return { label: nonempty(value.label, 'button label').slice(0, 100), data: nonempty(value.data, 'button data') }
      }).slice(0, 10) : undefined
      return await this.sendWithRetry(connection, chat, text, buttons)
    }
    fail('IM_INVALID_INPUT', 'Unknown IM pairing operation.')
  }

  /** Trusted Host reply path from a Main source or delivery. It never accepts a credential value. */
  async checkSendAuthorization(instanceId: string, threadId: string, requesterId: string): Promise<void> {
    this.authorize(instanceId)
    const route = parseImThread(threadId)
    if (!route) fail('IM_INVALID_INPUT', 'The send target does not carry an IM Thread route.')
    const connection = this.connection(route.connectionId)
    if (connection.platform !== route.platform || connection.account.id !== route.accountId) {
      fail('IM_NOT_AUTHORIZED', 'The send route no longer matches its IM connection.')
    }
    if (!connection.enabled) fail('IM_DISABLED', 'The IM connection is disabled.')
    this.assertPairedRequester(connection, route, requesterId)
    await this.options.authorizeSend?.({ connectionId: connection.id, platform: connection.platform,
      accountId: connection.account.id, requesterId, threadId })
  }

  async sendOnce(
    instanceId: string,
    threadId: string,
    requesterId: string,
    text: string,
    buttons?: ImButton[],
  ): Promise<ImSendView> {
    await this.checkSendAuthorization(instanceId, threadId, requesterId)
    const route = parseImThread(threadId)
    if (!route) fail('IM_INVALID_INPUT', 'The send target does not carry an IM Thread route.')
    const connection = this.connection(route.connectionId)
    if (Buffer.byteLength(text) > 65536) fail('IM_INVALID_INPUT', 'The IM message is too large.')
    await this.ensureTransport(connection)
    const chat: ImChat = {
      key: route.chatKey,
      kind: route.chatKind,
      ...(connection.chats.get(route.chatKey)?.title === undefined
        ? {}
        : { title: connection.chats.get(route.chatKey)!.title }),
    }
    await this.checkSendAuthorization(instanceId, threadId, requesterId)
    try {
      const result = await connection.transport!.send(chat, { text, ...(buttons === undefined ? {} : { buttons }) })
      connection.updatedAt = this.now()
      return {
        connectionId: connection.id,
        chatKey: chat.key,
        status: 'sent',
        attempts: 1,
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
      }
    } catch (error) {
      const safe = safeError(error, this.secretValues(connection.platform, connection.fields))
      throw safe
    }
  }

  private assertPairedRequester(connection: StoredConnection, route: ImThreadRoute, requesterId: string) {
    if (Buffer.byteLength(requesterId) > 512) fail('IM_INVALID_INPUT', 'The paired requester identifier is too long.')
    if (!connection.paired.some(account =>
      imRequesterId(connection.platform, connection.id, account.id) === requesterId)) {
      fail('IM_PAIRING_REVOKED', 'The original IM requester is no longer paired.')
    }
  }

  private async sendWithRetry(connection: StoredConnection, chat: ImChat, text: string, buttons?: ImButton[]): Promise<ImSendView> {
    await this.ensureTransport(connection)
    let attempts = 0
    let last: ImServiceError | undefined
    for (; attempts < this.maxAttempts; attempts += 1) {
      try {
        const sent = await connection.transport!.send(chat, { text, ...(buttons === undefined ? {} : { buttons }) })
        connection.updatedAt = this.now()
        return {
          connectionId: connection.id,
          chatKey: chat.key,
          status: 'sent',
          attempts: attempts + 1,
          ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
        }
      } catch (error) {
        last = safeError(error, this.secretValues(connection.platform, connection.fields))
        if (!last.retryable || attempts + 1 >= this.maxAttempts) break
        await this.sleep(this.delay(attempts, last))
      }
    }
    const reason = last?.message ?? 'The IM send failed.'
    this.rememberFailed(connection, chat, text, buttons, attempts + 1, reason)
    try {
      await this.persist(connection)
    } catch {
      // The in-memory failed job remains visible for this Host; the caller sees the send failure.
    }
    return { connectionId: connection.id, chatKey: chat.key, status: 'failed', attempts: attempts + 1, reason }
  }

  private rememberFailed(connection: StoredConnection, chat: ImChat, text: string, buttons: ImButton[] | undefined, attempts: number, reason: string) {
    if (connection.failed.length >= this.maxFailedSends) connection.failed.shift()
    connection.failed.push({
      id: this.newId('send'),
      chat: { ...chat },
      text,
      ...(buttons === undefined ? {} : { buttons: clone(buttons) }),
      attempts,
      reason,
      createdAt: this.now(),
    })
    connection.updatedAt = this.now()
  }

  private async retryFailed(connection: StoredConnection): Promise<ImRetryView> {
    await this.ensureTransport(connection).catch(() => {})
    const jobs = connection.failed.splice(0)
    let sent = 0
    let failed = 0
    for (const job of jobs) {
      if (!connection.transport) {
        connection.failed.push(job)
        failed += 1
        continue
      }
      try {
        await connection.transport.send(job.chat, { text: job.text, ...(job.buttons === undefined ? {} : { buttons: job.buttons }) })
        sent += 1
      } catch (error) {
        job.attempts += 1
        job.reason = safeError(error, this.secretValues(connection.platform, connection.fields)).message
        connection.failed.push(job)
        failed += 1
      }
    }
    connection.failed = connection.failed.slice(-this.maxFailedSends)
    connection.updatedAt = this.now()
    await this.persist(connection).catch(() => {})
    return { sent, failed, remaining: connection.failed.map(job => this.failedView(job)) }
  }

  health(instanceId: string): { connections: { id: string; state: ImConnectionState; lastError?: string }[] } {
    this.authorize(instanceId)
    return {
      connections: [...this.connections.values()].map(connection => ({
        id: connection.id,
        state: connection.state,
        ...(connection.lastError === undefined ? {} : { lastError: connection.lastError }),
      })),
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connections.values()].map(connection => this.close(connection)))
    await Promise.allSettled(this.persistenceTails.values())
    this.connections.clear()
    this.logins.clear()
    this.runtimes.clear()
    this.seen.clear()
    this.commands.clear()
  }

  private environmentFor(id: string): ImAdapterEnvironment {
    const runtime = this.runtime(id)
    return { ...this.environment, runtime }
  }

  private runtime(id: string): ImAdapterEnvironment['runtime'] {
    return {
      get: () => {
        const held = this.connections.get(id)?.runtime ?? this.runtimes.get(id)
        return held ?? {}
      },
      set: patch => {
        const current = this.connections.get(id)?.runtime ?? this.runtimes.get(id) ?? {}
        const next = { ...current, ...clone(patch) }
        this.runtimes.set(id, next)
        const connection = this.connections.get(id)
        if (connection) {
          connection.runtime = next
          void this.persist(connection).catch(error => this.options.log?.warn?.('im runtime persistence failed: %s',
            safeError(error, this.secretValues(connection.platform, connection.fields)).message))
        }
      },
    }
  }

  private adapter(platform: ImPlatformId): ImAdapter {
    const adapter = this.adapters.get(platform)
    if (!adapter) fail('IM_UNAVAILABLE', `${platform} is not available in this Host.`)
    return adapter
  }

  private connection(id: string): StoredConnection {
    const connection = this.connections.get(nonempty(id, 'connection id'))
    if (!connection) fail('IM_NOT_FOUND', 'The IM connection does not exist.')
    return connection
  }

  private authorize(instanceId: unknown): void {
    if (nonempty(instanceId, 'instanceId') !== this.instanceId) {
      fail('IM_NOT_AUTHORIZED', 'The IM request belongs to another Instance.')
    }
  }

  private newId(prefix: string): string {
    return `${prefix}-${this.createId()}`
  }

  private delay(attempt: number, error: unknown): number {
    const base = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 1000
    return retryDelay(error, base)
  }

  private secretValues(platform: ImPlatformId, fields: Record<string, string>): string[] {
    const keys = new Set(platformById(platform)?.fields.filter(field => field.secret).map(field => field.key) ?? [])
    for (const key of Object.keys(fields)) {
      if (/(?:token|secret|password|ticket)/iu.test(key)) keys.add(key)
    }
    return [...keys]
      .map(key => fields[key])
      .filter((value): value is string => typeof value === 'string' && value !== '')
  }

  private stored(connection: StoredConnection): ImStoredConnection {
    return {
      version: 1,
      id: connection.id,
      platform: connection.platform,
      fields: { ...connection.fields },
      runtime: clone(connection.runtime),
      account: { ...connection.account },
      enabled: connection.enabled,
      paired: connection.paired.map(account => ({ ...account })),
      pairRequests: connection.pairRequests.map(request => ({ ...request })),
      chats: [...connection.chats.values()].map(chat => this.chatView(chat)),
      failedSends: connection.failed.map(job => ({
        id: job.id,
        chat: { ...job.chat },
        text: job.text,
        ...(job.buttons === undefined ? {} : { buttons: clone(job.buttons) }),
        attempts: job.attempts,
        reason: job.reason,
        createdAt: job.createdAt,
      })),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      ...(connection.lastInboundAt === undefined ? {} : { lastInboundAt: connection.lastInboundAt }),
    }
  }

  private async persist(connection: StoredConnection): Promise<void> {
    if (!this.persistence) return
    const previous = this.persistenceTails.get(connection.id) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.persistence!.save(this.stored(connection)))
    this.persistenceTails.set(connection.id, operation)
    try {
      await operation
    } catch (error) {
      throw new ImServiceError('The IM connection could not be saved durably.', {
        code: 'IM_PERSISTENCE_FAILED',
        permanent: true,
        cause: error,
      })
    } finally {
      if (this.persistenceTails.get(connection.id) === operation) this.persistenceTails.delete(connection.id)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, login] of this.logins) if (login.expiresAt <= now) this.logins.delete(id)
    for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id)
    for (const connection of this.connections.values()) {
      connection.pairRequests = connection.pairRequests.filter(request => request.expiresAt > now)
    }
  }

  private view(connection: StoredConnection): ImConnectionView {
    this.prune()
    const platform = platformById(connection.platform)
    return {
      id: connection.id,
      platform: connection.platform,
      account: { ...connection.account },
      enabled: connection.enabled,
      state: connection.state,
      ...(connection.lastError === undefined ? {} : { lastError: connection.lastError }),
      secretFields: platform?.fields.filter(field => field.secret).map(field => field.key) ?? [],
      paired: connection.paired.map(account => ({ ...account })) as ImPairingView[],
      pairRequests: connection.pairRequests.map(request => this.pairRequestView(request)),
      chats: [...connection.chats.values()].sort((left, right) => right.lastMessageAt - left.lastMessageAt).map(chat => this.chatView(chat)),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      ...(connection.lastInboundAt === undefined ? {} : { lastInboundAt: connection.lastInboundAt }),
    }
  }

  private pairRequestView(request: PairRequest): ImPairRequestView {
    return {
      id: request.id,
      name: request.name,
      chatKey: request.chatKey,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    }
  }

  private chatView(chat: ChatState): ImChatView {
    return {
      key: chat.key,
      kind: chat.kind,
      ...(chat.title === undefined ? {} : { title: chat.title }),
      lastMessageAt: chat.lastMessageAt,
    }
  }

  private failedView(job: FailedSend): ImFailedSendView {
    return {
      id: job.id,
      chatKey: job.chat.key,
      attempts: job.attempts,
      reason: job.reason,
      createdAt: job.createdAt,
    }
  }

  private command<T>(endpoint: ImEndpoint, commandId: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    const key = `${endpoint}:${commandId}`
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const prior = this.commands.get(key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        fail('IM_IDENTITY_CONFLICT', 'This IM command was already used with different input.')
      }
      return Promise.resolve(clone(prior.result) as T)
    }
    return action().then(result => {
      if (this.commands.size >= this.maxCommands) {
        const oldest = this.commands.keys().next().value
        if (typeof oldest === 'string') this.commands.delete(oldest)
      }
      this.commands.set(key, { fingerprint, result: clone(result) })
      return result
    })
  }

  dispatch(endpoint: string, rawPayload: Record<string, unknown> = {}): Promise<unknown> {
    if (!(endpoint in IM_ENDPOINT_FIELDS)) {
      return Promise.reject(new ImServiceError(`The IM endpoint ${endpoint} is not available.`, {
        code: 'IM_ENDPOINT_UNSUPPORTED', permanent: true,
      }))
    }
    const fields: readonly string[] = IM_ENDPOINT_FIELDS[endpoint as ImEndpoint]
    const unknown = Object.keys(rawPayload).find(key => !fields.includes(key))
    if (unknown !== undefined) {
      return Promise.reject(new ImServiceError(`The IM endpoint does not accept ${unknown}.`, {
        code: 'IM_INVALID_INPUT', permanent: true,
      }))
    }
    const payload = rawPayload
    const instanceId = nonempty(payload.instanceId, 'instanceId')
    if (endpoint === 'im-registry') {
      if (Object.keys(payload).some(key => key !== 'instanceId')) {
        return Promise.reject(new ImServiceError('The IM registry accepts instanceId only.', { code: 'IM_INVALID_INPUT', permanent: true }))
      }
      return Promise.resolve(this.registry(instanceId))
    }
    const commandId = nonempty(payload.commandId, 'commandId')
    if (endpoint === 'im-save') {
      const op = nonempty(payload.op, 'operation')
      if (!['add', 'update', 'remove'].includes(op)) {
        return Promise.reject(new ImServiceError('Unknown IM save operation.', { code: 'IM_INVALID_INPUT', permanent: true }))
      }
      if ((op === 'update' || op === 'remove') && typeof payload.id !== 'string') {
        return Promise.reject(new ImServiceError('The IM connection id is required.', { code: 'IM_INVALID_INPUT', permanent: true }))
      }
      return this.command('im-save', commandId, payload, () => this.save({
        instanceId,
        op: op as ImSaveInput['op'],
        ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
        ...(typeof payload.platform === 'string' ? { platform: payload.platform } : {}),
        ...(payload.fields === undefined ? {} : { fields: asRecord(payload.fields) }),
        ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
      }))
    }
    if (endpoint === 'im-login') {
      const op = nonempty(payload.op, 'operation')
      if (op === 'start') {
        return this.command('im-login', commandId, payload, () => this.loginStart({
          instanceId,
          commandId,
          platform: nonempty(payload.platform, 'platform'),
        }))
      }
      if (op === 'wait') return this.loginWait({ instanceId, loginId: nonempty(payload.loginId, 'loginId') })
      return Promise.reject(new ImServiceError('Unknown IM login operation.', { code: 'IM_INVALID_INPUT', permanent: true }))
    }
    const op = nonempty(payload.op, 'operation')
    if (!['pair', 'unpair', 'chat', 'retry', 'send'].includes(op)) {
      return Promise.reject(new ImServiceError('Unknown IM pairing operation.', { code: 'IM_INVALID_INPUT', permanent: true }))
    }
    return this.command('im-pair', commandId, payload, () => this.pair({
      instanceId,
      id: nonempty(payload.id, 'connection id'),
      op: op as ImPairInput['op'],
      ...(typeof payload.chatKey === 'string' ? { chatKey: payload.chatKey } : {}),
      ...(typeof payload.senderId === 'string' ? { senderId: payload.senderId } : {}),
      ...(typeof payload.allow === 'boolean' ? { allow: payload.allow } : {}),
      ...(typeof payload.remove === 'boolean' ? { remove: payload.remove } : {}),
      ...(payload.body === undefined ? {} : { body: asRecord(payload.body) }),
    }))
  }
}

export function createImService(options: ImServiceOptions): ImService {
  return new ImService(options)
}

export function createImDispatcher(service: ImService): ImDispatcher {
  return {
    dispatch: (endpoint, payload) => service.dispatch(endpoint, payload),
  }
}
