import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { CoreError, identifier, triggerDeliveryTarget, type CommandRecord, type DesktopSource, type EventRecord, type IntakePolicy, type Receipt, type Source, type SubmitRequest, type Work } from './model.js'
import { capabilityLocations, validateHostCapabilities, validateRequiredCapabilities,
  type CapabilityPlanView, type HostCapabilities } from './capability-locations.js'
import type { AsyncTx, Storage } from './storage.js'
import { canonicalJson, commandTransaction } from './commands.js'
import { Effects, type EffectsOptions } from './effects.js'
import { Execution, type Assignment } from './execution.js'
import { visibleEnvironmentHandoff, withHandoffOwners } from './environment-handoff.js'
import type { EnvironmentHandoffRevalidation, EnvironmentHandoffView, HandoffBlocker } from './environment-handoff.js'
import type { NativeSessions } from './native-sessions.js'
import { environmentLocation, type EnvironmentLocation, type EnvironmentProbe, type ExecutionEnvironment } from './environment.js'
import { unsupportedAssetCapabilities, assertReferenceShape, attachmentBytes, UnsupportedEnvironmentCombination,
  type EnvironmentAssetCapabilities, type EnvironmentAssetReference } from './environment-assets.js'
import { SourceEvents, isCurrentSourceEvent, type AcceptSourceRequest, type ReceiveSourceEvent, type SourceEvent, type SourceObjectRef } from './source-events.js'
import { SourceEvaluations, validateIntakePolicy, type SourceEvaluation } from './source-evaluations.js'
import { associatedInput, WorkInputs, type TicketDirection, type WorkInput, type WorkNote } from './work-inputs.js'
import { Attentions, type Attention } from './attention.js'
import { Slots, type SlotOptions, type SlotSnapshot } from './slots.js'
import { Jobs, type JobsOptions, type JobView } from './jobs.js'
import type { Previews, PreviewView } from './previews.js'
import { Subagents, type SubagentsOptions, type SubagentView } from './subagents.js'
import { Deliveries, type Delivery, type DeliveryOptions, type DeliveryView } from './deliveries.js'
import { Outbox } from './outbox.js'
import { HostLease, type HostOptions } from './host.js'
import { ClientAccess } from './client-access.js'
import { feishuQuestionCode } from './feishu-delivery.js'
import { ProductCredentialManager } from './product-credential-manager.js'
import { ProductCredentialImports, type CredentialImportAdapter } from './product-credential-imports.js'
import type { WorkerMcpBinding } from './worker-mcp-tool.js'
import { ProductMcpConfiguration } from './product-mcp-configuration.js'
import { CapabilityLibrary } from './capability-library.js'
import type { WorkerMcpConfig } from './worker-mcp-tool.js'
import { BrowserResources, type BrowserAdapter, type BrowserImportPreview } from './browser-resources.js'
import type { ProductComputer } from './product-computer.js'
import type { ProductCredentialRecords } from './product-credential-vault.js'
import type { ProductAttachments } from './product-attachments.js'
import { validateProductViewAnswer, type ProductViewAnswer } from './product-views.js'
import { listSupervisorProposals, Supervisor, type SupervisorOptions, type SupervisorProposal } from './supervisor.js'
import { boundedInteger } from './bounds.js'
import { assertHostTakeoverSettled, loadHostTakeover, type HostTakeoverRecord, type HostTakeoverTicket } from './host-takeover.js'
import { ContextReader, type ContextCandidate, type ContextCard, type ContextRef, type ContextRequest } from './context.js'
import { RoleConfigStore, validateRoleConfig, type RoleConfig, type RoleConfigUse, type RoleConfigView } from './config.js'
import { RolePresetStore, type RolePresetApplication } from './role-preset-store.js'
import { prepareRolePresetApplication, type LegacyPresetCopy, type PresetRole } from './role-presets.js'
import { draftKey, instructionKey, validateBehaviorChange, type BehaviorChange, type BehaviorInterpreter,
  type BehaviorInstructionRecord, type ConfigDraft } from './config-instructions.js'
import { DeliveryState, type DeliveryCondition, type DeliveryTarget } from './delivery-state.js'
import { Proactive, type ProactiveCandidate, type ProactiveOptions, type ProactiveRule, type ProactiveRun } from './proactive.js'
import { SourceMembership, type MembershipSnapshot, type SourceMember } from './membership.js'
import { ExecutionPolicyStore, loadExecutionSelection, selectExecutionTarget, targetMatches,
  type ExecutionPolicyConfig, type ExecutionPolicyView, type ExecutionTarget } from './execution-target.js'
import { compareWorkCopy, WorkCopyUnsupported, workCopyGaps,
  uniqueBlockers, type HandoffCopyView, type WorkCopyBlocker, type WorkCopyComparison, type WorkCopyFile, type WorkCopySnapshot } from './work-copy.js'
import { MainConversation, type MainAddress, type MainSend } from './main-conversation.js'
import { WorkDelegation, type MainEvidenceCard, type MainWorkCard, type MainWorkControl,
  type MainWorkHandoffProjection, type MainWorkBrief, type MainWorkItem } from './work-delegation.js'
import { WorkObservations } from './work-observations.js'
import { MainSourceHandoffs, type MainSourceDeliveryPage, type MainSourceDeliveryView, type MainSourceHandoff, type MainSourceView } from './main-source.js'
import { ProductSchedules, authorizedScheduleEvent, scheduledOccurrenceKey, type ScheduleFamily,
  type ProductSchedule, type ScheduleCreate, type ScheduleTarget, type ScheduledOccurrence } from './product-schedules.js'
import type { ProactiveWorkRecord } from './proactive-work.js'
import { ProductMemory, memoryToolsFor, type MemoryReader, type MemoryScope, type MemorySideTarget } from './product-memory.js'
import { ProductUsage, type ProductUsageReport } from './product-usage.js'

interface StoredPolicy { revision: number; configuration: Omit<IntakePolicy, 'assess'>; origin: 'bootstrap' | 'manual' | 'sync'; sourceRevision?: string; updatedAt: number }
interface ProcessingState { paused: boolean; revision: number; updatedAt: number }
interface StoredPolicyNotice { key: string; ticketId: string; revision: number; reason: string }
type LeasedBehaviorInstruction = BehaviorInstructionRecord & { leaseToken?: string }

export class Engine {
  readonly effects: Effects
  private readonly main: MainConversation
  private readonly workDelegation?: WorkDelegation
  private readonly workObservations: WorkObservations | undefined
  private readonly mainSources: MainSourceHandoffs
  private readonly schedules: ProductSchedules
  private readonly memory: ProductMemory
  private readonly slots: Slots | undefined
  private readonly jobs: Jobs | undefined
  private readonly previews: Previews | undefined
  private readonly subagents: Subagents | undefined
  private readonly execution: Execution | undefined
  private readonly authoringActorIds: string[] | undefined
  private readonly sourceEvents: SourceEvents
  private readonly evaluations: SourceEvaluations | undefined
  private readonly inputs: WorkInputs
  private readonly attentions: Attentions
  private readonly deliveries: Deliveries
  private readonly outbox: Outbox
  private readonly storage: Storage
  private readonly host: HostLease
  private readonly context: ContextReader
  private readonly sessions: NativeSessions | undefined
  private readonly roleConfig: RoleConfigStore
  private capabilityLibrary: CapabilityLibrary | undefined
  private imSourceAuthority: ((tx: AsyncTx, event: SourceEvent) => Promise<boolean>) | undefined
  private readonly productUsage: ProductUsage
  private readonly rolePresets: RolePresetStore
  private readonly executionPolicy: ExecutionPolicyStore
  private readonly hostCapabilities: HostCapabilities
  private readonly deliveryState: DeliveryState
  private browserResources: BrowserResources | undefined
  private productCredentialManager: ProductCredentialManager | undefined
  private readonly proactive: Proactive | undefined
  private readonly membership: SourceMembership
  private roleConfigRevision = 1
  private policyRevision = 1
  private processingPaused = false
  private policyReady: Promise<void> | undefined
  private configuredIntake: IntakePolicy | undefined
  private readonly configuredAssessor: IntakePolicy['assess'] | undefined
  private readonly defaultAssessor: IntakePolicy['assess'] | undefined
  private readonly initialIntake: IntakePolicy | undefined
  private initialPolicyRevision = 1
  private hasPersistedPolicy = false
  private bootstrapPolicy = false
  private avoidPolicyPersistence = false
  private readonly ticketCursors = new Map<string, { after: string; sourceInstanceId: string; actorId: string; expiresAt: number }>()
  private supervisorCursorKey: Promise<Buffer> | undefined
  private commandKey(commandId: string) { return createHash('sha256').update(JSON.stringify([this.source.sourceInstanceId, this.source.actorId, commandId])).digest('hex') }
  private policyKey() { return JSON.stringify(['policy-state', this.source.sourceInstanceId]) }
  private processingKey() { return JSON.stringify(['processing-state', this.source.sourceInstanceId]) }
  private async triggerFor(transaction: AsyncTx, ticketId: string) {
    const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket ? await transaction.get<Work['trigger']>('trigger', ticket.triggerId) : undefined
    if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The Ticket does not exist.')
    return trigger
  }

  private async ensurePolicy() {
    if (this.avoidPolicyPersistence) {
      if (this.configuredIntake) this.evaluations?.replacePolicy(this.configuredIntake, 1, this.configuredAssessor)
      return
    }

    if (this.policyReady) {
      try { await this.policyReady }
      catch (error) { this.policyReady = undefined; throw error }
      return
    }
    this.policyReady = commandTransaction(this.storage, this.instanceId, async tx => {
      const stored = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      const currentAssessor = this.configuredAssessor
      const configured = this.initialIntake
      if (stored) {
        this.hasPersistedPolicy = true
        this.bootstrapPolicy = stored.origin === 'bootstrap'
        this.applyPolicy(stored.configuration, stored.revision, currentAssessor)
      } else if (configured) {
        const { assess: _assess, ...configuration } = configured
        const persistedConfiguration = structuredClone(configuration)
        const initial: StoredPolicy = { revision: this.initialPolicyRevision, configuration: persistedConfiguration, origin: 'bootstrap', updatedAt: Date.now() }
        if (!await tx.replace('policy-state', this.policyKey(), initial)) await tx.insert('policy-state', this.policyKey(), initial)
      }
      const processing = await tx.get<ProcessingState>('processing-state', this.processingKey())
      if (processing) this.processingPaused = processing.paused
      this.effects.setPaused(this.processingPaused)
      this.evaluations?.setPaused(this.processingPaused)
    })
    try { await this.policyReady }
    catch (error) { this.policyReady = undefined; throw error }
    await this.getRoleConfig()
    if (this.configuredIntake && (!this.hasPersistedPolicy || this.bootstrapPolicy)) await this.syncConfiguredPolicy()
  }

  private async syncConfiguredPolicy() {
    if (!this.configuredIntake) return
    const configured = this.initialIntake!
    const { assess: _assess, ...configuration } = configured
    const fingerprint = createHash('sha256').update(canonicalJson(configuration)).digest('hex')
    const key = JSON.stringify(['policy-bootstrap', this.source.sourceInstanceId])
    await this.storage.transaction(this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string }>('policy-state', key)
      if (prior?.fingerprint === fingerprint) return
      const revision = Math.max(this.initialPolicyRevision, ((await tx.get<StoredPolicy>('policy-state', this.policyKey()))?.revision ?? 0) + 1)
      const stored: StoredPolicy = { revision, configuration: structuredClone(configuration), origin: 'bootstrap', updatedAt: Date.now() }
      if (!await tx.replace('policy-state', this.policyKey(), stored)) await tx.insert('policy-state', this.policyKey(), stored)
      if (!await tx.replace('policy-state', key, { fingerprint })) await tx.insert('policy-state', key, { fingerprint })
      this.hasPersistedPolicy = true
      this.applyPolicy(this.initialIntake!, revision, this.configuredAssessor)
    })
  }

  private applyPolicy(policy: IntakePolicy | undefined, revision: number, assessor: IntakePolicy['assess'] | undefined = undefined) {
    if (!policy) return
    this.source.intake = policy
    this.policyRevision = revision
    this.evaluations?.replacePolicy(policy, revision, assessor ?? this.defaultAssessor)
    this.inputs.setPolicy(policy)
    this.execution?.setAllowedRequesterIds(policy.allowedRequesterIds)
  }

  private async drainPolicyReevaluations() {
    if (this.processingPaused) return
      const prefix = JSON.stringify(['policy-reevaluation', this.source.sourceInstanceId])
    const pending = await commandTransaction(this.storage, this.instanceId, async tx => {
      let cursor = prefix
      const items: StoredPolicyNotice[] = []
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<StoredPolicyNotice>('policy-reevaluation', { limit: 100, after: cursor })
        for (const item of page.items) {
          if (!item.id.startsWith(prefix)) return items
          items.push({ ...item.value, key: item.id })
        }
        if (!page.cursor || !page.cursor.startsWith(prefix)) return items
        cursor = page.cursor
        if (pageCount === 9) {
          const confirmation = await tx.scan<StoredPolicyNotice>('policy-reevaluation', { limit: 1, after: cursor })
          if (!confirmation.items[0]?.id.startsWith(prefix)) return items
          throw new CoreError('EVAL_BUDGET', 'The pending Policy reevaluation scan exceeded its 1000-record budget.')
        }
      }
      return items
    })
    if (!this.evaluations) return
    for (const item of pending) {
      await commandTransaction(this.storage, this.instanceId, tx => this.evaluations!.requeueInterrupted(tx, { evaluationId: item.ticketId, candidateEventIds: [] }, item.reason))
    }
    const threads = new Set<string>()
    for (const item of pending) {
      const detail = await this.storage.transaction(this.instanceId, tx => tx.get<SourceEvaluation>('eval', item.ticketId))
      if (detail) threads.add(detail.threadId)
    }
    await commandTransaction(this.storage, this.instanceId, async tx => {
      for (const item of pending) {
        if (item.key.startsWith(prefix)) await tx.remove('policy-reevaluation', item.key)
      }
    })
    for (const threadId of threads) await this.evaluations.runAll(threadId)
  }

  private assertAuthoringActor() {
    if (this.authoringActorIds !== undefined && !this.authoringActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot change versioned behavior configuration.')
    }
  }
  constructor(rawStorage: Storage, private readonly instanceId: string, private readonly source: DesktopSource, effectsOptions: EffectsOptions = {}, sessions?: NativeSessions, private readonly environments: ExecutionEnvironment[] = [], slotOptions: SlotOptions = {}, jobOptions: JobsOptions = {}, subagentOptions: SubagentsOptions = {}, deliveryOptions: DeliveryOptions = {}, hostOptions: HostOptions = {}, private readonly proactiveOptions?: ProactiveOptions, attachments?: ProductAttachments) {
    identifier(instanceId, 'instanceId')
    identifier(source.sourceInstanceId, 'sourceInstanceId')
    identifier(source.actorId, 'actorId')
    this.hostCapabilities = validateHostCapabilities(source.hostCapabilities)
    this.host = new HostLease(rawStorage, instanceId, hostOptions)
    const storage = this.host.guard(rawStorage)
    this.storage = storage
    this.productUsage = new ProductUsage(storage, instanceId, sessions)
    this.memory = new ProductMemory(storage, instanceId)
    this.sessions = sessions
    this.workObservations = sessions ? new WorkObservations(storage, instanceId, sessions) : undefined
    this.main = new MainConversation(storage, instanceId, source, sessions, async sessionId => {
      const config = await this.getRoleConfig()
      if (!config.roles.main) throw new CoreError('ROLE_NOT_CONFIGURED', 'Main needs its own role profile.')
      await storage.transaction(instanceId, tx => this.roleConfig.recordUse(tx, { sessionId, role: 'main', revision: config.revision,
        main: config.roles.main!.model, router: config.roles.router.model, worker: config.roles.worker.model }))
      const profile = structuredClone(config.roles.main)
      return { profile: await this.capabilityLibrary?.profile(profile, { role: 'main' }) ?? profile, revision: config.revision }
    }, () => this.environments.some(candidate => candidate.kind === 'local' && candidate.config.instanceId === instanceId
      && candidate.config.allowedActorIds.includes(source.actorId) && candidate.config.permissions.includes('read')
      && candidate.config.permissions.includes('write')) ? this.workDelegation : undefined,
    async transaction => (await this.instanceDirectoryIn(transaction))?.environmentId, attachments,
    binding => source.sourceInstanceId === 'product-desktop'
      ? memoryToolsFor(this.memory, { role: 'main', sessionId: binding.mainSessionId }) : [],
    (tx, request) => this.effects.enqueue(tx, request))
    this.roleConfig = new RoleConfigStore(storage, instanceId, {
      ...(sessions?.mainRoute ? { main: { name: 'Main', model: sessions.mainRoute, instructions: '', skills: [] } } : {}),
      router: { name: 'Router', model: sessions?.routerRoute ?? { provider: 'unconfigured', model: 'unconfigured' }, instructions: '', skills: [] },
      worker: { name: 'Worker', model: sessions?.workerRoute ?? { provider: 'unconfigured', model: 'unconfigured' }, instructions: '', skills: [] },
    }, Date.now)
    this.rolePresets = new RolePresetStore(storage, instanceId)
    this.executionPolicy = new ExecutionPolicyStore(storage, instanceId, Date.now)
    if (!Array.isArray(source.allowedActorIds)) throw new CoreError('INVALID_CONFIG', 'allowedActorIds must be explicitly configured.')
    for (const actor of source.allowedActorIds) identifier(actor, 'allowedActorId')
    if (source.authoringActorIds !== undefined) {
      if (!Array.isArray(source.authoringActorIds) || source.authoringActorIds.some(actor => typeof actor !== 'string')) throw new CoreError('INVALID_CONFIG', 'authoringActorIds must be an explicit actor list.')
      for (const actor of source.authoringActorIds) identifier(actor, 'authoringActorId')
      if (!source.authoringActorIds.every(actor => source.allowedActorIds.includes(actor))) throw new CoreError('INVALID_CONFIG', 'authoringActorIds must be allowed actors.')
    }
    this.authoringActorIds = source.authoringActorIds === undefined ? undefined : [...source.authoringActorIds]
    const { intake, hostCapabilities: _hostCapabilities, authoringActorIds: _authoringActorIds, ...serializableSource } = source
    this.avoidPolicyPersistence = typeof storage.transaction !== 'function'
    this.defaultAssessor = intake?.assess ?? (sessions ? ((events: Record<string, unknown>[], signal: AbortSignal, onDelivered: () => Promise<void>) => sessions.assessSourceBatch(events, signal, onDelivered)) : undefined)
    this.configuredAssessor = this.defaultAssessor
    this.configuredIntake = intake
    if (intake) {
      const { assess: _assess, ...configuration } = intake
      const clonedConfiguration = structuredClone(configuration)
      this.initialIntake = intake.assess ? { ...clonedConfiguration, assess: intake.assess } : clonedConfiguration
    }
    const clonedSource = structuredClone(serializableSource)
    this.source = intake ? { ...clonedSource, intake } : clonedSource
    const sourceBinding = { ...this.source }
    delete sourceBinding.intake
    this.sourceEvents = new SourceEvents(storage, instanceId, sourceBinding)
    this.mainSources = new MainSourceHandoffs(storage, instanceId, Date.now)
    this.schedules = new ProductSchedules(storage, instanceId, source.actorId,
      (tx, target) => this.authorizeScheduledTarget(tx, target),
      (rule, occurrence) => this.receiveScheduledOccurrence(rule, occurrence))
    this.membership = new SourceMembership(storage, instanceId, this.source.sourceInstanceId, Date.now)
    this.deliveryState = new DeliveryState(storage, instanceId, this.sourceEvents, Date.now)
    this.proactive = proactiveOptions ? new Proactive(storage, instanceId, { ...proactiveOptions,
      guard: async (tx, candidate) => {
        const event = await tx.get<SourceEvent>('source-event', candidate.eventId)
        if (!event || event.source.kind !== this.sourceEvents.kind || !this.sourceEvents.belongsToSource(event)
          || event.source.sourceInstanceId !== candidate.sourceInstanceId || event.threadId !== candidate.threadId
          || event.objectId !== candidate.objectId || event.text !== candidate.text || event.authorId !== candidate.authorId
          || event.authorKind !== candidate.authorKind || event.addressing !== candidate.addressing
          || !await isCurrentSourceEvent(tx, event)) return 'SOURCE_NOT_CURRENT'
        if ((await tx.get<ProcessingState>('processing-state', this.processingKey()))?.paused) return 'PROCESSING_PAUSED'
        if (await this.inputs.owns(tx, event)) return 'WORK_ALREADY_OWNED'
        return proactiveOptions.guard?.(tx, candidate)
      },
    }) : undefined
    if (sessions && (effectsOptions.operationTimeoutMs ?? 60000) <= sessions.timeoutMs) throw new CoreError('INVALID_CONFIG', 'The effect deadline must exceed the native Session turn budget.')
    this.effects = new Effects(storage, instanceId, sessions
      ? { ...effectsOptions, owner: effectsOptions.owner ?? source.sourceInstanceId, operationTimeoutMs: effectsOptions.operationTimeoutMs ?? 60000 }
      : { ...effectsOptions, owner: effectsOptions.owner ?? source.sourceInstanceId })
    this.configureEffectsGate()
    this.deliveries = new Deliveries(storage, instanceId, this.effects, Date.now)
    this.inputs = new WorkInputs(storage, instanceId, this.source, this.sourceEvents, (tx, request) => this.effects.enqueue(tx, request), Date.now)
    this.outbox = new Outbox(storage, instanceId, this.deliveries, this.sourceEvents, this.deliveryState, this.inputs, deliveryOptions.channel)
    this.attentions = new Attentions(storage, instanceId, this.sourceEvents, this.inputs, this.effects, this.deliveries, Date.now)
    this.context = new ContextReader(storage, instanceId, this.sourceEvents, this.attentions, this.deliveries)
    const assessor = intake?.assess ?? (sessions ? ((events: Record<string, unknown>[], signal: AbortSignal, onDelivered: () => Promise<void>) => sessions.assessSourceBatch(events, signal, onDelivered)) : undefined)
    this.evaluations = intake ? new SourceEvaluations(storage, instanceId, intake, this.sourceEvents,
      (tx, event, strength, commandId, policyVersion, newDecision, capabilities) => this.accept(tx, commandId, {
        id: newDecision ? JSON.stringify([event.id, 'manual-requeue', commandId]) : event.id,
        instanceId, source: event.source, eventId: event.objectId, threadId: event.threadId, nativeVersion: event.version, text: event.text!,
        ...(capabilities?.length ? { capabilities } : {}),
      }, `intake:${strength}:${policyVersion}:${event.id}`, { strength, policyVersion }), Date.now, assessor,
      async (tx, event) => await this.inputs.owns(tx, event) || !!(await this.mainSources.has(tx, event.id)),
      (tx, eventId) => this.inputs.hasPendingRequeue(tx, eventId),
      (tx, eventId, evaluationId) => this.inputs.claimRequeue(tx, eventId, evaluationId),
      (tx, eventId, evaluationId) => this.inputs.consumeRequeue(tx, eventId, evaluationId),
      (tx, eventId, evaluationId) => this.inputs.releaseRequeue(tx, eventId, evaluationId)) : undefined
    this.environments = [...environments]
    if (new Set(environments.map(environment => environment.config.id)).size !== environments.length) throw new CoreError('INVALID_CONFIG', 'Local Environment IDs must be unique within an Engine.')
    this.slots = sessions ? new Slots(storage, instanceId, randomUUID(), slotOptions, Date.now) : undefined
    const jobRuntimeToken = randomUUID()
    this.jobs = sessions ? new Jobs(storage, instanceId, jobRuntimeToken, jobOptions, Date.now) : undefined
    this.previews = this.jobs?.previews
    this.subagents = sessions ? new Subagents(sessions.context, storage, instanceId, randomUUID(), subagentOptions, Date.now) : undefined
    if (sessions) {
      this.execution = new Execution(storage, instanceId, this.effects, sessions, this.inputs, this.attentions, this.sourceEvents,
        this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds, this.environments, this.slots, this.jobs, this.subagents, this.previews,
        this.deliveries, this.context, this.roleConfig, this.deliveryState, this.host.hostId, this.hostCapabilities,
        () => this.host.epoch(), async (transaction, ticketId, runId) => {
          if (!this.proactive || !this.proactiveSourceAvailable) throw new CoreError('PROACTIVE_REVOKED', 'The original proactive authorization is unavailable.')
          const { run, event } = await this.proactive.assertPreparedIn(transaction, runId)
          const link = await transaction.get<ProactiveWorkRecord>('proactive-work', runId)
          if (link?.ticketId !== ticketId || !this.proactiveSourceAvailable(run.sourceInstanceId, event.source.actorId)) {
            throw new CoreError('PROACTIVE_REVOKED', 'The original source or Ticket authorization changed.')
          }
        },
        (ticketId, assignment) => source.sourceInstanceId === 'product-desktop'
          ? [...memoryToolsFor(this.memory, { role: 'worker', ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId }),
            ...this.secretTools(ticketId, assignment)] : [])
      this.effects.setStartup(async () => {
        try { await this.execution!.reconcileRemoteWork() }
        catch { /* Keep the independent Input recovery scan running when the remote recovery budget is exhausted. */ }
        try { await this.recoverInterruptedHandoffs() }
        catch { /* Keep ordinary Input recovery available when the handoff reconciliation is blocked. */ }
        await this.execution!.recoverInputs()
      })
    }
    const environment = this.environments.find(candidate => candidate.kind === 'local' && candidate.config.instanceId === instanceId
      && candidate.config.allowedActorIds.includes(source.actorId) && candidate.config.permissions.includes('read') && candidate.config.permissions.includes('write'))
    if (sessions?.mainRoute && this.execution) {
      this.workDelegation = new WorkDelegation({ storage, instanceId, source, sessions, effects: this.effects,
        environmentId: environment?.config.id ?? 'unconfigured',
        defaultEnvironmentId: async transaction => (await this.instanceDirectoryIn(transaction))?.environmentId,
        environmentRoot: id => this.environments.find(candidate => candidate.config.id === id
          && candidate.config.instanceId === instanceId && candidate.config.allowedActorIds.includes(source.actorId)
          && candidate.config.permissions.includes('read') && candidate.config.permissions.includes('write'))?.config.root,
        environmentKind: id => this.environments.find(candidate => candidate.config.id === id
          && candidate.config.instanceId === instanceId && candidate.config.allowedActorIds.includes(source.actorId))?.kind,
        createTicket: (brief, item) => this.createDelegatedWorkItem(brief, item),
        readTicket: async ticketId => {
          const conversation = await this.conversation(ticketId)
          const report = conversation.reports[0]
          const status = conversation.status
          if (status !== 'pending' && status !== 'running' && status !== 'ready' && status !== 'unknown' && status !== 'waiting-human' && status !== 'stopping' && status !== 'stopped') {
            throw new CoreError('INCOMPLETE_STATE', 'The work state is not recognized.')
          }
          const assignment = conversation.assignments[0]
          const attention = conversation.attention
          const stop = conversation.stop
          const currentTicket = await storage.transaction(instanceId,
            tx => tx.get<Work['ticket']>('ticket', ticketId))
          const ticketVersion = currentTicket?.directionVersion ?? 1
          const handoffCopy = await storage.transaction(instanceId,
            tx => loadHandoffCopy(tx, ticketId))
          const handoffRecord = conversation.environmentHandoff?.state === 'completed' && handoffCopy
            && handoffCopy.assignmentId === assignment?.id
            && handoffCopy.preparedAt > (conversation.environmentHandoff.completedAt ?? 0)
            ? undefined : conversation.environmentHandoff
          const handoff = handoffRecord ? visibleEnvironmentHandoff(handoffRecord) : undefined
          const actorAllowed = this.source.allowedActorIds.includes(this.source.actorId)
          const activeStop = stop && stop.resumedAt === undefined
          const handoffActive = handoff && ['requested', 'flushing', 'switching'].includes(handoff.state)
          const handoffBoundaryBlockers = [
            ...(!actorAllowed ? [{ code: 'source-environment-changed',
              message: 'The requesting actor no longer has access to this work.' }] : []),
            ...(this.processingPaused ? [{ code: 'processing-paused',
              message: 'Processing is paused, so a handoff cannot start.' }] : []),
            ...(!currentTicket || currentTicket.state !== 'open' ? [{ code: 'ticket-ended',
              message: 'The Ticket is not open.' }] : []),
            ...(activeStop ? [{ code: 'ticket-stopping', message: 'The Ticket has an active stop request.' }] : []),
            ...(attention?.status === 'waiting'
              ? [{ code: 'waiting-human', message: 'A human question must be answered before this handoff.' }] : []),
            ...(status === 'unknown'
              ? [{ code: 'unknown-effect', message: 'An external outcome is still unknown.' }] : []),
            ...(conversation.setup?.state === 'failed'
              ? [{ code: 'setup-failed', message: 'The source workspace setup failed.' }] : []),
            ...(status === 'ready'
              ? [{ code: 'ready-report', message: 'A ready report already ended this Assignment.' }] : []),
            ...(!assignment ? [{ code: 'no-assignment', message: 'The Ticket has no active Assignment.' }]
              : assignment.state === 'ended' ? [{ code: 'assignment-not-running',
                message: 'The source Assignment is not running.' }] : []),
          ]
          const canHandoff = handoffBoundaryBlockers.length === 0 && !handoffActive
          const handoffTargets = canHandoff ? this.environments
            .filter(environment => environment.config.id !== assignment?.environment?.id)
            .filter(environment => {
              try {
                environment.authorize({ instanceId, actorId: this.source.actorId })
                return true
              } catch {
                return false
              }
            })
            .map(environmentLocation) : []
          const handoffBlockers = handoffBoundaryBlockers.length ? withHandoffOwners([
            ...handoffBoundaryBlockers,
            ...(handoff?.blockers ?? []),
            ...(handoffCopy?.blockers ?? []),
          ])
            : handoff?.blockers.length ? handoff.blockers
              : handoffCopy?.blockers.length ? withHandoffOwners(handoffCopy.blockers) : []
          const handoffOwner: MainWorkHandoffProjection['owner'] = handoff?.state === 'completed' ? 'worker'
            : handoffActive ? 'host' : handoffBlockers[0]?.nextOwner ?? (handoffCopy ? 'operator' : 'human')
          const handoffNextStep: MainWorkHandoffProjection['nextStep'] = handoffActive ? 'reconcile'
            : handoff?.state === 'completed' ? 'continue'
              : handoffBlockers.length ? 'resolve'
                : handoffCopy?.status === 'verified' ? 'handoff'
                  : handoffCopy ? 'synchronize' : 'prepare'
          const handoffProjection: MainWorkHandoffProjection = {
            status: handoffBoundaryBlockers.length ? 'blocked' : handoff?.state ?? handoffCopy?.status ?? 'available',
            owner: handoffOwner,
            nextStep: handoffNextStep,
            blockers: handoffBlockers,
            targets: handoffTargets,
            ...(handoffCopy ? { copy: handoffCopy } : {}),
            ...(handoff ? { record: handoff } : {}),
          }
          const control: MainWorkControl = {
            workItemId: '',
            ticketId,
            ticketVersion,
            permissions: {
              actorId: this.source.actorId,
              canStop: actorAllowed && !['ready', 'stopped', 'stopping'].includes(status),
              canResume: actorAllowed && stop?.state === 'stopped' && !stop.pendingDeviceConfirmation
                && stop.cancellationConfirmedAt !== undefined && attention?.status !== 'waiting',
              canRetry: actorAllowed && status !== 'unknown' && (conversation.reason === 'worker-idle'
                || conversation.reason === 'recovery-blocked' || conversation.reason === 'recovery-exhausted'),
              canAnswer: actorAllowed && attention?.status === 'waiting' && status === 'waiting-human',
              canHandoff,
            },
            ...(assignment ? { assignment: { id: assignment.id, generation: assignment.generation,
              sessionId: assignment.sessionId, state: assignment.state,
              ...(assignment.environment ? { environment: assignment.environment } : {}) } } : {}),
            ...(actorAllowed ? { handoff: handoffProjection } : {}),
            ...(attention ? { attention: { id: attention.id, version: attention.sequence, status: attention.status,
              question: attention.question, options: [...attention.options], freeText: true as const,
              assignmentId: attention.assignmentId, sessionId: attention.sessionId,
              ...(attention.view ? { view: structuredClone(attention.view) } : {}),
              ...(attention.answerView ? { answerView: structuredClone(attention.answerView) } : {}),
              ...(attention.answeredAt === undefined ? {} : { answeredAt: attention.answeredAt }),
              ...(attention.answeredBy === undefined ? {} : { answeredBy: attention.answeredBy }),
              ...(attention.answerText === undefined ? {} : { answerText: attention.answerText }) } } : {}),
            ...(stop ? { stop: { id: stop.id, state: stop.state, requestedAt: stop.requestedAt,
              requestedBy: stop.requestedBy, reason: stop.reason,
              pendingDeviceConfirmation: stop.pendingDeviceConfirmation === true,
              ...(stop.cancellationConfirmedAt === undefined ? {} : { cancellationConfirmedAt: stop.cancellationConfirmedAt }),
              ...(stop.resumedAt === undefined ? {} : { resumedAt: stop.resumedAt }) } } : {}),
          }
          return { ticketId, status, reason: conversation.reason, lifecycle: conversation.lifecycle,
            ...(conversation.setup?.state === 'failed' ? { setupCode: conversation.setup.code ?? 'SETUP_FAILED' } : {}),
            executionLocation: conversation.executionLocation,
            ...(conversation.executionSelection ? { executionSelection: conversation.executionSelection } : {}),
            ...(report ? { report: { id: report.id, result: report.result, evidence: report.evidence, artifacts: report.artifacts,
              ...(report.view ? { view: structuredClone(report.view) } : {}) } } : {}),
            control }
        },
        routerProfile: async () => {
          const config = await this.roleConfig.currentView()
          if (!this.capabilityLibrary) return config
          const router = await this.capabilityLibrary.profile(config.roles.router, { role: 'router' })
          return { ...config, roles: { ...config.roles, router } }
        },
        recordRouterUse: async (sessionId, config) => {
          await storage.transaction(instanceId, tx => this.roleConfig.recordUse(tx, { sessionId, role: 'router', revision: config.revision,
            ...(config.roles.main ? { main: config.roles.main.model } : {}), router: config.roles.router.model, worker: config.roles.worker.model }))
        },
        notifyMain: (notification, signal, isCurrent) => this.main.notify(notification, signal, isCurrent),
        notifyMainSource: (handoff, signal) => this.main.notifySource(handoff, signal),
        authorizeImSource: async (tx, event) => await this.imSourceAuthority?.(tx, event) ?? false,
        applyFollowUp: (tx, request) => this.inputs.attachMainFollowUp(tx, request),
        readContext: request => this.context.read(request),
      })
    }
    const handlers = this.execution?.handlers()
    this.effects.configure({ ...(handlers && this.workDelegation ? this.workDelegation.handlers(handlers, proactiveOptions?.route) : handlers), outbox: this.outbox.handler() })
  }

  async receiveSource(event: ReceiveSourceEvent) {
    await this.ensurePolicy()
    await this.assertHostAdmission()
    if (this.processingPaused) this.evaluations?.setPaused(true)
    const receipt = await this.sourceEvents.receive(event, async (tx, sourceEvent) => {
      await this.inputs.recordFanout(tx, sourceEvent)
      await this.answerFromSourceEvent(tx, sourceEvent)
      if (this.proactive && sourceEvent.type !== 'deleted' && !this.processingPaused && !await this.inputs.owns(tx, sourceEvent)) {
        await this.proactive.enqueue(tx, { sourceInstanceId: sourceEvent.source.sourceInstanceId,
          eventId: sourceEvent.id, threadId: sourceEvent.threadId, objectId: sourceEvent.objectId, text: sourceEvent.text!,
          authorId: sourceEvent.authorId, authorKind: sourceEvent.authorKind, addressing: sourceEvent.addressing })
      }
    })
    if (this.proactive && receipt.status === 'recorded') void this.reconcileProactiveCandidates().catch(() => {
      // The durable candidate remains queued for Host recovery after a transient failure.
    })
    if (receipt.status === 'recorded' && event.type !== 'created') this.proactiveOptions?.onSourceChanged?.(this.source.sourceInstanceId)
    return receipt
  }

  /**
   * Source-local Main intake. A Thread with existing ownership keeps normal fan-out; every other
   * authorized human request becomes a Main handoff without starting an Eval or Ticket.
   */
  async receiveSourceForMain(event: ReceiveSourceEvent) {
    await this.ensurePolicy()
    await this.assertHostAdmission()
    const binding = await this.main.open({ instanceId: this.instanceId })
    const allowed = await this.storage.transaction(this.instanceId, async tx => {
      const policy = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      return policy?.configuration.allowedRequesterIds ?? this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
    })
    const receipt = await this.sourceEvents.receive(event, async (tx, sourceEvent) => {
      if (await this.inputs.threadHasWorkerSubscriptions(tx, sourceEvent.threadId) || await this.inputs.owns(tx, sourceEvent)
        || this.source.kind === 'feishu' && await this.hasWaitingSourceAttention(tx, sourceEvent)) {
        await this.inputs.recordFanout(tx, sourceEvent)
        await this.answerFromSourceEvent(tx, sourceEvent)
        return
      }
      if (sourceEvent.authorKind !== 'human' || sourceEvent.addressing === 'ambient' || !allowed.includes(sourceEvent.authorId)) return
      const handoff = await this.mainSources.create(tx, { event: sourceEvent, mainId: binding.mainId, commandId: `main-source:${sourceEvent.id}` })
      await this.effects.enqueue(tx, { key: `handoff:${handoff.id}`, stream: 'notice', scope: `main:${binding.mainId}`,
        payload: { type: 'main-source-handoff', handoffId: handoff.id } })
    })
    // A replay can observe a source event committed by an earlier process before its handoff transaction.
    const authorId = event.authorId ?? this.source.actorId
    const authorKind = event.authorKind ?? 'human'
    if (receipt.status === 'recorded' && receipt.eventId && authorKind === 'human' && (event.addressing ?? 'direct') !== 'ambient'
      && allowed.includes(authorId)) {
      await this.handOffSourceToMain({ commandId: `main-source:${receipt.eventId}`, eventId: receipt.eventId })
    }
    if (receipt.status === 'recorded' && event.type !== 'created') this.proactiveOptions?.onSourceChanged?.(this.source.sourceInstanceId)
    return receipt
  }

  /** Route one trusted new human source event to the logical Main; owned events stay on their Ticket. */
  async handOffSourceToMain(command: { commandId: string; eventId: string }): Promise<
    { kind: 'main-source'; handoff: MainSourceHandoff } | { kind: 'existing-work'; eventId: string }> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'eventId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A Main source handoff accepts commandId and eventId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.eventId, 'eventId')
    const binding = await this.main.open({ instanceId: this.instanceId })
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['main-source-handoff-v1', command.eventId, binding.mainId])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; handoffId?: string; kind: 'main-source' | 'existing-work'; eventId: string }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Main source handoff command was reused for different input.')
        if (prior.kind === 'existing-work') return { kind: 'existing-work' as const, eventId: prior.eventId }
        const handoff = prior.handoffId ? await this.mainSources.get(tx, prior.handoffId) : undefined
        if (!handoff) throw new CoreError('INCOMPLETE_STATE', 'The persisted Main source handoff is missing.')
        return { kind: 'main-source' as const, handoff }
      }
      const event = await tx.get<SourceEvent>('source-event', command.eventId)
      if (!event || !this.sourceEvents.belongsToSource(event)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source event belongs to another adapter.')
      if (await this.inputs.owns(tx, event)) {
        await tx.insert('work-command', key, { fingerprint, kind: 'existing-work', eventId: event.id })
        return { kind: 'existing-work' as const, eventId: event.id }
      }
      if (this.source.kind === 'feishu' && await this.hasWaitingSourceAttention(tx, event)) {
        await tx.insert('work-command', key, { fingerprint, kind: 'existing-work', eventId: event.id })
        return { kind: 'existing-work' as const, eventId: event.id }
      }
      const policy = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      const allowed = policy?.configuration.allowedRequesterIds ?? this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
      if (event.authorKind !== 'human' || event.addressing === 'ambient' || !allowed.includes(event.authorId)) {
        throw new CoreError('ACTOR_NOT_ALLOWED', 'Only a currently authorized addressed human request can enter Main.')
      }
      const handoff = await this.mainSources.create(tx, { event, mainId: binding.mainId, commandId: command.commandId })
      await this.effects.enqueue(tx, { key: `handoff:${handoff.id}`, stream: 'notice', scope: `main:${binding.mainId}`,
        payload: { type: 'main-source-handoff', handoffId: handoff.id } })
      await tx.insert('work-command', key, { fingerprint, kind: 'main-source', eventId: event.id, handoffId: handoff.id })
      return { kind: 'main-source' as const, handoff }
    })
    return result
  }

  private async hasWaitingSourceAttention(tx: AsyncTx, event: SourceEvent) {
    let cursor = ''
    for (let page = 0; page < 10; page++) {
      const batch = await tx.scan<{ attentionId: string }>('attention-head', { limit: 100, after: cursor })
      for (const head of batch.items) {
        const attention = await tx.get<Attention>('attention', head.value.attentionId)
        if (attention?.status === 'waiting' && attention.destination.sourceInstanceId === event.source.sourceInstanceId
          && attention.destination.threadId === event.threadId && attention.destination.actorId === event.authorId) return true
      }
      if (!batch.cursor) return false
      cursor = batch.cursor
    }
    throw new CoreError('ATTENTION_BUDGET', 'The pending question scan exceeded its declared bound.')
  }

  /** A trusted human reply with the current question code answers and resumes its work. */
  private async answerFromSourceEvent(tx: AsyncTx, event: SourceEvent) {
    if (event.type === 'deleted' || event.text === undefined || !event.text.trim() || event.authorKind !== 'human') return
    if (this.source.kind !== 'feishu') return
    // Feishu topic replies can have the discussion root as parent even when the user replied
    // to a question. The delivered question code identifies one current Attention instead.
    const answer = /^Q-([a-f0-9]{16}):\s*([\s\S]+)$/iu.exec(event.text.trim())
    if (!answer || !answer[2]?.trim()) return
    const answerers = this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
    if (!answerers.includes(event.authorId)) return
    const currentEvent = await this.sourceEvents.candidate(tx, event)
    if (currentEvent?.id !== event.id) return
    const heads: { attentionId: string }[] = []
    let cursor = ''
    for (let page = 0; page < 10; page++) {
      const batch = await tx.scan<{ attentionId: string }>('attention-head', { limit: 100, after: cursor })
      heads.push(...batch.items.map(item => item.value))
      if (!batch.cursor) break
      cursor = batch.cursor
    }
    const matches: Attention[] = []
    for (const head of heads) {
      const attention = await tx.get<Attention>('attention', head.attentionId)
      if (!attention || attention.status !== 'waiting') continue
      if (attention.destination.threadId !== event.threadId || attention.destination.actorId !== event.authorId
        || feishuQuestionCode(attention.id) !== answer[1]!.toLowerCase()) continue
      if (attention.destination.eventId === event.objectId) continue
      matches.push(attention)
    }
    // More than one waiting question in one Thread has no verifiable recipient; leave it to the explicit answer entry.
    if (matches.length !== 1) return
    const match = matches[0]!
    try {
      await this.attentions.answer(tx, { ticketId: match.ticketId, attentionId: match.id, text: answer[2]!.trim(),
        commandId: `source-answer:${event.id}`, actorId: event.authorId, sourceEventId: event.id })
    } catch (error) {
      if (!(error instanceof CoreError)) throw error
    }
  }
  getSourceObject(ref: SourceObjectRef) { return this.sourceEvents.get(ref) }
  getSourceHistory(ref: SourceObjectRef, options?: { limit?: number; after?: string }) { return this.sourceEvents.history(ref, options) }
  getSourceReceipt(commandId: string) { return this.sourceEvents.receipt(commandId) }
  getSourceCandidate(ref: SourceObjectRef) { return this.sourceEvents.getCandidate(ref) }

  /** Trusted adapters preserve unversioned observations without treating them as actionable native versions. */
  async receiveUnverifiedSource(event: ReceiveSourceEvent) {
    await this.ensurePolicy()
    await this.assertHostAdmission()
    const receipt = await this.sourceEvents.receiveUnverified(event)
    if (receipt.status === 'recorded') this.proactiveOptions?.onSourceChanged?.(this.source.sourceInstanceId)
    return receipt
  }

  async acceptSource(command: AcceptSourceRequest): Promise<Receipt> {
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    if (this.evaluations) throw new CoreError('INTAKE_REQUIRED', 'This source has an Intake Policy; submit candidates through assessSourceBatch.')
    if (!command || Object.keys(command).some(key => !['commandId', 'threadId', 'objectId', 'expectedEventId', 'environmentId', 'target', 'capabilities'].includes(key))) throw new CoreError('INVALID_INPUT', 'Accept a checked source reference, event identity, an optional Environment, execution target and capabilities only.')
    command = { ...command }
    identifier(command.commandId, 'commandId'); identifier(command.threadId, 'threadId'); identifier(command.objectId, 'objectId')
    if (typeof command.expectedEventId !== 'string' || command.expectedEventId.length > 8192) throw new CoreError('INVALID_INPUT', 'A checked current event ID is required.')
    if (command.target !== undefined && !['local-only', 'remote-only', 'auto'].includes(command.target)) {
      throw new CoreError('INVALID_INPUT', 'A Ticket execution target is local-only, remote-only or auto.')
    }
    const capabilities = validateRequiredCapabilities(command.capabilities)
    if (command.environmentId !== undefined) {
      identifier(command.environmentId, 'environmentId')
      const environment = this.environments.find(environment => environment.config.id === command.environmentId)
      if (!environment || !this.execution) throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment and native runtime must be configured.')
      environment.authorize({ instanceId: this.instanceId, actorId: this.source.actorId })
      if (command.target && (command.target === 'local-only' && environment.kind !== 'local'
        || command.target === 'remote-only' && environment.kind !== 'remote')) {
        throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment does not match the Ticket execution target.')
      }
    }
    const fingerprint = capabilities.length
      ? `source-accept:v4:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
        command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null, command.target ?? null, capabilities])).digest('hex')}`
      : command.target
        ? `source-accept:v3:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
          command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null, command.target])).digest('hex')}`
        : `source-accept:v2:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
          command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null])).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<CommandRecord>('command', command.commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(tx)
      const event = await this.sourceEvents.candidate(tx, command)
      if (!event || event.id !== command.expectedEventId) throw new CoreError('SOURCE_NOT_CURRENT', 'This source reference is deleted, conflicted, unknown or no longer current; no new work is authorized.')
      if (event.source.actorId !== this.source.actorId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source event cannot borrow another actor’s explicit authorization.')
      return this.accept(tx, command.commandId, { id: event.id, instanceId: this.instanceId, source: event.source, eventId: event.objectId,
        threadId: event.threadId, nativeVersion: event.version, text: event.text!,
        ...(command.environmentId ? { environmentId: command.environmentId } : {}), ...(command.target ? { target: command.target } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(command.environmentId ? { targetSource: 'explicit' as const } : command.target ? { targetSource: 'ticket' as const } : {}) }, fingerprint)
    })
  }

  async assessSourceBatch(command: { commandId: string; threadId: string; eventIds: string[] }): Promise<SourceEvaluation> {
    await this.ensurePolicy()
    await this.assertHostAdmission()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before evaluating source candidates.')
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'Source events remain recorded while new evaluations are paused.')
    return this.evaluations.assess(command)
  }

  async listEvaluations(threadId: string) {
    await this.ensurePolicy()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before querying source evaluations.')
    return this.evaluations.list(threadId)
  }

  dismissEvaluation(command: { commandId: string; evaluationId: string; reason: string }) {
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before dismissing an Eval.')
    if (!command || Object.keys(command).some(key => !['commandId', 'evaluationId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Dismissing an Eval accepts commandId, evaluationId and reason only.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to dismiss evaluations.')
    return this.evaluations.dismiss({ ...command, actorId: this.source.actorId })
  }

  async submit(command: SubmitRequest): Promise<Receipt> {
    const submitted = command ? structuredClone(command) : command
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    command = submitted
    if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).some(key => !['commandId', 'eventId', 'text', 'mode', 'execution', 'environmentId', 'target', 'capabilities'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Only commandId, eventId, text, mode, execution, environmentId, target and capabilities are accepted from request data.')
    }
    if (this.source.allowedThreadIds !== undefined || this.source.allowedThreadPrefixes !== undefined || this.source.versionOrder !== undefined) throw new CoreError('UNSUPPORTED_CAPABILITY', 'A versioned source must use receiveSource and acceptSource so native scope, conflicts and tombstones remain authoritative.')
    command = { ...command }
    identifier(command.commandId, 'commandId')
    identifier(command.eventId, 'eventId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) throw new CoreError('INVALID_INPUT', 'Request text must contain 1 to 65536 bytes.')
    if (command.mode !== undefined && command.mode !== 'explicit' || command.execution !== undefined && command.execution !== 'local') throw new CoreError('UNSUPPORTED_CAPABILITY', 'Only explicit requests in the local environment are enabled.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This desktop actor is not authorized by its source instance.')
    if (command.target !== undefined && !['local-only', 'remote-only', 'auto'].includes(command.target)) {
      throw new CoreError('INVALID_INPUT', 'A Ticket execution target is local-only, remote-only or auto.')
    }
    const capabilities = validateRequiredCapabilities(command.capabilities)
    const source: Source = { kind: this.source.kind ?? 'desktop', sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId }
    const triggerId = JSON.stringify([this.instanceId, source.kind, source.sourceInstanceId, command.eventId, 'created', '1'])
    if (command.environmentId !== undefined) identifier(command.environmentId, 'environmentId')
    if (command.environmentId !== undefined) {
      const environment = this.environments.find(environment => environment.config.id === command.environmentId)
      if (!environment || !this.execution) throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment and native runtime must be configured.')
      environment.authorize({ instanceId: this.instanceId, actorId: source.actorId })
      if (command.target && (command.target === 'local-only' && environment.kind !== 'local'
        || command.target === 'remote-only' && environment.kind !== 'remote')) {
        throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment does not match the Ticket execution target.')
      }
    }
    const input = capabilities.length ? ['desktop-submit-v4', source, command.eventId, command.text, 'explicit', 'local',
      command.environmentId ?? null, command.target ?? null, capabilities]
      : command.target ? ['desktop-submit-v3', source, command.eventId, command.text, 'explicit', 'local', command.environmentId ?? null, command.target]
        : command.environmentId === undefined ? ['desktop-submit-v1', source, command.eventId, command.text, 'explicit', 'local']
          : ['desktop-submit-v2', source, command.eventId, command.text, 'explicit', 'local', command.environmentId]
    const fingerprint = `sha256:${capabilities.length ? 'v4' : command.target ? 'v3' : command.environmentId === undefined ? 'v1' : 'v2'}:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.sourceEvents.requireDirectMode(tx)
      const existing = await tx.get<CommandRecord>('command', command.commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(tx)
      return this.accept(tx, command.commandId, { id: triggerId, instanceId: this.instanceId, source, eventId: command.eventId, text: command.text,
        ...(command.environmentId ? { environmentId: command.environmentId } : {}), ...(command.target ? { target: command.target } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(command.environmentId ? { targetSource: 'explicit' as const } : command.target ? { targetSource: 'ticket' as const } : {}) }, fingerprint)
    })
  }

  private async createDelegatedWorkItem(brief: import('./work-delegation.js').MainWorkBrief, item: MainWorkItem): Promise<Receipt> {
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    await this.assertHostAdmission()
    if (!brief.sourceEventId) throw new CoreError('INCOMPLETE_STATE', 'The Main WorkBrief source event is missing.')
    identifier(brief.id, 'workBriefId'); identifier(item.id, 'workItemId'); identifier(brief.sourceEventId, 'sourceEventId')
    if (brief.instanceId !== this.instanceId || item.workBriefId !== brief.id) throw new CoreError('INSTANCE_MISMATCH', 'The delegated item does not belong to this Main WorkBrief.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This desktop actor cannot establish delegated work.')
    const source: Source = { kind: this.source.kind ?? 'desktop', sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId }
    const triggerId = JSON.stringify([this.instanceId, source.kind, source.sourceInstanceId, brief.sourceEventId, item.id, 'main-work-item'])
    const granted = brief.attachments?.filter(attachment => item.attachmentIds?.includes(attachment.id))
    if (brief.attachments?.length && (!item.attachmentIds
      || granted?.length !== item.attachmentIds.length)) throw new CoreError('ATTACHMENT_SCOPE_AMBIGUOUS', 'The work item has no valid attachment grant.')
    const resources = granted?.map(attachment => attachment.asset) ?? brief.resources ?? []
    const images = granted?.flatMap(attachment => attachment.image ? [attachment.image] : []) ?? brief.images ?? []
    const readableResources = granted?.map(attachment => ({ ...attachment.asset, attachmentId: attachment.id })) ?? resources
    const text = `Original Main request:\n${brief.originalUserText}\n\nGoal:\n${item.goal}\n\nConstraints:\n${item.constraints}\n\nAcceptance criteria:\n${item.acceptanceCriteria}`
      + (readableResources.length ? `\n\nAttached resources for this work (read with the bound Environment's read_asset tool; include attachmentId for each admitted resource):\n${JSON.stringify(readableResources)}` : '')
    if (Buffer.byteLength(text) > 32768) throw new CoreError('INVALID_INPUT', 'This work request is too long with its attached resource references.')
    const deliveryOrigin = brief.sourceHandoffId ? await this.storage.transaction(this.instanceId, async tx => {
      const handoff = await tx.get<MainSourceHandoff>('main-source-handoff', brief.sourceHandoffId!)
      const event = handoff ? await tx.get<SourceEvent>('source-event', handoff.sourceEventId) : undefined
      const policy = handoff ? await tx.get<StoredPolicy>('policy-state', JSON.stringify(['policy-state', handoff.sourceInstanceId])) : undefined
      const scheduled = event?.source.kind === 'schedule'
        ? await authorizedScheduleEvent(tx, event, this.source.actorId, 'main').catch(() => undefined) : undefined
      if (!handoff || handoff.mainId !== brief.mainId || handoff.workBriefId !== brief.id || handoff.state !== 'delegated'
        || !event || !await isCurrentSourceEvent(tx, event) || event.authorId !== handoff.authorId
        || (event.source.kind === 'schedule' ? !scheduled : !policy?.configuration.allowedRequesterIds.includes(event.authorId))) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The delegated Ticket no longer has a current authorized Main source.')
      }
      if (scheduled) return undefined
      return { sourceEventId: event.id, source: event.source, authorId: event.authorId, eventId: event.objectId,
        ...(event.threadId ? { threadId: event.threadId } : {}), nativeVersion: event.version, reference: handoff.reference }
    }) : undefined
    const trigger: Work['trigger'] = { id: triggerId, instanceId: this.instanceId, source, eventId: brief.sourceEventId,
      text, ...(brief.environmentId ? { environmentId: brief.environmentId } : {}), target: brief.target ?? 'local-only',
      targetSource: brief.environmentId ? 'explicit' : 'ticket',
      ...(brief.capabilities?.length ? { capabilities: [...brief.capabilities] } : {}),
      ...(images.length ? { nativeImages: images } : {}), ...(deliveryOrigin ? { deliveryOrigin } : {}) }
    const commandId = `main-work-ticket:${brief.id}:${item.id}`
    const fingerprint = `sha256:main-work-item-${brief.attachments ? 'v2' : 'v1'}:${createHash('sha256').update(canonicalJson([
      this.instanceId, source, brief.sourceEventId, item.id, item.goal, item.constraints, item.acceptanceCriteria,
      brief.environmentId ?? null, brief.target ?? 'local-only', brief.capabilities ?? [],
      deliveryOrigin?.sourceEventId ?? null, ...(brief.attachments ? [item.attachmentIds, resources, images] : []),
    ])).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      await this.sourceEvents.requireDirectMode(transaction)
      const existing = await transaction.get<CommandRecord>('command', commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(transaction)
      if (deliveryOrigin?.source.kind === 'im') {
        const event = await transaction.get<SourceEvent>('source-event', deliveryOrigin.sourceEventId)
        if (!event || !await this.imSourceAuthority?.(transaction, event)) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The messaging conversation was unpaired before the Ticket could be established.')
        }
      }
      return this.accept(transaction, commandId, trigger, fingerprint, { mandateScope: item.goal,
        linkTicket: async (tx, receipt) => {
          await tx.insert('work-ticket', receipt.ticketId, { workBriefId: brief.id, workItemId: item.id, ticketId: receipt.ticketId })
          await tx.insert('work-item-ticket', item.id, { workBriefId: brief.id, workItemId: item.id, ticketId: receipt.ticketId })
        } })
    })
  }

  private async accept(tx: AsyncTx, commandId: string, trigger: Work['trigger'], fingerprint: string,
    options: { strength?: 'explicit' | 'inferred'; policyVersion?: string; mandateScope?: string; proactive?: boolean;
      linkTicket?: (tx: AsyncTx, receipt: Receipt) => Promise<void> } = {}): Promise<Receipt> {
    const triggerId = trigger.id
    const event = await tx.get<EventRecord>('event', triggerId)
    if (event) {
      const receipt = this.replay(event, fingerprint, 'event')
      await tx.insert('command', commandId, { fingerprint, receipt })
      return receipt
    }
    await this.assertHostAdmissionIn(tx)
    const environment = trigger.environmentId ? this.environments.find(candidate => candidate.config.id === trigger.environmentId) : undefined
    const policy = await this.executionPolicy.currentIn(tx)
    const target: ExecutionTarget = trigger.target ?? (environment ? environment.kind === 'remote' ? 'remote-only' : 'local-only'
      : policy.defaultTarget === 'local' ? 'local-only' : policy.defaultTarget)
    const targetSource = trigger.targetSource ?? (environment ? 'explicit' : trigger.target ? 'ticket' : 'default')
    const capabilities = validateRequiredCapabilities(trigger.capabilities)
    const persistedTrigger: Work['trigger'] = { ...trigger, target, targetSource, ...(capabilities.length ? { capabilities } : {}) }
    const environmentKind = target === 'auto' ? 'auto' : target === 'remote-only' ? 'remote' : 'local'
    const ticketId = randomUUID()
    const decisionId = randomUUID()
    const mandateId = randomUUID()
    const work: Work = {
      trigger: persistedTrigger,
      decision: { id: decisionId, instanceId: this.instanceId, triggerId, outcome: 'accept', policyVersion: options.policyVersion ?? 'desktop-explicit-v1' },
      mandate: { id: mandateId, instanceId: this.instanceId, decisionId, scope: options.mandateScope ?? trigger.text, strength: options.strength ?? 'explicit', environment: environmentKind,
        ...(persistedTrigger.capabilities?.length ? { capabilities: [...persistedTrigger.capabilities] } : {}) },
      ticket: { id: ticketId, instanceId: this.instanceId, mandateId, triggerId, state: 'open', directionVersion: 1 },
      intent: { id: randomUUID(), instanceId: this.instanceId, ticketId, state: 'pending', reason: this.execution ? 'router-pending' : 'worker-not-enabled', environment: environmentKind },
    }
    const receipt: Receipt = { instanceId: this.instanceId, ticketId, triggerId, acceptedCommandId: commandId, status: 'pending' }
    await tx.insert('trigger', triggerId, work.trigger)
    await tx.insert('decision', decisionId, work.decision)
    await tx.insert('mandate', mandateId, work.mandate)
    await tx.insert('ticket', ticketId, work.ticket)
    await tx.insert('intent', ticketId, work.intent)
    if (!options.proactive) await this.inputs.subscribe(tx, ticketId, persistedTrigger)
    await tx.insert('event', triggerId, { fingerprint, receipt })
    await tx.insert('command', commandId, { fingerprint, receipt })
    await options.linkTicket?.(tx, receipt)
    if (options.proactive) return receipt
    await this.effects.enqueue(tx, { key: ticketId, stream: 'notice', scope: 'router', payload: { type: 'request-accepted', ticketId, triggerId } })
    const deliveryId = `${ticketId}:acknowledgement`
    const delivery = triggerDeliveryTarget(persistedTrigger)
    const destination = { ...delivery.source, eventId: delivery.eventId, ...(delivery.threadId ? { threadId: delivery.threadId } : {}) }
    const effect = await this.effects.enqueue(tx, { key: ticketId, stream: 'outbox', scope: ticketId, payload: {
      purpose: 'acknowledgement', text: 'Request accepted.', ticketId, deliveryId, destination,
    } })
    await this.deliveries.record(tx, { id: deliveryId, ticketId, purpose: 'acknowledgement', text: 'Request accepted.', destination,
      basis: { kind: 'accepted-request', triggerId }, effectId: effect.id, effectGeneration: effect.generation }, effect)
    return receipt
  }

  private replay(record: CommandRecord | EventRecord, fingerprint: string, kind: string): Receipt {
    if (record.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', `The ${kind} ID was already used with different input.`)
    return record.receipt
  }

  async conversation(ticketId: string) {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'No native Session adapter is configured.')
    const conversation = await this.execution.conversation(ticketId)
    const delivery = await this.storage.transaction(this.instanceId, async tx => ({
      conditions: await this.deliveryState.list(tx, ticketId),
      resultTarget: await this.deliveryState.target(tx, ticketId, 'result'),
    }))
    return { ...conversation, globalPaused: this.processingPaused, policyRevision: this.policyRevision,
      roleConfigRevision: this.roleConfigRevision, deliveryConditions: delivery.conditions,
      resultDeliveryTarget: delivery.resultTarget, deliveryPending: delivery.conditions.some(condition => condition.state === 'open' || condition.state === 'draft') }
  }

  async retrySetup(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution || !this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A configured authorized native runtime is required.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Setup retry accepts commandId and ticketId only.')
    return this.execution.retrySetup(command.commandId, command.ticketId, this.source.actorId)
  }

  listEnvironments() {
    return this.environments.filter(environment => environment.config.instanceId === this.instanceId && environment.config.allowedActorIds.includes(this.source.actorId))
      .map(environment => ({ id: environment.config.id, kind: environment.kind, root: environment.config.root,
        permissions: [...environment.config.permissions],
        ...(environment.kind === 'remote' ? { deviceId: environment.deviceId, online: environment.online ?? false } : {}) }))
  }

  /**
   * Reports the native asset combinations this Environment can actually serve. Skills are
   * named as an explicit gap because the installed harness exposes no public discovery seam.
   */
  async getEnvironmentCapabilities(environmentId: string): Promise<EnvironmentAssetCapabilities> {
    await this.ensurePolicy()
    identifier(environmentId, 'environmentId')
    const environment = this.environments.find(candidate => candidate.config.id === environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    if (!environment.assetCapabilities) {
      return unsupportedAssetCapabilities([environment.kind === 'local' ? 'local-asset-store-unconfigured' : 'device-asset-store-unconfigured'])
    }
    return environment.assetCapabilities({ instanceId: this.instanceId, actorId: this.source.actorId })
  }

  /**
   * Re-reads a retained asset through its original Environment identity. A disconnected device
   * is contacted again by its stable reference; a changed root or incarnation is a stale
   * reference, never a same-named Host substitute.
   */
  async readEnvironmentAsset(request: { environmentId: string; reference: EnvironmentAssetReference; offset?: number; maxBytes?: number }) {
    await this.ensurePolicy()
    if (!request || Object.keys(request).some(key => !['environmentId', 'reference', 'offset', 'maxBytes'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An asset read accepts environmentId, reference, offset and maxBytes only.')
    }
    identifier(request.environmentId, 'environmentId')
    assertReferenceShape(request.reference)
    const environment = this.environments.find(candidate => candidate.config.id === request.environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    if (request.reference.environmentId !== environment.config.id || request.reference.environmentKind !== environment.kind) {
      throw new CoreError('REFERENCE_STALE', 'The reference belongs to a different Execution Environment.')
    }
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    const bound = await environment.prepare(identity)
    const capabilities = await this.getEnvironmentCapabilities(request.environmentId)
    const gaps = request.reference.kind === 'attachment' && !capabilities.attachments.supported ? capabilities.attachments.gaps
      : request.reference.kind === 'spill' && !capabilities.spill.supported ? capabilities.spill.gaps
        : request.reference.kind === 'skill' && !capabilities.skills.supported ? capabilities.skills.gaps : []
    if (gaps.length) throw new UnsupportedEnvironmentCombination(`This Environment cannot serve a ${request.reference.kind} reference.`, gaps)
    if (!bound.readAsset) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment implements no public asset read seam.')
    return bound.readAsset(request.reference, {
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  /** Durably saves exact attachment bytes into one authorized Environment. */
  async saveEnvironmentAttachment(command: { commandId: string; environmentId: string; name: string; data: string; encoding?: 'utf8' | 'base64'; mediaType?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'environmentId', 'name', 'data', 'encoding', 'mediaType'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An attachment save accepts commandId, environmentId, name, data, encoding and mediaType only.')
    }
    identifier(command.commandId, 'commandId')
    identifier(command.environmentId, 'environmentId')
    if (command.encoding !== undefined && command.encoding !== 'utf8' && command.encoding !== 'base64') {
      throw new CoreError('INVALID_INPUT', 'Attachment encoding is utf8 or base64.')
    }
    if (typeof command.data !== 'string') throw new CoreError('INVALID_INPUT', 'Attachment data must be text.')
    const data = attachmentBytes(command.data, command.encoding)
    const environment = this.environments.find(candidate => candidate.config.id === command.environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    environment.authorize({ instanceId: this.instanceId, actorId: this.source.actorId })
    const fingerprint = createHash('sha256').update(canonicalJson(['environment-attachment-v1', this.instanceId,
      this.source.sourceInstanceId, this.source.actorId, command.environmentId, command.name, data.toString('base64'),
      command.mediaType ?? null])).digest('hex')
    const key = this.commandKey(command.commandId)
    const prior = await this.storage.transaction(this.instanceId, transaction =>
      transaction.get<{ fingerprint: string; reference: EnvironmentAssetReference }>('work-command', key))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attachment command was reused with different input.')
      return prior.reference
    }
    const bound = await environment.prepare({ instanceId: this.instanceId, actorId: this.source.actorId })
    if (!bound.saveAttachment) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment implements no public attachment write seam.')
    const reference = await bound.saveAttachment({ name: command.name, data,
      ...(command.mediaType ? { mediaType: command.mediaType } : {}) })
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<{ fingerprint: string; reference: EnvironmentAssetReference }>('work-command', key)
      if (current) {
        if (current.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attachment command was reused with different input.')
        return current.reference
      }
      await transaction.insert('work-command', key, { fingerprint, reference })
      return reference
    })
  }

  getExecutionPolicy() {
    return this.executionPolicy.get()
  }

  async getExecutionPreview() {
    const policy = await this.executionPolicy.get()
    return selectExecutionTarget({ ticketId: 'execution-preview', instanceId: this.instanceId, actorId: this.source.actorId,
      hostId: this.host.hostId, environments: this.environments, policy, ticketTarget: 'auto',
      hostCapabilities: this.hostCapabilities, source: 'default' })
  }

  async updateExecutionPolicy(command: { commandId: string; expectedRevision: number; policy: Partial<ExecutionPolicyConfig> }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'policy'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An execution policy update accepts commandId, expectedRevision and policy only.')
    }
    identifier(command.commandId, 'commandId')
    if (!command.policy || typeof command.policy !== 'object' || Array.isArray(command.policy)) {
      throw new CoreError('INVALID_INPUT', 'An execution policy update needs an explicit policy object.')
    }
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot change the execution policy.')
    }
    if (command.policy.preferredEnvironmentId !== undefined && command.policy.preferredEnvironmentId !== null) {
      const preferred = this.environments.find(environment => environment.config.id === command.policy.preferredEnvironmentId
        && environment.config.instanceId === this.instanceId && environment.config.allowedActorIds.includes(this.source.actorId))
      if (!preferred) throw new CoreError('ENVIRONMENT_DENIED', 'The preferred Environment is not configured and authorized for this actor.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['execution-policy-update', this.instanceId,
      command.expectedRevision, command.policy])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; policy: ExecutionPolicyView }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The execution policy command was reused with different input.')
        return prior.policy
      }
      const policy = await this.executionPolicy.write(transaction, command.expectedRevision, command.policy)
      await transaction.insert('work-command', key, { fingerprint, policy })
      return policy
    })
  }

  getExecutionSelection(ticketId: string) {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The execution selection belongs to a different source instance.')
      }
      return loadExecutionSelection(transaction, ticketId)
    })
  }

  getCapabilityLocations() {
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot inspect capability locations.')
    }
    return capabilityLocations(this.hostCapabilities)
  }

  async getCapabilityPlan(ticketId: string): Promise<CapabilityPlanView> {
    identifier(ticketId, 'ticketId')
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
        || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The capability plan belongs to a different source instance or actor.')
      }
    })
    return (await this.conversation(ticketId)).capabilityPlan
  }

  async prepareHandoffCopy(command: { commandId: string; ticketId: string; targetEnvironmentId: string;
    expectedGeneration?: string }): Promise<HandoffCopyView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'targetEnvironmentId',
      'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Preparing a work copy accepts only its exact Ticket, target and generation.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.targetEnvironmentId, 'targetEnvironmentId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot prepare a work copy.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['prepare-handoff-copy', this.instanceId,
      command.ticketId, command.targetEnvironmentId, ...(command.expectedGeneration === undefined ? [] : [command.expectedGeneration])])).digest('hex')
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', command.ticketId),
      assignment: await transaction.get<{ id: string; generation: string; state: string;
        environment?: EnvironmentLocation }>('assignment', command.ticketId),
      trigger: await this.triggerFor(transaction, command.ticketId),
      prior: await transaction.get<{ fingerprint: string; record: HandoffCopyView }>('work-command', key),
    }))
    if (initial.prior) {
      if (initial.prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The work-copy command was reused for different input.')
      return initial.prior.record
    }
    if (command.expectedGeneration !== undefined && (!initial.assignment
      || initial.assignment.state === 'ended' || initial.assignment.generation !== command.expectedGeneration)) {
      throw new CoreError('HANDOFF_STALE', 'The work generation changed before the handoff copy was prepared.')
    }
    if (!initial.ticket || initial.ticket.state !== 'open') throw new CoreError('NOT_FOUND', 'The Ticket is not open.')
    if (initial.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || initial.trigger.source.actorId !== this.source.actorId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may prepare this work copy.')
    }
    const assignment = initial.assignment
    if (!assignment?.environment) throw new CoreError('ENVIRONMENT_NOT_BOUND', 'The Ticket has no fixed source Environment to inspect.')
    const source = this.environments.find(environment => environment.config.id === assignment.environment!.id)
    const target = this.environments.find(environment => environment.config.id === command.targetEnvironmentId)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The source or target Environment is not configured.')
    if (source.config.id === target.config.id) throw new CoreError('ENVIRONMENT_DENIED', 'A work copy needs a different target Environment.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    const blockers: WorkCopyBlocker[] = []
    let sourceProbe: EnvironmentProbe | undefined
    let targetProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    try { targetProbe = target.probe ? await target.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    const sourceLocation: EnvironmentLocation = { ...assignment.environment,
      ...(sourceProbe && !assignment.environment.version ? { version: sourceProbe.version } : {}),
      ...(sourceProbe && !assignment.environment.fingerprint ? { fingerprint: sourceProbe.fingerprint } : {}) }
    const targetCheck = await this.handoffTarget({ ticketId: command.ticketId,
      targetEnvironmentId: command.targetEnvironmentId, trigger: initial.trigger, target })
    blockers.push(...targetCheck.blockers)
    const targetLocation: EnvironmentLocation = { ...targetCheck.target,
      ...(targetProbe ? { version: targetProbe.version, fingerprint: targetProbe.fingerprint } : {}) }
    let sourceSnapshot: WorkCopySnapshot | undefined
    let targetSnapshot: WorkCopySnapshot | undefined
    const sourceInspection = await inspectEnvironmentWorkCopy(source, identity)
    if (sourceInspection.snapshot) sourceSnapshot = sourceInspection.snapshot
    else blockers.push(sourceInspection.blocker!)
    const targetInspection = await inspectEnvironmentWorkCopy(target, identity)
    if (targetInspection.snapshot) targetSnapshot = targetInspection.snapshot
    else blockers.push(targetInspection.blocker!)
    let comparison: WorkCopyComparison | undefined
    if (sourceSnapshot && targetSnapshot) {
      comparison = compareWorkCopy(sourceSnapshot, targetSnapshot, 'prepare')
      blockers.push(...comparison.blockers)
    }
    const unique = uniqueBlockers(blockers)
    const record: HandoffCopyView = {
      id: randomUUID(), instanceId: this.instanceId, ticketId: command.ticketId, assignmentId: assignment.id,
      source: sourceLocation, target: targetLocation,
      baseCommit: sourceSnapshot?.git.commit ?? '', ...(sourceSnapshot?.git.branch ? { branch: sourceSnapshot.git.branch } : {}),
      files: comparison?.filesToCopy ?? sourceSnapshot?.changes ?? [], patch: sourceSnapshot?.patch ?? { bytes: 0, sha256: '' },
      totalBytes: comparison?.totalBytes ?? sourceSnapshot?.totalBytes ?? 0,
      status: unique.length || !sourceSnapshot || !targetSnapshot || comparison?.status === 'handoff-blocked' ? 'handoff-blocked' : 'prepared',
      blockers: unique, preparedAt: Date.now(),
    }
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; record: HandoffCopyView }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The work-copy command was reused for different input.')
        return prior.record
      }
      if (command.expectedGeneration !== undefined) {
        const assignment = await transaction.get<{ generation: string; state: string }>('assignment', command.ticketId)
        if (!assignment || assignment.state === 'ended' || assignment.generation !== command.expectedGeneration) {
          throw new CoreError('HANDOFF_STALE', 'The work generation changed before the work copy was saved.')
        }
      }
      await saveHandoffCopy(transaction, record)
      await transaction.insert('work-command', key, { fingerprint, record })
      return record
    })
  }

  async verifyHandoffCopy(command: { commandId: string; ticketId: string; expectedGeneration?: string }): Promise<HandoffCopyView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Verifying a work copy accepts only its exact Ticket and generation.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot verify a work copy.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['verify-handoff-copy', this.instanceId, command.ticketId,
      ...(command.expectedGeneration === undefined ? [] : [command.expectedGeneration])])).digest('hex')
    const { prior, replay } = await this.storage.transaction(this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; recordId: string; record?: HandoffCopyView }>(
        'work-command', key)
      if (prior && prior.fingerprint !== fingerprint) {
        throw new CoreError('IDENTITY_CONFLICT', 'The work-copy verification command was reused for different input.')
      }
      const replay = prior?.record ?? (prior?.recordId
        ? await loadHandoffCopyById(transaction, command.ticketId, prior.recordId) : undefined)
      return { prior, replay }
    })
    if (replay) return replay
    const { record, assignmentId, assignmentGeneration, assignmentState } = await this.storage.transaction(this.instanceId, async transaction => {
      const current = await loadHandoffCopy(transaction, command.ticketId)
      if (!current) throw new CoreError('NOT_FOUND', 'Prepare a work copy before verifying it.')
      const trigger = await this.triggerFor(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may verify this work copy.')
      }
      const assignment = await transaction.get<{ id: string; generation: string; state: string }>('assignment', command.ticketId)
      return { record: current, assignmentId: assignment?.id, assignmentGeneration: assignment?.generation,
        assignmentState: assignment?.state }
    })
    if (!prior && command.expectedGeneration !== undefined
      && (assignmentGeneration !== command.expectedGeneration || assignmentState === 'ended')) {
      throw new CoreError('HANDOFF_STALE', 'The work generation changed before the handoff copy was verified.')
    }
    const source = this.environments.find(environment => environment.config.id === record.source.id)
    const target = this.environments.find(environment => environment.config.id === record.target.id)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The prepared source or target Environment is no longer configured.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    const blockers: WorkCopyBlocker[] = []
    if (assignmentId !== record.assignmentId) {
      blockers.push({ code: 'assignment-changed', message: 'The Ticket Assignment changed after preparation.' })
    }
    if (source.kind !== record.source.kind || source.config.root !== record.source.root) {
      blockers.push({ code: 'source-environment-changed', message: 'The source Environment identity changed after preparation.' })
    }
    if (target.kind !== record.target.kind || target.config.root !== record.target.root
      || target.deviceId !== record.target.deviceId || target.deviceIncarnation !== record.target.deviceIncarnation) {
      blockers.push({ code: 'target-environment-changed', message: 'The target Environment identity changed after preparation.' })
    }
    let sourceProbe: EnvironmentProbe | undefined
    let targetProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    try { targetProbe = target.probe ? await target.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    if (sourceProbe && record.source.version && sourceProbe.version !== record.source.version
      || sourceProbe && record.source.fingerprint && sourceProbe.fingerprint !== record.source.fingerprint) {
      blockers.push({ code: 'source-environment-changed', message: 'The source Environment version or fingerprint changed after preparation.' })
    }
    if (targetProbe && record.target.version && targetProbe.version !== record.target.version
      || targetProbe && record.target.fingerprint && targetProbe.fingerprint !== record.target.fingerprint) {
      blockers.push({ code: 'target-environment-changed', message: 'The target Environment version or fingerprint changed after preparation.' })
    }
    let sourceSnapshot: WorkCopySnapshot | undefined
    let targetSnapshot: WorkCopySnapshot | undefined
    const sourceInspection = await inspectEnvironmentWorkCopy(source, identity)
    if (sourceInspection.snapshot) sourceSnapshot = sourceInspection.snapshot
    else blockers.push(sourceInspection.blocker!)
    const targetInspection = await inspectEnvironmentWorkCopy(target, identity)
    if (targetInspection.snapshot) targetSnapshot = targetInspection.snapshot
    else blockers.push(targetInspection.blocker!)
    if (!sourceSnapshot || sourceSnapshot.git.commit !== record.baseCommit || sourceSnapshot.patch.sha256 !== record.patch.sha256
      || !sameWorkCopyFiles(sourceSnapshot.changes, record.files)) {
      blockers.push({ code: 'source-changed', message: 'The source work copy changed after preparation.' })
    }
    if (sourceSnapshot && targetSnapshot) {
      const comparison = compareWorkCopy(sourceSnapshot, targetSnapshot, 'verify')
      blockers.push(...comparison.blockers)
    }
    const unique = uniqueBlockers(blockers)
    const next: HandoffCopyView = { ...record, status: unique.length || !sourceSnapshot || !targetSnapshot ? 'handoff-blocked' : 'verified',
      blockers: unique, ...(unique.length || !sourceSnapshot || !targetSnapshot ? {} : { verifiedAt: Date.now() }) }
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await loadHandoffCopy(transaction, command.ticketId)
      if (!current || current.id !== record.id) throw new CoreError('COMMIT_UNKNOWN', 'The work-copy preparation changed during verification.')
      if (command.expectedGeneration !== undefined) {
        const assignment = await transaction.get<{ generation: string; state: string }>('assignment', command.ticketId)
        if (!assignment || assignment.state === 'ended' || assignment.generation !== command.expectedGeneration) {
          throw new CoreError('HANDOFF_STALE', 'The work generation changed before the work copy was verified.')
        }
      }
      await saveHandoffCopy(transaction, next)
      const receipt = { fingerprint, recordId: next.id, record: next }
      if (!await transaction.replace('work-command', key, receipt)) {
        await transaction.insert('work-command', key, receipt)
      }
      return next
    })
  }

  async getHandoffCopy(ticketId: string): Promise<HandoffCopyView | undefined> {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The work copy belongs to a different source instance or actor.')
      }
      return loadHandoffCopy(transaction, ticketId)
    })
  }

  async requestHandoff(command: { commandId: string; ticketId: string; targetEnvironmentId: string; reason: string;
    expectedGeneration?: string }): Promise<EnvironmentHandoffView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'targetEnvironmentId', 'reason',
      'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A handoff accepts only its exact Ticket, target, generation and reason.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.targetEnvironmentId, 'targetEnvironmentId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'A handoff needs a bounded reason.')
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'A handoff requires a configured native runtime.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot hand off work.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['request-handoff', this.instanceId, command.ticketId,
      command.targetEnvironmentId, command.reason, ...(command.expectedGeneration === undefined ? [] : [command.expectedGeneration])])).digest('hex')
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', command.ticketId),
      assignment: await transaction.get<{ id: string; generation: string; state: string;
        environment?: EnvironmentLocation }>('assignment', command.ticketId),
      trigger: await this.triggerFor(transaction, command.ticketId),
      prior: await transaction.get<{ fingerprint: string; record: EnvironmentHandoffView }>('work-command', key),
    }))
    if (initial.prior) {
      if (initial.prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The handoff command was reused for different input.')
      return initial.prior.record
    }
    if (command.expectedGeneration !== undefined && (!initial.assignment
      || initial.assignment.state === 'ended' || initial.assignment.generation !== command.expectedGeneration)) {
      throw new CoreError('HANDOFF_STALE', 'The work generation changed before the handoff was requested.')
    }
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'A handoff cannot start while processing is paused.')
    if (!initial.ticket || initial.ticket.state !== 'open') throw new CoreError('NOT_FOUND', 'The Ticket is not open.')
    if (initial.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || initial.trigger.source.actorId !== this.source.actorId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may request this handoff.')
    }
    if (!initial.assignment?.environment) throw new CoreError('ENVIRONMENT_NOT_BOUND', 'The Ticket has no fixed source Environment.')
    const source = this.environments.find(environment => environment.config.id === initial.assignment!.environment!.id)
    const target = this.environments.find(environment => environment.config.id === command.targetEnvironmentId)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The source or target Environment is not configured.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    let sourceProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined } catch { sourceProbe = undefined }
    const targetCheck = await this.handoffTarget({ ticketId: command.ticketId, targetEnvironmentId: command.targetEnvironmentId,
      trigger: initial.trigger, target })
    const sourceLocation: EnvironmentLocation = { ...initial.assignment.environment,
      ...(sourceProbe && !initial.assignment.environment.version ? { version: sourceProbe.version } : {}),
      ...(sourceProbe && !initial.assignment.environment.fingerprint ? { fingerprint: sourceProbe.fingerprint } : {}) }
    const copy = await this.getHandoffCopy(command.ticketId)
    return this.execution.requestEnvironmentHandoff({ ticketId: command.ticketId, source: sourceLocation,
      target: targetCheck.target, ...(copy ? { copy } : {}), ...(targetCheck.blockers.length ? { targetBlockers: targetCheck.blockers } : {}),
      revalidate: () => this.revalidateHandoff(command.commandId, command.ticketId, command.targetEnvironmentId, sourceLocation),
      authorize: () => this.authorizeHandoffEnvironments(sourceLocation, targetCheck.target),
      command: { key, fingerprint }, ...(command.expectedGeneration === undefined
        ? {} : { expectedGeneration: command.expectedGeneration }),
      actorId: this.source.actorId, reason: command.reason })
  }

  private async handoffTarget(request: { ticketId: string; targetEnvironmentId: string; trigger: Work['trigger'];
    target: ExecutionEnvironment; actorId?: string }) {
    const { ticketId, targetEnvironmentId, trigger, target, actorId = this.source.actorId } = request
    if (trigger.target && !targetMatches(target.kind, trigger.target)) {
      return { target: environmentLocation(target), blockers: [{ code: 'target-ineligible',
        message: `The ${target.kind} Environment is excluded by the Ticket execution target ${trigger.target}.` }] }
    }
    const policy = await this.executionPolicy.get()
    const selection = await selectExecutionTarget({ ticketId, instanceId: this.instanceId,
      actorId, hostId: this.host.hostId, environments: this.environments, policy,
      ...(trigger.target ? { ticketTarget: trigger.target } : {}),
      explicitEnvironmentId: targetEnvironmentId, source: 'explicit',
      ...(trigger.capabilities?.length ? { requiredCapabilities: trigger.capabilities } : {}),
      hostCapabilities: this.hostCapabilities })
    if (selection.status !== 'selected' || !selection.selected) {
      return { target: environmentLocation(target), blockers: [{ code: 'target-ineligible',
        message: selection.reason ?? 'The target Environment is not eligible for this Ticket.' }] }
    }
    return { target: structuredClone(selection.selected), blockers: [] as HandoffBlocker[] }
  }

  private async revalidateHandoff(commandId: string, ticketId: string,
    targetEnvironmentId: string, expectedSource: EnvironmentLocation): Promise<EnvironmentHandoffRevalidation> {
    return this.revalidateHandoffTarget({ ticketId, targetEnvironmentId, actorId: this.source.actorId,
      verifyCommandId: `handoff-verify:${commandId}`, expectedSource })
  }

  private authorizeHandoffEnvironments(sourceLocation: EnvironmentLocation, targetLocation: EnvironmentLocation) {
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    const source = this.environments.find(environment => environment.config.id === sourceLocation.id)
    const target = this.environments.find(environment => environment.config.id === targetLocation.id)
    const matches = (environment: ExecutionEnvironment | undefined, location: EnvironmentLocation) => Boolean(environment
      && environment.kind === location.kind && environment.config.root === location.root
      && (environment.kind === 'local' || !location.deviceId || environment.deviceId === location.deviceId)
      && (environment.kind === 'local' || !location.deviceIncarnation
        || environment.deviceIncarnation === location.deviceIncarnation))
    if (!matches(source, sourceLocation) || !matches(target, targetLocation)) {
      throw new CoreError('ENVIRONMENT_DENIED', 'The recorded source or target Environment identity changed.')
    }
    source!.authorize(identity)
    target!.authorize(identity)
  }

  private async revalidateHandoffTarget(request: { ticketId: string; targetEnvironmentId: string; actorId: string;
    verifyCommandId: string; expectedSource?: EnvironmentLocation }): Promise<EnvironmentHandoffRevalidation> {
    const blockers: HandoffBlocker[] = []
    const loaded = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', request.ticketId),
      trigger: await this.triggerFor(transaction, request.ticketId),
    }))
    if (!loaded.ticket || loaded.ticket.state !== 'open') {
      return { blockers: [{ code: 'ticket-ended', message: 'The Ticket is not open.' }] }
    }
    if (!request.expectedSource && (loaded.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
      || loaded.trigger.source.actorId !== this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may revalidate this handoff.')
    }
    if (request.expectedSource) {
      const source = this.environments.find(environment => environment.config.id === request.expectedSource!.id)
      if (!source || source.kind !== request.expectedSource.kind || source.config.root !== request.expectedSource.root) {
        blockers.push({ code: 'source-environment-changed', message: 'The recorded source Environment is no longer configured with the same identity.' })
      } else {
        try { source.authorize({ instanceId: this.instanceId, actorId: request.actorId }) }
        catch { blockers.push({ code: 'source-environment-changed', message: 'The recorded source Environment no longer authorizes the requesting actor.' }) }
      }
    }
    const target = this.environments.find(environment => environment.config.id === request.targetEnvironmentId)
    if (!target) return { blockers: uniqueBlockers([...blockers,
      { code: 'target-ineligible', message: 'The target Environment is no longer configured.' }]) }
    try { target.authorize({ instanceId: this.instanceId, actorId: request.actorId }) }
    catch { return { blockers: uniqueBlockers([...blockers,
      { code: 'target-ineligible', message: 'The target Environment no longer authorizes the requesting actor.' }]) } }
    const targetCheck = await this.handoffTarget({ ticketId: request.ticketId, targetEnvironmentId: request.targetEnvironmentId,
      trigger: loaded.trigger, target, actorId: request.actorId })
    const copyCheck = await this.verifiedHandoffCopy(request.verifyCommandId, request.ticketId)
    return { target: targetCheck.target, ...(copyCheck.copy ? { copy: copyCheck.copy } : {}),
      blockers: uniqueBlockers([...blockers, ...targetCheck.blockers, ...copyCheck.blockers]) }
  }

  private async verifiedHandoffCopy(commandId: string, ticketId: string) {
    const current = await this.getHandoffCopy(ticketId)
    if (!current) {
      return { blockers: [{ code: 'handoff-copy-missing', message: 'No prepared work copy exists for this handoff.' }] as HandoffBlocker[] }
    }
    try {
      const copy = await this.verifyHandoffCopy({ commandId: `handoff-verify:${commandId}`, ticketId })
      return { copy, blockers: copy.blockers as HandoffBlocker[] }
    } catch (error) {
      const blockers = workCopyBlockers(error)
      return { copy: { ...current, status: 'handoff-blocked' as const, blockers }, blockers: blockers as HandoffBlocker[] }
    }
  }

  /**
   * Reconcile unfinished handoffs before ordinary Inputs resume. At most 25 are continued per start so a large
   * backlog cannot hold startup; the remaining active records stay durable and are retried on the next start.
   */
  private async recoverInterruptedHandoffs() {
    if (!this.execution || this.processingPaused) return
    const active = await this.execution.activeEnvironmentHandoffs()
    let recovered = 0
    for (const record of active) {
      if (this.processingPaused || recovered >= 25) return
      try {
        const trigger = await this.storage.transaction(this.instanceId, transaction => this.triggerFor(transaction, record.ticketId))
        if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) continue
        await this.execution.recoverEnvironmentHandoff(record, () => this.revalidateHandoffRecord(record),
          () => this.authorizeHandoffEnvironments(record.source, record.target))
        recovered++
      } catch (error) {
        await this.execution.failInterruptedHandoff(record, error).catch(() => {})
      }
    }
  }

  private async revalidateHandoffRecord(record: EnvironmentHandoffView): Promise<EnvironmentHandoffRevalidation> {
    return this.revalidateHandoffTarget({ ticketId: record.ticketId, targetEnvironmentId: record.target.id,
      actorId: record.requestedBy, verifyCommandId: `recover:${record.id}`, expectedSource: record.source })
  }

  async getEnvironmentHandoff(ticketId: string): Promise<EnvironmentHandoffView | undefined> {
    identifier(ticketId, 'ticketId')
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'A handoff query requires a configured native runtime.')
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The handoff belongs to a different source instance or actor.')
      }
    })
    return this.execution.getEnvironmentHandoff(ticketId)
  }

  async retryExecutionTarget(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Choosing an execution target requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Retrying an execution target accepts commandId and ticketId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot retry an execution target.')
    }
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
        || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source instance and actor may retry this execution target.')
      }
    })
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['execution-target-retry', this.instanceId, command.ticketId])).digest('hex')
    const claim = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; state?: 'pending' | 'done' }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The execution target command was reused for different work.')
        return { claimed: prior.state !== 'done', pending: prior.state !== 'done' }
      }
      await transaction.insert('work-command', key, { fingerprint, state: 'pending' })
      return { claimed: true, pending: false }
    })
    if (!claim.claimed) return this.execution.conversation(command.ticketId)
    const result = await this.execution.retryExecutionTarget(command.ticketId, { replay: claim.pending })
    await this.storage.transaction(this.instanceId, async transaction => {
      await transaction.replace('work-command', key, { fingerprint, state: 'done' })
    })
    return result
  }

  getReceipt(commandId: string): Promise<Receipt | undefined> {
    identifier(commandId, 'commandId')
    return this.storage.transaction(this.instanceId, async tx => (await tx.get<CommandRecord>('command', commandId))?.receipt)
  }

  /**
   * Explicitly acquires or renews the instance lease. Taking over another Host advances the epoch, then
   * reconciles every Assignment left by the previous runtime before new input is accepted.
   */
  async acquireHost({ initializeMain = false } = {}) {
    const acquired = await this.host.acquireWithPrevious()
    if (initializeMain) await this.main.initializeSession(await this.openMain({ instanceId: this.instanceId }))
    if (!acquired.previous && !await this.storage.transaction(this.instanceId, transaction => this.hostTakeoverPending(transaction))) {
      return acquired.lease
    }
    if (!this.execution) {
      await this.completeTakeoverWithoutRuntime()
      return acquired.lease
    }
    await this.execution.takeOverHost({ epoch: acquired.lease.epoch,
      ...(acquired.previous ? { previousHostId: acquired.previous.hostId, previousEpoch: acquired.previous.epoch,
        previousToken: acquired.previous.token } : {}) })
    if (!this.processingPaused) {
      try { await this.recoverInterruptedHandoffs() }
      catch { /* A blocked handoff stays visible without holding ordinary Input recovery. */ }
      try { await this.execution.recoverInputs() }
      catch { /* The next start retries the durable Input scan. */ }
    }
    return acquired.lease
  }

  getHostLease() {
    return this.host.currentLease()
  }

  /** The durable reconciliation record for the current Host epoch, once a replacement has occurred. */
  async getHostTakeover(): Promise<HostTakeoverRecord | undefined> {
    const epoch = this.host.epoch() ?? (await this.host.currentLease())?.epoch
    if (!epoch) return undefined
    return this.storage.transaction(this.instanceId, transaction => loadHostTakeover(transaction, this.instanceId, epoch))
  }

  private async hostTakeoverPending(transaction: AsyncTx): Promise<boolean> {
    const epoch = this.host.epoch()
    if (!epoch) return false
    return (await loadHostTakeover(transaction, this.instanceId, epoch))?.state === 'pending'
  }

  private async assertHostAdmission() {
    await this.storage.transaction(this.instanceId, transaction => this.assertHostAdmissionIn(transaction))
  }

  assertProductAdmission() {
    return this.assertHostAdmission()
  }

  configureImSourceAuthority(authorize: (tx: AsyncTx, event: SourceEvent) => Promise<boolean>) {
    this.imSourceAuthority = authorize
  }

  productExtensionStorage(): Storage {
    const guard = (storage: Storage, ownsConnection: boolean): Storage => ({
      transaction: (instanceId, operation) => {
        if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The connection belongs to another Instance.')
        return storage.transaction(instanceId, async tx => {
          await this.assertHostAdmissionIn(tx)
          return operation(tx)
        })
      },
      reconnect: async () => guard(await storage.reconnect(), true),
      close: async () => {
        if (ownsConnection) await storage.close()
      },
    })
    return guard(this.storage, false)
  }

  /**
   * New work must be checked inside the transaction that would create it: a probe on its own connection would
   * turn a lost commit into a lost command identity instead of letting the original command reconcile.
   */
  private async assertHostAdmissionIn(transaction: AsyncTx) {
    await assertHostTakeoverSettled(transaction, this.instanceId, this.host.epoch())
  }

  private configureEffectsGate() {
    this.effects.setGate({
      paused: async tx => (await tx.get<ProcessingState>('processing-state', this.processingKey()))?.paused === true,
    })
  }

  private async completeTakeoverWithoutRuntime() {
    const epoch = this.host.epoch()
    if (!epoch) return
    const record = await this.storage.transaction(this.instanceId, transaction => loadHostTakeover(transaction, this.instanceId, epoch))
    if (!record || record.state === 'completed') return
    const tickets = await this.storage.transaction(this.instanceId, async transaction => {
      const blocked: HostTakeoverTicket[] = []
      let cursor: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<Assignment>('assignment', { limit: 100, ...(cursor ? { after: cursor } : {}) })
        for (const item of page.items) {
          const assignment = item.value
          if (assignment.state === 'ended') continue
          const ended = { ...assignment, state: 'ended' as const }
          const historyKey = `${JSON.stringify(['assignment-history', assignment.ticketId])}:${assignment.id}`
          if (!await transaction.replace('assignment-history', historyKey, ended)) await transaction.insert('assignment-history', historyKey, ended)
          await transaction.replace('assignment', assignment.ticketId, ended)
          const ticket = await transaction.get<Work['ticket']>('ticket', assignment.ticketId)
          if (ticket && !ticket.constraint) {
            const intent = await transaction.get<Work['intent']>('intent', assignment.ticketId)
            if (intent) await transaction.replace('intent', assignment.ticketId, { ...intent, state: 'pending', reason: 'recovery-blocked' })
          }
          blocked.push({ ticketId: assignment.ticketId, outcome: 'blocked', previousAssignmentId: assignment.id,
            previousGeneration: assignment.generation, sessionId: assignment.sessionId,
            blockers: [{ code: 'takeover-failed', message: 'This Host has no native runtime; attach one and reconcile the Ticket before it continues.' }] })
        }
        if (!page.cursor) break
        cursor = page.cursor
        if (pageCount === 9) throw new CoreError('HOST_TAKEOVER_BUDGET', 'The Host takeover Assignment scan exceeded its 1000-record budget.')
      }
      return blocked
    })
    await this.storage.transaction(this.instanceId, transaction =>
      transaction.replace('host-takeover', record.id, { ...record, state: 'completed', completedAt: Date.now(), tickets }))
  }

  async getSessionHistory(sessionId: string, options: { limit?: number; after?: number } = {}) {
    if (!this.sessions) throw new CoreError('RUNTIME_NOT_ENABLED', 'Session history requires a configured native runtime.')
    return this.sessions.readSession(sessionId, options)
  }

  async openMain(request: MainAddress) {
    const binding = await this.main.open(request)
    if (this.sessions) this.sessions.routerSessionId = binding.routerSessionId
    return binding
  }
  private requireProductMemory(request: { instanceId: string }) {
    if (request?.instanceId !== this.instanceId || this.source.sourceInstanceId !== 'product-desktop'
      || (this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Memory belongs to another product Instance or actor.')
    }
  }

  async listProductMemory(request: { instanceId: string; after?: string; limit?: number; query?: string }) {
    this.requireProductMemory(request)
    return this.memory.list(request.limit, request.after, request.query)
  }
  async getProductMemory(request: { instanceId: string; id: string; after?: string; maxBytes?: number }) {
    this.requireProductMemory(request)
    return this.memory.readUser(request.id, request.after, request.maxBytes)
  }
  async searchProductMemory(request: { instanceId: string; reader: MemoryReader; query: string; limit?: number }) {
    this.requireProductMemory(request)
    return this.memory.search(request.reader, request.query, request.limit)
  }
  async readProductMemory(request: { instanceId: string; reader: MemoryReader; id: string; after?: string; maxBytes?: number }) {
    this.requireProductMemory(request)
    return this.memory.read(request.reader, request.id, request.after, request.maxBytes)
  }
  async previewProductMemoryImport(request: {
    instanceId: string; commandId: string; sourceName: string; data: string | Uint8Array
  }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.previewImport(request)
  }
  async listProductMemoryImports(request: { instanceId: string; limit?: number }) {
    this.requireProductMemory(request)
    return this.memory.importBatches(request.limit)
  }
  async getProductMemoryImport(request: { instanceId: string; batchId: string }) {
    this.requireProductMemory(request)
    return this.memory.importBatch(request.batchId)
  }
  async commitProductMemoryImport(request: {
    instanceId: string; commandId: string; batchId: string; selections: Array<{ sourceId: string; scope: MemoryScope }>
  }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.commitImport(request)
  }
  async cancelProductMemoryImport(request: { instanceId: string; commandId: string; batchId: string }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.cancelImport(request)
  }
  async retryProductMemoryImport(request: { instanceId: string; commandId: string; batchId: string }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.retryImport(request)
  }
  async queryProductMemorySide(request: { instanceId: string; target: MemorySideTarget; query: string; limit?: number }) {
    this.requireProductMemory(request)
    return this.memory.sideSearch(request.target, request.query, request.limit)
  }
  async readProductMemorySide(request: { instanceId: string; target: MemorySideTarget; id: string; after?: string; maxBytes?: number }) {
    this.requireProductMemory(request)
    return this.memory.sideRead(request.target, request.id, request.after, request.maxBytes)
  }
  async saveProductMemory(request: { instanceId: string; commandId: string; scope: MemoryScope; text: string }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.save(request)
  }
  async shareProductMemory(request: { instanceId: string; commandId: string; id: string; expectedRevision: number; main: boolean; workItemIds: string[] }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.share(request)
  }
  async forgetProductMemory(request: { instanceId: string; commandId: string; id: string; expectedRevision: number }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.forget(request)
  }
  async getProductWorkMemoryAccess(request: { instanceId: string; workItemId: string }) {
    this.requireProductMemory(request)
    return this.memory.access(request.workItemId)
  }
  async grantProductWorkMemory(request: { instanceId: string; commandId: string; workItemId: string; expectedRevision: number; enabled: boolean }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.grant(request)
  }
  async listProductMemoryProposals(request: { instanceId: string }) {
    this.requireProductMemory(request)
    return this.memory.proposals()
  }
  async decideProductMemoryProposal(request: { instanceId: string; commandId: string; proposalId: string; approve: boolean }) {
    this.requireProductMemory(request); await this.assertHostAdmission()
    return this.memory.decide(request)
  }
  private async authorizeScheduledTarget(tx: AsyncTx, target: ScheduleTarget) {
    const binding = await tx.get<{ mainId: string }>('main-state', 'main')
    if (!binding) throw new CoreError('MAIN_NOT_CONFIGURED', 'Open the authorized Main before creating schedules.')
    if (target.kind === 'main') return
    const item = await tx.get<MainWorkItem>('work-item', target.workItemId)
    const brief = item ? await tx.get<import('./work-delegation.js').MainWorkBrief>('work-brief', item.workBriefId) : undefined
    const receipt = await tx.get<import('./work-delegation.js').MainWorkReceipt>('work-receipt', target.workItemId)
    const index = await tx.get<{ ticketId: string }>('work-item-ticket', target.workItemId)
    const ticket = await tx.get<Work['ticket']>('ticket', target.ticketId)
    const mandate = ticket ? await tx.get<Work['mandate']>('mandate', ticket.mandateId) : undefined
    const decision = mandate ? await tx.get<Work['decision']>('decision', mandate.decisionId) : undefined
    if (!item || !brief || brief.instanceId !== this.instanceId || brief.mainId !== binding.mainId
      || receipt?.status !== 'accepted' || (receipt.ticketId ?? index?.ticketId) !== target.ticketId
      || !ticket || !mandate || !decision || mandate.scope !== item.goal || decision.outcome !== 'accept') {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The scheduled target is not an established authorized Main work item.')
    }
  }

  private requireProductScheduleActor() {
    if ((this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only an authorized product actor can manage schedules.')
    }
    this.assertAuthoringActor()
  }

  createProductCredentialManager(records: ProductCredentialRecords) {
    if ((this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only an authorized product actor can manage credential resources.')
    }
    this.assertAuthoringActor()
    this.productCredentialManager ??= new ProductCredentialManager(this.productExtensionStorage(), this.instanceId, records,
      async (tx, ticketId, request) => {
        const receipt = await this.inputs.attachMainFollowUp(tx, { ticketId, followUpId: `credential:${request.id}`, authorId: this.source.actorId,
          text: `The local user approved credential resource ${request.resourceId} for this work. Continue with the approved tool; never ask for the value.`,
          reason: 'The local operator approved the Worker credential request.' })
        if (receipt.status !== 'attached') throw new CoreError('REQUEST_UNAVAILABLE', 'This credential request cannot resume the current work.')
      })
    return this.productCredentialManager
  }

  private secretTools(ticketId: string, assignment: Assignment): import('./native-sessions.js').NativeTool[] {
    const manager = this.productCredentialManager
    const environment = assignment.environment
    if (!manager || environment?.kind !== 'local') return []
    return [{ name: 'request_secret', description: 'Ask the person to approve use of an existing credential resource for this work. Never ask for or return its value in chat.',
      parameters: { resourceId: { type: 'string', required: true } }, execute: async ({ resourceId }, signal) => {
        signal.throwIfAborted()
        identifier(resourceId, 'resourceId')
        const link = await this.storage.transaction(this.instanceId, tx => tx.get<{ workItemId?: string }>('work-ticket', ticketId))
        if (!link?.workItemId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A current local work assignment is required for a credential request.')
        signal.throwIfAborted()
        const intent = createHash('sha256').update(JSON.stringify([assignment.id, resourceId])).digest('hex')
        const result = await manager.request({ instanceId: this.instanceId, commandId: `secret-request:${intent}`, resourceId,
          scope: { role: 'worker', workItemId: link.workItemId, environmentId: environment.id }, purpose: 'tool' },
        { ticketId, id: assignment.id, generation: assignment.generation })
        const current = await manager.getRequest({ instanceId: this.instanceId, requestId: result.id })
        return JSON.stringify({ requestId: result.id, status: current?.status ?? result.status })
      } }]
  }

  createProductCredentialImports(records: ProductCredentialRecords, adapter: CredentialImportAdapter) {
    const manager = this.createProductCredentialManager(records)
    return new ProductCredentialImports(this.storage, this.instanceId, manager, adapter)
  }

  createProductMcpConfiguration(config: WorkerMcpConfig) {
    if ((this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only an authorized product actor can manage MCP settings.')
    }
    this.assertAuthoringActor()
    return new ProductMcpConfiguration(this.storage, this.instanceId, config, tx => this.assertHostAdmissionIn(tx))
  }

  configureCapabilityLibrary(credentials?: WorkerMcpBinding['credentials']) {
    if ((this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Capability settings require an authorized product actor.')
    }
    this.assertAuthoringActor()
    if (this.capabilityLibrary) return this.capabilityLibrary
    this.capabilityLibrary = new CapabilityLibrary(this.storage, this.instanceId, tx => this.assertHostAdmissionIn(tx), credentials)
    this.execution?.configureCapabilities(this.capabilityLibrary)
    return this.capabilityLibrary
  }

  /** Host-only configuration of one approved Worker tool; never part of the model command surface. */
  configureWorkerMcp(binding: WorkerMcpBinding) {
    if (!this.execution) throw new CoreError('UNAVAILABLE', 'Worker Sessions are not configured.')
    this.execution.configureWorkerMcp(binding)
  }

  /** The trusted product Host binds the browser bridge to this Instance and its Worker runtime. */
  configureWorkerBrowser(adapter: BrowserAdapter) {
    if (!this.execution || this.browserResources || (this.source.kind ?? 'desktop') !== 'desktop') {
      throw new CoreError('UNAVAILABLE', 'A product Worker browser is unavailable for this Instance.')
    }
    this.browserResources = new BrowserResources(this.storage, this.instanceId, this.source.actorId, this.environments,
      adapter, tx => this.assertHostAdmissionIn(tx))
    this.execution.configureWorkerBrowser(this.browserResources)
  }

  configureWorkerComputer(computer: ProductComputer) {
    if (!this.execution || (this.source.kind ?? 'desktop') !== 'desktop') {
      throw new CoreError('UNAVAILABLE', 'A product Worker computer bridge is unavailable for this Instance.')
    }
    this.execution.configureWorkerComputer(computer)
  }

  private browser() {
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot manage browsers.')
    if (!this.browserResources) throw new CoreError('UNAVAILABLE', 'The product Host has no browser bridge.')
    return this.browserResources
  }

  createBrowserResource(command: { instanceId: string; commandId: string; environmentId: string; label: string }) {
    this.assertAuthoringActor()
    return this.browser().create(command)
  }
  grantBrowserResource(command: { instanceId: string; commandId: string; resourceId: string; workItemId: string; expectedRevision: number; active: boolean }) {
    this.assertAuthoringActor()
    return this.browser().grant(command)
  }
  revokeBrowserResource(command: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number }) {
    this.assertAuthoringActor()
    return this.browser().revoke(command)
  }
  takeBrowserResource(command: { instanceId: string; commandId: string; resourceId: string; workItemId: string; expectedRevision: number }) {
    this.assertAuthoringActor()
    return this.browser().take(command)
  }
  reconcileBrowserTake(request: { instanceId: string; resourceId: string; controlId: string }) {
    this.assertAuthoringActor()
    return this.browser().reconcileTake(request)
  }
  giveBackBrowserResource(command: { instanceId: string; commandId: string; resourceId: string; controlId: string }) {
    this.assertAuthoringActor()
    return this.browser().giveBack(command)
  }
  viewBrowserControl(request: { instanceId: string; resourceId: string; controlId: string }) {
    this.assertAuthoringActor()
    return this.browser().controlView(request)
  }
  async resolveBrowserOperation(command: { instanceId: string; commandId: string; resourceId: string; operationId: string; reason: string }) {
    this.assertAuthoringActor()
    const operation = await this.browser().resolve(command)
    await this.execution?.settleBrowserStop(operation.ticketId)
    return operation
  }
  listBrowserResources(request: { instanceId: string }) { return this.browser().list(request) }
  getBrowserPlugin(request: { instanceId: string }) { return this.browser().plugin(request) }
  setBrowserPlugin(command: Parameters<BrowserResources['setPlugin']>[0]) {
    this.assertAuthoringActor()
    return this.browser().setPlugin(command)
  }
  readBrowserResource(request: { instanceId: string; resourceId: string }) { return this.browser().read(request) }
  importBrowserData(command: { instanceId: string; commandId: string; sourceRef: string; pendingId: string; preview: BrowserImportPreview;
    environmentId: string; label: string }) {
    this.assertAuthoringActor()
    return this.browser().importData(command)
  }
  listBrowserImports(request: { instanceId: string; limit?: number }) { return this.browser().listImports(request) }
  readBrowserImport(request: { instanceId: string; importId: string }) { return this.browser().readImport(request) }
  cancelBrowserImport(command: { instanceId: string; commandId: string; importId: string }) {
    this.assertAuthoringActor()
    return this.browser().cancelImport(command)
  }
  closeBrowserResources() { return this.browserResources?.close() ?? Promise.resolve() }

  async createSchedule(request: ScheduleCreate, family: ScheduleFamily = 'calendar') {
    this.requireProductScheduleActor()
    await this.main.open({ instanceId: request?.instanceId })
    return this.schedules.create(request, family)
  }
  cancelSchedule(request: { instanceId: string; commandId: string; ruleId: string }, family: ScheduleFamily = 'calendar') { this.requireProductScheduleActor(); return this.schedules.cancel(request, family) }
  listSchedules(request: { instanceId: string }, family: ScheduleFamily = 'calendar') { this.requireProductScheduleActor(); return this.schedules.list(request, family) }
  getSchedule(request: { instanceId: string; ruleId: string }, family: ScheduleFamily = 'calendar') {
    this.requireProductScheduleActor(); return this.schedules.get(request, family)
  }
  getScheduleSource(request: { instanceId: string }, family: ScheduleFamily = 'calendar') { this.requireProductScheduleActor(); return this.schedules.sourceState(request, family) }
  setScheduleSource(request: { instanceId: string; commandId: string; enabled: boolean }, family: ScheduleFamily = 'calendar') { this.requireProductScheduleActor(); return this.schedules.setSource(request, family) }
  tickSchedules(now?: number) { this.requireProductScheduleActor(); return this.schedules.tick(now) }

  private async receiveScheduledOccurrence(rule: ProductSchedule, occurrence: ScheduledOccurrence): Promise<Partial<ScheduledOccurrence>> {
    await this.ensurePolicy()
    await this.assertHostAdmission()
    const source = new SourceEvents(this.storage, this.instanceId, { kind: 'schedule', sourceInstanceId: `schedule:${rule.ruleId}`,
      actorId: 'schedule', allowedActorIds: ['schedule'], allowedThreadIds: [`schedule:${rule.ruleId}`], versionOrder: 'sequence' })
    const receipt = await source.receive({ commandId: `schedule:${rule.ruleId}:${occurrence.dueAt}`,
      threadId: `schedule:${rule.ruleId}`, objectId: `occurrence:${occurrence.dueAt}`, type: 'created',
      version: String(occurrence.dueAt), text: rule.text, authorId: 'schedule', authorKind: 'system', addressing: 'direct' },
    async (tx, event) => {
      const current = await authorizedScheduleEvent(tx, event, this.source.actorId, rule.target.kind)
      const key = scheduledOccurrenceKey(rule.ruleId, occurrence.dueAt)
      const pending = await tx.get<ScheduledOccurrence>('product-schedule-occurrence', key)
      if (!pending) throw new CoreError('INCOMPLETE_STATE', 'The scheduled occurrence is missing.')
      let state: Partial<ScheduledOccurrence>
      if (this.processingPaused) state = { status: 'blocked', reason: 'PROCESSING_PAUSED' }
      else if (current.target.kind === 'main') {
        const binding = await tx.get<{ mainId: string }>('main-state', 'main')
        if (!binding) throw new CoreError('MAIN_NOT_CONFIGURED', 'The scheduled Main is unavailable.')
        const handoff = await this.mainSources.create(tx, { event, mainId: binding.mainId,
          commandId: `schedule-handoff:${event.id}`, authorizedBy: this.source.actorId })
        await this.effects.enqueue(tx, { key: `handoff:${handoff.id}`, stream: 'notice', scope: `main:${binding.mainId}`,
          payload: { type: 'main-source-handoff', handoffId: handoff.id } })
        state = { status: 'accepted', handoffId: handoff.id }
      } else {
        await this.authorizeScheduledTarget(tx, current.target)
        const ticket = await tx.get<Work['ticket']>('ticket', current.target.ticketId)
        if (ticket?.constraint) state = { status: 'blocked', reason: `TICKET_${ticket.constraint.kind.toUpperCase().replace('-', '_')}` }
        else {
          const reference = `superagent://${encodeURIComponent(this.instanceId)}/schedules/${encodeURIComponent(rule.ruleId)}/occurrences/${occurrence.dueAt}`
          const input = await this.inputs.attachAssociated(tx, current.target.ticketId, event,
            { reference, source: event.source, sourceActorId: event.authorId, authorizedBy: this.source.actorId,
              ownerSourceInstanceId: this.source.sourceInstanceId, reason: `Authorized schedule ${rule.ruleId}`, checkedAt: Date.now() },
            { schedule: true })
          state = { status: 'accepted', ticketIds: [current.target.ticketId], inputId: input.id }
        }
      }
      await tx.replace('product-schedule-occurrence', key, { ...pending, ...state, eventId: event.id, updatedAt: Date.now() })
    })
    if (receipt.status === 'filtered') return { status: 'blocked', reason: receipt.reason ?? 'SOURCE_FILTERED' }
    return this.storage.transaction(this.instanceId, async tx => {
      const recorded = await tx.get<ScheduledOccurrence>('product-schedule-occurrence', scheduledOccurrenceKey(rule.ruleId, occurrence.dueAt))
      if (!recorded || !recorded.eventId) throw new CoreError('INCOMPLETE_STATE', 'The scheduled source receipt is missing.')
      return recorded
    })
  }
  private async instanceDirectoryIn(transaction: AsyncTx) {
    const current = await transaction.get<{ revision: number; environmentId: string; updatedAt: number }>('instance-directory', 'default')
    if (current) return current
    const first = this.environments.find(candidate => candidate.kind === 'local' && candidate.config.instanceId === this.instanceId
      && candidate.config.allowedActorIds.includes(this.source.actorId) && candidate.config.permissions.includes('read')
      && candidate.config.permissions.includes('write'))
    return first ? { revision: 0, environmentId: first.config.id, updatedAt: 0 } : undefined
  }

  private directoryEnvironment(id: string) {
    const environment = this.environments.find(candidate => candidate.config.id === id && candidate.kind === 'local'
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId)
      && candidate.config.permissions.includes('read') && candidate.config.permissions.includes('write'))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'The selected work directory is not authorized for this Instance.')
    return environment
  }

  registerWorkDirectory(environment: ExecutionEnvironment) {
    if (environment.kind !== 'local' || environment.config.instanceId !== this.instanceId
      || !environment.config.allowedActorIds.includes(this.source.actorId)
      || !environment.config.permissions.includes('read') || !environment.config.permissions.includes('write')) {
      throw new CoreError('ENVIRONMENT_DENIED', 'The work directory must be a writable local Environment for this Instance.')
    }
    this.registerExecutionEnvironment(environment)
  }

  registerExecutionEnvironment(environment: ExecutionEnvironment) {
    if (environment.config.instanceId !== this.instanceId || !environment.config.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not authorized for the current Instance and actor.')
    }
    const existing = this.environments.find(candidate => candidate.config.id === environment.config.id)
    if (existing && (existing.kind !== environment.kind || existing.config.root !== environment.config.root
      || existing.deviceId !== environment.deviceId || existing.deviceIncarnation !== environment.deviceIncarnation)) {
      throw new CoreError('ENVIRONMENT_CHANGED', 'An Environment ID cannot change its execution world.')
    }
    if (!existing) this.environments.push(environment)
  }

  unregisterExecutionEnvironment(environmentId: string) {
    const index = this.environments.findIndex(environment => environment.config.id === environmentId)
    if (index >= 0) this.environments.splice(index, 1)
  }

  async addWorkDirectory(command: MainAddress & { commandId: string; environment: ExecutionEnvironment }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'environment'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A work directory registration accepts an Instance, command ID and Environment.')
    }
    if (command.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot register a work directory.')
    }
    identifier(command.commandId, 'commandId')
    const environment = command.environment
    if (!environment || environment.kind !== 'local' || environment.config.instanceId !== this.instanceId
      || !environment.config.allowedActorIds.includes(this.source.actorId)
      || !environment.config.permissions.includes('read') || !environment.config.permissions.includes('write')) {
      throw new CoreError('ENVIRONMENT_DENIED', 'The selected directory is not an authorized local Environment.')
    }
    const { id, root } = environment.config
    const fingerprint = createHash('sha256').update(canonicalJson(['product-directory-v1', this.instanceId, id, root])).digest('hex')
    const key = this.commandKey(`product-directory:${command.commandId}`)
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; id: string }>('instance-directory-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The directory command was reused for a different path.')
        return
      }
      const existing = await transaction.get<{ id: string; root: string }>('product-directory', id)
      if (existing && existing.root !== root) throw new CoreError('ENVIRONMENT_CHANGED', 'The work directory identity changed.')
      if (!existing) await transaction.insert('product-directory', id, { id, root, version: 1 })
      await transaction.insert('instance-directory-command', key, { fingerprint, id })
    })
    this.registerWorkDirectory(environment)
    return { id, root }
  }

  async getInstanceDirectory(request: MainAddress) {
    if (!request || request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This work directory is outside the authorized Main Instance.')
    }
    const current = await this.storage.transaction(this.instanceId, transaction => this.instanceDirectoryIn(transaction))
    if (!current) throw new CoreError('DELEGATION_UNAVAILABLE', 'No authorized local work directory is configured.')
    return { ...current, root: this.directoryEnvironment(current.environmentId).config.root }
  }

  async setInstanceDirectory(command: MainAddress & { commandId: string; expectedRevision: number; environmentId: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'expectedRevision', 'environmentId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A directory change accepts the Instance, command ID, revision and Environment only.')
    }
    if (command.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot change the Instance work directory.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.environmentId, 'environmentId')
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw new CoreError('INVALID_INPUT', 'The directory revision must be a nonnegative integer.')
    const environment = this.directoryEnvironment(command.environmentId)
    const fingerprint = createHash('sha256').update(canonicalJson(['instance-directory-v1', this.instanceId,
      command.environmentId, command.expectedRevision])).digest('hex')
    const key = this.commandKey(`instance-directory:${command.commandId}`)
    const result = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; value: { revision: number; environmentId: string; updatedAt: number } }>('instance-directory-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The directory command was reused with different input.')
        return prior.value
      }
      const current = await this.instanceDirectoryIn(transaction)
      if (current?.revision !== command.expectedRevision) throw new CoreError('DIRECTORY_REVISION_CONFLICT', 'The default work directory changed; refresh before saving.')
      const value = { revision: command.expectedRevision + 1, environmentId: environment.config.id, updatedAt: Date.now() }
      if (!await transaction.replace('instance-directory', 'default', value)) await transaction.insert('instance-directory', 'default', value)
      await transaction.insert('instance-directory-command', key, { fingerprint, value })
      return value
    })
    return { ...result, root: environment.config.root }
  }

  sendMainMessage(request: MainSend, authorize?: (tx: AsyncTx) => Promise<void>) {
    if (request.target !== undefined && !['local-only', 'remote-only', 'auto'].includes(request.target)) {
      throw new CoreError('INVALID_INPUT', 'A Main message target is local-only, remote-only or auto.')
    }
    let target = request.target
    if (request.environmentId !== undefined) {
      const environment = this.environments.find(candidate => candidate.config.id === request.environmentId
        && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId)
        && candidate.config.permissions.includes('read') && candidate.config.permissions.includes('write'))
      if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'The selected execution Environment is not authorized for this Instance.')
      if (request.target && request.target !== 'auto'
        && (request.target === 'local-only' && environment.kind !== 'local'
          || request.target === 'remote-only' && environment.kind !== 'remote')) {
        throw new CoreError('ENVIRONMENT_DENIED', 'The selected Environment does not match the Main message target.')
      }
      if (target === undefined) target = environment.kind === 'remote' ? 'remote-only' : 'local-only'
    }
    return this.main.send({ ...request, ...(target === undefined ? {} : { target }) }, authorize)
  }
  stopMainTurn(request: MainAddress & { commandId: string; messageId: string }) { return this.main.stop(request) }
  resumeMainInputs(request: MainAddress) { return this.main.resume(request) }
  async directMainWork(request: import('./main-conversation.js').MainWorkDirection) {
    await this.assertHostAdmission()
    return this.main.directWork(request)
  }

  async listMainWork(request: MainAddress & { after?: string; limit?: number }) {
    const { instanceId, after, limit } = request
    const binding = await this.main.open({ instanceId })
    const page = await this.workDelegation?.boardPage(binding.mainId, {
      ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }),
    })
    if (!page) return { items: [] }
    const items = await this.storage.transaction(instanceId, async tx => {
      const records = []
      for (const card of page.items) {
        const ticketId = card.receipt.ticketId
        const reportId = card.outcome?.reportId
        const result = card.status === 'success' && ticketId && reportId
          ? (await this.deliveries.list(tx, ticketId)).findLast(delivery =>
            delivery.reportId === reportId && ['result', 'answer'].includes(delivery.purpose))
          : undefined
        const state = card.status === 'stopped' ? 'stopped'
          : card.status === 'success' && result?.state === 'sent' ? 'delivered'
            : card.status === 'success' && (!result || result.state === 'pending') ? 'waiting-delivery'
              : ['running', 'routing', 'accepted', 'pending'].includes(card.status) ? 'running' : 'waiting-human'
        const assignment = card.control?.assignment
        const detail = assignment?.state === 'stopping' || card.control?.stop?.state === 'stopping' ? 'stopping'
          : result?.state === 'unknown' || result?.state === 'dropped' ? result.state : card.status
        records.push({ id: card.brief.workItemId, goal: card.brief.goal, createdAt: card.brief.createdAt,
          summary: card.update?.summary ?? card.outcome?.summary ?? card.receipt.nextStep, state, detail,
          ...(ticketId ? { ticketId } : {}),
          ...(ticketId && card.control?.permissions.canStop ? { stop: { expectedTicketVersion: card.control.ticketVersion,
            ...(assignment ? { expectedGeneration: assignment.generation } : {}) } } : {}),
          ...(card.followUps?.length ? { notes: card.followUps.map(({ id, text }) => ({ id, text })) } : {}),
        })
      }
      return records
    })
    return { items, ...(page.cursor ? { cursor: page.cursor } : {}) }
  }

  async mainWorkMembers(request: MainAddress) {
    const binding = await this.main.open(request)
    return this.storage.transaction(this.instanceId, async tx => {
      const members = new Map<string, { sessionId: string; state: string; item?: { id: string; ticketId: string; goal: string;
        stop: { expectedTicketVersion: number; expectedGeneration: string } } }>()
      let after: string | undefined
      do {
        const page = await tx.scan<Assignment>('assignment', { limit: 100, ...(after ? { after } : {}) })
        for (const { value: assignment } of page.items) {
          if (assignment.state !== 'running' && assignment.state !== 'stopping') continue
          const worker = { sessionId: assignment.sessionId, state: assignment.state }
          const link = await tx.get<{ workBriefId: string; workItemId: string }>('work-ticket', assignment.ticketId)
          const brief = link && await tx.get<MainWorkBrief>('work-brief', link.workBriefId)
          const item = link && await tx.get<MainWorkItem>('work-item', link.workItemId)
          const ticket = item && await tx.get<Work['ticket']>('ticket', assignment.ticketId)
          const target = assignment.state === 'running' && brief?.mainId === binding.mainId
            && item && ticket?.state === 'open' && !ticket.constraint ? {
              id: item.id, goal: item.goal, ticketId: assignment.ticketId,
              stop: { expectedTicketVersion: ticket.directionVersion ?? 1, expectedGeneration: assignment.generation },
            } : undefined
          if (!members.has(worker.sessionId) || target) members.set(worker.sessionId, { ...worker, ...(target ? { item: target } : {}) })
        }
        after = page.cursor
      } while (after)
      return { workers: [...members.values()] }
    })
  }

  async getMainConversation(request: MainAddress & { limit?: number; after?: number }) {
    const page = await this.main.page(request)
    return { ...page, works: this.workDelegation ? await this.workDelegation.list(page.mainId) : [] as MainWorkCard[],
      sources: await this.mainSourceViews((await this.mainSources.list(page.mainId, { limit: 20 })).items) }
  }

  async getRecentMainConversation(request: MainAddress & { limit?: number; before?: number }) {
    const page = await this.main.recentPage(request)
    return { ...page, works: this.workDelegation ? await this.workDelegation.list(page.mainId) : [] as MainWorkCard[],
      sources: await this.mainSourceViews((await this.mainSources.list(page.mainId, { limit: 20 })).items) }
  }

  async getMainSources(request: MainAddress & { limit?: number; after?: string }) {
    if (!request || Object.keys(request).some(key => !['instanceId', 'limit', 'after'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Main source history accepts an Instance and a bounded page.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Main source history is outside the authorized Instance.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    const page = await this.mainSources.list(binding.mainId, { ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.after === undefined ? {} : { after: request.after }) })
    return { ...page, items: await this.mainSourceViews(page.items) }
  }

  async getMainSourceDeliveries(request: MainAddress & { sourceId: string; after?: string; limit?: number }): Promise<MainSourceDeliveryPage> {
    if (!request || Object.keys(request).some(key => !['instanceId', 'sourceId', 'after', 'limit'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Source deliveries accept an Instance, source ID and bounded page.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Source deliveries are outside the authorized Main Instance.')
    }
    identifier(request.sourceId, 'sourceId')
    const limit = request.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || request.after !== undefined && request.after.length > 1024) {
      throw new CoreError('INVALID_INPUT', 'Source delivery history accepts 1–100 rows and a bounded cursor.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.storage.transaction(this.instanceId, async transaction => {
      const handoff = await this.mainSources.get(transaction, request.sourceId)
      if (!handoff || handoff.mainId !== binding.mainId) throw new CoreError('NOT_FOUND', 'The Main source handoff is unavailable.')
      return this.sourceDeliveryPage(transaction, handoff, request.after, limit)
    })
  }

  private mainSourceViews(handoffs: MainSourceHandoff[]): Promise<MainSourceView[]> {
    return this.storage.transaction(this.instanceId, async transaction => Promise.all(handoffs.map(async handoff => {
      const split = handoff.workBriefId ? await transaction.get<{ itemIds: string[] }>('work-split', handoff.workBriefId) : undefined
      const workItemIds = split?.itemIds ?? []
      const receipts = await Promise.all(workItemIds.map(id => transaction.get<{ ticketId?: string }>('work-receipt', id)))
      const ticketIds = [...new Set(receipts.flatMap(receipt => receipt?.ticketId ? [receipt.ticketId] : []))]
      const deliveryPage = this.deliveryPage(ticketIds, await Promise.all(ticketIds.map(ticketId => this.deliveries.list(transaction, ticketId))), undefined, 10)
      const conditions = (await Promise.all(ticketIds.map(ticketId => this.deliveryState.list(transaction, ticketId)))).flat()
        .map(condition => ({ ticketId: condition.ticketId, number: condition.number, state: condition.state,
          ...(condition.result ? { result: condition.result } : {}), ...(condition.reason ? { reason: condition.reason } : {}) }))
      const sourceReply = ticketIds.length === 0 ? await this.sourceReplyView(transaction, handoff) : undefined
      const deliveries = sourceReply ? [sourceReply, ...deliveryPage.items].slice(0, 10) : deliveryPage.items
      return { ...structuredClone(handoff), workItemIds, ticketIds, deliveries,
        deliveryHasMore: deliveryPage.hasMore || deliveries.length > 10, ...(deliveryPage.cursor ? { deliveryCursor: deliveryPage.cursor } : {}), conditions }
    })))
  }

  private async sourceDeliveryPage(transaction: AsyncTx, handoff: MainSourceHandoff, after: string | undefined, limit: number) {
    const split = handoff.workBriefId ? await transaction.get<{ itemIds: string[] }>('work-split', handoff.workBriefId) : undefined
    const receipts = await Promise.all((split?.itemIds ?? []).map(id => transaction.get<{ ticketId?: string }>('work-receipt', id)))
    const ticketIds = [...new Set(receipts.flatMap(receipt => receipt?.ticketId ? [receipt.ticketId] : []))]
    const page = this.deliveryPage(ticketIds, await Promise.all(ticketIds.map(ticketId => this.deliveries.list(transaction, ticketId))), after, limit)
    const sourceReply = ticketIds.length === 0 ? await this.sourceReplyView(transaction, handoff) : undefined
    if (!sourceReply || after) return page
    return { items: [sourceReply, ...page.items].slice(0, limit), ...(page.cursor ? { cursor: page.cursor } : {}), hasMore: page.hasMore }
  }

  private async sourceReplyView(transaction: AsyncTx, handoff: MainSourceHandoff): Promise<MainSourceDeliveryView | undefined> {
    const reply = await transaction.get<{ id: string; effectId: string; effectGeneration: string; createdAt: number; destination: MainSourceDeliveryView['destination'] }>(
      'main-source-reply', `main-source-reply:${handoff.id}`)
    if (!reply) return undefined
    const receipt = await transaction.get<{ state: 'pending' | 'done' | 'failed' | 'unknown' | 'superseded'; delivery?: 'pending' | 'sent' | 'dropped' | 'unknown'; attempts?: number; reason?: string }>(
      'effect-receipt', JSON.stringify([reply.effectId, reply.effectGeneration]))
    const state = receipt?.delivery ?? (receipt?.state === 'done' ? 'sent' : receipt?.state === 'unknown' ? 'unknown' : receipt?.state === 'failed' ? 'dropped' : 'pending')
    return { id: reply.id, ticketId: handoff.id, sequence: 0, createdAt: reply.createdAt, purpose: 'result', state,
      reconcileRequired: state === 'unknown', ...(receipt?.attempts === undefined ? {} : { attempts: receipt.attempts }),
      ...(receipt?.reason ? { reason: receipt.reason } : {}), destination: reply.destination }
  }

  private deliveryPage(ticketIds: string[], histories: DeliveryView[][], after: string | undefined, limit: number): MainSourceDeliveryPage {
    const all = histories.flat().sort((left, right) => right.createdAt - left.createdAt || right.sequence - left.sequence
      || left.ticketId.localeCompare(right.ticketId) || left.id.localeCompare(right.id))
    let start = 0
    if (after) {
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) } catch { throw new CoreError('INVALID_INPUT', 'Use a source-delivery cursor from this Main source.') }
      if (!Array.isArray(decoded) || decoded.length !== 4 || decoded.some(value => typeof value !== 'string' && typeof value !== 'number')) {
        throw new CoreError('INVALID_INPUT', 'Use a source-delivery cursor from this Main source.')
      }
      const [createdAt, ticketId, sequence, id] = decoded
      const index = all.findIndex(delivery => delivery.createdAt === createdAt && delivery.ticketId === ticketId
        && delivery.sequence === sequence && delivery.id === id && ticketIds.includes(delivery.ticketId))
      if (index < 0) throw new CoreError('INVALID_INPUT', 'The source-delivery cursor is no longer valid.')
      start = index + 1
    }
    const items = all.slice(start, start + limit).map(delivery => ({ id: delivery.id, ticketId: delivery.ticketId, sequence: delivery.sequence,
      createdAt: delivery.createdAt, purpose: delivery.purpose, state: delivery.state, reconcileRequired: delivery.reconcileRequired,
      ...(delivery.attempts === undefined ? {} : { attempts: delivery.attempts }), ...(delivery.reason ? { reason: delivery.reason } : {}),
      ...(delivery.platformReceipt ? { platformReceipt: delivery.platformReceipt } : {}),
      destination: delivery.destination }))
    const hasMore = start + items.length < all.length
    const last = items.at(-1)
    const cursor = hasMore && last ? Buffer.from(JSON.stringify([last.createdAt, last.ticketId, last.sequence, last.id])).toString('base64url') : undefined
    return { items, hasMore, ...(cursor ? { cursor } : {}) }
  }

  async getMainWorkPlan(request: MainAddress & { workBriefId: string }) {
    if (!this.workDelegation) throw new CoreError('DELEGATION_UNAVAILABLE', 'No authorized local workspace is configured.')
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This WorkBrief is outside the authorized Main Instance.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.workDelegation.plan(binding.mainId, request.workBriefId)
  }

  async getMainWorkCard(request: MainAddress & { workItemId: string }): Promise<MainWorkCard> {
    if (!this.workDelegation) throw new CoreError('DELEGATION_UNAVAILABLE', 'No authorized local workspace is configured.')
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This work item is outside the authorized Main Instance.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    const result = await this.workDelegation.query(binding.mainId, { workItemId: request.workItemId })
    if (!result || !('brief' in result)) throw new CoreError('INCOMPLETE_STATE', 'The work item projection is unavailable.')
    return result
  }

  async readMainEvidence(request: MainAddress & { workItemId: string; ref: Omit<ContextRef, 'ticketId'>;
    after?: string; maxBytes?: number }): Promise<MainEvidenceCard> {
    if (!request || Object.keys(request).some(key => !['instanceId', 'workItemId', 'ref', 'after', 'maxBytes'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Main evidence accepts one authorized work item and a bounded reference page.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Main evidence is outside the authorized Instance.')
    }
    if (!request.ref || typeof request.ref !== 'object' || Array.isArray(request.ref)) {
      throw new CoreError('INVALID_INPUT', 'Main evidence needs one context reference.')
    }
    if (Object.keys(request.ref).some(key => !['kind', 'id', 'threadId', 'objectId'].includes(key))
      || !['ticket', 'trigger', 'decision', 'mandate', 'report', 'attention', 'delivery', 'source-event', 'source-thread'].includes(request.ref.kind)) {
      throw new CoreError('INVALID_INPUT', 'Main evidence accepts one known context reference shape.')
    }
    if (!this.workDelegation) throw new CoreError('DELEGATION_UNAVAILABLE', 'Main evidence requires authorized local work.')
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.workDelegation.evidence(binding.mainId, {
      workItemId: request.workItemId,
      ref: request.ref,
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  async getWorkObservations(request: MainAddress & { limit?: number; after?: string; query?: string }) {
    if (!request || Object.keys(request).some(key => !['instanceId', 'limit', 'after', 'query'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Work activity accepts an Instance, a bounded page and an optional search.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Work activity is outside the authorized Main Instance.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    if (!this.workObservations) return { items: [] }
    return this.workObservations.list(binding.mainId, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.query === undefined ? {} : { query: request.query }),
    })
  }

  async readWorkObservation(request: MainAddress & { observationId: string; generation?: string; after?: number; limit?: number }) {
    if (!request || Object.keys(request).some(key => !['instanceId', 'observationId', 'generation', 'after', 'limit'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Work observation history accepts one authorized observation and a bounded page.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Work observation history is outside the authorized Main Instance.')
    }
    if (!this.workObservations) throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.workObservations.read(binding.mainId, { observationId: request.observationId,
      ...(request.generation === undefined ? {} : { generation: request.generation }),
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.limit === undefined ? {} : { limit: request.limit }) })
  }

  async readWorkObservationDetail(request: MainAddress & { observationId: string; generation?: string;
    detailId: string; offset?: number; limit?: number }) {
    if (!request || Object.keys(request).some(key =>
      !['instanceId', 'observationId', 'generation', 'detailId', 'offset', 'limit'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Work detail accepts one authorized observation and a bounded page.')
    }
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Work detail is outside the authorized Main Instance.')
    }
    if (!this.workObservations) throw new CoreError('NOT_FOUND', 'The requested work detail is unavailable.')
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.workObservations.detail(binding.mainId, {
      observationId: request.observationId,
      detailId: request.detailId,
      ...(request.generation === undefined ? {} : { generation: request.generation }),
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    })
  }

  async getRoleConfig(): Promise<RoleConfigView> {
    const config = await this.roleConfig.ensure()
    this.roleConfigRevision = config.revision
    this.applyRoleRoutes(config)
    return config
  }

  async updateRoleConfig(command: { commandId: string; expectedRevision: number; roles: RoleConfig }, options: { verify?: (roles: RoleConfig, signal: AbortSignal) => Promise<void> } = {}): Promise<RoleConfigView> {
    await this.getRoleConfig()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'roles'].includes(key))) throw new CoreError('INVALID_INPUT', 'A role configuration update accepts commandId, expectedRevision and roles only.')
    identifier(command.commandId, 'commandId')
    this.assertAuthoringActor()
    validateRoleConfig(command.roles)
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['role-config-v1', command.expectedRevision, command.roles])).digest('hex')
    const prior = await this.storage.transaction(this.instanceId,
      transaction => transaction.get<{ fingerprint: string; revision: number }>('work-command', commandKey))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The role configuration command was reused with different input.')
      return await this.roleConfig.atRevision(prior.revision) ?? await this.roleConfig.currentView()
    }
    if (options.verify) {
      const controller = new AbortController()
      try { await options.verify(structuredClone(command.roles), controller.signal) }
      finally { controller.abort() }
    }
    const result = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const committed = await transaction.get<{ fingerprint: string; revision: number }>('work-command', commandKey)
      if (committed) {
        if (committed.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The role configuration command was reused with different input.')
        return { revision: committed.revision, replayed: true }
      }
      const view = await this.roleConfig.write(transaction, command.expectedRevision, command.roles)
      await transaction.insert('work-command', commandKey, { fingerprint, revision: view.revision })
      return { revision: view.revision, replayed: false, view }
    })
    if (!('view' in result) || !result.view) return await this.roleConfig.atRevision(result.revision) ?? await this.roleConfig.currentView()
    const view = result.view
    this.roleConfigRevision = view.revision
    this.applyRoleRoutes(view)
    return view
  }

  getRoleConfigUses(sessionId: string): Promise<RoleConfigUse[]> {
    return this.roleConfig.uses(sessionId)
  }

  getRecentRoleConfigUses(limit = 50): Promise<RoleConfigUse[]> {
    return this.roleConfig.recentUses(limit)
  }

  private assertProductStatusAccess(instanceId: string) {
    if (instanceId !== this.instanceId || this.source.sourceInstanceId !== 'product-desktop'
      || (this.source.kind ?? 'desktop') !== 'desktop' || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Product settings belong to another Instance or actor.')
    }
  }

  async getProductUsage(request: { instanceId: string }, hourly = false): Promise<ProductUsageReport> {
    this.assertProductStatusAccess(request?.instanceId)
    return this.productUsage.read(hourly)
  }

  async getProductStatus(request: { instanceId: string }) {
    this.assertProductStatusAccess(request?.instanceId)
    const [main, configuration, processing, effects] = await Promise.all([
      this.getMainConversation({ instanceId: this.instanceId, limit: 1 }),
      this.getRoleConfig(),
      this.storage.transaction(this.instanceId, tx => tx.get<ProcessingState>('processing-state', this.processingKey())),
      this.effects.status(),
    ])
    return {
      main: main.health,
      processingPaused: processing?.paused ?? false,
      roles: { main: configuration.roles.main?.model.provider !== undefined && configuration.roles.main.model.provider !== 'unconfigured',
        router: configuration.roles.router.model.provider !== 'unconfigured', worker: configuration.roles.worker.model.provider !== 'unconfigured' },
      roleRevision: configuration.revision,
      effects,
    }
  }

  getRoleConfigHistory(limit = 20) {
    return this.roleConfig.history(limit)
  }

  private assertPresetAccess(instanceId: string, write = false) {
    if (instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot access presets in this Instance.')
    }
    if (write) this.assertAuthoringActor()
  }

  createRolePreset(command: { instanceId: string; commandId: string; preset: unknown }) {
    this.assertPresetAccess(command?.instanceId, true)
    identifier(command.commandId, 'commandId')
    return this.rolePresets.create({ ...command, commandId: this.commandKey(command.commandId) })
  }

  getRolePreset(request: { instanceId: string; presetId: string }) {
    this.assertPresetAccess(request?.instanceId)
    return this.rolePresets.get(request)
  }

  listRolePresets(request: { instanceId: string; after?: string; limit?: number }) {
    this.assertPresetAccess(request?.instanceId)
    return this.rolePresets.list(request)
  }

  previewRolePreset(command: { instanceId: string; commandId: string; copy: LegacyPresetCopy }) {
    this.assertPresetAccess(command?.instanceId, true)
    identifier(command.commandId, 'commandId')
    return this.rolePresets.recordPreview({ ...command, commandId: this.commandKey(command.commandId) })
  }

  getRolePresetPreview(request: { instanceId: string; previewId: string }) {
    this.assertPresetAccess(request?.instanceId)
    return this.rolePresets.getPreview(request)
  }

  selectRolePreset(command: { instanceId: string; commandId: string; previewId: string; decision: 'select' | 'replace' | 'skip';
    copy?: LegacyPresetCopy; preset?: unknown; expectedDecisionId?: string }) {
    this.assertPresetAccess(command?.instanceId, true)
    identifier(command.commandId, 'commandId')
    return this.rolePresets.decideImport({ ...command, commandId: this.commandKey(command.commandId) })
  }

  getRolePresetImport(request: { instanceId: string; importId: string }) {
    this.assertPresetAccess(request?.instanceId)
    return this.rolePresets.getImport(request)
  }

  listRolePresetImports(request: { instanceId: string; after?: string; limit?: number }) {
    this.assertPresetAccess(request?.instanceId)
    return this.rolePresets.listImports(request)
  }

  async applyRolePreset(command: { instanceId: string; commandId: string; presetId: string; targetRole: PresetRole;
    expectedRevision: number }, options: { verify?: (roles: RoleConfig, signal: AbortSignal) => Promise<void> } = {}): Promise<RolePresetApplication> {
    this.assertPresetAccess(command?.instanceId, true)
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'presetId', 'targetRole', 'expectedRevision'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A preset application accepts one preset, role and expected revision.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.presetId, 'presetId')
    const fingerprint = createHash('sha256').update(canonicalJson(['role-preset-apply-v1', command.presetId,
      command.targetRole, command.expectedRevision])).digest('hex')
    const key = this.commandKey(command.commandId)
    const prior = await this.storage.transaction(this.instanceId, async tx => {
      const receipt = await tx.get<{ fingerprint: string }>('work-command', key)
      if (!receipt) return undefined
      if (receipt.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The preset command was reused with different input.')
      const application = await tx.get<RolePresetApplication>('role-preset-application', key)
      if (!application) throw new CoreError('INCOMPLETE_STATE', 'The committed preset application is missing its role revision.')
      return application
    })
    if (prior) {
      await this.getRoleConfig()
      return prior
    }
    const current = await this.getRoleConfig()
    if (current.revision !== command.expectedRevision) throw new CoreError('CONFIG_REVISION_CONFLICT', 'The role configuration changed after this preset was selected.')
    const entry = await this.rolePresets.get({ instanceId: this.instanceId, presetId: command.presetId })
    if (!entry || entry.status !== 'active') throw new CoreError('PRESET_UNAVAILABLE', 'The preset is unavailable.')
    const prepared = prepareRolePresetApplication({ commandId: command.commandId, current,
      targetRole: command.targetRole, preset: entry.preset })
    if (options.verify) {
      const controller = new AbortController()
      try { await options.verify(structuredClone(prepared.roles), controller.signal) }
      finally { controller.abort() }
    }
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const receipt = await tx.get<{ fingerprint: string }>('work-command', key)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The preset command was reused with different input.')
        const application = await tx.get<RolePresetApplication>('role-preset-application', key)
        if (!application) throw new CoreError('INCOMPLETE_STATE', 'The committed preset application is missing its role revision.')
        return { application }
      }
      await this.rolePresets.assertCurrent(tx, entry.id, entry.revision)
      const view = await this.roleConfig.write(tx, prepared.expectedRevision, prepared.roles)
      const application: RolePresetApplication = { instanceId: this.instanceId, commandId: command.commandId,
        sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId, presetId: entry.id,
        presetRevision: entry.revision, targetRole: command.targetRole, revision: view.revision, appliedAt: Date.now() }
      await tx.insert('role-preset-application', key, application)
      await tx.insert('work-command', key, { fingerprint, revision: view.revision })
      return { application, view }
    })
    if (result.view) {
      this.roleConfigRevision = result.view.revision
      this.applyRoleRoutes(result.view)
    } else await this.getRoleConfig()
    return result.application
  }

  async getRolePresetApplication(request: { instanceId: string; commandId: string }) {
    this.assertPresetAccess(request?.instanceId)
    if (!request || Object.keys(request).some(key => !['instanceId', 'commandId'].includes(key))) throw new CoreError('INVALID_INPUT', 'A preset application query needs a command ID.')
    identifier(request.commandId, 'commandId')
    const application = await this.storage.transaction(this.instanceId,
      tx => tx.get<RolePresetApplication>('role-preset-application', this.commandKey(request.commandId)))
    if (application) await this.getRoleConfig()
    return application
  }

  async listRolePresetApplications(request: { instanceId: string; after?: string; limit?: number }) {
    this.assertPresetAccess(request?.instanceId)
    if (!request || Object.keys(request).some(key => !['instanceId', 'after', 'limit'].includes(key))) throw new CoreError('INVALID_INPUT', 'Invalid preset application query.')
    if (request.after !== undefined) identifier(request.after, 'after')
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'A page limit from 1 to 100 is required.')
    return this.storage.transaction(this.instanceId, async tx => {
      const found = await tx.scan<RolePresetApplication>('role-preset-application', { limit, ...(request.after ? { after: request.after } : {}) })
      return { items: found.items.map(item => item.value), ...(found.cursor ? { cursor: found.cursor } : {}) }
    })
  }

  async getIntakePolicy(): Promise<{ revision: number; policy: Omit<IntakePolicy, 'assess'>; processingPaused: boolean }> {
    await this.ensurePolicy()
    const stored = await this.storage.transaction(this.instanceId, transaction => transaction.get<StoredPolicy>('policy-state', this.policyKey()))
    if (!stored) throw new CoreError('INCOMPLETE_STATE', 'The current Policy snapshot is missing.')
    return { revision: stored.revision, policy: structuredClone(stored.configuration), processingPaused: this.processingPaused }
  }

  /** Bind one tracked P/R delivery condition to a Ticket; a ready report does not finish while it is open. */
  async bindDeliveryCondition(command: { commandId: string; ticketId: string; kind: 'pr'; sourceInstanceId: string; repo: string; number: number; basis: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'kind', 'sourceInstanceId', 'repo', 'number', 'basis'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Binding a delivery condition accepts commandId, ticketId, kind, sourceInstanceId, repo, number and basis only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId) && !this.source.intake?.allowedRequesterIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot bind a delivery condition.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['bind-delivery-condition-v1', command.ticketId, command.sourceInstanceId, command.repo, command.number, command.basis])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; conditionId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The delivery-condition command was reused for different input.')
        return tx.get<DeliveryCondition>('delivery-condition', existing.conditionId)
      }
      const work = await this.readWork(tx, command.ticketId)
      if (!work) throw new CoreError('NOT_FOUND', 'The delivery-condition Ticket does not exist.')
      if (work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The delivery-condition Ticket belongs to another source instance.')
      const condition = await this.deliveryState.bindCondition(tx, { ...command, createdBy: this.source.actorId, basis: command.basis })
      await tx.insert('work-command', commandKey, { fingerprint, conditionId: condition.id })
      return condition
    })
  }

  async getDeliveryConditions(ticketId: string): Promise<DeliveryCondition[]> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, tx => this.deliveryState.list(tx, ticketId))
  }

  /** Reconcile a P/R delivery condition from an already received source event. */
  async reconcileDeliveryCondition(command: { commandId: string; ticketId: string; sourceInstanceId: string; text: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'sourceInstanceId', 'text'].includes(key))) throw new CoreError('INVALID_INPUT', 'Reconciling accepts commandId, ticketId, sourceInstanceId and text only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile delivery conditions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['reconcile-delivery-condition-v1', command.ticketId, command.sourceInstanceId, command.text])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The reconcile command was reused for different input.')
        return this.deliveryState.list(tx, command.ticketId)
      }
      const conditions = await this.deliveryState.reconcileFromSource(tx, command.ticketId, { sourceInstanceId: command.sourceInstanceId, text: command.text })
      if (conditions && !conditions.some(condition => condition.state === 'open' || condition.state === 'draft')) {
        const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
        const result = await tx.get<Delivery>('delivery', `${command.ticketId}:result`)
        const delivered = result ? await this.deliveries.view(tx, result) : undefined
        const pendingInputs = await this.inputs.pendingInputsForTicket(tx, command.ticketId)
        // A resolved delivery condition ends a ready Ticket only after its result reached the channel.
        if (ticket?.state === 'open' && !ticket.constraint && delivered?.state === 'sent' && pendingInputs.length === 0) {
          await tx.replace('ticket', command.ticketId, { ...ticket, state: 'ended' })
        }
      }
      await tx.insert('work-command', commandKey, { fingerprint })
      return conditions
    })
  }

  /** Record an authorized result destination change, with its evidence, for one Ticket. */
  async setDeliveryTarget(command: { commandId: string; ticketId: string; purpose: 'result' | 'answer'; sourceInstanceId: string; actorId: string; threadId: string; objectId: string; evidence: string; evidenceEventId?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'purpose', 'sourceInstanceId', 'actorId', 'threadId', 'objectId', 'evidence', 'evidenceEventId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A delivery-target change accepts commandId, ticketId, purpose, sourceInstanceId, actorId, threadId, objectId, evidence and optional evidenceEventId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.actorId, 'actorId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only a trusted actor may change a delivery destination.')
    const commandKey = this.commandKey(command.commandId)
    if (command.evidenceEventId !== undefined) identifier(command.evidenceEventId, 'evidenceEventId')
    const fingerprint = createHash('sha256').update(canonicalJson(['delivery-target-v2', command.ticketId, command.purpose, command.sourceInstanceId,
      command.actorId, command.threadId, command.objectId, command.evidence, command.evidenceEventId ?? null])).digest('hex')
    const target = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The delivery-target command was reused for different input.')
        return this.deliveryState.target(tx, command.ticketId, command.purpose)
      }
      const work = await this.readWork(tx, command.ticketId)
      if (!work) throw new CoreError('NOT_FOUND', 'The delivery-target Ticket does not exist.')
      if (work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The delivery-target Ticket belongs to another source instance.')
      const foreign = command.sourceInstanceId !== work.trigger.source.sourceInstanceId
      const requiresEvidence = foreign || this.source.versionOrder !== undefined
      if (requiresEvidence && !command.evidenceEventId) {
        throw new CoreError('ASSOCIATION_REQUIRED', 'A result target change requires a current authorized native follow-up event.')
      }
      if (command.evidenceEventId) {
        const evidence = await tx.get<SourceEvent>('source-event', command.evidenceEventId)
        if (!evidence) throw new CoreError('INVALID_INPUT', 'The named delivery-target evidence event does not exist.')
        if (evidence.source.sourceInstanceId !== command.sourceInstanceId || evidence.threadId !== command.threadId || evidence.objectId !== command.objectId) {
          throw new CoreError('DESTINATION_MISMATCH', 'The evidence event does not belong to the named delivery target.')
        }
        if (evidence.authorId !== command.actorId) throw new CoreError('ACTOR_MISMATCH', 'The delivery target actor must be the exact evidence author.')
        if (!await isCurrentSourceEvent(tx, evidence)) throw new CoreError('SOURCE_NOT_CURRENT', 'The target follow-up is no longer current.')
        const evidencePolicy = await tx.get<StoredPolicy>('policy-state', JSON.stringify(['policy-state', evidence.source.sourceInstanceId]))
        if (evidencePolicy && !evidencePolicy.configuration.allowedRequesterIds.includes(evidence.authorId)) {
          throw new CoreError('ACTOR_NOT_ALLOWED', 'The target follow-up actor is no longer authorized.')
        }
        if (foreign) {
          const input = await associatedInput(tx, command.ticketId, evidence)
          if (!input || input.association?.ownerSourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('ASSOCIATION_REQUIRED', 'The external event has not been legally associated with this Ticket.')
        }
      }
      const target = await this.deliveryState.setTarget(tx, { ...command, authorizedBy: this.source.actorId })
      await tx.insert('work-command', commandKey, { fingerprint })
      return target
    })
    return target
  }

  async getDeliveryTarget(ticketId: string, purpose: 'result' | 'answer'): Promise<DeliveryTarget | undefined> {
    await this.ensurePolicy()
    identifier(ticketId, 'ticketId')
    await this.assertTicketReadable(ticketId)
    return this.storage.transaction(this.instanceId, tx => this.deliveryState.target(tx, ticketId, purpose))
  }

  async getProactiveRules(): Promise<{ revision: number; rules: ProactiveRule[] }> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading rules.')
    return this.proactive.rules()
  }

  /** Only the trusted product Router calls this after a real prepared run; the model supplies no scope or source. */
  async admitProactiveWork(runId: string, environment: ExecutionEnvironment): Promise<Receipt> {
    if (!this.proactive || !this.execution || !this.proactiveSourceAvailable) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Proactive work needs an authorized product runtime.')
    identifier(runId, 'proactive run ID')
    await this.assertHostAdmission()
    const commandId = `proactive-ticket:${runId}`
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const { run, rule, event } = await this.proactive!.assertPreparedIn(tx, runId)
      if (run.sourceInstanceId === this.source.sourceInstanceId || !this.proactiveSourceAvailable!(run.sourceInstanceId, event.source.actorId)
        || environment.kind !== 'local' || environment.config.instanceId !== this.instanceId
        || environment.config.root !== run.isolatedDirectory || !environment.config.allowedActorIds.includes(this.source.actorId)
        || environment.config.permissions.some(permission => !['read', 'write', 'search'].includes(permission))
        || environment.config.allowShell || Object.keys(environment.config.commands).length) {
        throw new CoreError('ENVIRONMENT_DENIED', 'A proactive Ticket needs the exact isolated read/write/search directory.')
      }
      if (await this.inputs.owns(tx, event)) throw new CoreError('WORK_ALREADY_OWNED', 'An existing Ticket owns this source event.')
      const sourceWork = await tx.get<{ runId: string; ticketId: string }>('proactive-work-source', run.eventId)
      if (sourceWork && sourceWork.runId !== runId) throw new CoreError('WORK_ALREADY_OWNED', 'A source event already has a proactive Ticket.')
      const scope = rule.scope ?? 'Review evidence in the isolated directory only.'
      const text = `Standing rule: ${rule.name}\nScope: ${scope}\nVerified source: ${run.sourceInstanceId} / ${run.eventId}\nSource body (untrusted):\n${run.text}\nPrepared review (not a completed Ticket):\n${run.summary}\nEvidence: ${run.evidence ?? 'See the verified preparation artifacts.'}`
      if (Buffer.byteLength(text) > 32768) throw new CoreError('INVALID_INPUT', 'The bounded proactive work request exceeds its text budget.')
      const source: Source = { kind: 'desktop', sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId }
      const trigger: Work['trigger'] = { id: JSON.stringify([this.instanceId, 'proactive', runId]), instanceId: this.instanceId,
        source, eventId: run.eventId, text, environmentId: environment.config.id, target: 'local-only', targetSource: 'ticket',
        proactive: { runId, sourceInstanceId: run.sourceInstanceId, sourceEventId: event.id, ruleRevision: run.ruleRevision,
          maxArtifactBytes: rule.budget.maxArtifactBytes ?? 5 * 1024 * 1024 } }
      const fingerprint = `sha256:proactive-ticket-v1:${createHash('sha256').update(canonicalJson([trigger, scope])).digest('hex')}`
      const prior = await tx.get<CommandRecord>('command', commandId)
      if (prior) return this.replay(prior, fingerprint, 'command')
      const link = await tx.get<ProactiveWorkRecord>('proactive-work', runId)
      if (link?.status !== 'routing' || link.sourceInstanceId !== run.sourceInstanceId || link.eventId !== run.eventId) {
        throw new CoreError('PROACTIVE_REVOKED', 'The proactive routing intent is no longer current.')
      }
      const receipt = await this.accept(tx, commandId, trigger, fingerprint, { strength: 'inferred',
        policyVersion: `proactive-rule:${rule.id}:${run.ruleRevision}`, mandateScope: scope, proactive: true,
        linkTicket: async (transaction, accepted) => {
          await transaction.replace('proactive-work', runId, { ...link, status: 'accepted', ticketId: accepted.ticketId, updatedAt: Date.now() })
          await transaction.insert('proactive-work-source', run.eventId, { runId, ticketId: accepted.ticketId })
        } })
      return receipt
    })
  }

  private get proactiveSourceAvailable() { return this.proactiveOptions?.sourceAvailable }

  async assertProactiveWorkCurrent(runId: string) {
    if (!this.proactive || !this.proactiveSourceAvailable) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Proactive work is unavailable.')
    return this.storage.transaction(this.instanceId, async tx => {
      const current = await this.proactive!.assertPreparedIn(tx, runId)
      if (!this.proactiveSourceAvailable!(current.run.sourceInstanceId, current.event.source.actorId)) throw new CoreError('SOURCE_STOPPED', 'The original source is stopped.')
      return current
    })
  }

  async registerProactiveEnvironment(runId: string, environment: ExecutionEnvironment) {
    const run = await this.getProactiveRun(runId)
    if (!run?.isolatedDirectory || environment.kind !== 'local' || environment.config.root !== run.isolatedDirectory
      || environment.config.instanceId !== this.instanceId || !environment.config.allowedActorIds.includes(this.source.actorId)
      || environment.config.permissions.some(permission => !['read', 'write', 'search'].includes(permission))
      || environment.config.allowShell || Object.keys(environment.config.commands).length) {
      throw new CoreError('ENVIRONMENT_DENIED', 'The proactive Environment does not match its isolated run.')
    }
    const existing = this.environments.find(item => item.config.id === environment.config.id)
    if (existing && existing.config.root !== environment.config.root) throw new CoreError('ENVIRONMENT_DENIED', 'The isolated Environment ID already belongs to another directory.')
    if (!existing) this.environments.push(environment)
  }

  async recordProactiveRouterUse(sessionId: string) {
    const config = await this.roleConfig.currentView()
    await this.storage.transaction(this.instanceId, tx => this.roleConfig.recordUse(tx, { sessionId, role: 'router', revision: config.revision,
      ...(config.roles.main ? { main: config.roles.main.model } : {}), router: config.roles.router.model, worker: config.roles.worker.model }))
    return config
  }

  async getProactiveControl() {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading controls.')
    return this.proactive.control()
  }

  async setProactivePaused(command: { commandId: string; paused: boolean }) {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before pausing.')
    this.assertAuthoringActor()
    return this.proactive.setPaused(command)
  }

  async updateProactiveRules(command: { commandId: string; expectedRevision: number; rules: ProactiveRule[] }): Promise<{ revision: number; rules: ProactiveRule[] }> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before saving rules.')
    this.assertAuthoringActor()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'rules'].includes(key))) throw new CoreError('INVALID_INPUT', 'A proactive rule update accepts commandId, expectedRevision and rules only.')
    identifier(command.commandId, 'commandId')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['proactive-rules-v1', command.expectedRevision, command.rules])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; saved: { revision: number; rules: ProactiveRule[] } }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The proactive rule command was reused with different input.')
        return prior.saved
      }
      const rules = await this.proactive!.setRules(tx, command.expectedRevision, command.rules)
      await tx.insert('work-command', commandKey, { fingerprint, saved: rules })
      return rules
    })
  }

  async evaluateProactive(candidate: ProactiveCandidate): Promise<ProactiveRun[]> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before evaluating candidates.')
    if (this.processingPaused) return []
    const verified = await this.storage.transaction(this.instanceId, async tx => {
      const event = await tx.get<SourceEvent>('source-event', candidate.eventId)
      if (!event || event.type === 'deleted' || event.text === undefined) return false
      if (event.source.sourceInstanceId !== candidate.sourceInstanceId || event.threadId !== candidate.threadId
        || event.objectId !== candidate.objectId || event.text !== candidate.text || event.authorId !== candidate.authorId
        || event.authorKind !== candidate.authorKind || event.addressing !== candidate.addressing) return false
      const current = await this.sourceEvents.candidate(tx, { threadId: candidate.threadId, objectId: candidate.objectId })
      return current?.id === candidate.eventId
    })
    if (!verified) throw new CoreError('SOURCE_NOT_CURRENT', 'A proactive candidate must be the current recorded source event.')
    return this.proactive.evaluate(candidate)
  }

  async listProactiveRuns(ruleId?: string): Promise<ProactiveRun[]> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading runs.')
    return this.proactive.listRuns(ruleId)
  }

  async getRecentProactiveNotices(): Promise<ProactiveRun[]> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading notices.')
    return this.proactive.recentNotices()
  }

  async getProactiveRun(runId: string): Promise<ProactiveRun | undefined> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading runs.')
    return this.proactive.getRun(runId)
  }

  async readProactiveArtifact(runId: string, path: string, offset?: number, maxBytes?: number) {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading artifacts.')
    return this.proactive.readArtifact(runId, path, offset, maxBytes)
  }

  async stopProactiveRun(command: { commandId: string; runId: string; reason: string }): Promise<ProactiveRun> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before stopping runs.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot stop a preparation.')
    return this.proactive.stop(command)
  }

  async assertProactiveRunCurrent(candidate: ProactiveCandidate, revision: number, runId: string) {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before preparing runs.')
    return this.proactive.assertCurrent(candidate, revision, runId)
  }

  async recoverProactiveRuns() {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before recovering runs.')
    return this.proactive.recoverInterrupted()
  }

  async reconcileProactiveCandidates() {
    if (!this.proactive) return 0
    const candidates = await this.proactive.pending(this.source.sourceInstanceId)
    for (const pending of candidates) {
      await this.proactive.evaluate(pending.candidate, pending.ruleRevision, pending.controlRevision)
      await this.proactive.completePending(pending.id)
    }
    return candidates.length
  }

  async discardProactiveCandidates() {
    return this.proactive?.discardPending(this.source.sourceInstanceId)
  }


  abortProactiveRuns() { this.proactive?.abortActive() }

  async getSourceMembers(): Promise<MembershipSnapshot | undefined> {
    return this.membership.get()
  }

  async syncSourceMembers(command: { commandId: string; revision: number; members: SourceMember[]; origin: 'startup' | 'manual' }): Promise<MembershipSnapshot> {
    if (!command || Object.keys(command).some(key => !['commandId', 'revision', 'members', 'origin'].includes(key))) throw new CoreError('INVALID_INPUT', 'A member sync accepts commandId, revision, members and origin only.')
    identifier(command.commandId, 'commandId')
    if (command.origin !== 'startup' && command.origin !== 'manual') throw new CoreError('INVALID_INPUT', 'A member sync origin is startup or manual.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['membership-sync-v1', command.revision, command.origin, command.members])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The member-sync command was reused with different input.')
        const snapshot = await tx.get<MembershipSnapshot>('source-members', JSON.stringify(['source-members', this.source.sourceInstanceId]))
        if (!snapshot) throw new CoreError('INCOMPLETE_STATE', 'The member snapshot is missing.')
        return snapshot
      }
      await this.membership.sync(tx, command)
      const snapshot = await tx.get<MembershipSnapshot>('source-members', JSON.stringify(['source-members', this.source.sourceInstanceId]))
      if (!snapshot) throw new CoreError('INCOMPLETE_STATE', 'The member snapshot was not stored.')
      await tx.insert('work-command', commandKey, { fingerprint, revision: snapshot.revision })
      return snapshot
    })
  }

  async getSupervision(options: { includeHistory?: boolean; cursor?: string; pageLimit?: number; durableCursor?: boolean } = {}) {
    const tickets: Work[] = []
    let cursor = options.cursor
    let hasMore = false
    let nextCursor: string | undefined
    const pageLimit = boundedInteger(options.pageLimit, 10, 1, 10, 'pageLimit')
    for (let pageCount = 0; pageCount < pageLimit; pageCount++) {
      const page = await this.listTickets(cursor, options.durableCursor === true)
      tickets.push(...page.items)
      if (!page.hasMore) { hasMore = false; nextCursor = undefined; break }
      if (!page.nextCursor) throw new CoreError('INCOMPLETE_STATE', 'The supervision Ticket page is missing its cursor.')
      hasMore = true
      nextCursor = page.nextCursor
      cursor = page.nextCursor
    }
    const proposedSupervision = (await listSupervisorProposals(this.storage, this.instanceId)).filter(proposal => proposal.status === 'proposed')
    const proposalsByTicket = new Map<string, SupervisorProposal[]>()
    for (const proposal of proposedSupervision) proposalsByTicket.set(proposal.ticketId, [...(proposalsByTicket.get(proposal.ticketId) ?? []), proposal])
    const items = [] as Record<string, unknown>[]
    const counts = { needsHuman: 0, blocked: 0, stopped: 0, ready: 0, running: 0, ended: 0, pending: 0 }
    for (const work of tickets) {
      const conversation = this.execution ? await this.execution.conversation(work.ticket.id) : undefined
      const unknownEffects = (await this.effects.listByScope(work.ticket.id)).filter(effect => effect.state === 'unknown')
      const unknownJobs = (conversation?.jobs ?? []).filter(job => job.state === 'unknown')
      const waiting = conversation?.attention?.status === 'waiting'
      const stop = conversation?.stop
      const setup = conversation?.setup
      let bucket: keyof typeof counts = 'pending'
      let priority = 8
      let nextAction = 'Review the accepted request and wait for a Worker assignment.'
      if (waiting) { bucket = 'needsHuman'; priority = 0; nextAction = 'Answer the current question. Other Tickets can continue while this one waits.' }
      else if (unknownEffects.length || unknownJobs.length) {
        bucket = 'blocked'; priority = 1
        nextAction = 'Reconcile the affected external action or job by its original ID before retrying; unrelated work can continue.'
      } else if (setup?.state === 'failed') { bucket = 'blocked'; priority = 2; nextAction = 'Recheck the original working directory and retry setup.' }
      else if (stop?.state === 'stopping') {
        bucket = 'stopped'; priority = 3; nextAction = 'Wait for confirmed cancellation of the original execution range; resume is blocked.'
      } else if (stop) { bucket = 'stopped'; priority = 4; nextAction = 'The Ticket is stopped. Resume only with an explicit authorized command after cancellation is confirmed.' }
      else if (conversation?.status === 'ready') { bucket = 'ready'; priority = 5; nextAction = 'Review the current report and its evidence.' }
      else if (conversation?.status === 'running' || conversation?.status === 'pending') {
        bucket = conversation.status === 'running' ? 'running' : 'pending'
        priority = conversation.status === 'running' ? 6 : 8
        nextAction = conversation.status === 'running' ? 'Inspect the active Assignment or wait for its next evidence event.' : 'The Ticket is queued; inspect its slot and intent reason.'
      } else if (work.ticket.state === 'ended') { bucket = 'ended'; priority = 7; nextAction = 'The Ticket is closed. An authorized human follow-up can reopen it.' }
      if (bucket in counts) counts[bucket]++
      items.push({ ticketId: work.ticket.id, request: work.trigger.text, bucket, priority,
        state: conversation?.status ?? work.intent.state, reason: conversation?.reason ?? work.intent.reason,
        lifecycle: work.ticket.state, nextAction,
        why: { triggerId: work.trigger.id, decisionId: work.decision.id, mandateId: work.mandate.id,
          ...(conversation?.assignments[0] ? { assignmentId: conversation.assignments[0].id, generation: conversation.assignments[0].generation } : {}),
          ...(conversation?.reports[0] ? { reportId: conversation.reports[0].id } : {}),
          ...(conversation?.attention ? { attentionId: conversation.attention.id } : {}),
          ...(conversation?.stop ? { stopId: conversation.stop.id } : {}) },
        health: { source: 'nominal', effectsUnknown: unknownEffects.length, jobsUnknown: unknownJobs.length,
          ...(setup ? { setup: setup.state } : {}), ...(conversation?.slot ? { slot: conversation.slot } : {}),
          attention: conversation?.attention?.status ?? 'none', stop: conversation?.stop?.state ?? 'none' },
        ...(conversation?.attention ? { attention: conversation.attention } : {}),
        ...(conversation?.stop ? { stop: conversation.stop } : {}),
        ...(setup ? { setup } : {}),
        ...(conversation?.assignments[0] ? { assignment: conversation.assignments[0] } : {}),
        messages: conversation?.messages ?? [],
        reports: conversation?.reports ?? [],
        ...(options.includeHistory ? { attentionHistory: conversation?.attentionHistory ?? [], reportHistory: conversation?.reportHistory ?? [] } : {}),
        ...(proposalsByTicket.has(work.ticket.id) ? { supervisorProposals: proposalsByTicket.get(work.ticket.id) } : {}),
        jobs: conversation?.jobs ?? [], subagents: conversation?.subagents ?? [] })
    }
    items.sort((left, right) => Number(left.priority) - Number(right.priority) || String(left.ticketId).localeCompare(String(right.ticketId)))
    return { items, counts, hasMore, ...(nextCursor ? { nextCursor } : {}), roleConfigRevision: this.roleConfigRevision, processingPaused: this.processingPaused }
  }

  async countSupervisionTickets(): Promise<number> {
    return this.storage.transaction(this.instanceId, async tx => {
      let count = 0
      let cursor: string | undefined
      do {
        const page = await tx.scan<Work['ticket']>('ticket', { limit: 100, ...(cursor ? { after: cursor } : {}) })
        for (const { value } of page.items) {
          const trigger = await tx.get<Work['trigger']>('trigger', value.triggerId)
          if (!trigger) throw new CoreError('INCOMPLETE_STATE', 'A supervision Ticket has no source identity.')
          if (this.canReadTicket(trigger)) count++
        }
        cursor = page.cursor
      } while (cursor)
      return count
    })
  }

  private applyRoleRoutes(config: RoleConfigView) {
    if (config.roles.main) this.sessions?.setMainProfile(config.roles.main)
    this.sessions?.setRoutes(config.roles.router.model, config.roles.worker.model)
    this.sessions?.setRoleInstructions(config.roles.router, config.roles.worker)
  }

  getTicket(ticketId: string): Promise<Work | undefined> {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async tx => {
      await this.assertTicketReadableIn(tx, ticketId)
      return this.readWork(tx, ticketId)
    })
  }

  getInstanceId() { return this.instanceId }

  /** Client access shares this Engine's Host-fenced storage and Instance identity. */
  createClientAccess(now: () => number = Date.now) { return ClientAccess.forEngine(this, this.storage, this.instanceId, now) }

  /** The semantic supervisor reads the same Host-fenced facts and only writes proposals; decisions run separately. */
  createSupervisor(options: Omit<SupervisorOptions, 'engine' | 'storage' | 'instanceId' | 'actorId'> = {}) {
    const { assess, stallMs, stallObservations, loopObservations, proposalWindowMs, maxProposals, historyLimit, maxPages, version, now } = options
    return new Supervisor({
      engine: this, storage: this.storage, instanceId: this.instanceId, actorId: this.source.actorId,
      ...(assess === undefined ? {} : { assess }), ...(stallMs === undefined ? {} : { stallMs }),
      ...(stallObservations === undefined ? {} : { stallObservations }), ...(loopObservations === undefined ? {} : { loopObservations }),
      ...(proposalWindowMs === undefined ? {} : { proposalWindowMs }), ...(maxProposals === undefined ? {} : { maxProposals }),
      ...(historyLimit === undefined ? {} : { historyLimit }), version: version ?? `supervisor-r${String(this.roleConfigRevision)}`,
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(now === undefined ? {} : { now }),
    })
  }

  getSupervisorProposals(ticketId?: string) { return listSupervisorProposals(this.storage, this.instanceId, ticketId) }

  getSupervisorState(ticketId: string) { return this.createSupervisor().getState(ticketId) }

  private async mainSupervisorTicket(ticketId: string) {
    identifier(ticketId, 'ticketId')
    const index = await this.storage.transaction(this.instanceId,
      tx => tx.get<{ workItemId: string }>('work-ticket', ticketId))
    if (!index) throw new CoreError('NOT_FOUND', 'This proposal does not belong to an established Main work card.')
    await this.requireMainWorkControl({ instanceId: this.instanceId, workItemId: index.workItemId, ticketId })
  }

  async getMainSupervisorProposals(request: { instanceId: string; ticketId?: string }) {
    if (request.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The supervision history belongs to another Instance.')
    if (request.ticketId !== undefined) await this.mainSupervisorTicket(request.ticketId)
    const proposals = await this.getSupervisorProposals(request.ticketId)
    const visible: SupervisorProposal[] = []
    for (const proposal of proposals) {
      try { await this.mainSupervisorTicket(proposal.ticketId); visible.push(proposal) }
      catch (error) {
        if (!(error instanceof CoreError) || !['NOT_FOUND', 'SOURCE_NOT_AUTHORIZED'].includes(error.code)) throw error
      }
    }
    return visible
  }

  async getMainSupervisorState(request: { instanceId: string; ticketId: string }) {
    if (request.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The supervision history belongs to another Instance.')
    await this.mainSupervisorTicket(request.ticketId)
    return this.getSupervisorState(request.ticketId)
  }

  async decideSupervisorProposal(command: { instanceId: string; commandId: string; proposalId: string;
    decision: 'approve' | 'reject'; fingerprint: string; reason?: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'proposalId', 'decision', 'fingerprint', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A supervision decision needs its proposal, fingerprint and choice.')
    }
    this.requireProductScheduleActor()
    if (command.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The proposal belongs to another Instance.')
    identifier(command.commandId, 'commandId'); identifier(command.proposalId, 'proposalId')
    const proposal = await this.createSupervisor().getProposal(command.proposalId)
    if (!proposal || proposal.instanceId !== this.instanceId) throw new CoreError('PROPOSAL_NOT_FOUND', 'The proposal does not exist.')
    if (proposal.fingerprint !== command.fingerprint) throw new CoreError('PROPOSAL_STALE', 'The proposal evidence changed; reload the current proposal.')
    if (!proposal.evidence.snapshot.assignmentId || !proposal.evidence.snapshot.generation
      || !Number.isSafeInteger(proposal.evidence.snapshot.directionVersion) || proposal.evidence.snapshot.stage !== 'running') {
      throw new CoreError('PROPOSAL_STALE', 'A supervision decision requires a current running Assignment and Ticket version.')
    }
    await this.mainSupervisorTicket(proposal.ticketId)
    return this.createSupervisor().decide({ commandId: command.commandId, proposalId: command.proposalId,
      decision: command.decision, ...(command.reason === undefined ? {} : { reason: command.reason }) })
  }

  async getTicketDirection(ticketId: string): Promise<TicketDirection | undefined> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    return this.inputs.direction(ticketId)
  }

  /** Stops every managed background process range and releases this Host's lease. */
  async shutdown() {
    try { await this.main.close(); await this.execution?.shutdown() }
    finally { await this.host.release().catch(() => {}) }
  }

  async listSlots(): Promise<SlotSnapshot> {
    await this.ensurePolicy()
    if (!this.slots) throw new CoreError('WORKER_NOT_ENABLED', 'Slot budgets require a configured native runtime.')
    return this.slots.list()
  }

  /** Background jobs of one Ticket: start facts, confirmed exit and bounded retained output. */
  async listJobs(ticketId: string): Promise<JobView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    return this.execution.listJobs(ticketId)
  }

  /** Subtasks one Ticket delegated, with their state and bounded result. */
  async listSubagents(ticketId: string): Promise<SubagentView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    return this.execution.listSubagents(ticketId)
  }

  async getSubagent(ticketId: string, subagentId: string) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    return this.execution.getSubagent(ticketId, subagentId)
  }

  async cancelSubagent(command: { commandId: string; ticketId: string; subagentId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a subagent requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'subagentId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a subagent accepts commandId, ticketId, subagentId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.subagentId, 'subagentId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a subagent.')
    return this.execution.cancelSubagent({ ...command, actorId: this.source.actorId })
  }

  async getJob(ticketId: string, jobId: string): Promise<JobView> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    return this.execution.getJob(ticketId, jobId)
  }

  async listPreviews(ticketId: string): Promise<PreviewView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.execution.listPreviews(ticketId)
  }

  async getPreview(ticketId: string, previewId: string): Promise<PreviewView> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.execution.getPreview(ticketId, previewId)
  }

  async cancelPreview(command: { commandId: string; ticketId: string; previewId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a preview requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'previewId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a preview accepts commandId, ticketId, previewId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a preview.')
    return this.execution.cancelPreview({ ...command, actorId: this.source.actorId })
  }

  async resolvePreview(command: { commandId: string; ticketId: string; previewId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Resolving a preview requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'previewId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Resolving a preview accepts commandId, ticketId, previewId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot resolve a preview.')
    return this.execution.resolvePreview({ ...command, actorId: this.source.actorId })
  }

  async cancelJob(command: { commandId: string; ticketId: string; jobId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a background job requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'jobId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a background job accepts commandId, ticketId, jobId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.jobId, 'jobId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a background job.')
    return this.execution.cancelJob({ ...command, actorId: this.source.actorId })
  }

  /**
   * Asks a Worker that is merely idle (no ready report, no question, no stop) to state its status.
   * It is a bounded command: it only queues for an idle Ticket, and it never clears a stop or a waiting question.
   */
  async requestStatus(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Requesting status requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'A status request accepts commandId and ticketId only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot request status.')
    return this.execution.requestStatus({ ...command, actorId: this.source.actorId })
  }

  async getTicketAttention(ticketId: string) {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async tx => {
      const current = await this.attentions.current(tx, ticketId)
      const history = await this.attentions.history(tx, ticketId)
      return { current, history }
    })
  }

  async getTicketDeliveries(ticketId: string): Promise<DeliveryView[]> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, tx => this.deliveries.list(tx, ticketId))
  }

  /** Reconcile one unknown delivery through its original Effect generation and idempotency key. */
  async reconcileDelivery(command: { commandId: string; ticketId: string; deliveryId: string }): Promise<DeliveryView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'deliveryId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Delivery reconciliation accepts commandId, ticketId and deliveryId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.deliveryId, 'deliveryId')
    await this.assertTicketReadable(command.ticketId)
    const initial = await this.storage.transaction(this.instanceId, async tx => {
      const delivery = await this.deliveries.get(tx, command.deliveryId)
      return delivery ? { delivery, view: await this.deliveries.view(tx, delivery) } : undefined
    })
    if (!initial || initial.delivery.ticketId !== command.ticketId) throw new CoreError('NOT_FOUND', 'The delivery does not belong to this Ticket.')
    const delivery = initial.delivery
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['delivery-reconcile-v1', command.ticketId, command.deliveryId])).digest('hex')
    const begun = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; state: 'running' | 'failed' | 'completed'; attempt: number }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The delivery reconciliation command was reused for different input.')
        if (prior.state === 'completed') return { replayed: true }
      }
      const attempt = (prior?.attempt ?? 0) + 1
      const next = { fingerprint, ticketId: command.ticketId, deliveryId: command.deliveryId, state: 'running' as const, attempt }
      if (prior) await tx.replace('work-command', key, next)
      else await tx.insert('work-command', key, next)
      return { replayed: false }
    })
    const currentView = () => this.storage.transaction(this.instanceId, async tx => {
      const current = await this.deliveries.get(tx, command.deliveryId)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The reconciled delivery record disappeared.')
      return this.deliveries.view(tx, current)
    })
    if (begun.replayed) return currentView()
    let view: DeliveryView
    try {
      await this.effects.reconcile(delivery.effectId, delivery.effectGeneration,
        { allowPending: initial.view.state === 'pending' && (initial.view.attempts ?? 0) > 0 })
      view = await currentView()
    } catch (error) {
      await commandTransaction(this.storage, this.instanceId, async tx => {
        const prior = await tx.get<{ fingerprint: string; state: 'running' | 'failed' | 'completed'; attempt: number }>('work-command', key)
        if (prior?.fingerprint === fingerprint && prior.state === 'running') {
          await tx.replace('work-command', key, { ...prior, state: 'failed',
            reason: error instanceof Error ? error.message.slice(0, 1024) : 'DELIVERY_RECONCILE_FAILED' })
        }
      }).catch(() => {})
      throw error
    }
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; state: 'running' | 'failed' | 'completed'; attempt: number }>('work-command', key)
      if (!prior || prior.fingerprint !== fingerprint) throw new CoreError('INCOMPLETE_STATE', 'The delivery reconciliation receipt disappeared.')
      const terminal = view.state === 'sent' || view.state === 'dropped'
      const next = { ...prior, state: terminal ? 'completed' as const : 'failed' as const,
        ...(terminal ? {} : { reason: view.reason ?? 'DELIVERY_RECONCILE_NOT_CONFIRMED' }) }
      await tx.replace('work-command', key, next)
    })
    return view
  }

  async readContext(request: ContextRequest): Promise<ContextCard> {
    await this.storage.transaction(this.instanceId, async tx => {
      const trigger = await this.triggerFor(tx, request.ticketId)
      if (!this.canReadTicket(trigger)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source reference does not grant access to private Ticket context.')
      }
      if (request.ref?.kind === 'source-event' && request.ref.id) {
        const event = await tx.get<SourceEvent>('source-event', request.ref.id)
        if (event && event.source.sourceInstanceId !== trigger.source.sourceInstanceId) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Cross-source event ownership supplies its Input only; it does not grant Thread history access.')
        }
      }
    })
    return this.context.read(request)
  }

  async findContextCandidates(ticketId: string, text: string, limit?: number): Promise<ContextCandidate[]> {
    const source = await this.storage.transaction(this.instanceId, async tx => {
      const trigger = await this.triggerFor(tx, ticketId)
      if (!this.canReadTicket(trigger)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source reference does not grant private context search.')
      }
      return trigger.source
    })
    const candidates = await this.context.candidates(ticketId, text, limit)
    return this.storage.transaction(this.instanceId, async tx => {
      const permitted: ContextCandidate[] = []
      for (const candidate of candidates) {
        const event = candidate.ref.id ? await tx.get<SourceEvent>('source-event', candidate.ref.id) : undefined
        if (event?.source.sourceInstanceId === source.sourceInstanceId && event.source.kind === source.kind) permitted.push(candidate)
      }
      return permitted
    })
  }

  /** Queues an answer only when it names a current human question and an explicit Worker fact. */
  async queueAnswer(command: { commandId: string; ticketId: string; questionEventId: string; text: string; fact: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'questionEventId', 'text', 'fact'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An answer accepts commandId, ticketId, questionEventId, text and fact only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.questionEventId, 'questionEventId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) throw new CoreError('INVALID_INPUT', 'An answer needs bounded nonempty text.')
    if (typeof command.fact !== 'string' || !command.fact.trim() || Buffer.byteLength(command.fact) > 4096) throw new CoreError('INVALID_INPUT', 'An answer needs an explicit bounded fact.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot answer a source question.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['answer-v1', this.source.sourceInstanceId, this.source.actorId,
      command.ticketId, command.questionEventId, command.text, command.fact])).digest('hex')
    const deliveryId = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; deliveryId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The answer command was reused for different input.')
        return existing.deliveryId
      }
      const question = await tx.get<SourceEvent>('source-event', command.questionEventId)
      if (!question) throw new CoreError('NOT_FOUND', 'The named question does not exist.')
      const association = await associatedInput(tx, command.ticketId, question)
      const foreign = !this.sourceEvents.belongsToSource(question)
      if (foreign) await this.associationOwner(tx, command.ticketId)
      if ((foreign && !association || question.authorKind !== 'human')) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'An answer must name a trusted human question or an exact owner-authorized input.')
      if (!await isCurrentSourceEvent(tx, question)) throw new CoreError('SOURCE_NOT_CURRENT', 'The named question is no longer current.')
      const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
      const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
      if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The answer Ticket does not exist.')
      if (!association && (trigger.source.sourceInstanceId !== question.source.sourceInstanceId || question.threadId !== trigger.threadId)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The question is outside this Ticket’s reachable source scope.')
      }
      const id = `${command.ticketId}:answer:${createHash('sha256').update(question.id).digest('hex')}`
      const destination = { sourceInstanceId: question.source.sourceInstanceId, actorId: question.authorId,
        eventId: question.objectId, ...(question.threadId ? { threadId: question.threadId } : {}) }
      const effect = await this.effects.enqueue(tx, { key: `answer:${question.id}`, stream: 'outbox', scope: command.ticketId,
        payload: { purpose: 'answer', ticketId: command.ticketId, deliveryId: id } })
      await this.deliveries.record(tx, { id, ticketId: command.ticketId, purpose: 'answer', text: command.text, destination,
        basis: { kind: 'human-question', questionEventId: question.id, questionText: question.text ?? '', fact: command.fact },
        effectId: effect.id, effectGeneration: effect.generation }, effect)
      await tx.insert('work-command', commandKey, { fingerprint, deliveryId: id })
      return id
    })
    const delivery = await this.storage.transaction(this.instanceId, tx => this.deliveries.get(tx, deliveryId))
    if (!delivery) throw new CoreError('INCOMPLETE_STATE', 'The queued answer is missing its delivery record.')
    return this.storage.transaction(this.instanceId, tx => this.deliveries.view(tx, delivery))
  }

  async answerAttention(command: { commandId: string; attentionId: string; text?: string; viewAction?: string; viewValues?: Record<string, unknown>; sourceEventId?: string;
    ticketId?: string; expectedGeneration?: string; expectedVersion?: number }, receiver?: Engine,
  requireMainWorkFact = false) {
    await this.ensurePolicy()
    if (receiver) {
      if (!(receiver instanceof Engine) || receiver.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The answer receiver must be a trusted Engine in this Instance.')
      await receiver.ensurePolicy()
    }
    if (!command || Object.keys(command).some(key => !['commandId', 'attentionId', 'text', 'viewAction', 'viewValues', 'sourceEventId', 'ticketId', 'expectedGeneration', 'expectedVersion'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Answering Attention accepts one exact question and bounded answer only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.attentionId, 'attentionId')
    if (command.sourceEventId !== undefined) identifier(command.sourceEventId, 'sourceEventId')
    if (command.ticketId !== undefined) identifier(command.ticketId, 'ticketId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (command.expectedVersion !== undefined && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1)) {
      throw new CoreError('INVALID_INPUT', 'The Attention version must be a positive integer.')
    }
    const viewAnswer = command.viewAction !== undefined || command.viewValues !== undefined
    if (viewAnswer ? typeof command.viewAction !== 'string' || !command.viewAction || command.viewValues === undefined
      : typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) {
      throw new CoreError('INVALID_INPUT', 'An Attention answer needs bounded text or one current view answer.')
    }
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['attention-answer-v2', this.source.sourceInstanceId, this.source.actorId,
      command.attentionId, command.text ?? null, command.viewAction ?? null, command.viewValues ?? null, command.sourceEventId ?? null, command.ticketId ?? null,
      command.expectedGeneration ?? null, command.expectedVersion ?? null,
      ...(receiver ? [receiver.source.sourceInstanceId, receiver.source.actorId] : [])])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; attentionId: string; inputId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Attention answer command was reused for different input.')
        const answered = await tx.get<Attention>('attention', existing.attentionId)
        const input = await this.inputs.getInput(tx, existing.inputId)
        if (!answered || !input) throw new CoreError('INCOMPLETE_STATE', 'The answered Attention is missing its Input.')
        const fact = await this.workDelegation?.recordAttentionAnswerIn(tx, { ticketId: answered.ticketId, attentionId: answered.id,
          attentionVersion: answered.sequence, assignmentId: answered.assignmentId, sessionId: answered.sessionId,
          commandId: command.commandId, actorId: answered.answeredBy!, answer: answered.answerText!,
          answeredAt: answered.answeredAt!, inputId: input.id })
        if (requireMainWorkFact && !fact) throw new CoreError('INCOMPLETE_STATE', 'The Main Attention answer fact is missing.')
        return { attention: answered, input }
      }
      await this.assertHostAdmissionIn(tx)
      const attention = await tx.get<Attention>('attention', command.attentionId)
      if (!attention) throw new CoreError('NOT_FOUND', 'The Attention does not exist.')
      if (command.ticketId !== undefined && command.ticketId !== attention.ticketId) {
        throw new CoreError('ATTENTION_STALE', 'The named work no longer owns this question.')
      }
      const ticket = await tx.get<Work['ticket']>('ticket', attention.ticketId)
      const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
      if (!ticket || !trigger || trigger.source.sourceInstanceId !== this.source.sourceInstanceId
        && trigger.deliveryOrigin?.source.sourceInstanceId !== this.source.sourceInstanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The Attention Ticket belongs to a different source instance.')
      }
      let checkedViewAnswer: { answer: ProductViewAnswer; text: string } | undefined
      if (attention.view) {
        if (!viewAnswer || command.sourceEventId) throw new CoreError('INVALID_INPUT', 'A view card accepts only its validated product answer.')
        checkedViewAnswer = validateProductViewAnswer(attention.view, command.viewAction, command.viewValues)
      } else if (viewAnswer) {
        throw new CoreError('INVALID_INPUT', 'This Attention is not an answerable view card.')
      }
      const managedOrigin = !!trigger.deliveryOrigin
        && attention.destination.sourceInstanceId === trigger.deliveryOrigin.source.sourceInstanceId
        && attention.destination.actorId === trigger.deliveryOrigin.authorId
        && attention.destination.eventId === trigger.deliveryOrigin.eventId
        && attention.destination.threadId === trigger.deliveryOrigin.threadId
      const originTicket = !!trigger.deliveryOrigin && attention.destination.sourceInstanceId === trigger.deliveryOrigin.source.sourceInstanceId
      const foreign = attention.destination.sourceInstanceId !== this.source.sourceInstanceId && !originTicket
      let crossQuestionInput: WorkInput | undefined
      if (foreign) {
        await this.associationOwner(tx, attention.ticketId)
        const question = attention.questionSourceEventId ? await tx.get<SourceEvent>('source-event', attention.questionSourceEventId) : undefined
        const input = question ? await associatedInput(tx, attention.ticketId, question) : undefined
        if (!input || !question || input.association?.ownerSourceInstanceId !== this.source.sourceInstanceId
          || attention.destination.sourceInstanceId !== question.source.sourceInstanceId || attention.destination.actorId !== question.authorId
          || attention.destination.threadId !== question.threadId || attention.destination.eventId !== question.objectId) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source Attention answer needs its exact owner-authorized question provenance.')
        }
        crossQuestionInput = input
      } else if (originTicket && attention.questionSourceEventId) {
        const question = await tx.get<SourceEvent>('source-event', attention.questionSourceEventId)
        const ownerships = await this.inputs.ownershipsForEventInTransaction(tx, attention.questionSourceEventId)
        const ownership = ownerships.find(candidate => candidate.ticketId === attention.ticketId && candidate.state === 'owned')
        const input = ownership ? await this.inputs.getInput(tx, ownership.inputId) : undefined
        if (!question || !input || !await isCurrentSourceEvent(tx, question)
          || question.source.sourceInstanceId !== attention.destination.sourceInstanceId
          || question.authorId !== attention.destination.actorId || question.objectId !== attention.destination.eventId
          || question.threadId !== attention.destination.threadId) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The original-source Attention is no longer backed by an active human Input.')
        }
      }
      const answerers = this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
      let actorId = this.source.actorId
      let answerText = checkedViewAnswer?.text ?? command.text!
      if (command.sourceEventId) {
        const inputSource = receiver ?? this
        const policy = await tx.get<StoredPolicy>('policy-state', inputSource.policyKey())
        if (!receiver && !foreign) {
          const candidate = await tx.get<SourceEvent>('source-event', command.sourceEventId)
          if (candidate && !answerers.includes(candidate.authorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This source actor cannot answer work questions.')
        }
        const event = await inputSource.sourceEvents.associationCandidate(tx, command.sourceEventId,
          policy?.configuration.allowedRequesterIds ?? inputSource.source.intake?.allowedRequesterIds ?? inputSource.source.allowedActorIds)
        if (event.source.sourceInstanceId !== attention.destination.sourceInstanceId || event.threadId !== attention.destination.threadId) throw new CoreError('ANSWER_THREAD_MISMATCH', 'The answer event is outside the question source and Thread.')
        if (event.authorId !== attention.destination.actorId) throw new CoreError('ANSWER_ACTOR_MISMATCH', 'The native answer must come from the actual question recipient.')
        actorId = event.authorId
        answerText = event.text!
      }
      if (!command.sourceEventId && !answerers.includes(actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot answer work questions.')
      if (!foreign && !originTicket && !managedOrigin && actorId !== attention.destination.actorId) throw new CoreError('ANSWER_ACTOR_MISMATCH', 'The current actor does not match the question recipient.')
      const result = await this.attentions.answer(tx, { ticketId: attention.ticketId, attentionId: attention.id, text: answerText,
        commandId: command.commandId, actorId, ...(command.sourceEventId ? { sourceEventId: command.sourceEventId } : {}),
        ...(command.expectedGeneration === undefined ? {} : { expectedGeneration: command.expectedGeneration }),
        ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }),
        ...(checkedViewAnswer ? { viewAnswer: checkedViewAnswer.answer } : {}) })
      if (command.sourceEventId && crossQuestionInput?.association) {
        result.input = { ...result.input, association: { ...crossQuestionInput.association, sourceActorId: actorId,
          reason: `Authorized native answer to ${attention.id}`, checkedAt: Date.now() } }
        await tx.replace('work-input', result.input.id, result.input)
      }
      await tx.insert('work-command', commandKey, { fingerprint, attentionId: result.attention.id, inputId: result.input.id })
      const fact = await this.workDelegation?.recordAttentionAnswerIn(tx, { ticketId: result.attention.ticketId,
        attentionId: result.attention.id, attentionVersion: result.attention.sequence,
        assignmentId: result.attention.assignmentId, sessionId: result.attention.sessionId,
        commandId: command.commandId, actorId: result.attention.answeredBy!, answer: result.attention.answerText!,
        answeredAt: result.attention.answeredAt!, inputId: result.input.id })
      if (requireMainWorkFact && !fact) throw new CoreError('INCOMPLETE_STATE', 'The Main Attention answer fact is missing.')
      return result
    })
  }

  private async requireMainWorkControl(request: { instanceId: string; workItemId: string; ticketId: string }) {
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The work control is outside the authorized Main Instance.')
    }
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Work controls require a configured native runtime.')
    identifier(request.workItemId, 'workItemId')
    identifier(request.ticketId, 'ticketId')
    const binding = await this.main.open({ instanceId: request.instanceId })
    await this.storage.transaction(this.instanceId, async tx => {
      const item = await tx.get<MainWorkItem>('work-item', request.workItemId)
      const brief = item ? await tx.get<import('./work-delegation.js').MainWorkBrief>('work-brief', item.workBriefId) : undefined
      const receipt = await tx.get<import('./work-delegation.js').MainWorkReceipt>('work-receipt', request.workItemId)
      const ticketIndex = await tx.get<{ ticketId: string }>('work-item-ticket', request.workItemId)
      if (!item || !brief || brief.mainId !== binding.mainId || brief.instanceId !== this.instanceId
        || receipt?.status !== 'accepted' || (receipt.ticketId ?? ticketIndex?.ticketId) !== request.ticketId) {
        throw new CoreError('NOT_FOUND', 'The named work card does not match this Main Instance.')
      }
    })
  }

  async prepareMainHandoff(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration: string; targetEnvironmentId: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId',
      'expectedGeneration', 'targetEnvironmentId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Preparing a Main handoff accepts only its exact work card and target.')
    }
    await this.requireMainWorkControl(command)
    return this.prepareHandoffCopy({ commandId: command.commandId, ticketId: command.ticketId,
      targetEnvironmentId: command.targetEnvironmentId, expectedGeneration: command.expectedGeneration })
  }

  async verifyMainHandoff(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId',
      'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Verifying a Main handoff accepts only its exact work card.')
    }
    await this.requireMainWorkControl(command)
    return this.verifyHandoffCopy({ commandId: command.commandId, ticketId: command.ticketId,
      expectedGeneration: command.expectedGeneration })
  }

  async requestMainHandoff(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration: string; targetEnvironmentId: string; reason: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId',
      'expectedGeneration', 'targetEnvironmentId', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Requesting a Main handoff accepts only its exact work card, target and reason.')
    }
    await this.requireMainWorkControl(command)
    return this.requestHandoff({ commandId: command.commandId, ticketId: command.ticketId,
      targetEnvironmentId: command.targetEnvironmentId, reason: command.reason,
      expectedGeneration: command.expectedGeneration })
  }

  async answerMainAttention(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration: string; attentionId: string; attentionVersion: number; text: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration',
      'attentionId', 'attentionVersion', 'text'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Answering a Main work card accepts only its exact current question and text.')
    }
    identifier(command.attentionId, 'attentionId')
    await this.requireMainWorkControl(command)
    const result = await this.answerAttention({
      commandId: command.commandId,
      attentionId: command.attentionId,
      ticketId: command.ticketId,
      expectedGeneration: command.expectedGeneration,
      expectedVersion: command.attentionVersion,
      text: command.text,
    }, undefined, true)
    this.effects.wake()
    return result
  }

  async answerMainView(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration: string; attentionId: string; attentionVersion: number; action: string; values: Record<string, unknown> }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration',
      'attentionId', 'attentionVersion', 'action', 'values'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Answering a Main view accepts only its exact current work and submitted values.')
    }
    identifier(command.action, 'action')
    await this.requireMainWorkControl(command)
    const result = await this.answerAttention({
      commandId: command.commandId,
      attentionId: command.attentionId,
      ticketId: command.ticketId,
      expectedGeneration: command.expectedGeneration,
      expectedVersion: command.attentionVersion,
      viewAction: command.action,
      viewValues: command.values,
    }, undefined, true)
    this.effects.wake()
    return result
  }

  async stopMainWork(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string;
    expectedGeneration?: string; expectedTicketVersion: number; reason: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId',
      'expectedGeneration', 'expectedTicketVersion', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Stopping work accepts only its exact card target and reason.')
    }
    if (!Number.isSafeInteger(command.expectedTicketVersion) || command.expectedTicketVersion < 1) {
      throw new CoreError('INVALID_INPUT', 'Stopping a Main work card needs its exact Ticket version.')
    }
    await this.requireMainWorkControl(command)
    return this.stopTicket({ commandId: command.commandId, ticketId: command.ticketId, reason: command.reason,
      ...(command.expectedGeneration === undefined ? {} : { expectedGeneration: command.expectedGeneration }),
      expectedTicketVersion: command.expectedTicketVersion })
  }

  async reconcileMainStop(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Reconciling a Main stop accepts only its exact work card.')
    }
    await this.requireMainWorkControl(command)
    return this.reconcileStop({ commandId: command.commandId, ticketId: command.ticketId })
  }

  async resumeMainWork(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string; expectedGeneration: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Resuming work accepts only its exact card target.')
    }
    await this.requireMainWorkControl(command)
    return this.resumeTicket({ commandId: command.commandId, ticketId: command.ticketId,
      expectedGeneration: command.expectedGeneration })
  }

  async retryMainWork(command: { instanceId: string; commandId: string; workItemId: string; ticketId: string; expectedGeneration: string; reason: string }) {
    if (!command || Object.keys(command).some(key => !['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Retrying work accepts only its exact card target and reason.')
    }
    await this.requireMainWorkControl(command)
    return this.retryTicket({ commandId: command.commandId, ticketId: command.ticketId, reason: command.reason,
      expectedGeneration: command.expectedGeneration })
  }

  async stopTicket(command: { commandId: string; ticketId: string; reason: string; expectedGeneration?: string;
    expectedTicketVersion?: number }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Stopping work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'reason', 'expectedGeneration', 'expectedTicketVersion'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Stopping work accepts its exact command, Ticket and version only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (command.expectedTicketVersion !== undefined && (!Number.isSafeInteger(command.expectedTicketVersion) || command.expectedTicketVersion < 1)) {
      throw new CoreError('INVALID_INPUT', 'The Ticket card version must be a positive integer.')
    }
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Stopping work needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot stop work.')
    return this.execution.stopTicket({ ...command, actorId: this.source.actorId })
  }

  /** Inspects and cancels a remote stop's original jobs; confirms only ranges the device reports quiet. */
  async reconcileStop(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Reconciling a stop requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Reconciling a stop accepts commandId and ticketId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile a stop.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['reconcile-stop', this.instanceId, command.ticketId])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The reconcile command was reused for different work.')
        return
      }
      await transaction.insert('work-command', key, { fingerprint })
    })
    return this.execution.reconcileRemoteStop(command.ticketId)
  }

  /** Reconciles persisted remote jobs by their original device identity, optionally for one Ticket. */
  async reconcileRemoteWork(command: { commandId: string; ticketId?: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Reconciling remote work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Reconciling remote work accepts commandId and an optional ticketId only.')
    }
    identifier(command.commandId, 'commandId')
    if (command.ticketId !== undefined) identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile remote work.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['reconcile-remote-work', this.instanceId, command.ticketId ?? null])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The remote reconciliation command was reused for different work.')
        return
      }
      await transaction.insert('work-command', key, { fingerprint })
    })
    return this.execution.reconcileRemoteWork(command.ticketId)
  }

  async resumeTicket(command: { commandId: string; ticketId: string; expectedGeneration?: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Resuming work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Resuming work accepts its exact command and Ticket version only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot resume work.')
    return this.execution.resumeTicket({ ...command, actorId: this.source.actorId })
  }

  async retryTicket(command: { commandId: string; ticketId: string; reason: string; expectedGeneration?: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Retrying work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'reason', 'expectedGeneration'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Retrying work accepts its exact command, Ticket, reason and version only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (command.expectedGeneration !== undefined) identifier(command.expectedGeneration, 'expectedGeneration')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Retrying work needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot retry work.')
    return this.execution.retryTicket({ ...command, actorId: this.source.actorId })
  }

  async updateIntakePolicy(command: { commandId: string; expectedRevision: number; policy: IntakePolicy; origin?: 'manual' | 'sync'; sourceRevision?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'policy', 'origin', 'sourceRevision'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Policy update accepts commandId, expectedRevision, policy, origin and sourceRevision only.')
    if (command.origin !== 'sync') this.assertAuthoringActor()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before changing it.')
    identifier(command.commandId, 'commandId')
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) throw new CoreError('INVALID_INPUT', 'Policy expectedRevision must be a positive integer.')
    if (command.origin !== undefined && command.origin !== 'manual' && command.origin !== 'sync') throw new CoreError('INVALID_INPUT', 'Policy origin is manual or sync.')
    if (command.origin === 'sync' && (typeof command.sourceRevision !== 'string' || !command.sourceRevision.trim() || Buffer.byteLength(command.sourceRevision) > 512)) throw new CoreError('INVALID_INPUT', 'A synchronised Policy update needs a bounded sourceRevision.')
    const assessor = command.policy.assess ?? this.defaultAssessor
    const { assess: _providedAssess, ...commandConfiguration } = command.policy
    const configurationSnapshot = structuredClone(commandConfiguration)
    const policy: IntakePolicy = assessor ? { ...configurationSnapshot, assess: assessor } : configurationSnapshot
    validateIntakePolicy(policy)
    const { assess: _assess, ...configuration } = policy
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['policy-update-v1', command.expectedRevision, command.origin ?? 'manual', command.sourceRevision ?? null, configuration])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; revision: number }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Policy command was reused with different input.')
        return { revision: prior.revision, replayed: true }
      }
      const current = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The current Policy snapshot is missing.')
      if (current.revision !== command.expectedRevision) throw new CoreError('POLICY_REVISION_CONFLICT', 'The Policy changed after this update was prepared.')
      if (command.origin === 'sync' && current.sourceRevision === command.sourceRevision) throw new CoreError('STALE_POLICY_SYNC', 'This member-sync revision was already applied.')
      const nextRevision = current.revision + 1
      const stored: StoredPolicy = { revision: nextRevision, configuration, origin: command.origin ?? 'manual',
        ...(command.sourceRevision ? { sourceRevision: command.sourceRevision } : {}), updatedAt: Date.now() }
      await tx.replace('policy-state', this.policyKey(), stored)
      await tx.insert('policy-history', `${JSON.stringify(['policy-history', this.source.sourceInstanceId])}:${nextRevision}`, stored)
      const interrupted = await this.evaluations!.invalidateForPolicyChange(tx, 'POLICY_CHANGED')
      const affectedTicketIds = new Set<string>()
      for (const evaluation of interrupted) {
        const requeue: StoredPolicyNotice = { key: `${JSON.stringify(['policy-reevaluation', this.source.sourceInstanceId])}:${evaluation.evaluationId}`,
          ticketId: evaluation.evaluationId, revision: nextRevision, reason: 'POLICY_CHANGED' }
        await tx.insert('policy-reevaluation', requeue.key, requeue)
        for (const eventId of evaluation.candidateEventIds) {
          for (const ownership of await this.inputs.ownershipsForEventInTransaction(tx, eventId)) {
            if (ownership.state === 'owned') affectedTicketIds.add(ownership.ticketId)
          }
        }
      }
      let ticketCursor: string | undefined
      let liveTickets = 0
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<Work['ticket']>('ticket', { limit: 100, ...(ticketCursor ? { after: ticketCursor } : {}) })
        for (const item of page.items) {
          const trigger = await tx.get<Work['trigger']>('trigger', item.value.triggerId)
          if (item.value.state !== 'open' || trigger?.source.sourceInstanceId !== this.source.sourceInstanceId || !affectedTicketIds.has(item.value.id)) continue
          liveTickets++
          if (liveTickets > 1000) throw new CoreError('POLICY_NOTICE_LIMIT', 'Too many live Tickets require a Policy notification.')
          await this.effects.enqueue(tx, { key: `policy:${item.value.id}:${nextRevision}`, stream: 'outbox', scope: item.value.id,
            payload: { purpose: 'policy', ticketId: item.value.id, revision: nextRevision } })
        }
        if (!page.cursor) break
        ticketCursor = page.cursor
        if (pageCount === 9) {
          const confirmation = await tx.scan<Work['ticket']>('ticket', { limit: 1, after: ticketCursor })
          if (!confirmation.items[0]) break
          throw new CoreError('POLICY_NOTICE_LIMIT', 'The live Ticket scan exceeded its 1000-record budget.')
        }
      }
      await tx.insert('work-command', commandKey, { fingerprint, revision: nextRevision })
      return { revision: nextRevision, replayed: false }
    })
    if (outcome.replayed) {
      const current = await this.storage.transaction(this.instanceId, tx => tx.get<StoredPolicy>('policy-state', this.policyKey()))
      return { revision: current?.revision ?? outcome.revision, policy: current ? structuredClone(current.configuration) : { ...configuration }, processingPaused: this.processingPaused }
    }
    this.applyPolicy(policy, outcome.revision)
    void this.drainPolicyReevaluations().catch(() => {})
    return { revision: outcome.revision, policy: { ...configuration }, processingPaused: this.processingPaused }
  }

  /**
   * A trusted maintainer instruction is interpreted into one constrained roles or policy change,
   * then applied with the same revision CAS as the settings surface. A conflict keeps a draft.
   */
  async updateBehaviorFromInstruction(
    command: { commandId: string; instruction: string; expectedRoleRevision?: number; expectedPolicyRevision?: number; signal?: AbortSignal },
    interpreter: BehaviorInterpreter,
  ): Promise<BehaviorInstructionRecord> {
    await this.ensurePolicy()
    this.assertAuthoringActor()
    if (!command || Object.keys(command).some(key => !['commandId', 'instruction', 'expectedRoleRevision', 'expectedPolicyRevision', 'signal'].includes(key))) throw new CoreError('INVALID_INPUT', 'A behavior instruction accepts commandId, instruction, expected revisions and a signal only.')
    identifier(command.commandId, 'commandId')
    if (typeof command.instruction !== 'string' || !command.instruction.trim() || Buffer.byteLength(command.instruction) > 16_384) throw new CoreError('INVALID_INPUT', 'A behavior instruction is bounded and nonempty.')
    for (const value of [command.expectedRoleRevision, command.expectedPolicyRevision]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new CoreError('INVALID_INPUT', 'Expected revisions are positive integers.')
    }
    if (typeof interpreter !== 'function') throw new CoreError('INVALID_CONFIG', 'A behavior interpreter is required.')
    if (command.signal !== undefined && (typeof command.signal !== 'object' || typeof command.signal.aborted !== 'boolean')) throw new CoreError('INVALID_INPUT', 'The behavior instruction signal is invalid.')
    const fingerprint = createHash('sha256').update(canonicalJson(['behavior-instruction-v1', this.instanceId, this.source.actorId,
      command.instruction, command.expectedRoleRevision ?? null, command.expectedPolicyRevision ?? null])).digest('hex')
    const key = instructionKey(command.commandId)
    const now = Date.now()
    const leaseUntil = now + 120_000
    const claimed: LeasedBehaviorInstruction = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<LeasedBehaviorInstruction>('behavior-instruction', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The behavior instruction command was reused with different input.')
        if (prior.status !== 'interpreting' && prior.status !== 'applying') return prior
        if ((prior.leaseUntil ?? 0) > now) throw new CoreError('INSTRUCTION_IN_PROGRESS', 'Another interpreter is still working on this instruction.')
        const renewed: LeasedBehaviorInstruction = { ...prior, leaseToken: randomUUID(), leaseUntil, updatedAt: now }
        await transaction.replace('behavior-instruction', key, renewed)
        return renewed
      }
      const next: LeasedBehaviorInstruction = {
        id: randomUUID(), instanceId: this.instanceId, commandId: command.commandId, actorId: this.source.actorId,
        instruction: command.instruction, fingerprint, status: 'interpreting', leaseToken: randomUUID(), leaseUntil, createdAt: now, updatedAt: now,
        ...(command.expectedRoleRevision === undefined ? {} : { expectedRoleRevision: command.expectedRoleRevision }),
        ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
      }
      await transaction.insert('behavior-instruction', key, next)
      return next
    })
    if (claimed.status !== 'interpreting' && claimed.status !== 'applying') return claimed
    const currentRoles = await this.getRoleConfig()
    const currentPolicy = this.evaluations === undefined ? undefined : await this.getIntakePolicy()
    let change = claimed.change
    if (change === undefined) {
      try {
        change = validateBehaviorChange(await interpreter({
          instruction: command.instruction, roles: currentRoles, ...(currentPolicy === undefined ? {} : { policy: currentPolicy.policy }), signal: command.signal ?? new AbortController().signal,
        }))
      } catch (error) {
        return this.finishBehaviorInstruction(claimed, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, key)
      }
      const prepared = await this.prepareBehaviorInstruction(claimed, change, key)
      if (prepared.status !== 'applying') return prepared
      change = prepared.change
    }
    const appliedChange = change!
    const fresh = claimed.change === undefined
    const metadata = { change: appliedChange, summary: appliedChange.summary,
      ...(appliedChange.interpreterVersion === undefined ? {} : { interpreterVersion: appliedChange.interpreterVersion }),
      ...(appliedChange.model === undefined ? {} : { model: appliedChange.model }) }
    try {
      if (appliedChange.target === 'roles') {
        if (fresh && (appliedChange.roles!.router.name !== currentRoles.roles.router.name || appliedChange.roles!.worker.name !== currentRoles.roles.worker.name
          || JSON.stringify(appliedChange.roles!.router.model) !== JSON.stringify(currentRoles.roles.router.model)
          || JSON.stringify(appliedChange.roles!.worker.model) !== JSON.stringify(currentRoles.roles.worker.model))) {
          throw new CoreError('INVALID_CONFIG', 'A behavior instruction cannot change role names or model routes.')
        }
        const expected = command.expectedRoleRevision ?? claimed.expectedRoleRevision
        if (expected === undefined) throw new CoreError('INVALID_INPUT', 'A roles instruction needs expectedRoleRevision.')
        const view = await this.updateRoleConfig({ commandId: `${command.commandId}:roles`, expectedRevision: expected, roles: appliedChange.roles! })
        return this.finishBehaviorInstruction(claimed, { ...metadata, status: 'applied', effectiveRoleRevision: view.revision }, key)
      }
      const expected = command.expectedPolicyRevision ?? claimed.expectedPolicyRevision
      if (expected === undefined) throw new CoreError('INVALID_INPUT', 'A policy instruction needs expectedPolicyRevision.')
      const latest = await this.getIntakePolicy()
      const policy = { ...latest.policy, ...appliedChange.policy!, allowedRequesterIds: latest.policy.allowedRequesterIds,
        allowedBotActorIds: latest.policy.allowedBotActorIds,
        ...(latest.policy.selfActorIds === undefined ? {} : { selfActorIds: latest.policy.selfActorIds }) }
      const view = await this.updateIntakePolicy({ commandId: `${command.commandId}:policy`, expectedRevision: expected, policy })
      return this.finishBehaviorInstruction(claimed, { ...metadata, status: 'applied', effectivePolicyRevision: view.revision }, key)
    } catch (error) {
      if (error instanceof CoreError && (error.code === 'CONFIG_REVISION_CONFLICT' || error.code === 'POLICY_REVISION_CONFLICT')) {
        const roles = await this.getRoleConfig()
        const policy = this.evaluations === undefined ? undefined : await this.getIntakePolicy()
        const draft: ConfigDraft = {
          id: claimed.id, instanceId: this.instanceId, instructionId: claimed.id, commandId: command.commandId, actorId: this.source.actorId,
          instruction: command.instruction, change: appliedChange, currentRoleRevision: roles.revision, ...(policy === undefined ? {} : { currentPolicyRevision: policy.revision }),
          status: 'conflict', createdAt: Date.now(),
          ...(command.expectedRoleRevision === undefined ? {} : { expectedRoleRevision: command.expectedRoleRevision }),
          ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
        }
        await this.storage.transaction(this.instanceId, async transaction => {
          if (!await transaction.replace('config-draft', draftKey(draft.id), draft)) await transaction.insert('config-draft', draftKey(draft.id), draft)
        })
        return this.finishBehaviorInstruction(claimed, { ...metadata, status: 'conflict', draftId: draft.id, error: error.message }, key)
      }
      return this.finishBehaviorInstruction(claimed, { ...metadata, status: 'failed', error: error instanceof Error ? error.message : String(error) }, key)
    }
  }

  private async prepareBehaviorInstruction(claimed: LeasedBehaviorInstruction, change: BehaviorChange, key: string): Promise<BehaviorInstructionRecord> {
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<LeasedBehaviorInstruction>('behavior-instruction', key)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The behavior instruction claim is missing.')
      if (current.status !== 'interpreting' && current.status !== 'applying') return current
      if (current.id !== claimed.id || current.leaseToken !== claimed.leaseToken) {
        throw new CoreError('INSTRUCTION_CHANGED', 'The behavior instruction claim changed while it was interpreted.')
      }
      if (current.status === 'applying' && current.change !== undefined) return current
      const next: LeasedBehaviorInstruction = { ...current, change, summary: change.summary,
        ...(change.interpreterVersion === undefined ? {} : { interpreterVersion: change.interpreterVersion }),
        ...(change.model === undefined ? {} : { model: change.model }), status: 'applying', leaseUntil: Date.now() + 120_000, updatedAt: Date.now() }
      await transaction.replace('behavior-instruction', key, next)
      return next
    })
  }

  private async finishBehaviorInstruction(claimed: LeasedBehaviorInstruction, fields: Partial<BehaviorInstructionRecord>, key: string): Promise<BehaviorInstructionRecord> {
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<LeasedBehaviorInstruction>('behavior-instruction', key)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The behavior instruction claim is missing.')
      if (current.status !== 'interpreting' && current.status !== 'applying') return current
      if (current.id !== claimed.id || current.leaseToken !== claimed.leaseToken) return current
      const next: LeasedBehaviorInstruction = { ...current, ...fields, leaseUntil: Date.now(), updatedAt: Date.now() }
      await transaction.replace('behavior-instruction', key, next)
      return next
    })
  }

  async getBehaviorInstructions(): Promise<BehaviorInstructionRecord[]> {
    return this.storage.transaction(this.instanceId, transaction => this.scanBehaviorRecords<BehaviorInstructionRecord>(transaction, 'behavior-instruction'))
  }

  async getBehaviorInstruction(commandId: string): Promise<BehaviorInstructionRecord | undefined> {
    identifier(commandId, 'commandId')
    return this.storage.transaction(this.instanceId, transaction => transaction.get<BehaviorInstructionRecord>('behavior-instruction', instructionKey(commandId)))
  }

  async getConfigDraft(draftId: string): Promise<ConfigDraft | undefined> {
    identifier(draftId, 'draftId')
    return this.storage.transaction(this.instanceId, transaction => transaction.get<ConfigDraft>('config-draft', draftKey(draftId)))
  }

  async listConfigDrafts(): Promise<ConfigDraft[]> {
    return this.storage.transaction(this.instanceId, transaction => this.scanBehaviorRecords<ConfigDraft>(transaction, 'config-draft'))
  }

  private async scanBehaviorRecords<T extends { createdAt: number }>(transaction: AsyncTx, kind: 'behavior-instruction' | 'config-draft'): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<T>(kind, { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) })
      items.push(...page.items.map(item => item.value))
      if (!page.cursor) break
      cursor = page.cursor
    }
    return items.sort((left, right) => right.createdAt - left.createdAt)
  }

  async setProcessingPaused(command: { commandId: string; paused: boolean }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'paused'].includes(key))) throw new CoreError('INVALID_INPUT', 'Pausing processing accepts commandId and paused only.')
    identifier(command.commandId, 'commandId')
    if (typeof command.paused !== 'boolean') throw new CoreError('INVALID_INPUT', 'paused must be boolean.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['processing-pause-v1', command.paused])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; state: ProcessingState }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The pause command was reused with different input.')
        return { state: prior.state, replayed: true }
      }
      const current = await tx.get<ProcessingState>('processing-state', this.processingKey())
      const next: ProcessingState = { paused: command.paused, revision: (current?.revision ?? 0) + 1, updatedAt: Date.now() }
      if (!await tx.replace('processing-state', this.processingKey(), next)) await tx.insert('processing-state', this.processingKey(), next)
      await tx.insert('work-command', commandKey, { fingerprint, state: next })
      return { state: next, replayed: false }
    })
    if (outcome.replayed) return outcome.state
    this.processingPaused = outcome.state.paused
    this.evaluations?.setPaused(this.processingPaused)
    if (outcome.state.paused) this.effects.setPaused(true)
    else {
      await this.effects.resume()
      this.evaluations?.resume()
      try { await this.recoverInterruptedHandoffs() }
      catch { /* The pause itself is committed; a later startup or unpause retries reconciliation. */ }
    }
    return outcome.state
  }

  async addThreadSubscription(command: { commandId: string; ticketId: string; threadId: string; reason: string; mode?: 'worker' | 'context' }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'threadId', 'reason', 'mode'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Thread subscription accepts commandId, ticketId, threadId, reason and mode only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.threadId, 'threadId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'A Thread subscription needs a bounded reason.')
    if (command.mode !== undefined && command.mode !== 'worker' && command.mode !== 'context') throw new CoreError('INVALID_INPUT', 'A Thread subscription mode is worker or context.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to manage subscriptions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['manual-subscription-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.threadId, command.reason, command.mode ?? 'worker'])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The subscription command was reused for different input.')
        return
      }
      await this.inputs.addSubscription(tx, command.ticketId, command.threadId, 'manual', false, command.mode ?? 'worker', command.reason, this.source.actorId)
      await tx.insert('work-command', commandKey, { fingerprint })
    })
    return this.inputs.direction(command.ticketId)
  }

  async attachSourceEvent(command: { commandId: string; eventId: string; ticketId: string; reason: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'eventId', 'ticketId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Explicit attach accepts commandId, eventId, ticketId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.eventId, 'eventId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Explicit attach needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to attach events.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['explicit-attach-v1', this.source.sourceInstanceId, this.source.actorId, command.eventId, command.ticketId, command.reason])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; inputId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attach command was reused for different input.')
        return (await this.inputs.getInput(tx, existing.inputId))!
      }
      const event = await tx.get<SourceEvent>('source-event', command.eventId)
      if (!event) throw new CoreError('NOT_FOUND', 'The source event does not exist.')
      const input = await this.inputs.attach(tx, event, command.ticketId, command.reason, this.source.actorId)
      await tx.insert('work-command', commandKey, { fingerprint, inputId: input.id })
      return input
    })
  }

  /** An explicit, Instance-qualified reference; knowing it never grants access to a Ticket. */
  async getTicketReference(ticketId: string): Promise<string> {
    await this.ensurePolicy()
    identifier(ticketId, 'ticketId')
    await this.storage.transaction(this.instanceId, tx => this.associationOwner(tx, ticketId))
    return `superagent://${encodeURIComponent(this.instanceId)}/tickets/${encodeURIComponent(ticketId)}`
  }

  /** Called by the Ticket owner with a trusted receiving Engine, never with source identity from message data. */
  async associateSourceEvent(command: { commandId: string; ticketId: string; eventId: string; reference: string; reason: string; retargetResult?: boolean }, receiver: Engine) {
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'eventId', 'reference', 'reason', 'retargetResult'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Association accepts a command, Ticket, event, explicit reference, reason and optional result retarget only.')
    }
    command = structuredClone(command)
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.eventId, 'eventId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048
      || command.retargetResult !== undefined && typeof command.retargetResult !== 'boolean') throw new CoreError('INVALID_INPUT', 'Association needs a bounded reason and a boolean retarget flag.')
    if (!(receiver instanceof Engine) || receiver.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Association requires a trusted receiver in the same Instance.')
    await this.ensurePolicy(); await receiver.ensurePolicy()
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['cross-source-association-v1', command,
      receiver.source.kind ?? 'desktop', receiver.source.sourceInstanceId, receiver.source.actorId])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.associationOwner(tx, command.ticketId)
      const prior = await tx.get<{ fingerprint: string; result: { input: WorkInput; target?: DeliveryTarget } }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The association command was reused for different input.')
        return prior.result
      }
      await this.assertHostAdmissionIn(tx)
      for (const engine of [this, receiver]) {
        const processing = await tx.get<ProcessingState>('processing-state', engine.processingKey())
        if (processing?.paused || engine.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'Cross-source input cannot be associated while either source is paused.')
      }
      const policy = await tx.get<StoredPolicy>('policy-state', receiver.policyKey())
      const event = await receiver.sourceEvents.associationCandidate(tx, command.eventId,
        policy?.configuration.allowedRequesterIds ?? receiver.source.intake?.allowedRequesterIds ?? receiver.source.allowedActorIds)
      const reference = `superagent://${encodeURIComponent(this.instanceId)}/tickets/${encodeURIComponent(command.ticketId)}`
      const references = [...new Set(event.text?.match(/superagent:\/\/[^\s<>"[\]]+/gu) ?? [])]
      if (command.reference !== reference || references.length !== 1 || references[0] !== reference) {
        throw new CoreError('ASSOCIATION_REFERENCE_INVALID', 'Association requires exactly one matching Instance-qualified Ticket reference in the current native message.')
      }
      const input = await this.inputs.attachAssociated(tx, command.ticketId, event, { reference, source: event.source,
        sourceActorId: event.authorId, authorizedBy: this.source.actorId, ownerSourceInstanceId: this.source.sourceInstanceId,
        reason: command.reason, checkedAt: Date.now() })
      const target = command.retargetResult ? await this.deliveryState.setTarget(tx, {
        ticketId: command.ticketId, purpose: 'result', sourceInstanceId: event.source.sourceInstanceId, actorId: event.authorId,
        threadId: event.threadId, objectId: event.objectId, evidence: command.reason, evidenceEventId: event.id, authorizedBy: this.source.actorId,
      }) : undefined
      const result = { input, ...(target ? { target } : {}) }
      await tx.insert('work-command', key, { fingerprint, result })
      return result
    })
  }

  private async associationOwner(tx: AsyncTx, ticketId: string) {
    const work = await this.readWork(tx, ticketId)
    if (!work || work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId || work.trigger.source.kind !== (this.source.kind ?? 'desktop') || work.trigger.source.actorId !== this.source.actorId
      || !this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original trusted source actor can authorize association to this Ticket.')
    const policy = await tx.get<StoredPolicy>('policy-state', this.policyKey())
    const original = work.trigger.threadId ? await tx.get<SourceEvent>('source-event', work.trigger.id) : undefined
    const allowed = policy?.configuration.allowedRequesterIds ?? this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
    if (!allowed.includes(original?.authorId ?? this.source.actorId) || work.decision.outcome !== 'accept') {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The original work authorization is no longer valid for association.')
    }
    return work
  }

  async requeueSourceEvent(command: { commandId: string; eventId: string }) {
    await this.ensurePolicy()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Manual requeue requires an Intake Policy.')
    if (!command || Object.keys(command).some(key => !['commandId', 'eventId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Manual requeue accepts commandId and eventId only.')
    identifier(command.commandId, 'commandId'); identifier(command.eventId, 'eventId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to requeue work.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['manual-requeue-v1', this.source.sourceInstanceId, this.source.actorId, command.eventId])).digest('hex')
    const event = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing && existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The requeue command was reused for a different event.')
      const sourceEvent = await tx.get<SourceEvent>('source-event', command.eventId)
      if (!sourceEvent) throw new CoreError('NOT_FOUND', 'The requeued source event does not exist.')
      if (!this.sourceEvents.belongsToSource(sourceEvent)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source event belongs to a different source instance.')
      if (!existing) {
        await this.inputs.prepareRequeue(tx, sourceEvent, command.commandId, commandKey, this.source.actorId)
        await tx.insert('work-command', commandKey, { fingerprint })
      }
      return sourceEvent
    })
    return this.evaluations.assess({ commandId: `requeue:${commandKey}`, threadId: event.threadId, eventIds: [event.id] })
  }

  async removeThreadSubscription(command: { commandId: string; ticketId: string; threadId: string; reason: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'threadId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Removing a Thread subscription accepts commandId, ticketId, threadId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.threadId, 'threadId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Removing a Thread subscription needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to manage subscriptions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['remove-subscription-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.threadId, command.reason])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The unsubscribe command was reused for different input.')
        return
      }
      await this.inputs.removeSubscription(tx, command.ticketId, command.threadId, command.reason, this.source.actorId, commandKey)
      await tx.insert('work-command', commandKey, { fingerprint })
    })
    return this.inputs.direction(command.ticketId)
  }

  async addTicketNote(command: { commandId: string; ticketId: string; text: string; sourceTicketId?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'text', 'sourceTicketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Ticket note accepts commandId, ticketId, text and sourceTicketId only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 4096) throw new CoreError('INVALID_INPUT', 'A Ticket note needs bounded nonempty text.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to add notes.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['ticket-note-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.text, command.sourceTicketId ?? null])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; noteId?: string; note?: WorkNote }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The note command was reused for different input.')
        if (existing.note) return existing.note
        return { noteId: existing.noteId }
      }
      const note = await this.inputs.addNote(tx, command.ticketId, command.text, this.source.actorId, command.sourceTicketId)
      await tx.insert('work-command', commandKey, { fingerprint, noteId: note.id, note })
      return note
    })
    if ('text' in result && 'createdAt' in result) return result
    return (await this.inputs.direction(command.ticketId))?.notes.find(note => note.id === result.noteId)!
  }

  /** An approved semantic correction: one direction input for the Worker, never a tool call by the supervisor. */
  async correctTicket(command: { commandId: string; ticketId: string; text: string; reason: string;
    expectedDirectionVersion?: number; expectedGeneration?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'text', 'reason', 'expectedDirectionVersion', 'expectedGeneration'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Ticket correction accepts commandId, ticketId, text, reason and expected version only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65_536) throw new CoreError('INVALID_INPUT', 'A correction needs bounded nonempty text.')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2_048) throw new CoreError('INVALID_INPUT', 'A correction needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot correct this Ticket.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['supervisor-correction-v1', this.instanceId, command.ticketId, command.text, command.reason])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; inputId: string; input?: WorkInput }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The correction command was reused for different input.')
        return prior.input ?? await tx.get<WorkInput>('work-input', prior.inputId)
      }
      const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
      if (!ticket) throw new CoreError('NOT_FOUND', 'The Ticket does not exist.')
      if (ticket.constraint) throw new CoreError('TICKET_BLOCKED', 'The Ticket constraint must be resolved before a correction.')
      const stopHead = await tx.get<{ stopId: string }>('stop-head', JSON.stringify(['stop-head', command.ticketId]))
      const stop = stopHead && await tx.get<{ resumedAt?: number }>('stop-state', stopHead.stopId)
      if (stop && !stop.resumedAt) throw new CoreError('TICKET_STOPPED', 'An approved correction cannot undo a human stop.')
      if (command.expectedDirectionVersion !== undefined && ticket.directionVersion !== command.expectedDirectionVersion) {
        throw new CoreError('PROPOSAL_STALE', 'The Ticket direction changed after the supervision proposal.')
      }
      if (command.expectedGeneration !== undefined) {
        const assignment = await tx.get<{ generation: string; state: string }>('assignment', command.ticketId)
        if (assignment?.generation !== command.expectedGeneration || assignment.state !== 'running') {
          throw new CoreError('PROPOSAL_STALE', 'The Worker generation changed after the supervision proposal.')
        }
      }
      const input = await this.inputs.attachSyntheticInput(tx, {
        ticketId: command.ticketId, sourceEventId: JSON.stringify(['supervisor-correction', command.ticketId, command.commandId]),
        threadId: '__supervisor__', text: command.text, authorId: this.source.actorId, reason: command.reason, basis: 'supervisor-correction',
      })
      await tx.insert('work-command', key, { fingerprint, inputId: input.id, input })
      return input
    })
    if (!result) throw new CoreError('INCOMPLETE_STATE', 'The correction input is missing.')
    return result
  }

  async listTickets(cursor?: string, durableCursor = false): Promise<{ items: Work[]; hasMore: boolean; nextCursor?: string }> {
    const key = durableCursor ? await this.loadSupervisorCursorKey() : undefined
    const sourceAfter = cursor === undefined ? undefined : this.ticketCursorAfter(cursor, key)
    return this.storage.transaction(this.instanceId, async tx => {
      const items: Work[] = []
      let after = sourceAfter
      let lastIncluded = sourceAfter
      let scanned = 0
      while (scanned < 1000) {
        const tickets = await tx.scan<Work['ticket']>('ticket', { limit: Math.min(101, 1000 - scanned), ...(after ? { after } : {}) })
        for (const { id } of tickets.items) {
          scanned++
          after = id
          const work = await this.readWork(tx, id)
          if (!work || !this.canReadTicket(work.trigger)) continue
          if (items.length === 100) return { items, hasMore: true, nextCursor: key ? this.sealSupervisorCursor(lastIncluded!, key) : this.rememberTicketCursor(lastIncluded!) }
          items.push(work)
          lastIncluded = id
        }
        if (!tickets.cursor) return { items, hasMore: false }
        after = tickets.cursor
      }
      const nextCursor = items.length === 100 ? lastIncluded : after
      return { items, hasMore: true, nextCursor: key ? this.sealSupervisorCursor(nextCursor!, key) : this.rememberTicketCursor(nextCursor!) }
    })
  }

  private async loadSupervisorCursorKey(): Promise<Buffer> {
    this.supervisorCursorKey ??= this.storage.transaction(this.instanceId, async tx => {
      const stored = await tx.get<string>('supervisor-cursor-key', 'product-supervisor')
      if (stored) return Buffer.from(stored, 'base64')
      const generated = randomBytes(32)
      await tx.insert('supervisor-cursor-key', 'product-supervisor', generated.toString('base64'))
      return generated
    }).catch(error => { this.supervisorCursorKey = undefined; throw error })
    const key = await this.supervisorCursorKey
    if (key.length !== 32) throw new CoreError('INCOMPLETE_STATE', 'The supervision cursor key is invalid.')
    return key
  }

  private supervisorCursorScope() { return JSON.stringify([this.instanceId, this.source.kind ?? 'desktop', this.source.sourceInstanceId, this.source.actorId]) }

  private sealSupervisorCursor(after: string, key: Buffer): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(this.supervisorCursorScope()))
    const cursor = `sv1.${Buffer.concat([nonce, cipher.update(after, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url')}`
    if (Buffer.byteLength(cursor) > 512) throw new CoreError('INCOMPLETE_STATE', 'The supervision cursor exceeds its size budget.')
    return cursor
  }

  private ticketCursorAfter(cursor: string, key?: Buffer): string {
    identifier(cursor, 'cursor')
    if (key) {
      if (!/^sv1\.[A-Za-z0-9_-]+$/u.test(cursor)) throw new CoreError('INVALID_INPUT', 'Use an authorized supervision continuation cursor.')
      const bytes = Buffer.from(cursor.slice(4), 'base64url')
      if (bytes.length <= 28 || bytes.toString('base64url') !== cursor.slice(4)) throw new CoreError('INVALID_INPUT', 'The supervision continuation cursor is invalid.')
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        decipher.setAAD(Buffer.from(this.supervisorCursorScope()))
        decipher.setAuthTag(bytes.subarray(-16))
        const after = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')
        identifier(after, 'cursor position')
        return after
      } catch { throw new CoreError('INVALID_INPUT', 'The supervision continuation cursor is invalid for this source.') }
    }
    const stored = this.ticketCursors.get(cursor)
    if (!stored || stored.expiresAt <= Date.now() || stored.sourceInstanceId !== this.source.sourceInstanceId || stored.actorId !== this.source.actorId) {
      this.ticketCursors.delete(cursor)
      throw new CoreError('INVALID_INPUT', 'The Ticket list cursor is stale or belongs to another source.')
    }
    stored.expiresAt = Date.now() + 5 * 60 * 1000
    return stored.after
  }

  private rememberTicketCursor(after: string): string {
    const now = Date.now()
    for (const [cursor, stored] of this.ticketCursors) {
      if (stored.expiresAt <= now) this.ticketCursors.delete(cursor)
    }
    while (this.ticketCursors.size >= 100) this.ticketCursors.delete(this.ticketCursors.keys().next().value!)
    const cursor = randomUUID()
    this.ticketCursors.set(cursor, { after, sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId, expiresAt: now + 5 * 60 * 1000 })
    return cursor
  }

  private async readWork(tx: AsyncTx, ticketId: string): Promise<Work | undefined> {
    const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
    if (!ticket) return undefined
    const trigger = await tx.get<Work['trigger']>('trigger', ticket.triggerId)
    const mandate = await tx.get<Work['mandate']>('mandate', ticket.mandateId)
    const decision = mandate && await tx.get<Work['decision']>('decision', mandate.decisionId)
    const intent = await tx.get<Work['intent']>('intent', ticket.id)
    if (!trigger || !mandate || !decision || !intent) throw new CoreError('INCOMPLETE_STATE', 'Accepted work is missing required durable facts.')
    return { trigger, decision, mandate, ticket, intent }
  }

  private canReadTicket(trigger: Work['trigger']) {
    return trigger.source.sourceInstanceId === this.source.sourceInstanceId
      && trigger.source.kind === (this.source.kind ?? 'desktop')
      && trigger.source.actorId === this.source.actorId
  }

  private async assertTicketReadable(ticketId: string) {
    return this.storage.transaction(this.instanceId, tx => this.assertTicketReadableIn(tx, ticketId))
  }

  private async assertTicketReadableIn(tx: AsyncTx, ticketId: string) {
    const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
    if (ticket && (!trigger || !this.canReadTicket(trigger))) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This source cannot read another source instance’s private Ticket.')
  }
}

const handoffCopyKey = (ticketId: string) => JSON.stringify(['handoff-copy', ticketId])
const handoffCopyHistoryPrefix = (ticketId: string) => JSON.stringify(['handoff-copy-history', ticketId])

function workCopyBlockers(error: unknown): WorkCopyBlocker[] {
  if (error instanceof WorkCopyUnsupported) return error.gaps.map(code => ({ code, message: error.message }))
  if (error instanceof CoreError) return [{ code: error.code, message: error.message }]
  return [{ code: 'work-copy-inspection-failed', message: 'The Environment could not inspect its work copy.' }]
}

async function inspectEnvironmentWorkCopy(environment: ExecutionEnvironment,
  identity: { instanceId: string; actorId: string }): Promise<{ snapshot?: WorkCopySnapshot; blocker?: WorkCopyBlocker }> {
  try {
    const bound = await environment.prepare(identity)
    if (!bound.inspectWorkCopy) throw new WorkCopyUnsupported('The Environment has no work-copy inspection.', [workCopyGaps.inspectMissing])
    return { snapshot: await bound.inspectWorkCopy() }
  } catch (error) {
    return { blocker: workCopyBlockers(error)[0]! }
  }
}

function sameWorkCopyFiles(left: WorkCopyFile[], right: WorkCopyFile[]) {
  if (left.length !== right.length) return false
  const expected = new Map(left.map(file => [file.path, file]))
  return right.every(file => {
    const match = expected.get(file.path)
    return Boolean(match) && match!.state === file.state && match!.executable === file.executable
      && match!.bytes === file.bytes && match!.sha256 === file.sha256
  })
}

async function saveHandoffCopy(transaction: AsyncTx, record: HandoffCopyView) {
  const key = handoffCopyKey(record.ticketId)
  if (!await transaction.replace('handoff-copy', key, record)) await transaction.insert('handoff-copy', key, record)
  const historyKey = `${handoffCopyHistoryPrefix(record.ticketId)}:${String(record.preparedAt).padStart(16, '0')}:${record.id}`
  if (!await transaction.replace('handoff-copy-history', historyKey, record)) await transaction.insert('handoff-copy-history', historyKey, record)
  return record
}

function loadHandoffCopy(transaction: AsyncTx, ticketId: string) {
  return transaction.get<HandoffCopyView>('handoff-copy', handoffCopyKey(ticketId))
}

async function loadHandoffCopyById(transaction: AsyncTx, ticketId: string, recordId: string) {
  const current = await loadHandoffCopy(transaction, ticketId)
  if (current?.id === recordId) return current
  const prefix = `${handoffCopyHistoryPrefix(ticketId)}:`
  let after = prefix
  for (let pageCount = 0; pageCount < 10; pageCount++) {
    const page = await transaction.scan<HandoffCopyView>('handoff-copy-history', { limit: 100, after })
    const found = page.items.find(entry => entry.id.startsWith(prefix) && entry.value.id === recordId)?.value
    if (found) return found
    if (!page.cursor || !page.cursor.startsWith(prefix)) break
    after = page.cursor
    if (pageCount === 9) throw new CoreError('WORK_COPY_HISTORY_BUDGET',
      'The work-copy history exceeds its 1000-record lookup budget.')
  }
  return undefined
}
