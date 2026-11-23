import { randomInt, randomUUID } from 'node:crypto'
import { toDataURL } from 'qrcode'
import { CoreError } from '../model.js'
import type { ProductCredentialVault } from '../product-credential-vault.js'
import type { Storage } from '../storage.js'
import { createAdapters } from './adapters.js'
import { hasControls, ImFailure, object, pause, required } from './transport.js'
import { imPlatforms, type ImAdapter, type ImAddress, type ImConnection, type ImInbound, type ImPlatform,
  type ImTransport, type NativeImMessage } from './types.js'
import { startWechatLogin, type WechatLogin } from './wechat.js'

export type { ImAddress, ImInbound, ImPlatform, ImTransport } from './types.js'

export interface ImAccountsOptions extends ImTransport {
  instanceId: string
  storage: Storage
  vault: Pick<ProductCredentialVault, 'create' | 'withSecret' | 'ensureRevoked'>
  onMessage(message: ImInbound): Promise<void>
}

type Pair = Pick<ImAddress, 'senderId' | 'conversationId'>
type ApprovedPair = Pair & Pick<ImAddress, 'pairId'>
type Account = { accountId: string; reference: string; nativeId?: string; cursor?: string; pair?: ApprovedPair; replyContext?: string; removing?: true }
type Pairing = { proposalId: string; code: string; expiresAt: number; candidate?: Pair }
type ConnectionState = 'connecting' | 'retrying' | 'connected' | 'login-expired' | 'attention'
type Runtime = {
  controller: AbortController
  state: ConnectionState
  loginExpiresAt: number | undefined
  connection: ImConnection | undefined
  activeSignal: AbortSignal | undefined
  task: Promise<void>
  inbound: Set<Promise<void>>
  error?: string
}

const accountKind = 'product-im-account'
const loginLifetime = 120_000
const pairingLifetime = 300_000
const input = () => new CoreError('INVALID_INPUT', 'Choose a messaging platform and a valid account operation.')
const unavailable = () => new CoreError('IM_UNAVAILABLE', 'The messaging account is unavailable.')
const missing = () => new CoreError('NOT_FOUND', 'The messaging account does not exist.')
const paired = (pair: Pair | undefined, address: Pair) => pair?.senderId === address.senderId && pair.conversationId === address.conversationId

function platformFrom(value: unknown): ImPlatform {
  const platform = imPlatforms.find(candidate => value === candidate)
  if (!platform) throw input()
  return platform
}

function credentialsFrom(adapter: ImAdapter, value: unknown): Record<string, string> {
  const record = object(value)
  if (Object.keys(record).length !== adapter.fields.length) throw input()
  return Object.fromEntries(adapter.fields.map(field => {
    const fieldValue = record[field.name]
    if (typeof fieldValue !== 'string' || !fieldValue.trim() || fieldValue.length > 2048 || hasControls(fieldValue)) throw input()
    return [field.name, fieldValue.trim()]
  }))
}

export class ImAccounts {
  private readonly adapters: Record<ImPlatform, ImAdapter>
  private readonly accounts = new Map<ImPlatform, Account>()
  private readonly runtimes = new Map<ImPlatform, Runtime>()
  private readonly pairGrants = new Map<ImPlatform, AbortController>()
  private readonly pairing = new Map<ImPlatform, Pairing>()
  private readonly stopping = new AbortController()
  private readonly now: () => number
  private qr: WechatLogin | undefined
  private qrTask: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ImAccountsOptions) {
    this.now = options.now ?? Date.now
    this.adapters = createAdapters(options)
  }

  async restore(): Promise<void> {
    const saved = await this.options.storage.transaction(this.options.instanceId, tx => Promise.all(imPlatforms.map(async platform =>
      [platform, await tx.get<Account>(accountKind, platform)] as const)))
    for (const [platform, account] of saved) {
      if (!account) continue
      this.accounts.set(platform, account)
      if (account.pair && !account.removing) this.pairGrants.set(platform, new AbortController())
      if (!account.removing) this.start(platform, account)
    }
  }

  async dispatch(payload: Record<string, unknown>): Promise<unknown> {
    if (this.stopping.signal.aborted) throw unavailable()
    const { operation, instanceId, platform: platformValue, ...rest } = payload
    if (instanceId !== this.options.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The messaging account belongs to a different Instance.')
    if (operation === 'list') {
      if (platformValue !== undefined || Object.keys(rest).length) throw input()
      return { accounts: imPlatforms.map(platform => this.view(platform)) }
    }
    const platform = platformFrom(platformValue)
    const fields = operation === 'connect' ? ['credentials'] : operation === 'pair-approve' ? ['proposalId'] : operation === 'qr-verify' ? ['code'] : []
    if (Object.keys(rest).some(field => !fields.includes(field))) throw input()
    return this.serialize(async () => {
      if (this.stopping.signal.aborted) throw unavailable()
      const account = this.accounts.get(platform)
      switch (operation) {
        case 'connect': {
          if (platform === 'wechat') throw input()
          await this.add(platform, credentialsFrom(this.adapters[platform], rest.credentials))
          return this.view(platform)
        }
        case 'reconnect': {
          if (!account || account.removing) throw missing()
          await this.stop(platform)
          this.start(platform, account)
          return this.view(platform)
        }
        case 'disconnect': {
          if (!account) throw missing()
          this.clearPairGrant(platform)
          await this.stop(platform)
          this.pairing.delete(platform)
          await this.update(platform, account.accountId, current => ({ ...current, removing: true }))
          await this.options.vault.ensureRevoked(this.options.instanceId, account.reference)
          if (account.replyContext) await this.options.vault.ensureRevoked(this.options.instanceId, account.replyContext)
          await this.options.storage.transaction(this.options.instanceId, tx => tx.remove(accountKind, platform))
          this.accounts.delete(platform)
          return this.view(platform)
        }
        case 'pair-start': {
          if (!account || account.removing || this.runtimes.get(platform)?.state !== 'connected') throw unavailable()
          if (account.pair) throw new CoreError('IM_ALREADY_PAIRED', 'Revoke the current pairing before pairing another conversation.')
          const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
          const challenge = { proposalId: randomUUID(), code, expiresAt: this.now() + pairingLifetime }
          this.pairing.set(platform, challenge)
          return { code, expiresAt: challenge.expiresAt }
        }
        case 'pair-approve': {
          const challenge = this.activePairing(platform)
          if (!account || account.removing || account.pair || !challenge?.candidate || challenge.proposalId !== rest.proposalId) {
            throw new CoreError('IM_PAIRING_EXPIRED', 'Start a new messaging pairing.')
          }
          const pair = { ...challenge.candidate, pairId: challenge.proposalId }
          await this.update(platform, account.accountId, current => {
            if (this.now() >= challenge.expiresAt) throw new CoreError('IM_PAIRING_EXPIRED', 'Start a new messaging pairing.')
            return { ...current, pair }
          })
          this.pairGrants.set(platform, new AbortController())
          this.pairing.delete(platform)
          return this.view(platform)
        }
        case 'pair-cancel': {
          this.pairing.delete(platform)
          return this.view(platform)
        }
        case 'pair-revoke': {
          if (!account || account.removing) throw missing()
          this.clearPairGrant(platform)
          this.pairing.delete(platform)
          if (account.replyContext) await this.options.vault.ensureRevoked(this.options.instanceId, account.replyContext)
          await this.update(platform, account.accountId, ({ pair: _pair, replyContext: _context, ...current }) => current)
          return this.view(platform)
        }
        case 'qr-start': {
          if (platform !== 'wechat' || account) throw input()
          this.qr?.controller.abort()
          const qr = await startWechatLogin(this.options, this.stopping.signal)
          const qrImage = await toDataURL(qr.text, { width: 256, margin: 4, errorCorrectionLevel: 'M' }).catch(() => {
            qr.controller.abort()
            throw unavailable()
          })
          qr.text = ''
          this.qr = qr
          this.qrTask = this.runQr(qr)
          return { qrImage, expiresAt: qr.expiresAt }
        }
        case 'qr-verify': {
          const qr = this.qr
          if (platform !== 'wechat' || !qr || qr.state !== 'verify' || typeof rest.code !== 'string' || !/^\d{4,8}$/u.test(rest.code)) throw input()
          qr.submitCode(rest.code)
          return this.view(platform)
        }
        case 'qr-cancel': {
          if (platform !== 'wechat') throw input()
          this.qr?.controller.abort()
          this.qr = undefined
          return this.view(platform)
        }
        default: throw input()
      }
    })
  }

  isPaired(address: Omit<ImAddress, 'messageId'>): boolean {
    const account = this.accounts.get(address.platform)
    return !this.stopping.signal.aborted && this.pairGrants.has(address.platform)
      && account?.accountId === address.accountId && !account.removing && account.pair?.pairId === address.pairId && paired(account.pair, address)
  }

  statusSummary() {
    return { accounts: imPlatforms.map(platform => {
      const { state, configured, paired } = this.view(platform)
      return { platform, state, configured, paired }
    }) }
  }

  async send(address: ImAddress, text: string, key: string, signal: AbortSignal): Promise<string> {
    const runtime = this.runtimes.get(address.platform)
    const account = this.accounts.get(address.platform)
    const grant = this.pairGrants.get(address.platform)
    if (!account || !grant || !this.isPaired(address)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The messaging conversation is no longer paired.')
    }
    if (!runtime?.connection || runtime.state !== 'connected' || !runtime.activeSignal) throw unavailable()
    if (!text.trim() || !key || !required(address.messageId)) throw input()
    const connection = runtime.connection
    const active = AbortSignal.any([signal, runtime.activeSignal, grant.signal])
    if (!account.replyContext) return connection.send(address, text, key, active)
    const result = await this.options.vault.withSecret(this.options.instanceId, account.replyContext, async contextToken => {
      try { return await connection.send({ ...address, contextToken }, text, key, active) }
      catch (error) { return error instanceof CoreError ? error : unavailable() }
    })
    if (result instanceof CoreError) throw result
    return result
  }

  async close(): Promise<void> {
    this.stopping.abort()
    this.qr?.controller.abort()
    this.qr = undefined
    this.pairing.clear()
    for (const platform of imPlatforms) this.clearPairGrant(platform)
    await this.tail
    await Promise.all([...imPlatforms.map(platform => this.stop(platform)), this.qrTask])
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private clearPairGrant(platform: ImPlatform) {
    this.pairGrants.get(platform)?.abort()
    this.pairGrants.delete(platform)
  }

  private async add(platform: ImPlatform, credentials: Record<string, string>) {
    if (this.accounts.has(platform)) throw new CoreError('IM_ACCOUNT_EXISTS', 'Disconnect the existing account before signing in again.')
    const accountId = randomUUID()
    const reference = await this.options.vault.create(this.options.instanceId, JSON.stringify(credentials))
    const account = { accountId, reference }
    try {
      await this.options.storage.transaction(this.options.instanceId, tx => tx.insert(accountKind, platform, account))
    } catch (error) {
      const current = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<Account>(accountKind, platform)).catch(() => undefined)
      if (current?.reference !== reference) {
        if (!(error instanceof CoreError && error.code === 'COMMIT_UNKNOWN')) {
          await this.options.vault.ensureRevoked(this.options.instanceId, reference).catch(() => {})
        }
        throw error
      }
    }
    this.accounts.set(platform, account)
    if (!this.stopping.signal.aborted) this.start(platform, account)
  }

  private async update(platform: ImPlatform, accountId: string, change: (current: Account) => Account) {
    const account = await this.options.storage.transaction(this.options.instanceId, async tx => {
      const current = await tx.get<Account>(accountKind, platform)
      if (!current || current.accountId !== accountId) throw missing()
      const next = change(current)
      await tx.replace(accountKind, platform, next)
      return next
    })
    this.accounts.set(platform, account)
    return account
  }

  private async runQr(qr: WechatLogin) {
    try {
      const credentials = await qr.finish()
      if (!credentials) return
      await this.serialize(async () => {
        if (this.qr !== qr || qr.controller.signal.aborted || this.stopping.signal.aborted || this.now() >= qr.expiresAt) return
        await this.add('wechat', credentials)
        this.qr = undefined
      })
    } catch {
      if (!qr.controller.signal.aborted) qr.state = 'failed'
    }
  }

  private activePairing(platform: ImPlatform): Pairing | undefined {
    const challenge = this.pairing.get(platform)
    if (challenge && this.now() < challenge.expiresAt) return challenge
    this.pairing.delete(platform)
    return undefined
  }

  private view(platform: ImPlatform) {
    const account = this.accounts.get(platform)
    const runtime = this.runtimes.get(platform)
    const challenge = this.activePairing(platform)
    const qr = platform === 'wechat' ? this.qr : undefined
    return {
      platform, fields: platform === 'wechat' ? [] : this.adapters[platform].fields,
      state: account?.removing ? 'remove-pending' : runtime?.loginExpiresAt !== undefined && this.now() >= runtime.loginExpiresAt
        ? 'login-expired' : runtime?.state ?? 'disconnected',
      configured: Boolean(account), paired: Boolean(account?.pair && this.pairGrants.has(platform)),
      ...(runtime?.error ? { error: runtime.error } : {}),
      ...(runtime?.loginExpiresAt ? { loginExpiresAt: runtime.loginExpiresAt } : {}),
      ...(challenge ? { pairing: { expiresAt: challenge.expiresAt,
        ...(challenge.candidate ? { proposalId: challenge.proposalId, senderId: challenge.candidate.senderId } : {}) } } : {}),
      ...(qr ? { qrState: this.now() >= qr.expiresAt ? 'expired' : qr.state, qrExpiresAt: qr.expiresAt } : {}),
    }
  }

  private start(platform: ImPlatform, account: Account) {
    const runtime: Runtime = { controller: new AbortController(), state: 'connecting',
      loginExpiresAt: this.now() + loginLifetime, connection: undefined, activeSignal: undefined, task: Promise.resolve(), inbound: new Set() }
    this.runtimes.set(platform, runtime)
    runtime.task = this.run(platform, account, runtime)
  }

  private async stop(platform: ImPlatform) {
    const runtime = this.runtimes.get(platform)
    if (!runtime) return
    this.runtimes.delete(platform)
    runtime.controller.abort()
    await runtime.task
    await Promise.allSettled(runtime.inbound)
  }

  private async run(platform: ImPlatform, account: Account, runtime: Runtime) {
    const signal = AbortSignal.any([runtime.controller.signal, this.stopping.signal])
    let attempt = 0
    while (!signal.aborted) {
      let expires = runtime.loginExpiresAt === undefined ? undefined : AbortSignal.timeout(Math.max(1, runtime.loginExpiresAt - this.now()))
      const connectionLifetime = new AbortController()
      const connectionSignal = AbortSignal.any([signal, connectionLifetime.signal])
      runtime.activeSignal = connectionSignal
      const expire = () => connectionLifetime.abort()
      expires?.addEventListener('abort', expire, { once: true })
      try {
        const result = await this.options.vault.withSecret(this.options.instanceId, account.reference, async raw => {
          try { return await this.adapters[platform].connect(credentialsFrom(this.adapters[platform], JSON.parse(raw)), connectionSignal) }
          catch (error) { return error instanceof CoreError ? error : unavailable() }
        })
        if (result instanceof CoreError) throw result
        runtime.connection = result
        if (account.nativeId && account.nativeId !== result.account) throw new ImFailure('IM_AUTH_FAILED')
        if (!account.nativeId) {
          const nativeId = required(result.account)
          account = await this.update(platform, account.accountId, current => ({ ...current, nativeId }))
        }
        await result.receive({
          ready: () => {
            if (connectionSignal.aborted) return
            if (runtime.loginExpiresAt !== undefined && this.now() >= runtime.loginExpiresAt) { connectionLifetime.abort(); return }
            expires?.removeEventListener('abort', expire)
            expires = undefined
            runtime.loginExpiresAt = undefined
            runtime.state = 'connected'
            delete runtime.error
            attempt = 0
          },
          message: message => {
            if (runtime.state !== 'connected') throw unavailable()
            const pending = this.receive(platform, account.accountId, message, connectionSignal)
            runtime.inbound.add(pending)
            return pending.finally(() => runtime.inbound.delete(pending))
          },
          cursor: async () => this.accounts.get(platform)?.cursor,
          checkpoint: async cursor => {
            if (!connectionSignal.aborted && cursor.length <= 262_144) {
              await this.update(platform, account.accountId, current => ({ ...current, cursor }))
            }
          },
        }, connectionSignal)
        if (!signal.aborted) throw unavailable()
      } catch (error) {
        connectionLifetime.abort()
        if (signal.aborted) return
        if (runtime.loginExpiresAt !== undefined && (this.now() >= runtime.loginExpiresAt || expires?.aborted)) {
          runtime.state = 'login-expired'
          runtime.loginExpiresAt = undefined
          return
        }
        const code = error instanceof CoreError && ['IM_AUTH_FAILED', 'RESOURCE_UNAVAILABLE', 'CREDENTIAL_USE_FAILED'].includes(error.code)
          ? 'IM_AUTH_FAILED' : 'IM_UNAVAILABLE'
        runtime.error = code
        if (code === 'IM_AUTH_FAILED') {
          runtime.state = 'attention'
          runtime.loginExpiresAt = undefined
          return
        }
        runtime.state = 'retrying'
        const backoff = Math.min(1000 * 2 ** Math.min(attempt++, 5), 30_000)
        const remaining = runtime.loginExpiresAt === undefined ? 300_000 : Math.max(1, runtime.loginExpiresAt - this.now())
        const retryAfter = error instanceof ImFailure ? error.retryAfterMs ?? 0 : 0
        await pause(Math.min(Math.max(backoff, retryAfter), remaining), signal).catch(() => {})
      } finally {
        expires?.removeEventListener('abort', expire)
        connectionLifetime.abort()
        runtime.connection?.stop?.()
        runtime.connection = undefined
        runtime.activeSignal = undefined
      }
    }
  }

  private async receive(platform: ImPlatform, accountId: string, message: NativeImMessage, signal: AbortSignal) {
    const account = this.accounts.get(platform)
    if (signal.aborted || this.stopping.signal.aborted || account?.accountId !== accountId || account.removing) return
    const match = /^pair\s+(\d{8})$/iu.exec(message.text.trim())
    if (match) {
      const challenge = this.activePairing(platform)
      if (!account.pair && challenge && !challenge.candidate && match[1] === challenge.code) {
        challenge.code = ''
        challenge.candidate = { senderId: message.senderId, conversationId: message.conversationId }
      }
      return
    }
    const { contextToken, ...incoming } = message
    if (!account.pair) return
    const address = { platform, accountId, pairId: account.pair.pairId, ...incoming }
    if (!this.isPaired(address)) return
    if (contextToken) await this.rememberReplyContext(account, address, contextToken)
    if (!signal.aborted && this.isPaired(address)) await this.options.onMessage(address)
  }

  private async rememberReplyContext(account: Account, address: ImAddress, token: string) {
    const { platform, accountId } = address
    if (account.replyContext) {
      const current = await this.options.vault.withSecret(this.options.instanceId, account.replyContext, async value => value === token).catch(() => false)
      if (current) return
    }
    const reference = await this.options.vault.create(this.options.instanceId, token)
    try {
      if (!this.isPaired(address)) throw unavailable()
      await this.update(platform, accountId, current => {
        if (!this.isPaired(address) || current.pair?.pairId !== address.pairId || !paired(current.pair, address)) throw unavailable()
        return { ...current, replyContext: reference }
      })
    } catch (error) {
      if (!(error instanceof CoreError && error.code === 'COMMIT_UNKNOWN')) {
        await this.options.vault.ensureRevoked(this.options.instanceId, reference).catch(() => {})
      }
      throw error
    }
    if (account.replyContext) await this.options.vault.ensureRevoked(this.options.instanceId, account.replyContext)
  }
}
