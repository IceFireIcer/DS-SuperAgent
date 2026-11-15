import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier, type DesktopSource } from './model.js'
import type { NativeSessions, NativeTool } from './native-sessions.js'
import type { AsyncTx, Storage } from './storage.js'
import type { RoleProfile } from './config.js'
import type { ContextRef } from './context.js'
import type { MainWorkCard, MainWorkHandoff, MainWorkIntent, MainWorkNotification, WorkDelegation } from './work-delegation.js'
import type { MainSourceHandoff, MainSourceView } from './main-source.js'

export interface MainBinding { instanceId: string; mainId: string; mainSessionId: string; routerSessionId: string; generation: number }
interface MainState extends MainBinding { sequence: number; activeCommand?: string }
export type MainMessageStatus = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'interrupted' | 'failed'
export interface MainExternalSource {
  kind: 'github' | 'feishu'
  sourceInstanceId: string
  eventId: string
  objectId: string
  threadId: string
  authorId: string
  reference: string
}
export type MainMessageSource = MainExternalSource | { kind: 'client'; clientId: string }
export interface MainMessage {
  id: string
  sequence: number
  role: 'user' | 'main' | 'system'
  text: string
  createdAt: number
  status: MainMessageStatus
  error?: string
  source?: MainMessageSource
}
export interface MainTurnStop {
  id: string
  version: 1
  instanceId: string
  commandId: string
  commandKey: string
  messageId: string
  status: 'stopping' | 'stopped'
  confirmation?: 'runtime-cancelled' | 'turn-ended' | 'host-restart'
  requestedAt: number
  confirmedAt?: number
}
export interface MainTurnView { messageId: string; status: 'running' | 'stopping' | 'stopped'; stop?: MainTurnStop }
interface MainCommand {
  fingerprint: string
  messageId: string
  userSequence: number
  environmentId?: string | null
  status: MainMessage['status']
  replySequence?: number
  attempts?: number
  updatedAt?: number
  error?: string
  run?: { attempts: number; messageId: string; sessionId: string; generation: number; startedAt: number }
}
interface MainUpdateCommand {
  attempt: number
  state: 'running' | 'failed' | 'completed' | 'discarded' | 'interrupted'
  messageId: string
  sequence?: number
  updatedAt?: number
  error?: string
  run?: { sessionId: string; generation: number }
}
interface MainSourceCommand {
  state: 'running' | 'failed' | 'completed'
  handoffId: string
  messageId: string
  turnMessageId: string
  userSequence: number
  sessionId: string
  sessionGeneration: number
  attempt: number
}
interface MainSourceRollover {
  id: string
  version: 1
  instanceId: string
  mainId: string
  handoffId: string
  sourceCommandKey: string
  previousSessionId: string
  sessionId: string
  previousGeneration: number
  sessionGeneration: number
  previousTurnMessageId: string
  turnMessageId: string
  attempt: number
  reason: 'CONTEXT_WINDOW'
  createdAt: number
}
interface MainActiveCommand {
  key: string
  userSequence: number
  status: 'queued' | 'running'
}
interface MainHealthHead {
  queuedInputs: number
  failedInputs: number
  lastStatus?: MainMessage['status']
  errorCode?: string
  updatedAt: number
}
export interface MainHealth {
  state: 'ready' | 'running' | 'degraded'
  queuedInputs: number
  failedInputs: number
  updatedAt: number
  errorCode?: string
}
export interface MainAddress { instanceId: string }
export interface MainSend extends MainAddress { commandId: string; text: string; environmentId?: string; clientId?: string }
export interface MainSessionRollover {
  id: string
  mainId: string
  previousSessionId: string
  sessionId: string
  generation: number
  forked: boolean
  workIndex: MainWorkHandoff['workIndex']
  evidenceRefs: ContextRef[]
  unreadInputs: { id: string; sequence: number; text: string }[]
  unreadInputCount: number
  unreadInputsTruncated: boolean
  createdAt: number
}
export interface MainPage extends MainBinding {
  messages: MainMessage[]
  health: MainHealth
  cursor?: number
  works?: MainWorkCard[]
  activeTurn?: MainTurnView
  sources?: MainSourceView[]
  mainRollover?: MainSessionRollover
}
export interface MainRunResult extends MainBinding { messageId: string; status: MainMessage['status'] }
interface MainEvent { type: string; data: { id?: string; message?: { content?: { type: string; text?: string }[] }; reason?: { kind?: string } } }
const messageKey = (sequence: number) => String(sequence).padStart(16, '0')
const sourceRecoveryMessageId = (handoffId: string, generation: number, attempt: number) =>
  `main-source-recovery:${handoffId}:g${generation}:${attempt}`
const activeCommandKey = (sequence: number, key: string) => JSON.stringify(['main-active-command', messageKey(sequence), key])
const reconcileCommandKey = (key: string) => JSON.stringify(['main-reconcile-command', key])

/** Business facts stay separate from the native Session; no transaction spans a model turn. */
export class MainConversation {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly scheduled = new Map<string, Promise<MainRunResult>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  private closed = false
  private closingTurn: Promise<void> | undefined
  private pendingTurns = 0
  private readonly turnControllers = new Map<string, AbortController>()
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly source: DesktopSource,
    private readonly sessions?: NativeSessions,
    private readonly prepare?: (sessionId: string) => Promise<{ profile: RoleProfile; revision: number }>,
    private readonly work?: () => WorkDelegation | undefined,
    private readonly defaultEnvironment?: (transaction: AsyncTx) => Promise<string | undefined>) {}

  private authorize(request: MainAddress) {
    if (!request || request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This Main conversation is outside the authorized Instance.')
    }
    if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The Main conversation is closed.')
  }

  private async state(tx: AsyncTx): Promise<MainState> {
    const prior = await tx.get<MainState>('main-state', 'main')
    if (prior) {
      if (!Number.isSafeInteger(prior.generation) || prior.generation < 0) {
        const migrated = { ...prior, generation: 0 }
        await tx.replace('main-state', 'main', migrated)
        return migrated
      }
      return prior
    }
    const initial: MainState = { instanceId: this.instanceId, mainId: `main-${randomUUID()}`, mainSessionId: `main-session-${randomUUID()}`,
      routerSessionId: `router-${randomUUID()}`, generation: 0, sequence: 0 }
    await tx.insert('main-state', 'main', initial)
    return initial
  }

  private async healthHead(tx: AsyncTx): Promise<MainHealthHead> {
    return await tx.get<MainHealthHead>('main-health', 'main') ?? { queuedInputs: 0, failedInputs: 0, updatedAt: 0 }
  }

  private async saveHealthHead(tx: AsyncTx, health: MainHealthHead) {
    if (!await tx.replace('main-health', 'main', health)) await tx.insert('main-health', 'main', health)
  }

  private async updateHealthTransition(tx: AsyncTx, before: MainCommand['status'] | undefined,
    after: MainCommand['status'], error?: string) {
    const health = await this.healthHead(tx)
    const next: MainHealthHead = {
      ...health,
      queuedInputs: Math.max(0, health.queuedInputs + (after === 'queued' ? 1 : 0) - (before === 'queued' ? 1 : 0)),
      failedInputs: Math.max(0, health.failedInputs + (after === 'failed' ? 1 : 0) - (before === 'failed' ? 1 : 0)),
      lastStatus: after,
      updatedAt: Date.now(),
      ...(error ? { errorCode: error } : {}),
    }
    if (!error) delete next.errorCode
    await this.saveHealthHead(tx, next)
  }

  private async updateHealthState(tx: AsyncTx, status: MainHealthHead['lastStatus'], error?: string) {
    const health = await this.healthHead(tx)
    const next: MainHealthHead = { ...health, ...(status ? { lastStatus: status } : {}), updatedAt: Date.now(),
      ...(error ? { errorCode: error } : {}) }
    if (!error) delete next.errorCode
    await this.saveHealthHead(tx, next)
  }

  private async activeCommand(tx: AsyncTx, command: MainCommand & { key: string }) {
    const active: MainActiveCommand = { key: command.key, userSequence: command.userSequence, status: 'queued' }
    const id = activeCommandKey(command.userSequence, command.key)
    if (!await tx.replace('main-active-command', id, active)) await tx.insert('main-active-command', id, active)
  }

  private async runningCommand(tx: AsyncTx, command: MainCommand & { key: string }) {
    const active: MainActiveCommand = { key: command.key, userSequence: command.userSequence, status: 'running' }
    const id = activeCommandKey(command.userSequence, command.key)
    if (!await tx.replace('main-active-command', id, active)) await tx.insert('main-active-command', id, active)
  }

  private async removeActiveCommand(tx: AsyncTx, command: MainCommand, key: string) {
    await tx.remove('main-active-command', activeCommandKey(command.userSequence, key))
  }

  private async reconcileIndex(tx: AsyncTx, command: MainCommand, key: string, present: boolean) {
    const id = reconcileCommandKey(key)
    if (present) {
      const value = { key, userSequence: command.userSequence }
      if (!await tx.replace('main-reconcile-command', id, value)) await tx.insert('main-reconcile-command', id, value)
    } else await tx.remove('main-reconcile-command', id)
  }

  private async health(tx: AsyncTx, state: MainState): Promise<MainHealth> {
    const head = await this.healthHead(tx)
    return {
      state: state.activeCommand || head.queuedInputs || head.lastStatus === 'queued' || head.lastStatus === 'running'
        ? 'running' : head.lastStatus === 'failed' ? 'degraded' : 'ready',
      queuedInputs: head.queuedInputs,
      failedInputs: head.failedInputs,
      updatedAt: head.updatedAt || Date.now(),
      ...(head.errorCode ? { errorCode: head.errorCode } : {}),
    }
  }

  private binding(state: MainState): MainBinding {
    return { instanceId: state.instanceId, mainId: state.mainId, mainSessionId: state.mainSessionId,
      routerSessionId: state.routerSessionId, generation: state.generation }
  }

  private async latestRollover(tx: AsyncTx): Promise<MainSessionRollover | undefined> {
    let latest: MainSessionRollover | undefined
    let after: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await tx.scan<MainSessionRollover>('main-session-rollover', { limit: 100,
        ...(after === undefined ? {} : { after }) })
      for (const item of page.items) if (!latest || item.value.createdAt > latest.createdAt) latest = item.value
      if (!page.cursor) break
      after = page.cursor
      if (pageCount === 9) throw new CoreError('MAIN_ROLLOVER_BUDGET', 'Main rollover history exceeds its 1000-record budget.')
    }
    return latest
  }

  async open(request: MainAddress): Promise<MainBinding> {
    this.authorize(request)
    if (!this.sessions?.mainRoute) throw new CoreError('ROLE_NOT_CONFIGURED', 'Main needs its own explicit model route.')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const { sequence: _sequence, activeCommand: _active, ...binding } = await this.state(tx)
      return binding
    })
  }

  async page(request: MainAddress & { after?: number; limit?: number }): Promise<MainPage> {
    this.authorize(request)
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) {
      throw new CoreError('INVALID_INPUT', 'Main history needs a bounded page and non-negative cursor.')
    }
    await this.reconcileRecoverable()
    const state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
    if (state.activeCommand) await this.reconcile(state, state.activeCommand)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await this.state(tx)
      const { sequence: _sequence, activeCommand: _active, ...binding } = current
      const page = await tx.scan<MainMessage>('main-message', { limit, ...(request.after === undefined ? {} : { after: messageKey(request.after) }) })
      const activeTurn = current.activeCommand ? await this.activeTurnIn(tx, current.activeCommand) : undefined
      const mainRollover = await this.latestRollover(tx)
      return { ...binding, messages: page.items.map(item => item.value), health: await this.health(tx, current),
        ...(mainRollover ? { mainRollover } : {}),
        ...(page.cursor ? { cursor: Number(page.cursor) } : {}),
        ...(activeTurn ? { activeTurn } : {}) }
    })
  }

  async recentPage(request: MainAddress & { before?: number; limit?: number }): Promise<MainPage> {
    this.authorize(request)
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || request.before !== undefined
      && (!Number.isSafeInteger(request.before) || request.before < 1)) {
      throw new CoreError('INVALID_INPUT', 'Recent Main history needs a bounded page and a positive before cursor.')
    }
    await this.reconcileRecoverable()
    const state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
    if (state.activeCommand) await this.reconcile(state, state.activeCommand)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await this.state(tx)
      const { sequence: _sequence, activeCommand: _active, ...binding } = current
      const end = request.before ?? current.sequence + 1
      if (end > current.sequence + 1) throw new CoreError('INVALID_INPUT', 'The Main history cursor is ahead of the durable conversation.')
      const start = Math.max(1, end - limit)
      const messages: MainMessage[] = []
      for (let sequence = start; sequence < end; sequence++) {
        const message = await tx.get<MainMessage>('main-message', messageKey(sequence))
        if (message) messages.push(message)
      }
      const activeTurn = current.activeCommand ? await this.activeTurnIn(tx, current.activeCommand) : undefined
      const mainRollover = await this.latestRollover(tx)
      return { ...binding, messages, health: await this.health(tx, current), ...(mainRollover ? { mainRollover } : {}),
        ...(start > 1 ? { cursor: start } : {}),
        ...(activeTurn ? { activeTurn } : {}) }
    })
  }

  async send(request: MainSend) {
    this.authorize(request)
    identifier(request.commandId, 'commandId')
    if (request.clientId !== undefined) identifier(request.clientId, 'clientId')
    if (request.environmentId !== undefined) identifier(request.environmentId, 'environmentId')
    if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 32768) throw new CoreError('INVALID_INPUT', 'Send a nonempty Main message of at most 32768 bytes.')
    const binding = await this.open(request)
    const key = createHash('sha256').update(canonicalJson(request.clientId
      ? [this.source.sourceInstanceId, this.source.actorId, request.clientId, request.commandId]
      : [this.source.sourceInstanceId, this.source.actorId, request.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson([request.instanceId, request.text,
      ...(request.environmentId === undefined ? [] : [request.environmentId]),
      ...(request.clientId === undefined ? [] : [request.clientId])])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainCommand>('main-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This Main message identity was already used for different text.')
        if (prior.status === 'queued' || prior.status === 'running') await this.activeCommand(tx, { ...prior, key })
        else if (prior.status === 'failed' || prior.status === 'interrupted') {
          const { error: _error, ...current } = prior
          await this.updateCommandIn(tx, key, { ...current, status: 'queued', updatedAt: Date.now() })
        }
        return
      }
      const state = await this.state(tx)
      const sequence = state.sequence + 1
      const messageId = `main-input-${randomUUID()}`
      const environmentId = request.environmentId ?? await this.defaultEnvironment?.(tx) ?? null
      await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: messageId, sequence, role: 'user', text: request.text,
        createdAt: Date.now(), status: 'queued', ...(request.clientId ? { source: { kind: 'client', clientId: request.clientId } as const } : {}) })
      const command: MainCommand = { fingerprint, messageId, userSequence: sequence, status: 'queued', updatedAt: Date.now(),
        environmentId }
      await tx.insert<MainCommand>('main-command', key, command)
      await tx.insert('main-message-command', messageId, { commandKey: key })
      await this.activeCommand(tx, { ...command, key })
      const health = await this.healthHead(tx)
      await this.saveHealthHead(tx, { ...health, queuedInputs: health.queuedInputs + 1, lastStatus: 'queued', updatedAt: Date.now() })
      await tx.replace('main-state', 'main', { ...state, sequence })
    })
    return this.enqueue(binding, key, request.text)
  }

  async resume(request: MainAddress) {
    this.authorize(request)
    const commands: { key: string; command: MainCommand; text: string }[] = []
    await commandTransaction(this.storage, this.instanceId, async tx => {
      let after: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<MainActiveCommand>('main-active-command', { limit: 100, ...(after === undefined ? {} : { after }) })
        for (const item of page.items) {
          const command = await tx.get<MainCommand>('main-command', item.value.key)
          if (!command || command.status !== 'queued' && command.status !== 'running') {
            await tx.remove('main-active-command', item.id)
            continue
          }
          const message = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
          if (message?.role === 'user') commands.push({ key: item.value.key, command, text: message.text })
        }
        if (!page.cursor) break
        after = page.cursor
        if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main active input queue exceeds its 1000-command budget.')
      }
    })
    commands.sort((left, right) => left.command.userSequence - right.command.userSequence)
    const binding = await this.open(request)
    const resumed = commands.map(entry => this.enqueue(binding, entry.key, entry.text))
    await Promise.all(resumed)
    return { resumed: commands.length }
  }

  private async reconcileRecoverable() {
    if (!this.sessions) return
    const state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
    const binding = this.binding(state)
    const commands: { key: string; command: MainCommand }[] = []
    await commandTransaction(this.storage, this.instanceId, async tx => {
      let after: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<{ key: string; userSequence: number }>('main-reconcile-command', { limit: 100,
          ...(after === undefined ? {} : { after }) })
        for (const item of page.items) {
          const command = await tx.get<MainCommand>('main-command', item.value.key)
          if (command?.status === 'failed') commands.push({ key: item.value.key, command })
          else await tx.remove('main-reconcile-command', item.id)
        }
        if (!page.cursor) break
        after = page.cursor
        if (pageCount === 9) throw new CoreError('MAIN_RECONCILE_BUDGET', 'The Main recovery index exceeds its 1000-command budget.')
      }
    })
    for (const entry of commands.sort((left, right) => left.command.userSequence - right.command.userSequence)) {
      await this.reconcile(binding, entry.key)
    }
  }

  private enqueue(binding: MainBinding, key: string, text: string): Promise<MainRunResult> {
    const existing = this.scheduled.get(key)
    if (existing) return existing
    this.pendingTurns++
    let tracked: Promise<MainRunResult>
    tracked = this.tail.then(() => this.run(binding, key, text)).finally(() => {
      this.pendingTurns--
      if (this.scheduled.get(key) === tracked) this.scheduled.delete(key)
    })
    this.scheduled.set(key, tracked)
    this.tail = tracked.catch(() => {})
    return tracked
  }

  async stop(request: MainAddress & { commandId: string; messageId: string }) {
    this.authorize(request)
    identifier(request.commandId, 'commandId')
    identifier(request.messageId, 'messageId')
    const stopCommandKey = createHash('sha256').update(canonicalJson([
      'main-turn-stop-v1', this.source.sourceInstanceId, this.source.actorId, request.commandId,
    ])).digest('hex')
    const stop = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; messageId: string }>('main-turn-stop-command', stopCommandKey)
      if (prior) {
        if (prior.messageId !== request.messageId) {
          throw new CoreError('IDENTITY_CONFLICT', 'The Main stop command was reused for a different turn.')
        }
        const stored = await tx.get<MainTurnStop>('main-turn-stop', prior.messageId)
        if (!stored) throw new CoreError('INCOMPLETE_STATE', 'The Main stop record is missing.')
        return stored
      }
      const index = await tx.get<{ commandKey: string }>('main-message-command', request.messageId)
      const state = await this.state(tx)
      if (!index || state.activeCommand !== index.commandKey) {
        throw new CoreError('MAIN_NOT_RUNNING', 'Only the current Main turn can be stopped.')
      }
      const command = await tx.get<MainCommand>('main-command', index.commandKey)
      if (!command || !['queued', 'running', 'stopping'].includes(command.status)) {
        throw new CoreError('MAIN_NOT_RUNNING', 'The Main turn is no longer running.')
      }
      const existing = await tx.get<MainTurnStop>('main-turn-stop', request.messageId)
      const record: MainTurnStop = existing ?? {
        id: `main-turn-stop:${request.messageId}`,
        version: 1,
        instanceId: this.instanceId,
        commandId: request.commandId,
        commandKey: index.commandKey,
        messageId: request.messageId,
        status: 'stopping',
        requestedAt: Date.now(),
      }
      if (!existing) await tx.insert('main-turn-stop', request.messageId, record)
      await this.updateCommandIn(tx, index.commandKey, { ...command, status: 'stopping' })
      await tx.insert('main-turn-stop-command', stopCommandKey, {
        fingerprint: createHash('sha256').update(canonicalJson([this.instanceId, request.messageId])).digest('hex'),
        messageId: request.messageId,
      })
      return record
    })
    const controller = this.turnControllers.get(stop.commandKey)
    if (controller) controller.abort()
    else {
      await this.confirmStopped(stop.commandKey, stop.messageId, 'host-restart')
      return commandTransaction(this.storage, this.instanceId, tx => tx.get<MainTurnStop>('main-turn-stop', stop.messageId))
    }
    return stop
  }

  private tools(binding: MainBinding, command: MainCommand, originalUserText: string, configurationRevision: number): NativeTool[] {
    return [
      { name: 'delegate_work', description: 'Create one durable local WorkBrief for one to four independent items. Give every item a clear goal, strict constraints and observable acceptance criteria. The Router decides and establishes the Tickets; this tool does not mean any Worker started or completed.',
        parameters: {
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                goal: { type: 'string', required: true },
                constraints: { type: 'string' },
                acceptanceCriteria: { type: 'string' },
              },
            },
          },
          goal: { type: 'string' },
          constraints: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
        },
        execute: async args => {
          const work = this.work?.()
          if (!work || command.environmentId === null) return JSON.stringify({ status: 'rejected', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false, message: 'No authorized local workspace was selected for this input; no work was started.' })
          const items = Array.isArray(args.items) ? args.items.map(item => {
            const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
            return {
              goal: value.goal,
              constraints: value.constraints ?? args.constraints,
              acceptanceCriteria: value.acceptanceCriteria ?? args.acceptanceCriteria,
            }
          }) as MainWorkIntent[] : undefined
          const brief = await work.create({ commandId: `main-work:${command.messageId}`, mainId: binding.mainId,
            mainSessionId: binding.mainSessionId, routerSessionId: binding.routerSessionId, mainMessageId: command.messageId,
            originalUserText, ...(items ? { items } : { goal: args.goal ?? '', constraints: args.constraints ?? '', acceptanceCriteria: args.acceptanceCriteria ?? '' }),
            configurationRevision, ...(command.environmentId ? { environmentId: command.environmentId } : {}) })
          return JSON.stringify(await work.query(binding.mainId, { workBriefId: brief.id }))
        } },
      { name: 'query_work', description: 'Read a bounded status, receipt and verified result for a work item already visible in the Main conversation.',
        parameters: { workBriefId: { type: 'string' }, workItemId: { type: 'string' } },
        execute: async args => {
          const work = this.work?.()
          return work ? JSON.stringify(await work.query(binding.mainId, {
            ...(args.workBriefId ? { workBriefId: args.workBriefId } : {}), ...(args.workItemId ? { workItemId: args.workItemId } : {}),
          }))
            : JSON.stringify({ status: 'unavailable', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false })
        } },
      { name: 'read_work_evidence', description: 'Read one bounded page of original authorized evidence for a work item visible in this Main conversation. Use the returned cursor to continue when truncated; do not treat a summary as the original request or full tool output.',
        parameters: {
          workItemId: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          id: { type: 'string' },
          threadId: { type: 'string' },
          objectId: { type: 'string' },
          after: { type: 'string' },
          maxBytes: { type: 'number' },
        },
        execute: async args => {
          const work = this.work?.()
          if (!work) return JSON.stringify({ status: 'unavailable', code: 'DELEGATION_UNAVAILABLE' })
          return JSON.stringify(await work.evidence(binding.mainId, {
            workItemId: args.workItemId ?? '',
            ref: {
              kind: args.kind,
              ...(args.id ? { id: args.id } : {}),
              ...(args.threadId ? { threadId: args.threadId } : {}),
              ...(args.objectId ? { objectId: args.objectId } : {}),
            },
            ...(args.after ? { after: args.after } : {}),
            ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
          }))
        } },
      { name: 'follow_up_work', description: 'Send an explicit user follow-up or direction change to exactly one existing workItemId. Use this only when the user unambiguously identifies that displayed work item. Never substitute the current page, focus, recency, a Worker, or another item. If the target is unclear, ask the user which work item they mean.',
        parameters: {
          workItemId: { type: 'string', required: true },
          text: { type: 'string', required: true },
          reason: { type: 'string' },
        },
        execute: async args => {
          const work = this.work?.()
          if (!work) return JSON.stringify({ status: 'unavailable', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false })
          return JSON.stringify(await work.followUp({
            commandId: `main-follow-up:${command.messageId}:${args.workItemId}`,
            mainId: binding.mainId,
            mainSessionId: binding.mainSessionId,
            mainMessageId: command.messageId,
            originalUserText,
            workItemId: args.workItemId ?? '',
            text: args.text ?? '',
            ...(args.reason ? { reason: args.reason } : {}),
          }))
        } },
    ]
  }

  private sourceTool(binding: MainBinding, handoff: MainSourceHandoff, messageId: string, configurationRevision: number): NativeTool {
    return {
      name: 'delegate_work',
      description: 'Delegate this one authorized source request to one to four independent work items. The original source remains the default acknowledgement and result audience until a separately verified authority changes it.',
      parameters: {
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true },
              constraints: { type: 'string' },
              acceptanceCriteria: { type: 'string' },
            },
          },
        },
        goal: { type: 'string' },
        constraints: { type: 'string' },
        acceptanceCriteria: { type: 'string' },
      },
      execute: async args => {
        const work = this.work?.()
        if (!work) return JSON.stringify({ status: 'rejected', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false })
        const items = Array.isArray(args.items) ? args.items.map(item => {
          const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
          return { goal: value.goal, constraints: value.constraints ?? args.constraints, acceptanceCriteria: value.acceptanceCriteria ?? args.acceptanceCriteria }
        }) as MainWorkIntent[] : undefined
        const brief = await work.create({
          commandId: `main-source-work:${handoff.id}`,
          mainId: binding.mainId,
          mainSessionId: binding.mainSessionId,
          routerSessionId: binding.routerSessionId,
          mainMessageId: messageId,
          originalUserText: handoff.text,
          sourceHandoffId: handoff.id,
          ...(items ? { items } : { goal: args.goal ?? '', constraints: args.constraints ?? '', acceptanceCriteria: args.acceptanceCriteria ?? '' }),
          configurationRevision,
        })
        return JSON.stringify(await work.query(binding.mainId, { workBriefId: brief.id }))
      },
    }
  }

  notifySource(handoff: MainSourceHandoff, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.pendingTurns) throw new CoreError('MAIN_BUSY', 'Main is handling another turn; keep this source handoff queued.')
    this.pendingTurns++
    const turn = this.tail.then(async () => {
      signal.throwIfAborted()
      const binding = await this.open({ instanceId: this.instanceId })
      if (handoff.mainId !== binding.mainId || handoff.instanceId !== this.instanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source handoff belongs to another Main.')
      }
      const key = `main-source:${handoff.id}`
      let prepared = await commandTransaction(this.storage, this.instanceId, async tx => {
        const prior = await tx.get<MainSourceCommand>('main-source-command', key)
        if (prior) return { ...prior, handoffId: prior.handoffId ?? handoff.id, turnMessageId: prior.turnMessageId ?? prior.messageId,
          sessionId: prior.sessionId ?? binding.mainSessionId, sessionGeneration: prior.sessionGeneration ?? binding.generation }
        const state = await this.state(tx)
        const sequence = state.sequence + 1
        const messageId = `main-source-message:${handoff.id}`
        await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: messageId, sequence, role: 'user', text: handoff.text,
          createdAt: Date.now(), status: 'running', source: { kind: handoff.sourceInstanceId.startsWith('feishu:') ? 'feishu' : 'github', sourceInstanceId: handoff.sourceInstanceId,
            eventId: handoff.sourceEventId, objectId: handoff.objectId, threadId: handoff.threadId, authorId: handoff.authorId, reference: handoff.reference } })
        await tx.replace('main-state', 'main', { ...state, sequence })
        const command: MainSourceCommand = { state: 'running', handoffId: handoff.id, messageId, turnMessageId: messageId, userSequence: sequence,
          sessionId: binding.mainSessionId, sessionGeneration: binding.generation, attempt: 1 }
        await tx.insert('main-source-command', key, command)
        return command
      })
      if (prepared.state === 'completed') return
      if (prepared.handoffId !== handoff.id || prepared.sessionId !== binding.mainSessionId
        || prepared.sessionGeneration !== binding.generation) {
        throw new CoreError('INCOMPLETE_STATE', 'The source Main recovery state does not match the current Main Session generation.')
      }
      let answer: string | undefined
      const persistedTurn = await this.sessions!.hasMessage(binding.mainSessionId, prepared.turnMessageId)
      if (persistedTurn.found) {
        answer = await this.readReply(binding, prepared.turnMessageId)
      }
      if (!answer && persistedTurn.found) {
        prepared = await commandTransaction(this.storage, this.instanceId, async tx => {
          const current = await tx.get<MainSourceCommand>('main-source-command', key)
          if (!current || current.state === 'completed') throw new CoreError('MAIN_SOURCE_FAILED', 'The source recovery receipt disappeared.')
          if (current.attempt >= 10) throw new CoreError('MAIN_SOURCE_FAILED', 'The source Main recovery budget is exhausted.')
          const attempt = current.attempt + 1
          const command: MainSourceCommand = { ...current, state: 'running', attempt,
            turnMessageId: sourceRecoveryMessageId(handoff.id, current.sessionGeneration, attempt) }
          await tx.replace('main-source-command', key, command)
          const user = await tx.get<MainMessage>('main-message', messageKey(current.userSequence))
          if (user) {
            const { error: _error, ...retry } = user
            await tx.replace('main-message', messageKey(current.userSequence), { ...retry, status: 'running' })
          }
          return command
        })
      }
      let rolloverPrepared = false
      const prepareFork = async (childSessionId: string) => {
        prepared = await commandTransaction(this.storage, this.instanceId, async tx => {
          const current = await tx.get<MainSourceCommand>('main-source-command', key)
          if (!current || current.state === 'completed') throw new CoreError('MAIN_SOURCE_FAILED', 'The source recovery receipt disappeared.')
          if (current.handoffId !== handoff.id || current.sessionId !== binding.mainSessionId
            || current.sessionGeneration !== binding.generation) {
            throw new CoreError('INCOMPLETE_STATE', 'The source Main Session changed while its rollover was being prepared.')
          }
          if (current.attempt >= 10) throw new CoreError('MAIN_SOURCE_FAILED', 'The source Main recovery budget is exhausted.')
          const state = await this.state(tx)
          const sessionGeneration = Math.max(state.generation, current.sessionGeneration) + 1
          const attempt = current.attempt + 1
          const turnMessageId = sourceRecoveryMessageId(handoff.id, sessionGeneration, attempt)
          const command: MainSourceCommand = { ...current, state: 'running', sessionId: childSessionId,
            sessionGeneration, turnMessageId, attempt }
          await tx.replace('main-source-command', key, command)
          await tx.replace('main-state', 'main', { ...state, mainSessionId: childSessionId, generation: sessionGeneration })
          const rollover: MainSourceRollover = {
            id: `${JSON.stringify(['main-source-rollover', handoff.id])}:${childSessionId}`,
            version: 1,
            instanceId: this.instanceId,
            mainId: binding.mainId,
            handoffId: handoff.id,
            sourceCommandKey: key,
            previousSessionId: current.sessionId,
            sessionId: childSessionId,
            previousGeneration: current.sessionGeneration,
            sessionGeneration,
            previousTurnMessageId: current.turnMessageId,
            turnMessageId,
            attempt,
            reason: 'CONTEXT_WINDOW',
            createdAt: Date.now(),
          }
          if (!await tx.replace('main-source-rollover', rollover.id, rollover)) await tx.insert('main-source-rollover', rollover.id, rollover)
          return command
        })
        rolloverPrepared = true
      }
      if (!answer) {
        const configured = await this.prepare?.(binding.mainSessionId)
        const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, messageId: prepared.turnMessageId, signal,
          onForkPrepared: prepareFork,
          text: `[${handoff.sourceInstanceId.startsWith('feishu:') ? 'Feishu' : 'GitHub'} request${prepared.attempt > 1 ? ' recovery' : ''}]\nThis is one authorized source handoff, not a private transcript. ${prepared.attempt > 1
            ? 'The previous Main turn ended without a reply. Continue the same durable request and produce one safe reply; do not repeat completed side effects. '
            : 'When the request is actionable, use delegate_work and preserve the source reference. If no work is justified, explain that only in Main; no source message is sent without established work.'}\n${JSON.stringify({
              sourceEventId: handoff.sourceEventId, sourceInstanceId: handoff.sourceInstanceId, threadId: handoff.threadId, objectId: handoff.objectId,
              mainSessionGeneration: prepared.sessionGeneration,
              authorId: handoff.authorId, reference: handoff.reference, text: handoff.text,
            })}`,
          tools: [this.sourceTool(binding, handoff, prepared.messageId, configured?.revision ?? 1)],
          ...(configured ? { profile: configured.profile } : {}) })
        if (result.forkedSessionId) {
          if (!rolloverPrepared) await prepareFork(result.forkedSessionId)
          throw new CoreError('MAIN_SOURCE_ROLLOVER', 'Main reached its context limit and prepared a new Session for the same source handoff.')
        }
        answer = this.reply(result.events as MainEvent[], prepared.turnMessageId)
      }
      if (!answer) throw new CoreError('MAIN_SOURCE_FAILED', 'Main ended the source handoff without a visible reply.')
      signal.throwIfAborted()
      await commandTransaction(this.storage, this.instanceId, async tx => {
        const command = await tx.get<MainSourceCommand>('main-source-command', key)
        if (!command || command.state === 'completed') return
        const state = await this.state(tx)
        const sequence = state.sequence + 1
        await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: `source-reply:${handoff.id}`, sequence, role: 'main',
          text: answer, createdAt: Date.now(), status: 'completed' })
        const user = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
        if (user) {
          const { error: _error, ...settledUser } = user
          await tx.replace('main-message', messageKey(command.userSequence), { ...settledUser, status: 'completed' })
        }
        await tx.replace('main-state', 'main', { ...state, sequence })
        await tx.replace('main-source-command', key, { ...command, state: 'completed' })
        const current = await tx.get<MainSourceHandoff>('main-source-handoff', handoff.id)
        if (current && current.state !== 'discarded') {
          const { lastError: _error, ...settled } = current
          await tx.replace('main-source-handoff', handoff.id,
            { ...settled, state: current.state === 'delegated' ? 'delegated' : 'presented', mainMessageId: prepared.messageId, updatedAt: Date.now() })
        }
      })
    }).catch(async error => {
      await this.storage.transaction(this.instanceId, async tx => {
        const key = `main-source:${handoff.id}`
        const command = await tx.get<MainSourceCommand>('main-source-command', key)
        if (command && command.state !== 'completed') {
          const rollover = error instanceof CoreError && error.code === 'MAIN_SOURCE_ROLLOVER'
          if (!rollover) await tx.replace('main-source-command', key, { ...command, state: 'failed' })
          const user = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
          if (user && !rollover) await tx.replace('main-message', messageKey(command.userSequence), { ...user, status: 'failed' })
          const current = await tx.get<MainSourceHandoff>('main-source-handoff', handoff.id)
          if (current && current.state !== 'delegated' && current.state !== 'discarded') {
            await tx.replace('main-source-handoff', handoff.id, { ...current,
              lastError: rollover ? 'CONTEXT_WINDOW' : error instanceof Error ? error.message.slice(0, 1024) : 'MAIN_SOURCE_FAILED',
              updatedAt: Date.now() })
          }
        }
      }).catch(() => {})
      if (error instanceof CoreError && error.code === 'MAIN_SOURCE_ROLLOVER') throw error
      throw new CoreError('MAIN_SOURCE_FAILED', error instanceof Error ? error.message : 'Main could not recover the source request.')
    }).finally(() => { this.pendingTurns-- })
    this.tail = turn.catch(() => {})
    return turn
  }

  private async run(binding: MainBinding, key: string, text: string) {
    if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The Main conversation is closed.')
    let state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
    let current = this.binding(state)
    if (current.mainId !== binding.mainId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The durable Main input belongs to another conversation.')
    const command = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
    if (!command) throw new CoreError('INCOMPLETE_STATE', 'The Main input receipt is missing.')
    if (command.status === 'completed') return { ...current, messageId: command.messageId, status: command.status }
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      if (state.activeCommand && state.activeCommand !== key) {
        if (!await this.reconcile(current, state.activeCommand)) {
          await this.updateCommand(state.activeCommand, 'failed', 'MAIN_TURN_INTERRUPTED')
        }
        state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
        current = this.binding(state)
      }
      if (await this.reconcile(current, key)) return { ...current, messageId: command.messageId, status: 'completed' as const }
      const priorDelivery = command.run
        ? await this.sessions!.hasMessage(command.run.sessionId, command.run.messageId)
        : await this.sessions!.hasMessage(current.mainSessionId, command.messageId)
      const attempts = (command.attempts ?? 0) + 1
      const messageId = priorDelivery.found ? `main-continue:${command.messageId}:${attempts}` : command.messageId
      const turnText = priorDelivery.found
        ? `Continue the interrupted Main turn for durable input ${command.messageId}. Use the existing Session history and durable tool receipts. Do not repeat a delegation, follow-up, stop, answer or query that already completed. Reply to the user without restating the original input.`
        : text
      await this.updateCommand(key, 'running', undefined, { attempts, run: { attempts, messageId, sessionId: current.mainSessionId,
        generation: state.generation, startedAt: Date.now() } })
      this.turnControllers.set(key, controller)
      const stopping = await commandTransaction(this.storage, this.instanceId,
        tx => tx.get<MainTurnStop>('main-turn-stop', command.messageId))
      if (stopping) controller.abort()
      const prepared = await this.prepare?.(current.mainSessionId)
      const result = await this.sessions!.run({ role: 'main', sessionId: current.mainSessionId, text: turnText,
        tools: this.tools(current, command, text, prepared?.revision ?? 1), messageId, signal: controller.signal,
        onForkPrepared: async childSessionId => { await this.rollover(key, current, childSessionId) },
        ...(prepared ? { profile: prepared.profile } : {}) })
      if (await this.confirmStopped(key, command.messageId, 'runtime-cancelled')) {
        return { ...current, messageId: command.messageId, status: 'stopped' as const }
      }
      const answer = this.reply(result.events as MainEvent[], messageId)
      if (result.forkedSessionId) {
        state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
        current = this.binding(state)
        return { ...current, messageId: command.messageId, status: 'interrupted' as const }
      }
      if (!answer) throw new CoreError('MAIN_TURN_FAILED', 'Main did not produce a completed visible reply.')
      if (!await this.publish(key, answer, { sessionId: current.mainSessionId, generation: state.generation })) {
        throw new CoreError('MAIN_TURN_STALE', 'An older Main generation cannot advance the current conversation.')
      }
      state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
      current = this.binding(state)
      return { ...current, messageId: command.messageId, status: 'completed' as const }
    } catch (error) {
      const current = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
      if (current && await this.confirmStopped(key, current.messageId, 'runtime-cancelled')) {
        return { ...binding, messageId: current.messageId, status: 'stopped' as const }
      }
      const code = error instanceof CoreError ? error.code : 'MAIN_TURN_FAILED'
      if (this.closing && controller.signal.aborted) {
        await this.updateCommand(key, 'running', 'HOST_SHUTDOWN')
        throw new CoreError('HOST_SHUTDOWN', 'The Host stopped the Main turn; it will resume after reopen.')
      }
      await this.updateCommand(key, 'failed', code)
      throw new CoreError(code, 'Main could not finish this reply. Your message remains in the conversation.')
    } finally {
      this.controllers.delete(controller)
      this.turnControllers.delete(key)
    }
  }

  private async rollover(key: string, run: MainBinding, newSessionId: string) {
    const command = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
    if (!command) throw new CoreError('INCOMPLETE_STATE', 'The Main input receipt is missing during rollover.')
    return this.commitRollover(run, newSessionId, async (tx, record) => {
      const current = await tx.get<MainCommand>('main-command', key)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The Main input receipt is missing during rollover.')
      const { error: _error, ...settled } = current
      await this.updateCommandIn(tx, key, { ...settled, status: 'interrupted', updatedAt: record.createdAt })
    }, messageKey(command.userSequence))
  }

  private async rolloverUpdate(key: string, run: MainBinding, newSessionId: string) {
    return this.commitRollover(run, newSessionId, async (tx, record) => {
      const prior = await tx.get<MainUpdateCommand>('main-update-command', key)
      if (!prior) throw new CoreError('INCOMPLETE_STATE', 'The Main update receipt is missing during rollover.')
      const next: MainUpdateCommand = { ...prior, state: 'interrupted', updatedAt: record.createdAt }
      await tx.replace('main-update-command', key, next)
      await this.updateHealthState(tx, 'interrupted')
    })
  }

  private async commitRollover(run: MainBinding, newSessionId: string,
    settle: (tx: AsyncTx, record: MainSessionRollover) => Promise<void>, activeAfterSequence?: string) {
    const rolloverId = `main-session-rollover:${newSessionId}`
    const existing = await commandTransaction(this.storage, this.instanceId, tx =>
      tx.get<MainSessionRollover>('main-session-rollover', rolloverId))
    if (existing) return existing
    const work = this.work?.()
    const handoff = work ? await work.handoff(run.mainId) : { workIndex: [], evidenceRefs: [] } satisfies MainWorkHandoff
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainSessionRollover>('main-session-rollover', rolloverId)
      if (prior) return prior
      const state = await this.state(tx)
      if (state.mainId !== run.mainId || state.mainSessionId !== run.mainSessionId || state.generation !== run.generation) {
        return undefined
      }
      const unreadInputs: MainSessionRollover['unreadInputs'] = []
      let after: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<MainActiveCommand>('main-active-command', { limit: 100, ...(after === undefined ? {} : { after }) })
        for (const entry of page.items) {
          if (activeAfterSequence && messageKey(entry.value.userSequence) <= activeAfterSequence) continue
          const message = await tx.get<MainMessage>('main-message', messageKey(entry.value.userSequence))
          if (message?.role === 'user') unreadInputs.push({ id: message.id, sequence: message.sequence, text: message.text })
        }
        if (!page.cursor) break
        after = page.cursor
        if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main input queue exceeds its 1000-command budget.')
      }
      const record: MainSessionRollover = {
        id: rolloverId,
        mainId: state.mainId,
        previousSessionId: state.mainSessionId,
        sessionId: newSessionId,
        generation: state.generation + 1,
        forked: true,
        workIndex: structuredClone(handoff.workIndex),
        evidenceRefs: structuredClone(handoff.evidenceRefs),
        unreadInputs: structuredClone(unreadInputs.slice(-20)),
        unreadInputCount: unreadInputs.length,
        unreadInputsTruncated: unreadInputs.length > 20,
        createdAt: Date.now(),
      }
      const sequence = state.sequence + 1
      await tx.insert<MainSessionRollover>('main-session-rollover', rolloverId, record)
      await tx.insert<MainMessage>('main-message', messageKey(sequence), {
        id: rolloverId,
        sequence,
        role: 'system',
        text: `Main context rolled over to generation ${record.generation}. The logical Main, durable work index and evidence references are preserved.`,
        createdAt: record.createdAt,
        status: 'completed',
      })
      const { activeCommand: _active, ...settledState } = state
      await tx.replace('main-state', 'main', { ...settledState, mainSessionId: newSessionId,
        generation: record.generation, sequence })
      await settle(tx, record)
      return record
    })
  }

  notify(notification: MainWorkNotification, signal: AbortSignal, isCurrent: (transaction?: AsyncTx) => Promise<boolean>) {
    signal.throwIfAborted()
    if (this.pendingTurns) throw new CoreError('MAIN_BUSY', 'Main is handling another turn; keep this notification queued.')
    this.pendingTurns++
    const turn = this.tail.then(async () => {
      signal.throwIfAborted()
      const binding = await this.open({ instanceId: this.instanceId })
      if (notification.mainId !== binding.mainId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The work update belongs to another Main.')
      const key = notification.update.id
      const prior = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainUpdateCommand>('main-update-command', key))
      if (prior?.state === 'completed' || prior?.state === 'discarded') return
      if (prior?.state === 'running') {
        const previous = await this.readTurn(binding, prior.messageId)
        if (previous.answer) {
          await this.publishUpdateReply(key, prior.messageId, previous.answer, prior.attempt, isCurrent)
          return
        }
      }
      const attempt = prior?.state === 'failed' || prior?.state === 'running' || prior?.state === 'interrupted'
        ? prior.attempt + 1 : prior?.attempt ?? 0
      const messageId = `main-update:${key}:${attempt}`
      const record = (state: MainUpdateCommand['state']) => commandTransaction(this.storage, this.instanceId, async tx => {
        const current = await this.state(tx)
        const next: MainUpdateCommand = { attempt, state, messageId, updatedAt: Date.now(),
          ...(state === 'running' ? { run: { sessionId: current.mainSessionId, generation: current.generation } } : {}) }
        if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
        await this.updateHealthState(tx, state === 'failed' ? 'failed' : state === 'running' ? 'running'
          : state === 'interrupted' ? 'interrupted' : 'completed')
      })
      if (!await isCurrent()) { await record('discarded'); return }
      let answer: string | undefined
      if ((await this.sessions!.hasMessage(binding.mainSessionId, messageId)).found) {
        const turn = await this.readTurn(binding, messageId)
        answer = turn.answer
        if (!answer && turn.ended) { await record('failed'); throw new CoreError('MAIN_UPDATE_FAILED', 'Main ended this notification without a visible reply.') }
        if (!answer) throw new CoreError('MAIN_TURN_UNKNOWN', 'The original Main update turn needs reconciliation.')
      } else {
        const prepared = await this.prepare?.(binding.mainSessionId)
        if (!await isCurrent()) { await record('discarded'); return }
        signal.throwIfAborted()
        await record('running')
        let forkedSessionId: string | undefined
        try {
          const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, messageId, tools: [], signal,
            text: `[Work update]\nThis is a bounded Router notification, not a new user request. Explain the receipt or result briefly. Do not claim more than its evidence.\n${JSON.stringify(notification)}`,
            ...(prepared ? { profile: prepared.profile } : {}) })
          forkedSessionId = result.forkedSessionId
          if (forkedSessionId) answer = undefined
          else answer = this.reply(result.events as MainEvent[], messageId)
        } catch (error) {
          const turn = await this.readTurn(binding, messageId)
          if (!turn.ended) throw error
          answer = turn.answer
        }
        if (forkedSessionId) {
          await this.rolloverUpdate(key, binding, forkedSessionId)
          throw new CoreError('MAIN_UPDATE_INTERRUPTED', 'Main rolled over while handling this work update.')
        }
        if (!answer) { await record('failed'); throw new CoreError('MAIN_UPDATE_FAILED', 'Main ended this notification without a visible reply.') }
      }
      if (!await isCurrent()) { await record('discarded'); return }
      await this.publishUpdateReply(key, messageId, answer, attempt, isCurrent)
    }).catch(async error => {
      const code = error instanceof CoreError ? error.code : 'MAIN_UPDATE_FAILED'
      await commandTransaction(this.storage, this.instanceId, async tx => {
        const key = notification.update.id
        const prior = await tx.get<MainUpdateCommand>('main-update-command', key)
        if (prior?.state === 'completed' || prior?.state === 'discarded' || prior?.state === 'interrupted') return
        const next: MainUpdateCommand = { ...(prior ?? { attempt: 0, messageId: `main-update:${key}:0` }), state: 'failed',
          error: code, updatedAt: Date.now() }
        if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
        await this.updateHealthState(tx, 'failed', code)
      })
      throw error
    }).finally(() => { this.pendingTurns-- })
    this.tail = turn.catch(() => {})
    return turn
  }

  private publishUpdateReply(key: string, messageId: string, answer: string, attempt: number,
    isCurrent: (transaction?: AsyncTx) => Promise<boolean>) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainUpdateCommand>('main-update-command', key)
      if (prior?.state === 'completed') return
      const current = await isCurrent(tx)
      const state = await this.state(tx)
      const live = current && (!prior?.run || prior.run.sessionId === state.mainSessionId && prior.run.generation === state.generation)
      const sequence = state.sequence + 1
      if (live) await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: `reply:${messageId}`, sequence,
        role: 'main', text: answer, createdAt: Date.now(), status: 'completed' })
      const next: MainUpdateCommand = { messageId, sequence, attempt, state: live ? 'completed' : 'discarded', updatedAt: Date.now() }
      if (live) await tx.replace('main-state', 'main', { ...state, sequence })
      if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
      await this.updateHealthState(tx, live ? 'completed' : 'interrupted')
    })
  }

  private reply(events: readonly MainEvent[], messageId: string) {
    const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
    if (start < 0) return undefined
    const following = events.slice(start + 1)
    const end = following.findIndex(event => event.type === 'turn/end')
    if (end < 0 || following[end]?.data.reason?.kind !== 'completed') return undefined
    const answer = following.slice(0, end).filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    return answer.trim() ? answer : undefined
  }

  private async reconcile(binding: MainBinding, key: string) {
    const command = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
    if (!command) return false
    if (command.status === 'completed') return true
    const sessionId = command.run?.sessionId ?? binding.mainSessionId
    const messageId = command.run?.messageId ?? command.messageId
    const stop = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainTurnStop>('main-turn-stop', command.messageId))
    if (stop) {
      if (stop.status === 'stopped') {
        await this.confirmStopped(key, command.messageId, 'turn-ended')
        return true
      }
      if (!this.turnControllers.has(key)) {
        await this.confirmStopped(key, command.messageId, 'host-restart')
        return true
      }
      if (!this.sessions || !(await this.sessions.hasMessage(sessionId, messageId)).found) return false
      const turn = await this.readTurn({ ...binding, mainSessionId: sessionId }, messageId)
      if (!turn.ended) return false
      await this.confirmStopped(key, command.messageId, 'turn-ended')
      return true
    }
    if (!this.sessions) return false
    if (!(await this.sessions.hasMessage(sessionId, messageId)).found) {
      if (command.status === 'failed') await commandTransaction(this.storage, this.instanceId, tx =>
        tx.remove('main-reconcile-command', reconcileCommandKey(key)))
      return false
    }
    const answer = await this.readReply({ ...binding, mainSessionId: sessionId }, messageId)
    if (answer) {
      return await this.publish(key, answer, command.run ? { sessionId: command.run.sessionId, generation: command.run.generation } : undefined)
    }
    if (command.status === 'failed') await commandTransaction(this.storage, this.instanceId, tx =>
      tx.remove('main-reconcile-command', reconcileCommandKey(key)))
    return false
  }

  private async readReply(binding: MainBinding, messageId: string) {
    return (await this.readTurn(binding, messageId)).answer
  }

  private async readTurn(binding: MainBinding, messageId: string): Promise<{ answer?: string; ended: boolean; terminalReason?: string }> {
    if (!this.sessions) return { ended: false }
    const events: MainEvent[] = []
    let after: number | undefined
    for (let count = 0; count < 100; count++) {
      const page = await this.sessions.readSession(binding.mainSessionId, { limit: 100, ...(after === undefined ? {} : { after }) })
      events.push(...page.events as unknown as MainEvent[])
      const answer = this.reply(events, messageId)
      if (answer) return { answer, ended: true, terminalReason: 'completed' }
      const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
      if (start >= 0) {
        const end = events.slice(start + 1).find(event => event.type === 'turn/end')
        if (end) return { ended: true, ...(end.data.reason?.kind ? { terminalReason: end.data.reason.kind } : {}) }
      }
      if (page.cursor === undefined) return { ended: false }
      after = page.cursor
    }
    throw new CoreError('MAIN_HISTORY_BUDGET', 'Main history reconciliation exceeded its bounded read budget.')
  }

  private publish(key: string, answer: string, run?: { sessionId: string; generation: number }) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainCommand>('main-command', key)
      if (!prior) return false
      if (prior.status === 'completed') return true
      if (prior.status === 'stopped' || prior.status === 'stopping') return false
      const state = await this.state(tx)
      if (run && (state.mainSessionId !== run.sessionId || state.generation !== run.generation)) {
        await this.updateCommandIn(tx, key, { ...prior, status: 'failed', updatedAt: Date.now(), error: 'MAIN_TURN_STALE' })
        return false
      }
      const sequence = state.sequence + 1
      await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: `reply:${prior.messageId}`, sequence, role: 'main', text: answer, createdAt: Date.now(), status: 'completed' })
      await tx.replace('main-state', 'main', { ...state, sequence })
      const { error: _error, ...settled } = prior
      await this.updateCommandIn(tx, key, { ...settled, status: 'completed', replySequence: sequence, updatedAt: Date.now() })
      return true
    })
  }

  private async updateCommandIn(tx: AsyncTx, key: string, command: MainCommand, error?: string) {
    const before = await tx.get<MainCommand>('main-command', key)
    await tx.replace('main-command', key, command)
    const message = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
    if (message) await tx.replace('main-message', messageKey(command.userSequence), { ...message, status: command.status, ...(error ? { error } : {}) })
    if (command.status === 'queued') await this.activeCommand(tx, { ...command, key })
    else if (command.status === 'running') await this.runningCommand(tx, { ...command, key })
    else await this.removeActiveCommand(tx, command, key)
    await this.reconcileIndex(tx, command, key, command.status === 'failed')
    await this.updateHealthTransition(tx, before?.status, command.status, error)
    const state = await this.state(tx)
    if (command.status === 'running') await tx.replace('main-state', 'main', { ...state, activeCommand: key })
    else if (state.activeCommand === key && command.status !== 'stopping') {
      const { activeCommand: _active, ...settled } = state
      await tx.replace('main-state', 'main', settled)
    }
  }

  private updateCommand(key: string, status: MainCommand['status'], error?: string,
    update: Partial<Pick<MainCommand, 'attempts' | 'run'>> = {}) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const command = await tx.get<MainCommand>('main-command', key)
      if (command && command.status !== 'completed') {
        const { error: _oldError, ...current } = command
        await this.updateCommandIn(tx, key, { ...current, ...update, status, updatedAt: Date.now() }, error)
      }
    })
  }

  private async activeTurnIn(tx: AsyncTx, key: string): Promise<MainTurnView | undefined> {
    const command = await tx.get<MainCommand>('main-command', key)
    if (!command) return undefined
    const stop = await tx.get<MainTurnStop>('main-turn-stop', command.messageId)
    return { messageId: command.messageId,
      status: stop?.status ?? (command.status === 'stopped' ? 'stopped' : 'running'),
      ...(stop ? { stop } : {}) }
  }

  private async confirmStopped(key: string, messageId: string, confirmation: NonNullable<MainTurnStop['confirmation']>) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const command = await tx.get<MainCommand>('main-command', key)
      const stop = await tx.get<MainTurnStop>('main-turn-stop', messageId)
      if (!command || !stop) return false
      const finished: MainTurnStop = { ...stop, status: 'stopped', confirmation: stop.confirmation ?? confirmation,
        confirmedAt: stop.confirmedAt ?? Date.now() }
      await tx.replace('main-turn-stop', messageId, finished)
      if (command.status !== 'completed' && command.status !== 'failed') {
        await this.updateCommandIn(tx, key, { ...command, status: 'stopped' })
      } else {
        const state = await this.state(tx)
        if (state.activeCommand === key) {
          const { activeCommand: _active, ...settled } = state
          await tx.replace('main-state', 'main', settled)
        }
      }
      return true
    })
  }

  close() {
    if (this.closingTurn) return this.closingTurn
    this.closing = true
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    for (const controller of this.turnControllers.values()) controller.abort()
    this.closingTurn = this.tail.then(() => undefined)
    return this.closingTurn
  }
}
