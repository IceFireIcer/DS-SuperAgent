import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier, type DesktopSource, type Work } from './model.js'
import type { RoleProfile } from './config.js'
import type { NativeSessions, NativeTool } from './native-sessions.js'
import type { AsyncTx, Storage } from './storage.js'
import type { Effect, EffectHandler, EffectResult, Effects } from './effects.js'
import type { InputDelivery, MainFollowUpAttachment, MainFollowUpAttachmentRequest, WorkInput, WorkOwnership } from './work-inputs.js'
import type { MainSourceHandoff } from './main-source.js'
import { isCurrentSourceEvent, type SourceEvent } from './source-events.js'

export interface MainWorkIntent {
  goal: string
  constraints: string
  acceptanceCriteria: string
}

export interface MainWorkBrief {
  id: string
  version: 1
  instanceId: string
  mainId: string
  mainSessionId: string
  routerSessionId: string
  mainMessageId: string
  originalUserText: string
  authorization: { kind: 'authorized-main-actor'; sourceInstanceId: string; actorId: string }
  goal: string
  constraints: string
  acceptanceCriteria: string
  requestedItems?: MainWorkIntent[]
  sourceEventId?: string
  evidence: { kind: 'main-message'; id: string }
  environmentId: string
  configurationRevision: number
  sourceHandoffId?: string
  createdAt: number
}

export interface MainWorkReceipt {
  version: 1
  workBriefId: string
  workItemId?: string
  status: 'routing' | 'accepted' | 'rejected'
  ticketId?: string
  ticketIds?: string[]
  reason?: string
  nextStep: string
  createdAt: number
}

export interface MainWorkOutcome {
  version: 1
  workBriefId: string
  workItemId?: string
  ticketId: string
  status: 'success' | 'failed' | 'unknown' | 'waiting' | 'stopped' | 'blocked'
  summary: string
  evidence: string
  artifacts: { path: string; bytes: number; sha256: string; reference?: unknown }[]
  reportId?: string
  nextStep: string
  updatedAt: number
}

export type MainWorkStatus = MainWorkReceipt['status'] | MainWorkOutcome['status'] | 'pending' | 'running'
export interface MainWorkUpdate {
  version: 1
  id: string
  workBriefId: string
  workItemId?: string
  ticketId?: string
  status: MainWorkStatus
  owner: 'router' | 'worker' | 'user'
  summary: string
  needsDecision: boolean
  createdAt: number
}
export interface MainWorkNotification {
  mainId: string
  receipt: MainWorkReceipt
  update: MainWorkUpdate
  outcome?: MainWorkOutcome
  followUps?: MainWorkFollowUpView[]
}
export interface MainWorkCardBrief extends MainWorkIntent {
  id: string
  workItemId: string
  sourceEventId: string
  position: number
  mainMessageId: string
  createdAt: number
}
export interface MainWorkCard {
  brief: MainWorkCardBrief
  receipt: MainWorkReceipt
  status: MainWorkStatus
  update?: MainWorkUpdate
  outcome?: MainWorkOutcome
  followUps?: MainWorkFollowUpView[]
  control?: MainWorkControl
}

export interface MainWorkRequest {
  commandId: string
  mainId: string
  mainSessionId: string
  routerSessionId: string
  mainMessageId: string
  originalUserText: string
  items?: MainWorkIntent[]
  goal?: string
  constraints?: string
  acceptanceCriteria?: string
  configurationRevision: number
  sourceHandoffId?: string
}

export interface MainWorkFollowUpRequest {
  commandId: string
  mainId: string
  mainSessionId: string
  mainMessageId: string
  originalUserText: string
  workItemId: string
  text: string
  reason?: string
}

export interface MainWorkFollowUp {
  id: string
  version: 1
  instanceId: string
  commandId: string
  authorization: { kind: 'authorized-main-actor'; sourceInstanceId: string; actorId: string }
  mainId: string
  mainSessionId: string
  originalUserText: string
  workBriefId: string
  workItemId: string
  originalSourceEventId: string
  ticketId: string
  text: string
  reason: string
  source: { kind: 'main-message'; id: string }
  routing: 'direct-to-original'
  directionVersion: number
  attachment: 'attached' | 'waiting' | 'stopped'
  inputId?: string
  ownershipId?: string
  blockedReason?: string
  createdAt: number
}

export type MainWorkFollowUpStatus = 'queued' | 'delivering' | 'persisted' | 'ready' | 'waiting' | 'handed-back' | 'stopped' | 'expired'

export interface MainWorkFollowUpView extends MainWorkFollowUp {
  status: MainWorkFollowUpStatus
  persisted: boolean
  adopted: boolean
  delivery?: InputDelivery
  ownership?: WorkOwnership
  displayReason?: string
}

export interface MainWorkItem extends MainWorkIntent {
  id: string
  version: 1
  workBriefId: string
  sourceEventId: string
  position: number
  createdAt: number
}

export interface MainWorkSplit {
  id: string
  version: 1
  workBriefId: string
  sourceEventId: string
  fingerprint: string
  itemIds: string[]
  createdAt: number
}

export interface MainWorkPlanConflict {
  id: string
  version: 1
  workBriefId: string
  sourceEventId: string
  plannedFingerprint: string
  attemptedFingerprint: string
  attemptedItems: MainWorkIntent[]
  message: string
  createdAt: number
}

export interface MainWorkPlanItem extends MainWorkItem {
  receipt: MainWorkReceipt
  status: MainWorkReceipt['status']
  ticketId?: string
}

export interface MainWorkPlan {
  workBriefId: string
  sourceEventId: string
  status: MainWorkReceipt['status'] | 'partial'
  items: MainWorkPlanItem[]
  conflict?: MainWorkPlanConflict
}

interface WorkRouterTurn {
  version: 1
  id: string
  workBriefId: string
  sessionId: string
  phase: 'route' | 'update'
  status: 'pending' | 'completed' | 'failed'
  startSeq?: number
  endSeq?: number
  stepCount?: number
  budget: number
  errorCode?: string
  createdAt: number
  updatedAt: number
}

export interface MainWorkTicketSnapshot {
  ticketId: string
  status: Work['intent']['state'] | 'waiting-human' | 'stopping' | 'stopped'
  reason: Work['intent']['reason']
  lifecycle: Work['ticket']['state']
  setupCode?: string
  report?: { id: string; result: string; evidence: string; artifacts: MainWorkOutcome['artifacts'] }
  control?: MainWorkControl
}

export interface MainWorkControl {
  workItemId: string
  ticketId: string
  permissions: { actorId: string; canStop: boolean; canResume: boolean; canRetry: boolean; canAnswer: boolean }
  assignment?: { id: string; generation: string; sessionId: string; state: 'pending' | 'running' | 'stopping' | 'ended' }
  attention?: {
    id: string
    version: number
    status: 'waiting' | 'answered' | 'superseded'
    question: string
    options: string[]
    freeText: true
    assignmentId: string
    sessionId: string
  }
  stop?: {
    id: string
    state: 'stopping' | 'stopped'
    requestedAt: number
    requestedBy: string
    reason: string
    pendingDeviceConfirmation: boolean
    cancellationConfirmedAt?: number
    resumedAt?: number
  }
}

export interface WorkDelegationOptions {
  storage: Storage
  instanceId: string
  source: DesktopSource
  sessions: NativeSessions
  effects: Effects
  environmentId: string
  now?: () => number
  createTicket(brief: MainWorkBrief, item: MainWorkItem): Promise<{ ticketId: string }>
  readTicket(ticketId: string): Promise<MainWorkTicketSnapshot>
  routerProfile(): Promise<{ revision: number; profile: RoleProfile }>
  recordRouterUse(sessionId: string, revision: number, profile: RoleProfile): Promise<void>
  notifyMain(notification: MainWorkNotification, signal: AbortSignal, isCurrent: (transaction?: AsyncTx) => Promise<boolean>): Promise<void>
  notifyMainSource(handoff: MainSourceHandoff, signal: AbortSignal): Promise<void>
  applyFollowUp(tx: AsyncTx, request: MainFollowUpAttachmentRequest): Promise<MainFollowUpAttachment>
}

const commandKey = (source: DesktopSource, commandId: string) => createHash('sha256')
  .update(canonicalJson([source.sourceInstanceId, source.actorId, commandId])).digest('hex')
const followUpPrefix = (workItemId: string) => JSON.stringify(['work-follow-up', workItemId])
const followUpKey = (workItemId: string, followUpId: string) => `${followUpPrefix(workItemId)}:${createHash('sha256').update(followUpId).digest('hex')}`
const followUpCardStatus: Record<MainWorkFollowUpStatus, MainWorkStatus> = {
  queued: 'pending', delivering: 'running', persisted: 'running', ready: 'success',
  waiting: 'waiting', 'handed-back': 'waiting', stopped: 'stopped', expired: 'unknown',
}
const routerStepBudget = 8

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) {
    throw new CoreError('INVALID_INPUT', `${label} must be nonempty and at most ${maximum} bytes.`)
  }
  return value.trim()
}

function workIntents(items: unknown, label = 'Each work item'): MainWorkIntent[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 4) throw new CoreError('INVALID_INPUT', 'A work plan needs between one and four independent work items.')
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['goal', 'constraints', 'acceptanceCriteria'].includes(key))) {
      throw new CoreError('INVALID_INPUT', `${label} accepts only goal, constraints and acceptance criteria.`)
    }
    const value = item as Record<string, unknown>
    return {
      goal: boundedText(value.goal, `Work item ${index + 1} goal`, 4096),
      constraints: boundedText(value.constraints, `Work item ${index + 1} constraints`, 4096),
      acceptanceCriteria: boundedText(value.acceptanceCriteria, `Work item ${index + 1} acceptance criteria`, 4096),
    }
  })
  const exact = new Set(normalized.map(item => canonicalJson(item)))
  if (exact.size !== normalized.length) throw new CoreError('INVALID_INPUT', 'A work plan cannot contain duplicate work items.')
  return normalized.sort((left, right) => {
    const leftKey = canonicalJson(left)
    const rightKey = canonicalJson(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function requestIntents(request: MainWorkRequest) {
  if (request.items !== undefined) return workIntents(request.items)
  return workIntents([{ goal: request.goal, constraints: request.constraints, acceptanceCriteria: request.acceptanceCriteria }])
}

export class WorkDelegation {
  private readonly now: () => number

  constructor(private readonly options: WorkDelegationOptions) { this.now = options.now ?? Date.now }

  async create(request: MainWorkRequest) {
    if (!request || Object.keys(request).some(key => !['commandId', 'mainId', 'mainSessionId', 'routerSessionId', 'mainMessageId', 'originalUserText',
      'items', 'goal', 'constraints', 'acceptanceCriteria', 'configurationRevision', 'sourceHandoffId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A Main delegation accepts only its source and independent work items.')
    }
    if (request.items !== undefined && (request.goal !== undefined || request.constraints !== undefined || request.acceptanceCriteria !== undefined)) {
      throw new CoreError('INVALID_INPUT', 'Use either a work items array or one legacy goal, not both.')
    }
    identifier(request.commandId, 'commandId'); identifier(request.mainId, 'mainId'); identifier(request.mainSessionId, 'mainSessionId')
    identifier(request.routerSessionId, 'routerSessionId'); identifier(request.mainMessageId, 'mainMessageId')
    if (request.sourceHandoffId !== undefined) identifier(request.sourceHandoffId, 'sourceHandoffId')
    if (!this.options.source.allowedActorIds.includes(this.options.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot delegate work in the Main Instance.')
    identifier(this.options.environmentId, 'environmentId')
    if (!Number.isSafeInteger(request.configurationRevision) || request.configurationRevision < 1) throw new CoreError('INVALID_INPUT', 'A delegation needs its Main role configuration revision.')
    const originalUserText = boundedText(request.originalUserText, 'The original Main request', 32768)
    const requestedItems = requestIntents(request)
    const single = requestedItems.length === 1 ? requestedItems[0] : undefined
    const goal = single?.goal ?? `${requestedItems.length} independent work items from one Main request.`
    const constraints = single?.constraints ?? 'Each item has its own constraints.'
    const acceptanceCriteria = single?.acceptanceCriteria ?? 'Each item has its own observable acceptance criteria.'
    const fingerprint = createHash('sha256').update(canonicalJson(['main-work-brief-v2', this.options.instanceId, request.mainId,
      request.mainSessionId, request.routerSessionId, request.mainMessageId, originalUserText, requestedItems,
      this.options.environmentId, request.configurationRevision, request.sourceHandoffId ?? null])).digest('hex')
    const key = commandKey(this.options.source, request.commandId)
    return commandTransaction(this.options.storage, this.options.instanceId, async transaction => {
      const existing = await transaction.get<{ fingerprint: string; workBriefId: string }>('work-brief-command', key)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This Main delegation identity was already used for different work.')
        const brief = await transaction.get<MainWorkBrief>('work-brief', existing.workBriefId)
        if (!brief) throw new CoreError('INCOMPLETE_STATE', 'The accepted WorkBrief is missing.')
        return brief
      }
      const id = randomUUID()
      let sourceHandoff: MainSourceHandoff | undefined
      if (request.sourceHandoffId) {
        sourceHandoff = await transaction.get<MainSourceHandoff>('main-source-handoff', request.sourceHandoffId)
        if (!sourceHandoff || sourceHandoff.instanceId !== this.options.instanceId || sourceHandoff.mainId !== request.mainId
          || !['pending', 'presented'].includes(sourceHandoff.state)) {
          throw new CoreError('NOT_FOUND', 'The Main source handoff is unavailable or belongs to another Main.')
        }
        const sourceEvent = await transaction.get<SourceEvent>('source-event', sourceHandoff.sourceEventId)
        const policy = await transaction.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state',
          JSON.stringify(['policy-state', sourceHandoff.sourceInstanceId]))
        if (!sourceEvent || !await isCurrentSourceEvent(transaction, sourceEvent) || sourceEvent.authorId !== sourceHandoff.authorId || sourceEvent.source.sourceInstanceId !== sourceHandoff.sourceInstanceId
          || !policy?.configuration.allowedRequesterIds.includes(sourceEvent.authorId)) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The Main source handoff is no longer current and authorized.')
        }
      }
      const brief: MainWorkBrief = { id, version: 1, instanceId: this.options.instanceId,
        mainId: request.mainId, mainSessionId: request.mainSessionId, routerSessionId: request.routerSessionId,
        mainMessageId: request.mainMessageId, originalUserText,
        authorization: { kind: 'authorized-main-actor', sourceInstanceId: this.options.source.sourceInstanceId, actorId: this.options.source.actorId },
        goal, constraints, acceptanceCriteria, requestedItems, sourceEventId: `main-work-source:${id}`,
        evidence: { kind: 'main-message', id: request.mainMessageId }, environmentId: this.options.environmentId,
        configurationRevision: request.configurationRevision, ...(sourceHandoff ? { sourceHandoffId: sourceHandoff.id } : {}), createdAt: this.now() }
      const receipt: MainWorkReceipt = { version: 1, workBriefId: brief.id, status: 'routing',
        nextStep: 'Router is deciding the independent work items.', createdAt: this.now() }
      await transaction.insert('work-brief', brief.id, brief)
      if (sourceHandoff) await transaction.replace('main-source-handoff', sourceHandoff.id,
        { ...sourceHandoff, state: 'delegated', workBriefId: brief.id, updatedAt: this.now() })
      await transaction.insert('work-receipt', brief.id, receipt)
      await transaction.insert('work-brief-command', key, { fingerprint, workBriefId: brief.id })
      await this.options.effects.enqueue(transaction, { key: brief.id, stream: 'notice', scope: brief.mainId,
        payload: { type: 'main-work-brief', workBriefId: brief.id } })
      return brief
    })
  }

  async route(workBriefId: string, signal: AbortSignal) {
    identifier(workBriefId, 'workBriefId')
    const brief = await this.options.storage.transaction(this.options.instanceId, async transaction => {
      const stored = await transaction.get<MainWorkBrief>('work-brief', workBriefId)
      if (!stored || stored.instanceId !== this.options.instanceId) throw new CoreError('NOT_FOUND', 'The Main WorkBrief does not exist in this Instance.')
      return stored
    })
    const priorSplit = await this.readSplit(workBriefId)
    if (!priorSplit) {
      const existing = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<MainWorkReceipt>('work-receipt', workBriefId))
      if (existing?.status === 'accepted' || existing?.status === 'rejected') {
        await this.publishUpdate(brief, this.legacyItem(brief), existing)
        return
      }
    } else if ((await Promise.all(priorSplit.items.map(item => this.itemReceipt(item.id)))).every(receipt => receipt?.status !== 'routing')) {
      return
    }

    const { revision, profile } = await this.options.routerProfile()
    this.options.sessions.routerSessionId = brief.routerSessionId
    const tool: NativeTool = {
      name: 'establish_work_plan',
      description: 'Decide the independent local work items for this one authorized WorkBrief and establish every missing Ticket. Each item gets a durable Engine identity, Mandate, acceptance criteria and delivery. Repeating the exact same plan reuses it; a different plan for this brief is a target conflict.',
      parameters: {
        items: {
          type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true },
              constraints: { type: 'string', required: true },
              acceptanceCriteria: { type: 'string', required: true },
            },
          },
        },
      },
      execute: async (args, callSignal) => {
        callSignal.throwIfAborted()
        const decision = await this.persistSplit(brief, workIntents(args.items, 'Router work item'))
        for (const item of decision.items) {
          const receipt = await this.itemReceipt(item.id)
          if (receipt?.status !== 'routing') continue
          await this.establishItem(decision.brief, item, callSignal)
        }
        return JSON.stringify(await this.plan(brief.mainId, brief.id))
      },
    }
    const attempt = await this.startRouterTurn(brief, 'route')
    let result
    try {
      result = await this.options.sessions.run({ sessionId: brief.routerSessionId, role: 'router', signal,
        stepBudget: routerStepBudget,
        profile: structuredClone(profile), text: `Decide the independent work items for this one versioned Main WorkBrief. Preserve the one original source event. Establish each missing local Ticket and report only durable receipts.\n${JSON.stringify(brief)}`,
        tools: [tool] })
      await this.finishRouterTurn(attempt, { ...result, status: 'completed' })
    } catch (error) {
      await this.finishRouterTurn(attempt, { status: 'failed', error }).catch(() => {})
      throw error
    }
    await this.options.recordRouterUse(result.sessionId, revision, profile)
    const split = await this.readSplit(brief.id)
    if (!split) throw new CoreError('ROUTER_NOTICE_UNHANDLED', 'Router did not establish a durable work plan.')
    const receipts = await Promise.all(split.items.map(item => this.itemReceipt(item.id)))
    if (receipts.some(receipt => !receipt || receipt.status === 'routing')) {
      throw new CoreError('ROUTER_NOTICE_UNHANDLED', 'Router left part of the authorized work plan unestablished.')
    }
  }

  async plan(mainId: string, workBriefId: string): Promise<MainWorkPlan> {
    identifier(mainId, 'mainId'); identifier(workBriefId, 'workBriefId')
    const { brief, split, items, conflict } = await this.readPlan(workBriefId)
    if (!brief || brief.mainId !== mainId || brief.instanceId !== this.options.instanceId) throw new CoreError('NOT_FOUND', 'This WorkBrief is not available in the current Main Instance.')
    if (!split) throw new CoreError('WORK_PLAN_PENDING', 'Router has not established the work plan yet.')
    const planItems = await Promise.all(items.map(async item => {
      const receipt = await this.itemReceipt(item.id)
      if (!receipt) throw new CoreError('INCOMPLETE_STATE', 'A work plan item receipt is missing.')
      const ticket = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<{ ticketId: string }>('work-item-ticket', item.id))
      return { ...item, receipt, status: receipt.status, ...(receipt.ticketId ?? ticket?.ticketId ? { ticketId: receipt.ticketId ?? ticket!.ticketId } : {}) }
    }))
    const status = planItems.every(item => item.status === 'accepted') ? 'accepted'
      : planItems.every(item => item.status === 'rejected') ? 'rejected'
        : planItems.some(item => item.status === 'routing') ? 'routing' : 'partial'
    return { workBriefId: brief.id, sourceEventId: brief.sourceEventId!, status, items: planItems, ...(conflict ? { conflict } : {}) }
  }

  handlers(base: Record<'notice' | 'relay', EffectHandler>): Record<'notice' | 'relay', EffectHandler> {
    const execute = async (effect: Effect, context: { idempotencyKey: string; signal: AbortSignal }, handler: EffectHandler): Promise<EffectResult> => {
      try {
        if (effect.payload.type === 'main-source-handoff') {
          const handoff = await this.options.storage.transaction(this.options.instanceId,
            tx => tx.get<MainSourceHandoff>('main-source-handoff', String(effect.payload.handoffId)))
          if (!handoff) throw new CoreError('INCOMPLETE_STATE', 'The Main source handoff is missing.')
          if (handoff.state === 'pending' || handoff.state === 'presented') await this.options.notifyMainSource(handoff, context.signal)
        } else if (effect.payload.type === 'main-work-brief') await this.route(String(effect.payload.workBriefId), context.signal)
        else if (effect.payload.type === 'main-work-update') {
          const notification = await this.options.storage.transaction(this.options.instanceId,
            tx => tx.get<MainWorkNotification>('work-update', String(effect.payload.updateId)))
          if (!notification) throw new CoreError('INCOMPLETE_STATE', 'The Router work update is missing.')
          await this.options.notifyMain(notification, context.signal, transaction => this.isCurrent(notification, transaction))
        } else {
          const result = await handler.execute(effect, context)
          if (result.type === 'success' && typeof effect.payload.ticketId === 'string') await this.refreshTicket(effect.payload.ticketId, context.signal)
          return result
        }
        return { type: 'success' }
      } catch (error) {
        if (error instanceof CoreError && error.code === 'MAIN_BUSY') return { type: 'defer', reason: error.message }
        if (error instanceof CoreError && (error.code === 'MAIN_UPDATE_FAILED' || error.code === 'MAIN_SOURCE_FAILED')) {
          return { type: effect.state === 'unknown' ? 'not-applied' : 'transient', reason: error.message }
        }
        if (error instanceof CoreError && error.code === 'ROUTER_NOTICE_UNHANDLED') return { type: 'transient', reason: error.message }
        throw error
      }
    }
    const wrap = (handler: EffectHandler): EffectHandler => ({
      execute: (effect, context) => execute(effect, context, handler),
      reconcile: (effect, context) => execute(effect, context, { ...handler, execute: handler.reconcile ?? handler.execute }),
      ...(handler.batch ? { batch: { maxSize: handler.batch.maxSize, execute: async (effects, context) => {
        if (effects.some(effect => effect.payload.type === 'main-work-brief' || effect.payload.type === 'main-work-update')) {
          return Promise.all(effects.map(effect => execute(effect,
            { idempotencyKey: JSON.stringify([effect.id, effect.generation]), signal: context.signal }, handler)))
        }
        const results = await handler.batch!.execute(effects, context)
        return Promise.all(results.map(async (result, index) => {
          const ticketId = effects[index]?.payload.ticketId
          if (result.type !== 'success' || typeof ticketId !== 'string') return result
          try { await this.refreshTicket(ticketId, context.signal); return result }
          catch { return { type: 'transient', reason: 'The bounded Main work update could not be recorded yet.' } }
        }))
      } } } : {}),
    })
    return { notice: wrap(base.notice), relay: wrap(base.relay) }
  }

  private async persistSplit(brief: MainWorkBrief, suggestions: MainWorkIntent[]) {
    const sourceEventId = brief.sourceEventId ?? `main-work-source:${brief.id}`
    const fingerprint = createHash('sha256').update(canonicalJson(['main-work-split-v1', brief.id, sourceEventId, suggestions])).digest('hex')
    return commandTransaction(this.options.storage, this.options.instanceId, async tx => {
      const prior = await tx.get<MainWorkSplit>('work-split', brief.id)
      const persistedSourceEventId = prior?.sourceEventId ?? sourceEventId
      const normalizedBrief: MainWorkBrief = brief.sourceEventId === persistedSourceEventId ? brief
        : { ...brief, sourceEventId: persistedSourceEventId }
      if (!brief.sourceEventId) await tx.replace('work-brief', brief.id, normalizedBrief)
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          const id = createHash('sha256').update(canonicalJson(['main-work-plan-conflict-v1', brief.id, prior.fingerprint, fingerprint])).digest('hex')
          const conflict: MainWorkPlanConflict = { id, version: 1, workBriefId: brief.id, sourceEventId: persistedSourceEventId,
            plannedFingerprint: prior.fingerprint, attemptedFingerprint: fingerprint, attemptedItems: structuredClone(suggestions),
            message: 'Router suggested a different target decision for an already established WorkBrief. The existing item identities are retained; use a new Main request for a new decision.',
            createdAt: this.now() }
          if (!await tx.get('work-plan-conflict', id)) await tx.insert('work-plan-conflict', id, conflict)
          if (!await tx.replace('work-plan-conflict-head', brief.id, { conflictId: id })) {
            await tx.insert('work-plan-conflict-head', brief.id, { conflictId: id })
          }
        }
        return { ...await this.readSplitIn(tx, prior), brief: normalizedBrief }
      }
      const items: MainWorkItem[] = suggestions.map((item, position) => ({ id: randomUUID(), version: 1,
        workBriefId: brief.id, sourceEventId: persistedSourceEventId, position, ...item, createdAt: this.now() }))
      const split: MainWorkSplit = { id: brief.id, version: 1, workBriefId: brief.id, sourceEventId: persistedSourceEventId,
        fingerprint, itemIds: items.map(item => item.id), createdAt: this.now() }
      for (const item of items) {
        await tx.insert('work-item', item.id, item)
        const receipt: MainWorkReceipt = { version: 1, workBriefId: brief.id, workItemId: item.id, status: 'routing',
          nextStep: 'Router is establishing this independent local work item.', createdAt: this.now() }
        await tx.insert('work-receipt', item.id, receipt)
      }
      await tx.insert('work-split', brief.id, split)
      await this.syncPlanReceipt(tx, normalizedBrief, items)
      return { split, items, brief: normalizedBrief }
    })
  }

  private async establishItem(brief: MainWorkBrief, item: MainWorkItem, signal: AbortSignal) {
    signal.throwIfAborted()
    const existing = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<{ ticketId: string }>('work-item-ticket', item.id))
    if (existing) return this.acceptItem(brief, item, existing.ticketId)
    let ticket: { ticketId: string }
    try {
      ticket = await this.options.createTicket(brief, item)
    } catch (error) {
      if (error instanceof CoreError && ['COMMIT_UNKNOWN', 'STORAGE_UNAVAILABLE', 'HOST_LEASE_LOST'].includes(error.code)) throw error
      const reason = error instanceof CoreError ? error.code : 'WORK_REJECTED'
      const receipt: MainWorkReceipt = { version: 1, workBriefId: brief.id, workItemId: item.id, status: 'rejected', reason,
        nextStep: 'No Ticket was established for this item. Resolve the stated blocker before a new decision.', createdAt: this.now() }
      await this.replaceItemReceipt(item, receipt)
      await this.syncPlanReceiptByBrief(brief)
      await this.publishUpdate(brief, item, receipt)
      return receipt
    }
    return this.acceptItem(brief, item, ticket.ticketId)
  }

  private async acceptItem(brief: MainWorkBrief, item: MainWorkItem, ticketId: string) {
    const current = await this.itemReceipt(item.id)
    const receipt: MainWorkReceipt = current?.status === 'accepted' && current.ticketId === ticketId ? current
      : { version: 1, workBriefId: brief.id, workItemId: item.id, status: 'accepted', ticketId,
        nextStep: 'The Worker must complete this item and verify its acceptance criteria.', createdAt: this.now() }
    await this.options.storage.transaction(this.options.instanceId, async tx => {
      const stored = await tx.get<MainWorkReceipt>('work-receipt', item.id)
      if (stored?.status !== 'accepted') await tx.replace('work-receipt', item.id, receipt)
      if (!await tx.get('work-ticket', ticketId)) await tx.insert('work-ticket', ticketId, { workBriefId: brief.id, workItemId: item.id, ticketId })
      if (!await tx.get('work-item-ticket', item.id)) await tx.insert('work-item-ticket', item.id, { workBriefId: brief.id, workItemId: item.id, ticketId })
      await this.syncPlanReceiptByBriefIn(tx, brief)
    })
    await this.publishUpdate(brief, item, receipt)
    return receipt
  }

  private async replaceItemReceipt(item: MainWorkItem, receipt: MainWorkReceipt) {
    await this.options.storage.transaction(this.options.instanceId,
      tx => tx.replace('work-receipt', item.id, receipt))
  }

  private async syncPlanReceiptByBrief(brief: MainWorkBrief) {
    const { items } = await this.readPlan(brief.id)
    await this.options.storage.transaction(this.options.instanceId, tx => this.syncPlanReceipt(tx, brief, items))
  }

  private async syncPlanReceiptByBriefIn(tx: AsyncTx, brief: MainWorkBrief) {
    const split = await tx.get<MainWorkSplit>('work-split', brief.id)
    if (!split) return
    const items = await Promise.all(split.itemIds.map(id => tx.get<MainWorkItem>('work-item', id)))
    await this.syncPlanReceipt(tx, brief, items.filter((item): item is MainWorkItem => !!item))
  }

  private async syncPlanReceipt(tx: AsyncTx, brief: MainWorkBrief, items: MainWorkItem[]) {
    const prior = await tx.get<MainWorkReceipt>('work-receipt', brief.id)
    const receipts = await Promise.all(items.map(item => tx.get<MainWorkReceipt>('work-receipt', item.id)))
    const tickets = receipts.filter((receipt): receipt is MainWorkReceipt => !!receipt?.ticketId)
    const status = receipts.length > 0 && receipts.every(receipt => receipt?.status === 'accepted') ? 'accepted'
      : receipts.length > 0 && receipts.every(receipt => receipt?.status === 'rejected') ? 'rejected' : 'routing'
    const receipt: MainWorkReceipt = { version: 1, workBriefId: brief.id, status,
      ...(tickets.length ? { ticketIds: tickets.map(receipt => receipt.ticketId!) } : {}),
      nextStep: status === 'routing' ? 'Router is establishing the remaining independent work items.' : 'The independent work items have separate receipts below.',
      createdAt: prior?.createdAt ?? this.now() }
    if (prior) await tx.replace('work-receipt', brief.id, receipt)
    else await tx.insert('work-receipt', brief.id, receipt)
  }

  private async readPlan(workBriefId: string) {
    return this.options.storage.transaction(this.options.instanceId, async tx => {
      const brief = await tx.get<MainWorkBrief>('work-brief', workBriefId)
      if (!brief) return { brief: undefined, split: undefined, items: [] as MainWorkItem[], conflict: undefined }
      const split = await tx.get<MainWorkSplit>('work-split', workBriefId)
      const head = await tx.get<{ conflictId: string }>('work-plan-conflict-head', workBriefId)
      const conflict = head ? await tx.get<MainWorkPlanConflict>('work-plan-conflict', head.conflictId) : undefined
      if (!split) return { brief, split, items: [] as MainWorkItem[], conflict }
      const items = await Promise.all(split.itemIds.map(id => tx.get<MainWorkItem>('work-item', id)))
      if (items.some(item => !item)) throw new CoreError('INCOMPLETE_STATE', 'The durable work plan is missing a decided item.')
      return { brief, split, items: items.filter((item): item is MainWorkItem => !!item).sort((left, right) => left.position - right.position), conflict }
    })
  }

  private async readSplit(workBriefId: string) {
    const plan = await this.readPlan(workBriefId)
    return plan.split ? { ...plan.split, items: plan.items } : undefined
  }

  private async readSplitIn(tx: AsyncTx, split: MainWorkSplit) {
    const items = await Promise.all(split.itemIds.map(id => tx.get<MainWorkItem>('work-item', id)))
    if (items.some(item => !item)) throw new CoreError('INCOMPLETE_STATE', 'The durable work plan is missing a decided item.')
    return { split, items: items.filter((item): item is MainWorkItem => !!item) }
  }

  private itemReceipt(itemId: string) {
    return this.options.storage.transaction(this.options.instanceId, tx => tx.get<MainWorkReceipt>('work-receipt', itemId))
  }

  private async isCurrent(notification: MainWorkNotification, transaction?: AsyncTx) {
    if (notification.outcome?.status !== 'success') return true
    if (!notification.receipt.ticketId) return false
    const check = async (tx: AsyncTx) => {
      const ticket = await tx.get<Work['ticket']>('ticket', notification.receipt.ticketId!)
      const report = await tx.get<{ id: string; assignmentId: string }>('report', notification.receipt.ticketId!)
      const assignment = await tx.get<{ id: string }>('assignment', notification.receipt.ticketId!)
      const intent = await tx.get<Work['intent']>('intent', notification.receipt.ticketId!)
      return !!ticket && !ticket.constraint && !!report && report.id === notification.outcome!.reportId
        && report.assignmentId === assignment?.id && intent?.state === 'ready' && intent.reason === 'ready-report'
    }
    if (transaction) return check(transaction)
    return this.options.storage.transaction(this.options.instanceId, check)
  }

  private async refreshTicket(ticketId: string, signal: AbortSignal) {
    const source = await this.options.storage.transaction(this.options.instanceId, async tx => {
      const index = await tx.get<{ workBriefId: string; workItemId?: string; ticketId?: string }>('work-ticket', ticketId)
      if (!index) return undefined
      const brief = await tx.get<MainWorkBrief>('work-brief', index.workBriefId)
      const item = index.workItemId ? await tx.get<MainWorkItem>('work-item', index.workItemId) : undefined
      return brief ? { brief, item: item ?? this.legacyItem(brief) } : undefined
    })
    if (!source) return
    const snapshot = await this.options.readTicket(ticketId)
    const outcome = this.outcome(source.brief.id, source.item.id, snapshot)
    const followUps = await this.options.storage.transaction(this.options.instanceId,
      transaction => this.followUpsForItem(transaction, source.item))
    const latestFollowUp = followUps.at(-1)
    if (!outcome && latestFollowUp?.status !== 'handed-back') return
    let receipt = await this.itemReceipt(source.item.id)
      ?? await this.options.storage.transaction(this.options.instanceId, tx => tx.get<MainWorkReceipt>('work-receipt', source.brief.id))
    if (!receipt) throw new CoreError('INCOMPLETE_STATE', 'The work receipt is missing.')
    if (receipt.status !== 'accepted' || receipt.ticketId !== ticketId) receipt = await this.acceptItem(source.brief, source.item, ticketId)
    const updateId = this.updateId(source.brief.id, source.item.id, receipt, outcome, followUps)
    if (await this.options.storage.transaction(this.options.instanceId, tx => tx.get('work-update', updateId))) return
    const { revision, profile } = await this.options.routerProfile()
    let recorded = false
    const attempt = await this.startRouterTurn(source.brief, 'update')
    let result
    try {
      result = await this.options.sessions.run({ role: 'router', sessionId: source.brief.routerSessionId, signal, profile,
        stepBudget: routerStepBudget,
        text: `Return this bounded, verified work item state to Main. Keep its source, stable item identity and follow-up delivery facts; no Worker transcript is included.\n${JSON.stringify({
          workBriefId: source.brief.id, workItemId: source.item.id, receipt, outcome, followUps,
        })}`,
        tools: [{ name: 'record_work_update', description: 'Record the supplied work status and evidence exactly and notify Main once.', parameters: {},
          execute: async () => { await this.publishUpdate(source.brief, source.item, receipt, outcome, followUps); recorded = true; return 'The bounded work update is queued for Main.' } }] })
      await this.finishRouterTurn(attempt, { ...result, status: 'completed' })
    } catch (error) {
      await this.finishRouterTurn(attempt, { status: 'failed', error }).catch(() => {})
      throw error
    }
    await this.options.recordRouterUse(result.sessionId, revision, profile)
    if (!recorded) throw new CoreError('ROUTER_NOTICE_UNHANDLED', 'Router did not record the bounded work result.')
  }

  private updateId(workBriefId: string, workItemId: string, receipt: MainWorkReceipt, outcome?: MainWorkOutcome,
    followUps: MainWorkFollowUpView[] = []) {
    const { updatedAt: _time, ...facts } = outcome ?? {}
    const followUpFacts = followUps.map(followUp => ({ id: followUp.id, status: followUp.status,
      persisted: followUp.persisted, adopted: followUp.adopted, delivery: followUp.delivery?.outcome,
      ownership: followUp.ownership?.state, reason: followUp.ownership?.reason ?? followUp.blockedReason }))
    return createHash('sha256').update(canonicalJson([workBriefId, workItemId, receipt, facts, followUpFacts])).digest('hex')
  }

  private async startRouterTurn(brief: MainWorkBrief, phase: WorkRouterTurn['phase']) {
    const prefix = `${JSON.stringify(['work-router-turn', brief.id])}:`
    const id = `${prefix}${randomUUID()}`
    const turn: WorkRouterTurn = { version: 1, id, workBriefId: brief.id, sessionId: brief.routerSessionId,
      phase, status: 'pending', budget: routerStepBudget, createdAt: this.now(), updatedAt: this.now() }
    await this.options.storage.transaction(this.options.instanceId,
      transaction => transaction.insert('work-router-turn', id, turn))
    return turn
  }

  private finishRouterTurn(turn: WorkRouterTurn, result: { status: 'completed' | 'failed'; sessionId?: string
    turnStartSeq?: number; turnEndSeq?: number; stepCount?: number; error?: unknown }) {
    const failure = result.error && typeof result.error === 'object' ? result.error as { code?: unknown } : undefined
    const finished: WorkRouterTurn = {
      ...turn,
      status: result.status,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.turnStartSeq === undefined ? {} : { startSeq: result.turnStartSeq }),
      ...(result.turnEndSeq === undefined ? {} : { endSeq: result.turnEndSeq }),
      ...(result.stepCount === undefined ? {} : { stepCount: result.stepCount }),
      ...(result.status === 'failed' && typeof failure?.code === 'string' ? { errorCode: failure.code } : {}),
      updatedAt: this.now(),
    }
    return this.options.storage.transaction(this.options.instanceId, async transaction => {
      if (!await transaction.replace('work-router-turn', turn.id, finished)) {
        throw new CoreError('INCOMPLETE_STATE', 'The Router observation attempt disappeared before completion.')
      }
    })
  }

  private async publishUpdate(brief: MainWorkBrief, item: MainWorkItem, receipt: MainWorkReceipt, outcome?: MainWorkOutcome,
    followUps: MainWorkFollowUpView[] = []) {
    return commandTransaction(this.options.storage, this.options.instanceId, async tx => {
      const id = this.updateId(brief.id, item.id, receipt, outcome, followUps)
      if (await tx.get('work-update', id)) return
      if (outcome?.status === 'success') {
        const ticket = await tx.get<Work['ticket']>('ticket', outcome.ticketId)
        const report = await tx.get<{ id: string; assignmentId: string }>('report', outcome.ticketId)
        const assignment = await tx.get<{ id: string }>('assignment', outcome.ticketId)
        if (!ticket || ticket.constraint || !report || report.id !== outcome.reportId || report.assignmentId !== assignment?.id) return
      }
      const latestFollowUp = followUps.at(-1)
      const followUpHandback = latestFollowUp?.status === 'handed-back'
      const status = outcome?.status ?? (followUpHandback ? 'waiting' : receipt.status)
      const update: MainWorkUpdate = { version: 1, id, workBriefId: brief.id, workItemId: item.id, ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}),
        status, owner: outcome ? (['waiting', 'blocked', 'unknown'].includes(outcome.status) ? 'user' : 'router') : followUpHandback ? 'user' : 'router',
        summary: outcome?.summary ?? (followUpHandback && latestFollowUp
          ? `Worker handed back the follow-up: ${latestFollowUp.ownership?.reason ?? 'This direction is outside the original work.'}`
          : status === 'accepted' ? 'Router accepted this independent work item.' : 'Router declined this independent work item.'),
        needsDecision: ['waiting', 'blocked', 'unknown', 'rejected'].includes(status), createdAt: this.now() }
      const notification: MainWorkNotification = { mainId: brief.mainId, receipt, update, ...(outcome ? { outcome } : {}),
        ...(followUps.length ? { followUps } : {}) }
      await tx.insert('work-update', id, notification)
      if (!await tx.replace('work-update-head', item.id, update)) await tx.insert('work-update-head', item.id, update)
      if (outcome && !await tx.replace('work-outcome', item.id, outcome)) await tx.insert('work-outcome', item.id, outcome)
      await this.options.effects.enqueue(tx, { key: id, stream: 'notice', scope: `main:${brief.mainId}`, payload: { type: 'main-work-update', updateId: id } })
    })
  }

  async list(mainId: string): Promise<MainWorkCard[]> {
    identifier(mainId, 'mainId')
    const briefs: MainWorkBrief[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.options.storage.transaction(this.options.instanceId,
        transaction => transaction.scan<MainWorkBrief>('work-brief', { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) }))
      briefs.push(...page.items.map(item => item.value).filter(brief => brief.mainId === mainId))
      if (page.cursor === undefined) break
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('WORK_LIST_BUDGET', 'The Main work list exceeds its 1000-record read budget.')
    }
    const recent = briefs.sort((left, right) => right.createdAt - left.createdAt).slice(0, 20)
    const sources = await Promise.all(recent.map(async brief => {
      const split = await this.readSplit(brief.id)
      return split?.items.map(item => ({ brief, item })) ?? [{ brief, item: this.legacyItem(brief) }]
    }))
    const cards = await Promise.all(sources.flat().map(({ brief, item }) => this.card(brief, item)))
    return cards.filter((card): card is MainWorkCard => !!card)
      .sort((left, right) => left.brief.createdAt - right.brief.createdAt || left.brief.position - right.brief.position)
      .slice(-20)
  }

  async query(mainId: string, selector: { workBriefId?: string; workItemId?: string }) {
    identifier(mainId, 'mainId')
    if (!selector.workBriefId && !selector.workItemId || selector.workBriefId && selector.workItemId) {
      throw new CoreError('INVALID_INPUT', 'Query one work item or one WorkBrief.')
    }
    if (selector.workItemId) {
      identifier(selector.workItemId, 'workItemId')
      const { brief, item } = await this.options.storage.transaction(this.options.instanceId, async tx => {
        const item = await tx.get<MainWorkItem>('work-item', selector.workItemId!)
        const brief = item ? await tx.get<MainWorkBrief>('work-brief', item.workBriefId) : undefined
        return { item, brief }
      })
      if (!item || !brief || brief.mainId !== mainId || brief.instanceId !== this.options.instanceId) {
        throw new CoreError('NOT_FOUND', 'This work item is not available in the current Main Instance.')
      }
      return this.card(brief, item)
    }
    const briefId = selector.workBriefId!
    identifier(briefId, 'workBriefId')
    const { brief, split } = await this.readPlan(briefId)
    if (!brief || brief.mainId !== mainId || brief.instanceId !== this.options.instanceId) {
      throw new CoreError('NOT_FOUND', 'This work item is not available in the current Main Instance.')
    }
    if (split) return this.plan(mainId, briefId)
    const receipt = await this.options.storage.transaction(this.options.instanceId, tx => tx.get<MainWorkReceipt>('work-receipt', brief.id))
    if (!receipt) throw new CoreError('INCOMPLETE_STATE', 'The Main WorkReceipt is missing.')
    return this.card(brief, this.legacyItem(brief))
  }

  async followUp(request: MainWorkFollowUpRequest): Promise<MainWorkFollowUpView> {
    if (!request || Object.keys(request).some(key => !['commandId', 'mainId', 'mainSessionId', 'mainMessageId',
      'originalUserText', 'workItemId', 'text', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A Main follow-up accepts only its source and one exact work item.')
    }
    identifier(request.commandId, 'commandId')
    identifier(request.mainId, 'mainId')
    identifier(request.mainSessionId, 'mainSessionId')
    identifier(request.mainMessageId, 'mainMessageId')
    identifier(request.workItemId, 'workItemId')
    if (!this.options.source.allowedActorIds.includes(this.options.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot follow up Main work.')
    }
    const originalUserText = boundedText(request.originalUserText, 'The Main follow-up source text', 32768)
    const text = boundedText(request.text, 'The Main follow-up direction', 32768)
    const reason = request.reason === undefined ? 'The user explicitly directed this work item from its Main conversation.'
      : boundedText(request.reason, 'The Main follow-up reason', 2048)
    const key = commandKey(this.options.source, request.commandId)
    return commandTransaction(this.options.storage, this.options.instanceId, async transaction => {
      await this.verifyFollowUpSource(transaction, request, originalUserText)
      const { item, brief, ticketId } = await this.followUpTarget(transaction, request)
      const fingerprint = this.followUpFingerprint(request, originalUserText, item, ticketId, text, reason)
      const prior = await transaction.get<{ fingerprint: string; followUpId: string }>('work-follow-up-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new CoreError('IDENTITY_CONFLICT', 'This Main follow-up identity was already used for different direction.')
        }
        const record = await transaction.get<MainWorkFollowUp>('work-follow-up', followUpKey(item.id, prior.followUpId))
        if (!record) throw new CoreError('INCOMPLETE_STATE', 'The accepted Main follow-up is missing.')
        return this.followUpView(transaction, record)
      }
      const followUpId = randomUUID()
      const attachment = await this.options.applyFollowUp(transaction, {
        ticketId,
        followUpId,
        text,
        authorId: this.options.source.actorId,
        reason,
      })
      const record = this.followUpRecord(followUpId, request, originalUserText, item, brief, ticketId, text, reason, attachment)
      await transaction.insert('work-follow-up', followUpKey(item.id, record.id), record)
      await transaction.insert('work-follow-up-command', key, { fingerprint, followUpId: record.id })
      return this.followUpView(transaction, record)
    })
  }

  private async verifyFollowUpSource(transaction: AsyncTx, request: MainWorkFollowUpRequest, originalUserText: string) {
    const mainState = await transaction.get<{ mainId: string; mainSessionId: string }>('main-state', 'main')
    if (mainState?.mainId !== request.mainId || mainState.mainSessionId !== request.mainSessionId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The Main follow-up source does not belong to the current Main conversation.')
    }
    let sourceMessage: { role: 'user' | 'main'; text: string } | undefined
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<{ id: string; role: 'user' | 'main'; text: string }>('main-message',
        { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) })
      sourceMessage = page.items.find(entry => entry.value.id === request.mainMessageId)?.value
      if (sourceMessage || !page.cursor) break
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('MAIN_HISTORY_BUDGET', 'The Main follow-up source scan exceeded its 1000-message budget.')
    }
    if (!sourceMessage || sourceMessage.role !== 'user' || sourceMessage.text.trim() !== originalUserText) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A Main follow-up must cite the exact current Main user message.')
    }
  }

  private async followUpTarget(transaction: AsyncTx, request: MainWorkFollowUpRequest) {
    const item = await transaction.get<MainWorkItem>('work-item', request.workItemId)
    const brief = item ? await transaction.get<MainWorkBrief>('work-brief', item.workBriefId) : undefined
    if (!item || !brief || brief.mainId !== request.mainId || brief.instanceId !== this.options.instanceId) {
      throw new CoreError('NOT_FOUND', 'The named work item is not available in the current Main Instance.')
    }
    const receipt = await transaction.get<MainWorkReceipt>('work-receipt', item.id)
      ?? await transaction.get<MainWorkReceipt>('work-receipt', brief.id)
    const ticketIndex = await transaction.get<{ ticketId: string }>('work-item-ticket', item.id)
    const ticketId = receipt?.status === 'accepted' ? receipt.ticketId ?? ticketIndex?.ticketId : undefined
    if (!receipt || receipt.status !== 'accepted' || !ticketId) {
      throw new CoreError('WORK_NOT_ACCEPTED', 'Only accepted, established work can receive a Main follow-up.')
    }
    return { item, brief, ticketId }
  }

  private followUpFingerprint(request: MainWorkFollowUpRequest, originalUserText: string, item: MainWorkItem,
    ticketId: string, text: string, reason: string) {
    return createHash('sha256').update(canonicalJson(['main-work-follow-up-v1', this.options.instanceId,
      request.mainId, request.mainSessionId, request.mainMessageId, originalUserText, item.id, item.workBriefId,
      item.sourceEventId, ticketId, text, reason])).digest('hex')
  }

  private followUpRecord(followUpId: string, request: MainWorkFollowUpRequest, originalUserText: string, item: MainWorkItem,
    brief: MainWorkBrief, ticketId: string, text: string, reason: string, attachment: MainFollowUpAttachment): MainWorkFollowUp {
    return {
      id: followUpId,
      version: 1,
      instanceId: this.options.instanceId,
      commandId: request.commandId,
      authorization: { kind: 'authorized-main-actor', sourceInstanceId: this.options.source.sourceInstanceId,
        actorId: this.options.source.actorId },
      mainId: brief.mainId,
      mainSessionId: request.mainSessionId,
      originalUserText,
      workBriefId: brief.id,
      workItemId: item.id,
      originalSourceEventId: item.sourceEventId,
      ticketId,
      text,
      reason,
      source: { kind: 'main-message', id: request.mainMessageId },
      routing: 'direct-to-original',
      directionVersion: attachment.directionVersion,
      attachment: attachment.status,
      ...(attachment.inputId ? { inputId: attachment.inputId } : {}),
      ...(attachment.ownershipId ? { ownershipId: attachment.ownershipId } : {}),
      ...(attachment.reason ? { blockedReason: attachment.reason } : {}),
      createdAt: this.now(),
    }
  }

  private async followUpView(transaction: AsyncTx, record: MainWorkFollowUp): Promise<MainWorkFollowUpView> {
    const input = record.inputId ? await transaction.get<WorkInput>('work-input', record.inputId) : undefined
    const ownership = record.ownershipId
      ? await transaction.get<WorkOwnership>('work-ownership', record.ownershipId)
      : undefined
    const delivery = input?.delivery
    const completed = delivery?.completedAt !== undefined
    const status: MainWorkFollowUpStatus = record.attachment === 'stopped' ? 'stopped'
      : record.attachment === 'waiting' ? 'waiting'
        : delivery?.exhaustedAt !== undefined ? 'expired'
          : completed && delivery.outcome === 'ready' ? 'ready'
            : completed && delivery.outcome === 'attention' ? 'waiting'
              : completed && delivery?.outcome === 'handback' || ownership?.state === 'handed-back' ? 'handed-back'
                : delivery?.persistedAt !== undefined ? 'persisted'
                  : delivery?.claimedAt !== undefined ? 'delivering'
                    : 'queued'
    return {
      ...record,
      status,
      persisted: delivery?.persistedAt !== undefined,
      adopted: completed,
      ...(delivery ? { delivery: structuredClone(delivery) } : {}),
      ...(ownership ? { ownership: structuredClone(ownership) } : {}),
      ...(ownership?.reason || record.blockedReason
        ? { displayReason: ownership?.reason ?? record.blockedReason } : {}),
    }
  }

  private async followUpsForItem(transaction: AsyncTx, item: MainWorkItem): Promise<MainWorkFollowUpView[]> {
    const records = await this.readFollowUpsForItem(transaction, item.id)
    const views: MainWorkFollowUpView[] = []
    for (const record of records.sort((left, right) => left.createdAt - right.createdAt).slice(-10)) {
      views.push(await this.followUpView(transaction, record))
    }
    return views
  }

  private async readFollowUpsForItem(transaction: AsyncTx, workItemId: string): Promise<MainWorkFollowUp[]> {
    const prefix = followUpPrefix(workItemId)
    const records: MainWorkFollowUp[] = []
    let cursor = prefix
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<MainWorkFollowUp>('work-follow-up', { limit: 100, after: cursor })
      for (const entry of page.items) {
        if (!entry.id.startsWith(prefix)) return records
        const record = entry.value
        records.push(record)
      }
      if (!page.cursor || !page.cursor.startsWith(prefix)) break
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('WORK_FOLLOW_UP_BUDGET', 'The Main follow-up list exceeds its 1000-record budget.')
    }
    return records
  }

  private async card(brief: MainWorkBrief, item: MainWorkItem): Promise<MainWorkCard | undefined> {
    const receipt = await this.itemReceipt(item.id)
      ?? await this.options.storage.transaction(this.options.instanceId, tx => tx.get<MainWorkReceipt>('work-receipt', brief.id))
    if (!receipt) return undefined
    const cardBrief: MainWorkCardBrief = { id: brief.id, workItemId: item.id, sourceEventId: item.sourceEventId,
      position: item.position, mainMessageId: brief.mainMessageId, goal: item.goal, constraints: item.constraints, acceptanceCriteria: item.acceptanceCriteria,
      createdAt: brief.createdAt }
    const projection = await this.options.storage.transaction(this.options.instanceId, async tx => ({
      update: await tx.get<MainWorkUpdate>('work-update-head', item.id), outcome: await tx.get<MainWorkOutcome>('work-outcome', item.id),
      followUps: await this.followUpsForItem(tx, item),
    }))
    const followUps = projection.followUps.length ? { followUps: projection.followUps } : {}
    if (!receipt.ticketId) return { brief: cardBrief, receipt, status: receipt.status,
      ...(projection.update ? { update: projection.update } : {}), ...followUps }
    const snapshot = await this.options.readTicket(receipt.ticketId)
    const current = this.outcome(brief.id, item.id, snapshot)
    const persisted = !!current && projection.outcome?.status === current.status && projection.outcome.reportId === current.reportId
    const outcome = persisted ? projection.outcome : current
    const update = !current ? projection.update : persisted ? projection.update : undefined
    const latestFollowUp = projection.followUps.at(-1)
    const snapshotStatus = this.status(snapshot)
    const status = latestFollowUp ? followUpCardStatus[latestFollowUp.status]
      : outcome?.status ?? (snapshotStatus === 'success' ? 'running' : snapshotStatus)
    return { brief: cardBrief, receipt, status,
      ...(update ? { update } : {}), ...(outcome ? { outcome } : {}), ...followUps,
      ...(snapshot.control ? { control: { ...snapshot.control, workItemId: item.id } } : {}) }
  }

  private legacyItem(brief: MainWorkBrief): MainWorkItem {
    return { id: brief.id, version: 1, workBriefId: brief.id, sourceEventId: brief.sourceEventId ?? `legacy-main-source:${brief.id}`,
      position: 0, goal: brief.goal, constraints: brief.constraints, acceptanceCriteria: brief.acceptanceCriteria, createdAt: brief.createdAt }
  }

  private status(snapshot: MainWorkTicketSnapshot): MainWorkStatus {
    if (snapshot.setupCode) return 'blocked'
    if (snapshot.status === 'waiting-human') return 'waiting'
    if (snapshot.status === 'stopped' || snapshot.status === 'stopping') return 'stopped'
    if (snapshot.reason === 'environment-waiting') return 'blocked'
    if (snapshot.reason === 'recovery-blocked' || snapshot.reason === 'recovery-exhausted') return 'unknown'
    if (snapshot.status === 'ready' && snapshot.report) return 'success'
    if (snapshot.reason === 'worker-idle' || snapshot.lifecycle === 'ended') return 'failed'
    if (snapshot.status === 'ready') return 'unknown'
    return snapshot.status
  }

  private outcome(workBriefId: string, workItemId: string, snapshot: MainWorkTicketSnapshot): MainWorkOutcome | undefined {
    const report = snapshot.report
    const status = this.status(snapshot)
    if (report && status === 'success') return { version: 1, workBriefId, workItemId, ticketId: snapshot.ticketId, status: 'success',
      summary: report.result.slice(0, 2048), evidence: report.evidence.slice(0, 2048),
      artifacts: report.artifacts.slice(0, 10).map(({ path, bytes, sha256, reference }) => ({ path, bytes, sha256, ...(reference === undefined ? {} : { reference }) })),
      reportId: report.id, nextStep: 'Review the verified result and artifact references.', updatedAt: this.now() }
    const details = {
      blocked: ['The Worker could not prepare the configured local workspace.', `Setup status: ${snapshot.setupCode ?? snapshot.reason}.`, 'Resolve the workspace blocker before retrying.'],
      waiting: ['The Worker is waiting for an authorized answer.', 'See the work question attached to this Ticket.', 'Answer the current work question.'],
      stopped: ['This work is stopped or stopping.', 'No completion is inferred from a stop request.', 'Check the confirmed stop state before resuming.'],
      unknown: ['The work result could not be confirmed.', 'No current verified result can be accepted.', 'Reconcile the original work before retrying.'],
      failed: ['The Worker ended without a verified result.', 'No ready report was recorded for the current Assignment.', 'Review the failure before deciding whether to retry.'],
    } as const
    if (!(status in details)) return undefined
    const [summary, evidence, nextStep] = details[status as keyof typeof details]
    return { version: 1, workBriefId, workItemId, ticketId: snapshot.ticketId, status: status as keyof typeof details,
      summary, evidence, nextStep, artifacts: [], updatedAt: this.now() }
  }
}
