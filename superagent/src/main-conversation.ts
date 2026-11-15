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
export interface MainMessageSource {
  kind: 'github'
  sourceInstanceId: string
  eventId: string
  objectId: string
  threadId: string
  authorId: string
  reference: string
}
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
  status: MainMessage['status']
  replySequence?: number
  attempts?: number
  updatedAt?: number
  error?: string
  run?: { attempts: number; messageId: string; sessionId: string; generation: number; startedAt: number }
}
interface MainUpdateCommand {
  attempt: number
  state: 'running' | 'failed' | 'completed' | 'discarded'
  messageId: string
  sequence?: number
  updatedAt?: number
  error?: string
  run?: { sessionId: string; generation: number }
}
interface MainSourceCommand { state: 'running' | 'failed' | 'completed'; messageId: string; turnMessageId: string; userSequence: number; attempt: number }
export interface MainHealth {
  state: 'ready' | 'running' | 'degraded'
  queuedInputs: number
  failedInputs: number
  updatedAt: number
  errorCode?: string
}
export interface MainAddress { instanceId: string }
export interface MainSend extends MainAddress { commandId: string; text: string }
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
const sourceRecoveryMessageId = (handoffId: string, attempt: number) => `main-source-recovery:${handoffId}:${attempt}`

/** Business facts stay separate from the native Session; no transaction spans a model turn. */
export class MainConversation {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly scheduled = new Map<string, Promise<MainRunResult>>()
  private closed = false
  private pendingTurns = 0
  private readonly turnControllers = new Map<string, AbortController>()
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly source: DesktopSource,
    private readonly sessions?: NativeSessions,
    private readonly prepare?: (sessionId: string) => Promise<{ profile: RoleProfile; revision: number }>,
    private readonly work?: () => WorkDelegation | undefined) {}

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

  private async health(tx: AsyncTx, state: MainState): Promise<MainHealth> {
    const commands: MainCommand[] = []
    const updates: MainUpdateCommand[] = []
    let commandAfter: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await tx.scan<MainCommand>('main-command', { limit: 100, ...(commandAfter === undefined ? {} : { after: commandAfter }) })
      commands.push(...page.items.map(item => item.value))
      if (!page.cursor) break
      commandAfter = page.cursor
      if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main input queue exceeds its 1000-command budget.')
    }
    let updateAfter: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const updatePage = await tx.scan<MainUpdateCommand>('main-update-command', { limit: 100, ...(updateAfter === undefined ? {} : { after: updateAfter }) })
      updates.push(...updatePage.items.map(item => item.value))
      if (!updatePage.cursor) break
      updateAfter = updatePage.cursor
      if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main notification queue exceeds its 1000-command budget.')
    }
    const latestCommand = commands.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
    const latestUpdate = updates.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
    const latest = (latestCommand?.updatedAt ?? 0) >= (latestUpdate?.updatedAt ?? 0)
      ? { status: latestCommand?.status, error: latestCommand?.error, updatedAt: latestCommand?.updatedAt }
      : { status: latestUpdate?.state === 'failed' ? 'failed' as const : latestUpdate?.state === 'running' ? 'running' as const
        : 'completed' as const, error: latestUpdate?.error, updatedAt: latestUpdate?.updatedAt }
    const queuedInputs = commands.filter(command => command.status === 'queued').length
    const failedInputs = commands.filter(command => command.status === 'failed').length
    return {
      state: state.activeCommand || latest.status === 'running' ? 'running' : latest.status === 'failed' ? 'degraded' : 'ready',
      queuedInputs,
      failedInputs,
      updatedAt: latest.updatedAt ?? Date.now(),
      ...(latest.error ? { errorCode: latest.error } : {}),
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
    if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 32768) throw new CoreError('INVALID_INPUT', 'Send a nonempty Main message of at most 32768 bytes.')
    const binding = await this.open(request)
    const key = createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId, request.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson([request.instanceId, request.text])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainCommand>('main-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This Main message identity was already used for different text.')
        return
      }
      const state = await this.state(tx)
      const sequence = state.sequence + 1
      const messageId = `main-input-${randomUUID()}`
      await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: messageId, sequence, role: 'user', text: request.text, createdAt: Date.now(), status: 'queued' })
      await tx.insert<MainCommand>('main-command', key, { fingerprint, messageId, userSequence: sequence, status: 'queued', updatedAt: Date.now() })
      await tx.insert('main-message-command', messageId, { commandKey: key })
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
        const page = await tx.scan<MainCommand>('main-command', { limit: 100, ...(after === undefined ? {} : { after }) })
        for (const item of page.items) {
          if (item.value.status !== 'queued' && item.value.status !== 'running') continue
          const message = await tx.get<MainMessage>('main-message', messageKey(item.value.userSequence))
          if (message?.role === 'user') commands.push({ key: item.id, command: item.value, text: message.text })
        }
        if (!page.cursor) break
        after = page.cursor
        if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main input queue exceeds its 1000-command budget.')
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
        const page = await tx.scan<MainCommand>('main-command', { limit: 100, ...(after === undefined ? {} : { after }) })
        for (const item of page.items) {
          if (item.value.status !== 'failed' && item.value.status !== 'running') continue
          commands.push({ key: item.id, command: item.value })
        }
        if (!page.cursor) break
        after = page.cursor
        if (pageCount === 9) throw new CoreError('MAIN_QUEUE_BUDGET', 'The Main input queue exceeds its 1000-command budget.')
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
          if (!work) return JSON.stringify({ status: 'rejected', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false, message: 'No authorized local workspace is configured; no work was started.' })
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
            configurationRevision })
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
      description: 'Delegate this one authorized GitHub request to one to four independent work items. The original source remains the default acknowledgement and result audience until a separately verified authority changes it.',
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
        if (prior) return { ...prior, turnMessageId: prior.turnMessageId ?? prior.messageId }
        const state = await this.state(tx)
        const sequence = state.sequence + 1
        const messageId = `main-source-message:${handoff.id}`
        await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: messageId, sequence, role: 'user', text: handoff.text,
          createdAt: Date.now(), status: 'running', source: { kind: 'github', sourceInstanceId: handoff.sourceInstanceId,
            eventId: handoff.sourceEventId, objectId: handoff.objectId, threadId: handoff.threadId, authorId: handoff.authorId, reference: handoff.reference } })
        await tx.replace('main-state', 'main', { ...state, sequence })
        const command: MainSourceCommand = { state: 'running', messageId, turnMessageId: messageId, userSequence: sequence, attempt: 1 }
        await tx.insert('main-source-command', key, command)
        return command
      })
      if (prepared.state === 'completed') return
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
            turnMessageId: sourceRecoveryMessageId(handoff.id, attempt) }
          await tx.replace('main-source-command', key, command)
          const user = await tx.get<MainMessage>('main-message', messageKey(current.userSequence))
          if (user) {
            const { error: _error, ...retry } = user
            await tx.replace('main-message', messageKey(current.userSequence), { ...retry, status: 'running' })
          }
          return command
        })
      }
      if (!answer) {
        const configured = await this.prepare?.(binding.mainSessionId)
        const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, messageId: prepared.turnMessageId, signal,
          text: `[GitHub request${prepared.attempt > 1 ? ' recovery' : ''}]\nThis is one authorized source handoff, not a private transcript. ${prepared.attempt > 1
            ? 'The previous Main turn ended without a reply. Continue the same durable request and produce one safe reply; do not repeat completed side effects. '
            : 'When the request is actionable, use delegate_work and preserve the source reference. If no work is justified, explain that only in Main; no source message is sent without established work.'}\n${JSON.stringify({
              sourceEventId: handoff.sourceEventId, sourceInstanceId: handoff.sourceInstanceId, threadId: handoff.threadId, objectId: handoff.objectId,
              authorId: handoff.authorId, reference: handoff.reference, text: handoff.text,
            })}`,
          tools: [this.sourceTool(binding, handoff, prepared.messageId, configured?.revision ?? 1)],
          ...(configured ? { profile: configured.profile } : {}) })
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
          await tx.replace('main-source-command', key, { ...command, state: 'failed' })
          const user = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
          if (user) await tx.replace('main-message', messageKey(command.userSequence), { ...user, status: 'failed' })
          const current = await tx.get<MainSourceHandoff>('main-source-handoff', handoff.id)
          if (current && current.state !== 'delegated' && current.state !== 'discarded') {
            await tx.replace('main-source-handoff', handoff.id, { ...current,
              lastError: error instanceof Error ? error.message.slice(0, 1024) : 'MAIN_SOURCE_FAILED', updatedAt: Date.now() })
          }
        }
      }).catch(() => {})
      throw new CoreError('MAIN_SOURCE_FAILED', error instanceof Error ? error.message : 'Main could not recover the GitHub request.')
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
      const controller = new AbortController()
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
        await this.rollover(key, current, result.forkedSessionId)
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
      await this.updateCommand(key, 'failed', code)
      throw new CoreError(code, 'Main could not finish this reply. Your message remains in the conversation.')
    } finally {
      this.turnControllers.delete(key)
    }
  }

  private async rollover(key: string, run: MainBinding, newSessionId: string) {
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
      const command = await tx.get<MainCommand>('main-command', key)
      if (!command || state.mainId !== run.mainId || state.mainSessionId !== run.mainSessionId || state.generation !== run.generation) {
        if (command) await this.updateCommandIn(tx, key, { ...command, status: 'failed', error: 'MAIN_TURN_STALE', updatedAt: Date.now() })
        return undefined
      }
      const unreadInputs: MainSessionRollover['unreadInputs'] = []
      let after: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<MainCommand>('main-command', { limit: 100, ...(after === undefined ? {} : { after }) })
        for (const entry of page.items) {
          if (entry.value.userSequence <= command.userSequence || entry.value.status !== 'queued' && entry.value.status !== 'running') continue
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
      const { error: _error, ...settledCommand } = command
      await this.updateCommandIn(tx, key, { ...settledCommand, status: 'interrupted', updatedAt: Date.now() })
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
      const attempt = prior?.state === 'failed' || prior?.state === 'running' ? prior.attempt + 1 : prior?.attempt ?? 0
      const messageId = `main-update:${key}:${attempt}`
      const record = (state: MainUpdateCommand['state']) => commandTransaction(this.storage, this.instanceId, async tx => {
        const current = await this.state(tx)
        const next: MainUpdateCommand = { attempt, state, messageId, updatedAt: Date.now(),
          ...(state === 'running' ? { run: { sessionId: current.mainSessionId, generation: current.generation } } : {}) }
        if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
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
        try {
          const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, messageId, tools: [], signal,
            text: `[Work update]\nThis is a bounded Router notification, not a new user request. Explain the receipt or result briefly. Do not claim more than its evidence.\n${JSON.stringify(notification)}`,
            ...(prepared ? { profile: prepared.profile } : {}) })
          answer = this.reply(result.events as MainEvent[], messageId)
        } catch (error) {
          const turn = await this.readTurn(binding, messageId)
          if (!turn.ended) throw error
          answer = turn.answer
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
        if (prior?.state === 'completed' || prior?.state === 'discarded') return
        const next: MainUpdateCommand = { ...(prior ?? { attempt: 0, messageId: `main-update:${key}:0` }), state: 'failed',
          error: code, updatedAt: Date.now() }
        if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
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
    if (!(await this.sessions.hasMessage(sessionId, messageId)).found) return false
    const answer = await this.readReply({ ...binding, mainSessionId: sessionId }, messageId)
    if (answer) {
      return await this.publish(key, answer, command.run ? { sessionId: command.run.sessionId, generation: command.run.generation } : undefined)
    }
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
    await tx.replace('main-command', key, command)
    const message = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
    if (message) await tx.replace('main-message', messageKey(command.userSequence), { ...message, status: command.status, ...(error ? { error } : {}) })
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

  async close() {
    this.closed = true
    for (const controller of this.turnControllers.values()) controller.abort()
    await this.tail
  }
}
