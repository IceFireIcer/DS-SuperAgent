import { createHash, randomUUID } from 'node:crypto'
import { CoreError, identifier, triggerDeliveryTarget, type PathGrant, type Work } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import type { SourceEvent, SourceEvents } from './source-events.js'
import type { Effects } from './effects.js'
import type { WorkInput, WorkInputs } from './work-inputs.js'
import type { Deliveries } from './deliveries.js'
import type { ProductViewAnswer, ProductViewCard } from './product-views.js'
import { normalizePathGrants } from './path-grants.js'

export interface Attention {
  id: string
  instanceId: string
  ticketId: string
  assignmentId: string
  sessionId: string
  question: string
  options: string[]
  destination: { sourceInstanceId: string; actorId: string; eventId: string; threadId?: string }
  questionSourceEventId?: string
  status: 'waiting' | 'answered' | 'superseded'
  sequence: number
  createdAt: number
  answeredAt?: number
  answeredBy?: string
  answerText?: string
  view?: ProductViewCard
  answerView?: ProductViewAnswer
  answerCommandId?: string
  answerSourceEventId?: string
  requestedPathGrants?: PathGrant[]
  pathGrantApproval?: string
  approvedPathGrants?: PathGrant[]
  supersededAt?: number
  supersededBy?: string
}

interface AttentionHead { attentionId: string }

const headKey = (ticketId: string) => JSON.stringify(['attention-head', ticketId])
const historyPrefix = (ticketId: string) => JSON.stringify(['attention', createHash('sha256').update(ticketId).digest('hex')])
export const attentionPathApproval = 'Allow this path access'

export class Attentions {
  constructor(
    private readonly storage: Storage,
    private readonly instanceId: string,
    private readonly sources: SourceEvents,
    private readonly inputs: WorkInputs,
    private readonly effects: Effects,
    private readonly deliveries: Deliveries,
    private readonly now: () => number = Date.now,
  ) {}

  ask(tx: AsyncTx, request: { ticketId: string; assignmentId: string; sessionId: string; question: string; options: string[];
    input?: WorkInput; pathGrants?: PathGrant[] }) {
    const pathGrants = normalizePathGrants(request.pathGrants)
    return this.create(tx, { ...request, ...(pathGrants ? { pathGrants } : {}),
      options: pathGrants ? [...request.options, attentionPathApproval] : request.options,
      ...(pathGrants ? { pathGrantApproval: attentionPathApproval } : {}) })
  }

  askView(tx: AsyncTx, request: { ticketId: string; assignmentId: string; sessionId: string; title: string; view: ProductViewCard; input?: WorkInput }) {
    return this.create(tx, { ...request, question: request.title ? `View: ${request.title}` : 'View card', options: [], view: request.view })
  }

  private async create(tx: AsyncTx, request: { ticketId: string; assignmentId: string; sessionId: string; question: string;
    options: string[]; input?: WorkInput; view?: ProductViewCard; pathGrants?: PathGrant[]; pathGrantApproval?: string }) {
    identifier(request.ticketId, 'ticketId'); identifier(request.assignmentId, 'assignmentId'); identifier(request.sessionId, 'sessionId')
    if (!request.question.trim() || Buffer.byteLength(request.question) > 4096) throw new CoreError('INVALID_INPUT', 'A human question needs bounded nonempty text.')
    if (!Array.isArray(request.options) || request.options.length > 10 || request.options.some(option => !option.trim() || Buffer.byteLength(option) > 512)) throw new CoreError('INVALID_ATTENTION', 'Attention options must contain at most ten bounded labels.')
    const ticket = await tx.get<Work['ticket']>('ticket', request.ticketId)
    const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
    const intent = await tx.get<Work['intent']>('intent', request.ticketId)
    if (!ticket || !trigger || !intent) throw new CoreError('NOT_FOUND', 'The Ticket cannot ask a human question.')
    if (ticket.constraint?.kind === 'stopped') throw new CoreError('TICKET_STOPPED', 'A stopped Ticket cannot ask another question.')
    const previousHead = await tx.get<AttentionHead>('attention-head', headKey(request.ticketId))
    const inputEvent = request.input && await tx.get<SourceEvent>('source-event', request.input.sourceEventId)
    const defaultTarget = triggerDeliveryTarget(trigger)
    const originalEvent = !inputEvent && trigger.deliveryOrigin ? await tx.get<SourceEvent>('source-event', trigger.deliveryOrigin.sourceEventId)
      : !inputEvent && trigger.threadId ? await this.sources.candidate(tx, { threadId: trigger.threadId, objectId: trigger.eventId }) : undefined
    const destination = inputEvent
      ? { sourceInstanceId: inputEvent.source.sourceInstanceId, actorId: inputEvent.authorId, eventId: inputEvent.objectId, ...(inputEvent.threadId ? { threadId: inputEvent.threadId } : {}) }
      : { sourceInstanceId: originalEvent?.source.sourceInstanceId ?? defaultTarget.source.sourceInstanceId, actorId: originalEvent?.authorId ?? defaultTarget.source.actorId,
        eventId: originalEvent?.objectId ?? defaultTarget.eventId, ...(defaultTarget.threadId ? { threadId: defaultTarget.threadId } : {}) }
    const id = `${historyPrefix(request.ticketId)}:${randomUUID()}`
    const sequenceKey = JSON.stringify(['attention-meta', request.ticketId])
    const sequence = (await tx.get<number>('attention-meta', sequenceKey) ?? 0) + 1
    if (!Number.isSafeInteger(sequence)) throw new CoreError('ATTENTION_BUDGET', 'The Ticket Attention sequence is exhausted.')
    if (!await tx.replace('attention-meta', sequenceKey, sequence)) await tx.insert('attention-meta', sequenceKey, sequence)
    if (previousHead) {
      const previous = await tx.get<Attention>('attention', previousHead.attentionId)
      const options = [...new Set(request.options.map(option => option.trim()).filter(Boolean))]
      if (previous?.status === 'waiting' && previous.question.trim() === request.question.trim()
        && previous.options.length === options.length && previous.options.every((option, index) => option === options[index])
        && JSON.stringify(previous.view ?? null) === JSON.stringify(request.view ?? null)
        && JSON.stringify(previous.requestedPathGrants ?? null) === JSON.stringify(request.pathGrants ?? null)
        && previous.pathGrantApproval === request.pathGrantApproval) {
        return previous
      }
      if (previous?.status === 'waiting') await tx.replace('attention', previous.id, { ...previous, status: 'superseded', supersededAt: this.now(), supersededBy: id })
    }
    const attention: Attention = { id, instanceId: this.instanceId, ticketId: request.ticketId, assignmentId: request.assignmentId, sessionId: request.sessionId,
      question: request.question, options: [...new Set(request.options.map(option => option.trim()).filter(Boolean))], destination,
      ...(inputEvent || originalEvent ? { questionSourceEventId: inputEvent?.id ?? originalEvent!.id } : {}), status: 'waiting', sequence, createdAt: this.now() }
    if (request.view) attention.view = structuredClone(request.view)
    if (request.pathGrants?.length) attention.requestedPathGrants = structuredClone(request.pathGrants)
    if (request.pathGrantApproval) attention.pathGrantApproval = request.pathGrantApproval
    await tx.insert('attention', id, attention)
    if (!await tx.replace('attention-head', headKey(request.ticketId), { attentionId: id })) await tx.insert('attention-head', headKey(request.ticketId), { attentionId: id })
    await tx.replace('ticket', ticket.id, { ...ticket, constraint: { kind: 'waiting-human', attentionId: id, reason: request.question } })
    await tx.replace('intent', ticket.id, { ...intent, state: 'pending', reason: 'waiting-human' })
    const deliveryId = `${ticket.id}:attention:${id}`
    const effect = await this.effects.enqueue(tx, { key: `attention:${id}`, stream: 'outbox', scope: ticket.id,
      payload: { purpose: 'attention', ticketId: ticket.id, attentionId: id, deliveryId } })
    await this.deliveries.record(tx, { id: deliveryId, ticketId: ticket.id, purpose: 'attention', text: attention.question,
      destination, basis: { kind: 'waiting-attention', attentionId: id }, effectId: effect.id, effectGeneration: effect.generation }, effect)
    return attention
  }

  async answer(tx: AsyncTx, request: { ticketId: string; attentionId: string; text: string; commandId: string; actorId: string;
    sourceEventId?: string; expectedGeneration?: string; expectedVersion?: number; viewAnswer?: ProductViewAnswer }) {
    identifier(request.ticketId, 'ticketId'); identifier(request.attentionId, 'attentionId'); identifier(request.commandId, 'commandId'); identifier(request.actorId, 'actorId')
    if (!request.text.trim() || Buffer.byteLength(request.text) > 65536) throw new CoreError('INVALID_INPUT', 'An Attention answer needs bounded nonempty text.')
    const attention = await tx.get<Attention>('attention', request.attentionId)
    const head = await tx.get<AttentionHead>('attention-head', headKey(request.ticketId))
    const ticket = await tx.get<Work['ticket']>('ticket', request.ticketId)
    if (!attention || !head || !ticket) throw new CoreError('NOT_FOUND', 'The Attention does not exist.')
    const waitingCurrent = ticket.constraint?.kind === 'waiting-human' && ticket.constraint.attentionId === attention.id
    if (ticket.constraint?.kind === 'stopped') throw new CoreError('TICKET_STOPPED', 'A stopped work item cannot receive an Attention answer.')
    if (attention.ticketId !== request.ticketId || head.attentionId !== attention.id || !waitingCurrent) {
      throw new CoreError('ATTENTION_STALE', 'This question is no longer the current waiting-human constraint.')
    }
    const assignment = request.expectedGeneration === undefined ? undefined
      : await tx.get<{ id: string; generation: string }>('assignment', request.ticketId)
    if (request.expectedGeneration !== undefined && (!assignment || assignment.generation !== request.expectedGeneration
      || attention.assignmentId !== assignment.id)
      || request.expectedVersion !== undefined && attention.sequence !== request.expectedVersion) {
      throw new CoreError('ATTENTION_STALE', 'This question version no longer matches the work card.')
    }
    if (attention.status !== 'waiting') throw new CoreError('ATTENTION_STALE', 'This question has already been answered or superseded.')
    const answerEventId = request.sourceEventId ?? JSON.stringify(['attention-answer', attention.id, request.commandId])
    const input = await this.inputs.attachSyntheticInput(tx, { ticketId: request.ticketId, sourceEventId: answerEventId,
      threadId: attention.destination.threadId ?? '__attention__', text: request.text, authorId: request.actorId,
      reason: `Answer to ${attention.id}`, dispatch: true })
    const approvedPathGrants = request.text.trim() === (attention.pathGrantApproval ?? attentionPathApproval)
      ? attention.requestedPathGrants : undefined
    const retainedPathGrants = await this.inputs.applyAttentionPathGrants(tx, { ticketId: request.ticketId,
      directionVersion: input.directionVersion, previousDirectionVersion: input.directionVersion - 1,
      ...(approvedPathGrants ? { grants: approvedPathGrants } : {}) })
    const answeredAt = this.now()
    const answered: Attention = { ...attention, status: 'answered', answeredAt, answeredBy: request.actorId, answerText: request.text,
      answerCommandId: request.commandId, answerSourceEventId: answerEventId,
      ...(request.viewAnswer ? { answerView: structuredClone(request.viewAnswer) } : {}),
      ...(approvedPathGrants && retainedPathGrants?.length ? { approvedPathGrants: structuredClone(retainedPathGrants) } : {}) }
    await tx.replace('attention', attention.id, answered)
    const updatedTicket = (await tx.get<Work['ticket']>('ticket', request.ticketId))!
    const { constraint: _constraint, ...openTicket } = updatedTicket
    await tx.replace('ticket', ticket.id, { ...openTicket, state: 'open' })
    return { attention: answered, input }
  }

  async supersedeForStop(tx: AsyncTx, ticketId: string) {
    const current = await this.current(tx, ticketId)
    if (current?.status !== 'waiting') return
    await tx.replace('attention', current.id, { ...current, status: 'superseded', supersededAt: this.now(), supersededBy: 'human-stop' })
  }

  async current(tx: AsyncTx, ticketId: string) {
    const head = await tx.get<AttentionHead>('attention-head', headKey(ticketId))
    return head ? tx.get<Attention>('attention', head.attentionId) : undefined
  }

  async history(tx: AsyncTx, ticketId: string) {
    const items: Attention[] = []
    const prefix = `${historyPrefix(ticketId)}:`
    let cursor = prefix
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await tx.scan<Attention>('attention', { limit: 100, after: cursor })
      for (const item of page.items) {
        if (!item.id.startsWith(prefix)) break
        if (item.value.ticketId === ticketId) items.push(item.value)
      }
      if (!page.cursor || !page.cursor.startsWith(prefix)) return items.sort((left, right) => left.sequence - right.sequence)
      cursor = page.cursor
      if (pageCount === 9) {
        const confirmation = await tx.scan<Attention>('attention', { limit: 1, after: cursor })
        if (!confirmation.items[0]?.id.startsWith(prefix) || confirmation.items[0].value.ticketId !== ticketId) {
          return items.sort((left, right) => left.sequence - right.sequence)
        }
      }
    }
    throw new CoreError('ATTENTION_BUDGET', 'The Ticket Attention history exceeds its 1000-record budget.')
  }

  async get(attentionId: string) {
    identifier(attentionId, 'attentionId')
    return this.storage.transaction(this.instanceId, tx => tx.get<Attention>('attention', attentionId))
  }
}
