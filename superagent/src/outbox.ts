import { CoreError } from './model.js'
import { triggerDeliveryTarget, type Work } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import type { Effect, EffectHandler, EffectResult } from './effects.js'
import type { SourceEvent, SourceEvents } from './source-events.js'
import { isCurrentSourceEvent } from './source-events.js'
import { localDeliveryChannel, type Deliveries, type Delivery, type DeliveryChannel } from './deliveries.js'
import type { Attention } from './attention.js'
import type { Assignment, ReadyReport } from './execution.js'
import type { DeliveryState } from './delivery-state.js'
import { associatedInput, type WorkInputs } from './work-inputs.js'
import type { MainSourceHandoff } from './main-source.js'
import type { FeishuSourceReply } from './feishu-delivery.js'

interface MainReplyRecord extends FeishuSourceReply {
  handoffId: string
  mainId: string
  sourceEventId: string
  nativeVersion: SourceEvent['version']
  effectId: string
  effectGeneration: string
}

interface SourceReplyChannel extends DeliveryChannel {
  deliverSourceReply?(reply: FeishuSourceReply, context: { idempotencyKey: string; signal: AbortSignal }): Promise<EffectResult>
  reconcileSourceReply?(reply: FeishuSourceReply, context: { idempotencyKey: string; signal: AbortSignal }): Promise<EffectResult>
}

export class Outbox {
  private readonly channel: SourceReplyChannel
  constructor(
    private readonly storage: Storage,
    private readonly instanceId: string,
    private readonly deliveries: Deliveries,
    private readonly sourceEvents: SourceEvents,
    private readonly deliveryState: DeliveryState,
    private readonly inputs: WorkInputs,
    channel?: DeliveryChannel,
  ) {
    this.channel = channel ?? localDeliveryChannel
  }

  handler(): EffectHandler {
    return {
      execute: (effect, context) => this.deliver(effect, context, false),
      reconcile: (effect, context) => this.deliver(effect, context, true),
    }
  }

  private async deliver(effect: Effect, context: { idempotencyKey: string; signal: AbortSignal }, reconciling: boolean): Promise<EffectResult> {
    if (effect.payload.type === 'main-source-reply') return this.deliverMainReply(effect, context, reconciling)
    const ticketId = String(effect.payload.ticketId)
    const deliveryId = typeof effect.payload.deliveryId === 'string' ? effect.payload.deliveryId : undefined
    const prepared = await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.trigger(transaction, ticketId)
      let delivery = deliveryId ? await this.deliveries.get(transaction, deliveryId) : undefined
      if (!delivery) {
        if (reconciling) return { invalid: 'INVALID_DELIVERY: reconciliation requires the immutable delivery record.' }
        const legacy = await this.legacyDelivery(transaction, effect, trigger)
        if (!legacy) return { invalid: 'INVALID_DELIVERY: the outbox effect has no delivery record.' }
        delivery = await this.deliveries.record(transaction, legacy, effect)
      }
      if (reconciling) {
        const invalid = await this.validateImmutableDelivery(transaction, delivery, effect)
        if (invalid) return { invalid }
        return { view: await this.deliveries.view(transaction, delivery) }
      }
      if (delivery.purpose === 'result') {
        const target = await this.deliveryState.target(transaction, ticketId, 'result')
        if (target) {
          const redirected: Delivery = { ...delivery, destination: { actorId: target.destination.actorId,
            sourceInstanceId: target.destination.sourceInstanceId, eventId: target.destination.objectId,
            ...(target.destination.threadId ? { threadId: target.destination.threadId } : {}) } }
          delivery = await this.deliveries.record(transaction, redirected, effect)
        }
      }
      const invalid = await this.validateDelivery(transaction, delivery, trigger)
      if (invalid) return { invalid }
      if (delivery.purpose === 'result') {
        const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
        if (!ticket) return { invalid: 'INCOMPLETE_STATE: result delivery is missing its Ticket.' }
        const outstanding = (await this.deliveryState.outstanding(transaction, ticketId)).length > 0
        const pendingInputs = await this.inputs.pendingInputsForTicket(transaction, ticketId)
        // A result may still be delivered and the Ticket left open while it keeps tracked PR delivery conditions.
        // A pending follow-up also owns the next direction: the earlier result must not close its Ticket.
        if (!ticket.constraint && !outstanding && pendingInputs.length === 0) await transaction.replace('ticket', ticketId, { ...ticket, state: 'ended' })
      }
      return { view: await this.deliveries.view(transaction, delivery) }
    })
    if ('invalid' in prepared) return { type: 'permanent', reason: prepared.invalid }
    const action = reconciling ? this.channel.reconcile?.bind(this.channel) : this.channel.deliver.bind(this.channel)
    if (!action) return { type: 'unknown', reason: 'The delivery channel cannot reconcile an unknown outcome.' }
    return action(prepared.view, context)
  }

  private async deliverMainReply(effect: Effect, context: { idempotencyKey: string; signal: AbortSignal }, reconciling: boolean): Promise<EffectResult> {
    const replyId = effect.payload.replyId
    if (typeof replyId !== 'string' || replyId !== effect.key) return { type: 'permanent', reason: 'INVALID_DELIVERY: invalid Main reply identity.' }
    const checked = await this.storage.transaction(this.instanceId, async tx => {
      const reply = await tx.get<MainReplyRecord>('main-source-reply', replyId)
      if (!reply || reply.id !== replyId || reply.effectId !== effect.id || reply.effectGeneration !== effect.generation) {
        return { invalid: 'INVALID_DELIVERY: the Main reply does not match its durable Effect.' }
      }
      const receipt = await tx.get<{ attempts?: number }>('effect-receipt', JSON.stringify([effect.id, effect.generation]))
      if (reconciling) {
        // An unknown external outcome keeps the original reply identity. A later edit,
        // recall or handoff transition must not turn an already accepted send into a
        // permanent failure; the Feishu channel owns the stable UUID reconciliation.
        const policy = await tx.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state',
          JSON.stringify(['policy-state', reply.destination.sourceInstanceId]))
        if (!policy?.configuration.allowedRequesterIds.includes(reply.destination.actorId)) {
          return { blocked: 'SOURCE_POLICY_REVOKED: the original requester is no longer authorized for reconciliation.' }
        }
        return { reply: { ...reply, attempts: receipt?.attempts ?? effect.attempts } }
      }
      const handoff = await tx.get<MainSourceHandoff>('main-source-handoff', reply.handoffId)
      const event = await tx.get<SourceEvent>('source-event', reply.sourceEventId)
      const policy = await tx.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state',
        JSON.stringify(['policy-state', reply.destination.sourceInstanceId]))
      const state = await tx.get<{ mainId: string }>('main-state', 'main')
      if (!handoff || handoff.state !== 'presented' || handoff.workBriefId || handoff.mainId !== reply.mainId
        || state?.mainId !== reply.mainId || handoff.sourceEventId !== reply.sourceEventId
        || handoff.sourceInstanceId !== reply.destination.sourceInstanceId || handoff.authorId !== reply.destination.actorId
        || handoff.objectId !== reply.destination.eventId || handoff.threadId !== reply.destination.threadId
        || JSON.stringify(handoff.nativeVersion) !== JSON.stringify(reply.nativeVersion)
        || !event || event.source.kind !== 'feishu' || event.source.sourceInstanceId !== reply.destination.sourceInstanceId
        || event.authorId !== reply.destination.actorId || event.authorKind !== 'human' || event.addressing === 'ambient'
        || event.objectId !== reply.destination.eventId || event.threadId !== reply.destination.threadId
        || JSON.stringify(event.version) !== JSON.stringify(reply.nativeVersion) || !await isCurrentSourceEvent(tx, event)
        || !policy?.configuration.allowedRequesterIds.includes(event.authorId)) {
        return { invalid: 'SOURCE_NOT_CURRENT: the Main reply source, audience or authorization changed.' }
      }
      return { reply: { ...reply, attempts: receipt?.attempts ?? effect.attempts } }
    })
    if ('invalid' in checked) return { type: 'permanent', reason: checked.invalid }
    if ('blocked' in checked) return { type: 'unknown', reason: checked.blocked }
    const action = reconciling ? this.channel.reconcileSourceReply?.bind(this.channel) : this.channel.deliverSourceReply?.bind(this.channel)
    if (!action) return { type: 'unknown', reason: 'The delivery channel cannot send a ticketless Main reply.' }
    return action(checked.reply, context)
  }

  private async validateImmutableDelivery(transaction: AsyncTx, delivery: Delivery, effect: Effect): Promise<string | undefined> {
    if (delivery.effectId !== effect.id || delivery.effectGeneration !== effect.generation) {
      return 'INVALID_DELIVERY: the delivery does not match its original Effect generation.'
    }
    if (!await transaction.get<Work['ticket']>('ticket', delivery.ticketId)) return 'NOT_FOUND: the delivery Ticket does not exist.'
    return undefined
  }

  private async trigger(transaction: AsyncTx, ticketId: string) {
    const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket && await transaction.get<Work['trigger']>('trigger', ticket.triggerId)
    if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The work does not exist in this instance.')
    return trigger
  }

  private async legacyDelivery(transaction: AsyncTx, effect: Effect, trigger: Work['trigger']): Promise<Omit<Delivery, 'instanceId' | 'sequence' | 'createdAt'> | undefined> {
    const purpose = effect.payload.purpose
    if (purpose !== 'acknowledgement' && purpose !== 'result' && purpose !== 'attention' && purpose !== 'policy') return undefined
    const ticketId = String(effect.payload.ticketId)
    const target = triggerDeliveryTarget(trigger)
    const destination = { ...target.source, eventId: target.eventId, ...(target.threadId ? { threadId: target.threadId } : {}) }
    if (purpose === 'acknowledgement') return { id: `${ticketId}:acknowledgement`, ticketId, purpose,
      text: 'Request accepted.', destination, basis: { kind: 'accepted-request', triggerId: trigger.id },
      effectId: effect.id, effectGeneration: effect.generation }
    if (purpose === 'result') {
      // A product work result is authored by Main. An older outbox Effect without
      // its immutable Delivery must never reconstruct a Worker-authored reply.
      if (trigger.source.sourceInstanceId === 'product-desktop' || await transaction.get('work-ticket', ticketId)) return undefined
      const report = await transaction.get<ReadyReport>('report', ticketId)
      if (!report) return undefined
      return { id: `${ticketId}:result`, ticketId, purpose, text: report.result, destination,
        basis: { kind: 'ready-report', reportId: report.id, directionVersion: report.directionVersion },
        effectId: effect.id, effectGeneration: effect.generation }
    }
    if (purpose === 'attention') {
      const attention = await transaction.get<Attention>('attention', String(effect.payload.attentionId))
      if (!attention) return undefined
      return { id: `${ticketId}:attention:${attention.id}`, ticketId, purpose, text: attention.question,
        destination: attention.destination, basis: { kind: 'waiting-attention', attentionId: attention.id },
        effectId: effect.id, effectGeneration: effect.generation }
    }
    const revision = Number(effect.payload.revision)
    return { id: `${ticketId}:policy:${revision}`, ticketId, purpose, text: `Policy updated to revision ${revision}.`,
      destination, basis: { kind: 'policy-update', revision }, effectId: effect.id, effectGeneration: effect.generation }
  }

  private async validateDelivery(transaction: AsyncTx, delivery: Delivery, trigger: Work['trigger']): Promise<string | undefined> {
    if (!await transaction.get<Work['ticket']>('ticket', delivery.ticketId)) return 'NOT_FOUND: the delivery Ticket does not exist.'
    const authorizedTarget = delivery.purpose === 'result' ? await this.deliveryState.target(transaction, delivery.ticketId, 'result') : undefined
    const defaultTarget = triggerDeliveryTarget(trigger)
    const foreign = delivery.destination.sourceInstanceId !== defaultTarget.source.sourceInstanceId
    const originEvent = trigger.deliveryOrigin
      ? await transaction.get<SourceEvent>('source-event', trigger.deliveryOrigin.sourceEventId) : undefined
    const originPolicy = trigger.deliveryOrigin
      ? await transaction.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state',
        JSON.stringify(['policy-state', trigger.deliveryOrigin.source.sourceInstanceId])) : undefined
    if (trigger.deliveryOrigin && (!originEvent || !await isCurrentSourceEvent(transaction, originEvent)
      || originEvent.authorId !== trigger.deliveryOrigin.authorId
      || originPolicy && !originPolicy.configuration.allowedRequesterIds.includes(originEvent.authorId))) {
      return 'SOURCE_NOT_CURRENT: the original Main source is no longer current and authorized.'
    }
    if (foreign && !authorizedTarget && delivery.purpose !== 'attention' && delivery.purpose !== 'answer') return 'SOURCE_MISMATCH: the delivery destination belongs to another source instance.'
    if (delivery.purpose === 'acknowledgement') {
      if (delivery.basis.kind !== 'accepted-request' || delivery.basis.triggerId !== trigger.id) return 'INVALID_DELIVERY: an acknowledgement needs the accepted request.'
      if (delivery.destination.eventId !== defaultTarget.eventId || delivery.destination.threadId !== defaultTarget.threadId) {
        return 'DESTINATION_MISMATCH: an acknowledgement returns to the original request.'
      }
      return undefined
    }
    if (delivery.purpose === 'result') {
      if (trigger.source.sourceInstanceId === 'product-desktop' && !await transaction.get('work-ticket', delivery.ticketId)) {
        return 'MAIN_RESULT_REQUIRED: a product result needs its Main work ownership.'
      }
      const evidence = authorizedTarget?.evidenceEventId ? await transaction.get<SourceEvent>('source-event', authorizedTarget.evidenceEventId) : undefined
      if (foreign) {
        const input = evidence ? await associatedInput(transaction, delivery.ticketId, evidence) : undefined
        if (!input || !evidence || input.association?.ownerSourceInstanceId !== trigger.source.sourceInstanceId
          || evidence.source.sourceInstanceId !== delivery.destination.sourceInstanceId || evidence.threadId !== delivery.destination.threadId
          || evidence.objectId !== delivery.destination.eventId || evidence.authorId !== delivery.destination.actorId) {
          return 'ASSOCIATION_REQUIRED: a cross-source result requires its exact authorized native follow-up.'
        }
      }
      if (evidence) {
        if (!await isCurrentSourceEvent(transaction, evidence)) return 'SOURCE_NOT_CURRENT: the destination evidence is no longer current.'
        const policy = await transaction.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state', JSON.stringify(['policy-state', evidence.source.sourceInstanceId]))
        if (policy && !policy.configuration.allowedRequesterIds.includes(evidence.authorId)) return 'ACTOR_NOT_ALLOWED: the destination follow-up actor is no longer authorized.'
      }
      if (delivery.basis.kind !== 'ready-report') return 'INVALID_DELIVERY: a result needs a ready-report basis.'
      const report = await transaction.get<ReadyReport>('report', delivery.ticketId)
      if (!report || report.id !== delivery.basis.reportId) return 'NOT_READY: result delivery requires the current ready report.'
      const assignment = await transaction.get<Assignment>('assignment', delivery.ticketId)
      if (!assignment || report.assignmentId !== assignment.id) return 'NOT_READY: the ready report belongs to an older Assignment generation.'
      const ticket = await transaction.get<Work['ticket']>('ticket', delivery.ticketId)
      if (!ticket) return 'INCOMPLETE_STATE: result delivery is missing its Ticket.'
      if (ticket.constraint?.kind === 'stopped') return 'TICKET_STOPPED: a stopped Ticket cannot deliver a result.'
      if (ticket.constraint) return 'TICKET_CONSTRAINED: the Ticket is waiting for a person before delivery.'
      const authorizedEventId = authorizedTarget?.destination.objectId ?? defaultTarget.eventId
      const authorizedThreadId = authorizedTarget?.destination.threadId ?? defaultTarget.threadId
      const authorizedActorId = authorizedTarget?.destination.actorId ?? defaultTarget.source.actorId
      if (delivery.destination.eventId !== authorizedEventId || delivery.destination.threadId !== authorizedThreadId
        || delivery.destination.actorId !== authorizedActorId) {
        return 'DESTINATION_MISMATCH: the result destination has not been authorized to change.'
      }
      return undefined
    }
    if (delivery.purpose === 'attention') {
      if (delivery.basis.kind !== 'waiting-attention') return 'INVALID_DELIVERY: an attention delivery needs its question.'
      const attention = await transaction.get<Attention>('attention', delivery.basis.attentionId)
      if (!attention || attention.ticketId !== delivery.ticketId || attention.status !== 'waiting') return 'ATTENTION_STALE: the question was answered or superseded before delivery.'
      const event = attention.questionSourceEventId ? await transaction.get<SourceEvent>('source-event', attention.questionSourceEventId) : undefined
      if (foreign) {
        const input = event ? await associatedInput(transaction, delivery.ticketId, event) : undefined
        if (!event || !input || input.association?.ownerSourceInstanceId !== trigger.source.sourceInstanceId
          || attention.destination.sourceInstanceId !== event.source.sourceInstanceId || attention.destination.threadId !== event.threadId
          || attention.destination.eventId !== event.objectId || attention.destination.actorId !== event.authorId) {
          return 'SOURCE_MISMATCH: a cross-source question needs the exact owner-authorized input and native recipient.'
        }
      }
      if (event) {
        if (!await isCurrentSourceEvent(transaction, event)) return 'SOURCE_NOT_CURRENT: the question event is no longer current.'
        const policy = await transaction.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state', JSON.stringify(['policy-state', event.source.sourceInstanceId]))
        if (policy && !policy.configuration.allowedRequesterIds.includes(event.authorId)) return 'ACTOR_NOT_ALLOWED: the question author is no longer authorized.'
      }
      const ticket = await transaction.get<Work['ticket']>('ticket', delivery.ticketId)
      if (ticket?.constraint?.kind !== 'waiting-human' || ticket.constraint.attentionId !== attention.id) return 'ATTENTION_STALE: the question is no longer the current constraint.'
      if (JSON.stringify(delivery.destination) !== JSON.stringify(attention.destination)) return 'DESTINATION_MISMATCH: a question returns to the message that caused it.'
      return undefined
    }
    if (delivery.purpose === 'answer') {
      if (delivery.basis.kind !== 'human-question' || !delivery.basis.fact.trim() || !delivery.basis.questionText.trim()) {
        return 'INVALID_DELIVERY: an answer needs a human question and an explicit Worker fact.'
      }
      const question = await transaction.get<SourceEvent>('source-event', delivery.basis.questionEventId)
      const associated = foreign && question ? await associatedInput(transaction, delivery.ticketId, question) : undefined
      if (!question || (!this.sourceEvents.belongsToSource(question) && associated?.association?.ownerSourceInstanceId !== trigger.source.sourceInstanceId) || question.authorKind !== 'human') {
        return 'ANSWER_WITHOUT_QUESTION: an answer must name a trusted human question from this source.'
      }
      if (!await isCurrentSourceEvent(transaction, question)) return 'SOURCE_NOT_CURRENT: the answered question is no longer current.'
      const policy = await transaction.get<{ configuration: { allowedRequesterIds: string[] } }>('policy-state', JSON.stringify(['policy-state', question.source.sourceInstanceId]))
      if (policy && !policy.configuration.allowedRequesterIds.includes(question.authorId)) return 'ACTOR_NOT_ALLOWED: the question author is no longer authorized.'
      if (delivery.destination.sourceInstanceId !== question.source.sourceInstanceId || delivery.destination.actorId !== question.authorId
        || delivery.destination.eventId !== question.objectId || delivery.destination.threadId !== question.threadId) {
        return 'DESTINATION_MISMATCH: an answer returns to the human question it names.'
      }
      return undefined
    }
    if (delivery.purpose === 'policy') {
      if (delivery.basis.kind !== 'policy-update' || !Number.isInteger(delivery.basis.revision) || delivery.basis.revision < 1) return 'INVALID_DELIVERY: a policy notice needs its revision.'
      return undefined
    }
    return 'INVALID_DELIVERY: unsupported delivery purpose.'
  }
}
