// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/host/computer/{index,leases,catalog}.js.
import { randomUUID } from 'node:crypto'
import type { BrowserWork } from './browser-resources.js'
import type { Assignment } from './execution.js'
import { CoreError, identifier, type Work } from './model.js'
import type { NativeTool } from './native-sessions.js'
import type { AsyncTx, Storage } from './storage.js'
import type { MainWorkBrief, MainWorkItem } from './work-delegation.js'

export const computerFields = {
  'computer-status': ['instanceId'],
  'computer-policy': ['instanceId', 'operation', 'enabled', 'appId', 'level'],
  'computer-control': ['instanceId', 'operation', 'leaseId', 'appId', 'operationId'],
} as const

type ComputerEndpoint = keyof typeof computerFields
type Level = 'view' | 'background' | 'foreground'
type Action = 'windows' | 'snapshot' | 'click' | 'type' | 'activate'
type InputAction = Exclude<Action, 'windows' | 'snapshot'>
type ProviderStatus = 'ready' | 'unavailable' | 'permission-required'
const levels = { view: 0, background: 1, foreground: 2 } as const
const actions = { windows: 0, snapshot: 0, click: 1, type: 1, activate: 2 } as const
const leaseMs = 60_000
const maxPendingInputs = 100

export interface ComputerScope extends BrowserWork { sessionId: string }
export interface ComputerApp { id: string; name: string }
export interface ComputerAction { appId: string; action: Action; windowId?: number; point?: { x: number; y: number }; text?: string }
export interface ComputerResult {
  windows?: { windowId: number; onScreen: boolean }[]
  screenshot?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
}
interface PendingInput {
  kind: 'pending-input'
  operationId: string
  appId: string
  appName: string
  action: InputAction
  workItemId: string
  recordedAt: number
}
type LaunchInput = <Result>(dispatch: () => Promise<Result>) => Promise<Result>
export interface ComputerAdapter {
  status(signal: AbortSignal): Promise<ProviderStatus>
  apps(signal: AbortSignal): Promise<ComputerApp[]>
  approve(request: { app: ComputerApp; level: Level; workItemId: string; generation: string }, signal: AbortSignal): Promise<boolean>
  reconcile(request: PendingInput, signal: AbortSignal): Promise<boolean>
  indicator(active: boolean, stop?: () => void): Promise<boolean>
  execute(action: ComputerAction, signal: AbortSignal, authorize: () => Promise<void>, launchInput: LaunchInput): Promise<ComputerResult>
}

interface Lease {
  id: string
  scope: ComputerScope
  app: ComputerApp
  level: Level
  abort: AbortController
  state: 'approving' | 'active' | 'human'
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  flight?: boolean
  observed?: number
  screenshot?: ComputerResult['screenshot']
}

const denied = () => new CoreError('COMPUTER_NOT_AUTHORIZED', 'Computer control requires a current local Worker, an allowed application, and local approval.')
const unavailable = () => new CoreError('COMPUTER_UNAVAILABLE', 'The native computer driver is unavailable on this desktop.')
const permission = () => new CoreError('COMPUTER_PERMISSION_REQUIRED', 'Grant the required desktop permissions locally before continuing.')
const pendingInput = () => new CoreError('COMPUTER_OUTCOME_UNKNOWN', 'Input may have reached this application. Inspect it and reconcile the pending action locally before granting access again.')
const inputKey = (appId: string) => `pending-input:${appId}`
const sameScope = (left: ComputerScope, right: ComputerScope) => left.instanceId === right.instanceId
  && left.ticketId === right.ticketId && left.workItemId === right.workItemId && left.assignmentId === right.assignmentId
  && left.generation === right.generation && left.sessionId === right.sessionId && left.environmentId === right.environmentId

export class ProductComputer {
  private enabled = false
  private closed = false
  private policyRevision = 0
  private readonly allowed = new Map<string, ComputerApp & { level: Level }>()
  private lease: Lease | undefined
  private busy = false
  private statusValue: ProviderStatus = 'unavailable'
  private denial: { generation: string; until: number } | undefined

  constructor(private readonly config: { instanceId: string; storage: Storage; adapter: () => ComputerAdapter | undefined }) {}

  private async current(scope: ComputerScope, tx?: AsyncTx): Promise<void> {
    if (this.closed || scope.instanceId !== this.config.instanceId) throw denied()
    if (!tx) return this.config.storage.transaction(scope.instanceId, transaction => this.current(scope, transaction))
    const assignment = await tx.get<Assignment>('assignment', scope.ticketId)
    const ticket = await tx.get<Work['ticket']>('ticket', scope.ticketId)
    const link = await tx.get<{ workBriefId: string; workItemId: string }>('work-ticket', scope.ticketId)
    const work = await tx.get<MainWorkItem>('work-item', scope.workItemId)
    const brief = work ? await tx.get<MainWorkBrief>('work-brief', work.workBriefId) : undefined
    if (ticket?.state !== 'open' || ticket.constraint || !link || link.workItemId !== scope.workItemId
      || !work || !brief || link.workBriefId !== brief.id || brief.instanceId !== scope.instanceId
      || brief.environmentId !== scope.environmentId || assignment?.state !== 'running'
      || assignment.id !== scope.assignmentId || assignment.generation !== scope.generation || assignment.sessionId !== scope.sessionId
      || assignment.environment?.kind !== 'local' || assignment.environment.id !== scope.environmentId) throw denied()
  }

  private readPending(appId: string) {
    return this.config.storage.transaction(this.config.instanceId, tx => tx.get<PendingInput>('computer-policy', inputKey(appId)))
  }

  private clearPending(pending: PendingInput) {
    const key = inputKey(pending.appId)
    return this.config.storage.transaction(this.config.instanceId, async tx => {
      if ((await tx.get<PendingInput>('computer-policy', key))?.operationId !== pending.operationId) throw denied()
      await tx.remove('computer-policy', key)
    })
  }

  private async reconcile(appId: unknown, operationId: unknown) {
    identifier(appId, 'appId')
    identifier(operationId, 'operationId')
    if (this.busy || this.lease?.app.id === appId && this.lease.state !== 'human') throw denied()
    const adapter = this.config.adapter()
    if (!adapter) throw unavailable()
    this.busy = true
    try {
      const pending = await this.readPending(appId)
      if (!pending || pending.operationId !== operationId) throw denied()
      if (await adapter.reconcile(pending, AbortSignal.timeout(60_000)) && !this.closed) await this.clearPending(pending)
    } finally { this.busy = false }
  }

  private async driver(signal: AbortSignal) {
    const adapter = this.config.adapter()
    if (!adapter || !this.enabled || this.closed) throw unavailable()
    signal.throwIfAborted()
    this.statusValue = await adapter.status(signal)
    signal.throwIfAborted()
    if (this.statusValue === 'permission-required') throw permission()
    if (this.statusValue !== 'ready') throw unavailable()
    return adapter
  }

  private cancel(hold = false) {
    const lease = this.lease
    if (!lease) return
    clearTimeout(lease.timer)
    lease.abort.abort(new CoreError('COMPUTER_INTERRUPTED', 'Computer control stopped. Input already sent cannot be undone.'))
    delete lease.screenshot
    if (hold) lease.state = 'human'
    else this.lease = undefined
    void this.config.adapter()?.indicator(false).catch(() => {})
  }

  private async view() {
    const stored = await this.config.storage.transaction(this.config.instanceId, tx => tx.list<PendingInput>('computer-policy', maxPendingInputs))
    const pending = stored.filter(record => record.kind === 'pending-input')
    const lease = this.lease
    const available = Boolean(this.config.adapter())
    return { available, enabled: this.enabled, provider: available ? (this.enabled ? this.statusValue : 'off') : 'unavailable',
      apps: [...this.allowed.values()], pending, ...(lease ? { lease: { id: lease.id, app: lease.app, level: lease.level,
        workItemId: lease.scope.workItemId, state: lease.state, expiresAt: lease.expiresAt,
        ...(lease.screenshot !== undefined ? { screenshot: lease.screenshot } : {}) } } : {}) }
  }

  async dispatch(endpoint: string, payload: Record<string, unknown>, remote: boolean): Promise<unknown> {
    if (remote || payload.instanceId !== this.config.instanceId) throw denied()
    const fields: readonly string[] | undefined = Object.hasOwn(computerFields, endpoint) ? computerFields[endpoint as ComputerEndpoint] : undefined
    if (!fields || Object.keys(payload).some(key => !fields.includes(key))) throw new CoreError('INVALID_INPUT', 'Unsupported computer control request.')
    if (this.closed) throw unavailable()
    if (this.lease && this.lease.state !== 'human') {
      const lease = this.lease
      try { await this.current(lease.scope) } catch { if (this.lease === lease) this.cancel() }
    }
    if (endpoint === 'computer-status') return this.view()
    if (endpoint === 'computer-control') {
      if (payload.operation === 'reconcile') {
        await this.reconcile(payload.appId, payload.operationId)
        return this.view()
      }
      const lease = this.lease
      if (!lease || payload.leaseId !== lease.id) throw denied()
      if (payload.operation === 'takeover' && lease.state !== 'human') this.cancel(true)
      else if (payload.operation === 'stop' || payload.operation === 'return' && lease.state === 'human') this.cancel()
      else throw new CoreError('INVALID_INPUT', 'Unsupported computer control action.')
      return this.view()
    }
    if (payload.operation === 'enable' && typeof payload.enabled === 'boolean') {
      if (payload.enabled && !this.config.adapter()) throw unavailable()
      this.enabled = payload.enabled
      ++this.policyRevision
      if (!this.enabled) { this.cancel(); this.statusValue = 'unavailable' }
      return this.view()
    }
    if (payload.operation === 'revoke') {
      const id = payload.appId
      identifier(id, 'appId')
      this.allowed.delete(id)
      ++this.policyRevision
      if (this.lease?.app.id === id) this.cancel()
      return this.view()
    }
    if (payload.operation !== 'apps' && payload.operation !== 'allow' && payload.operation !== 'probe') throw new CoreError('INVALID_INPUT', 'Unsupported computer policy action.')
    const revision = this.policyRevision
    const signal = AbortSignal.timeout(15_000)
    if (payload.operation === 'probe') {
      const adapter = this.config.adapter()
      if (!this.enabled || !adapter) throw unavailable()
      const status = await adapter.status(signal)
      if (revision === this.policyRevision) this.statusValue = status
      return this.view()
    }
    const adapter = await this.driver(signal)
    const discovered = await adapter.apps(signal)
    if (!this.enabled || this.closed || revision !== this.policyRevision) throw denied()
    if (payload.operation === 'apps') return { ...await this.view(), discovered }
    const level = payload.level as Level
    if (!Object.hasOwn(levels, level)) throw new CoreError('INVALID_INPUT', 'Unknown computer control level.')
    const app = discovered.find(candidate => candidate.id === payload.appId)
    if (!app || !this.allowed.has(app.id) && this.allowed.size >= 24) throw denied()
    this.allowed.set(app.id, { ...app, level })
    ++this.policyRevision
    if (this.lease?.app.id === app.id) this.cancel()
    return this.view()
  }

  private async request(scope: ComputerScope, appId: string, workerSignal: AbortSignal) {
    await this.current(scope)
    workerSignal.throwIfAborted()
    const grant = this.allowed.get(appId)
    if (!this.enabled || !grant || this.lease || this.busy || this.denial?.generation === scope.generation && this.denial.until > Date.now()) throw denied()
    const abort = new AbortController()
    const timer = setTimeout(() => { if (this.lease?.abort === abort) this.cancel() }, leaseMs)
    timer.unref()
    const lease: Lease = { id: randomUUID(), scope, app: { id: grant.id, name: grant.name }, level: grant.level,
      abort, state: 'approving', timer, expiresAt: Date.now() + leaseMs }
    this.lease = lease
    this.busy = true
    const onWorkerStop = () => { if (this.lease === lease) this.cancel() }
    workerSignal.addEventListener('abort', onWorkerStop, { once: true, signal: abort.signal })
    const signal = AbortSignal.any([workerSignal, abort.signal])
    try {
      if (await this.readPending(appId)) throw pendingInput()
      const adapter = await this.driver(signal)
      const approved = await adapter.approve({ app: lease.app, level: lease.level, workItemId: scope.workItemId, generation: scope.generation }, signal)
      if (!approved) { this.denial = { generation: scope.generation, until: Date.now() + leaseMs }; throw denied() }
      await this.current(scope)
      signal.throwIfAborted()
      const shown = await adapter.indicator(true, () => { if (this.lease === lease) this.cancel() })
      signal.throwIfAborted()
      if (!shown || this.lease !== lease) throw unavailable()
      lease.state = 'active'
      return JSON.stringify({ leaseId: lease.id, app: lease.app, level: lease.level, expiresAt: lease.expiresAt })
    } catch (error) {
      this.cancelFailed(lease)
      throw error
    } finally { this.busy = false }
  }

  private async use(scope: ComputerScope, input: Record<string, unknown>, workerSignal: AbortSignal) {
    const lease = this.lease
    const action = input.action as Action
    if (!lease || lease.state !== 'active' || input.leaseId !== lease.id || !sameScope(lease.scope, scope)
      || Date.now() >= lease.expiresAt || !Object.hasOwn(actions, action) || levels[lease.level] < actions[action]) throw denied()
    if (this.busy || lease.flight) throw new CoreError('COMPUTER_BUSY', 'Wait for the current computer action to finish.')
    const request: ComputerAction = { appId: lease.app.id, action }
    if (action !== 'windows') {
      if (typeof input.windowId !== 'number' || !Number.isSafeInteger(input.windowId) || input.windowId <= 0) throw denied()
      request.windowId = input.windowId
    }
    if (actions[action] > 0 && lease.observed !== request.windowId) throw new CoreError('COMPUTER_SNAPSHOT_REQUIRED', 'Read a fresh snapshot of the approved window before sending input.')
    if (action === 'click') {
      if (typeof input.x !== 'number' || typeof input.y !== 'number' || ![input.x, input.y].every(value => Number.isInteger(value) && value >= 0 && value <= 16384)) throw denied()
      request.point = { x: input.x, y: input.y }
    }
    if (action === 'type') {
      if (typeof input.text !== 'string' || !input.text.length || input.text.length > 2048 || /\p{Cc}/u.test(input.text)) throw denied()
      request.text = input.text
    }
    if (actions[action] > 0) delete lease.observed
    const signal = AbortSignal.any([workerSignal, lease.abort.signal, AbortSignal.timeout(15_000)])
    lease.flight = true
    this.busy = true
    const authorize = async () => {
      signal.throwIfAborted()
      if (this.lease !== lease || lease.state !== 'active' || !this.enabled) throw denied()
      await this.current(scope)
      signal.throwIfAborted()
      if (this.lease !== lease || lease.state !== 'active' || !this.enabled) throw denied()
    }
    let unconfirmed = false
    let launched = false
    const launchInput: LaunchInput = async dispatch => {
      if (action === 'windows' || action === 'snapshot' || launched) throw denied()
      const pending: PendingInput = { kind: 'pending-input', operationId: randomUUID(), appId: lease.app.id,
        appName: lease.app.name, action, workItemId: scope.workItemId, recordedAt: Date.now() }
      const key = inputKey(pending.appId)
      await this.config.storage.transaction(scope.instanceId, async tx => {
        await this.current(scope, tx)
        if (await tx.get<PendingInput>('computer-policy', key)) throw pendingInput()
        if ((await tx.list<PendingInput>('computer-policy', maxPendingInputs)).length >= maxPendingInputs) {
          throw new CoreError('COMPUTER_OUTCOME_UNKNOWN', 'Review pending computer actions locally before sending more input.')
        }
        signal.throwIfAborted()
        if (this.lease !== lease || lease.state !== 'active' || !this.enabled) throw denied()
        await tx.insert('computer-policy', key, pending)
        unconfirmed = true
      })
      if (signal.aborted) {
        await this.clearPending(pending)
        unconfirmed = false
        signal.throwIfAborted()
      }
      launched = true
      const result = await dispatch()
      await this.clearPending(pending)
      unconfirmed = false
      return result
    }
    try {
      await authorize()
      const adapter = await this.driver(signal)
      await authorize()
      const result = await adapter.execute(request, signal, authorize, launchInput)
      await authorize()
      if (action === 'windows') return JSON.stringify({ windows: (result.windows ?? []).slice(0, 100)
        .filter(window => Number.isSafeInteger(window.windowId) && window.windowId > 0)
        .map(window => ({ windowId: window.windowId, onScreen: window.onScreen === true })) })
      if (action === 'snapshot') {
        lease.observed = request.windowId!
        if (result.screenshot) lease.screenshot = result.screenshot
        else delete lease.screenshot
        return 'The approved window was captured. The screenshot is available only in local computer settings.'
      }
      if (!launched) throw unavailable()
      return 'Input was dispatched. Inspect the result in the approved application.'
    } catch (error) {
      this.cancelFailed(lease)
      if (unconfirmed) throw pendingInput()
      if (error instanceof CoreError) throw error
      throw unavailable()
    } finally { lease.flight = false; this.busy = false }
  }

  tools(resolveScope: () => Promise<ComputerScope>, turnSignal: AbortSignal): NativeTool[] {
    if (!this.config.adapter()) return []
    const scope = async (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!this.enabled) throw unavailable()
      return resolveScope()
    }
    return [{
      name: 'computer_apps', description: 'List applications the local user has added to the computer-control allowlist.', parameters: {},
      execute: async (_args, signal) => { const current = await scope(signal); await this.current(current); return JSON.stringify([...this.allowed.values()]) },
    }, {
      name: 'computer_request', description: 'Request local approval for the exact current Worker and one allowlisted app. Use only for an explicit productivity task; do not ask repeatedly after a denial. Hand payment, sign-in, security prompts, and consequential actions to the human.',
      parameters: { appId: { type: 'string', required: true } },
      execute: async (args, signal) => {
        const appId: unknown = args.appId
        identifier(appId, 'appId')
        return this.request(await scope(signal), appId, AbortSignal.any([signal, turnSignal]))
      },
    }, {
      name: 'computer_use', description: 'Use an approved app with a current lease. List its windows, then read a fresh window snapshot before typing, clicking, or requesting foreground activation. Do not use the desktop for security settings, credentials, payments, destructive actions, or circumvention. Await fresh state after input; dispatched does not mean applied.',
      parameters: { leaseId: { type: 'string', required: true }, action: { type: 'string', enum: ['windows', 'snapshot', 'click', 'type', 'activate'], required: true },
        windowId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } },
      execute: async (args, signal) => this.use(await scope(signal), args, AbortSignal.any([signal, turnSignal])),
    }]
  }

  private cancelFailed(lease: Lease) { if (this.lease === lease && lease.state !== 'human') this.cancel() }

  endTurn(scope: { assignmentId: string; generation: string }) {
    if (this.lease?.scope.assignmentId === scope.assignmentId && this.lease.scope.generation === scope.generation && this.lease.state !== 'human') this.cancel()
  }

  close() { this.closed = true; this.cancel(); this.allowed.clear() }
}
