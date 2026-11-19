import { createHash } from 'node:crypto'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import type { SourceEvent, SourceEvents } from './source-events.js'

export type DeliveryConditionKind = 'pr'
export type DeliveryConditionState = 'open' | 'draft' | 'merged' | 'closed'

export interface DeliveryCondition {
  id: string
  instanceId: string
  ticketId: string
  kind: DeliveryConditionKind
  sourceInstanceId: string
  repo: string
  number: number
  state: DeliveryConditionState
  basis: string
  createdBy: string
  createdAt: number
  updatedAt: number
  result?: 'completed' | 'merged' | 'dropped'
  reason?: string
}

export interface DeliveryTarget {
  id: string
  instanceId: string
  ticketId: string
  purpose: 'result' | 'answer'
  destination: { sourceInstanceId: string; actorId: string; threadId: string; objectId: string }
  evidence: string
  evidenceEventId?: string
  authorizedBy: string
  createdAt: number
}

const conditionPrefix = (ticketId: string) => `${JSON.stringify(['delivery-condition', ticketId])}:`
const conditionKey = (ticketId: string, sourceInstanceId: string, number: number) => createHash('sha256').update(JSON.stringify([ticketId, sourceInstanceId, number])).digest('hex')
const targetPrefix = (ticketId: string) => `${JSON.stringify(['delivery-target', ticketId])}:`

export class DeliveryState {
  constructor(
    private readonly storage: Storage,
    private readonly instanceId: string,
    private readonly sourceEvents: SourceEvents,
    private readonly now: () => number = Date.now,
  ) {}

  async bindCondition(tx: AsyncTx, request: { ticketId: string; kind: DeliveryConditionKind; sourceInstanceId: string; repo: string; number: number; basis: string; createdBy: string }): Promise<DeliveryCondition> {
    identifier(request.ticketId, 'ticketId'); identifier(request.basis, 'basis'); identifier(request.createdBy, 'createdBy')
    if (!Number.isInteger(request.number) || request.number < 1) throw new CoreError('INVALID_INPUT', 'A delivery condition needs a positive P/R number.')
    const id = `${conditionPrefix(request.ticketId)}${conditionKey(request.ticketId, request.sourceInstanceId, request.number)}`
    const existing = await tx.get<DeliveryCondition>('delivery-condition', id)
    if (existing) return existing
    const condition: DeliveryCondition = { id, instanceId: this.instanceId, ticketId: request.ticketId, kind: request.kind,
      sourceInstanceId: request.sourceInstanceId, repo: request.repo, number: request.number, state: 'open',
      basis: request.basis, createdBy: request.createdBy, createdAt: this.now(), updatedAt: this.now() }
    await tx.insert('delivery-condition', id, condition)
    const historyKey = `${JSON.stringify(['delivery-condition-history', request.ticketId])}:${id}`
    if (!await tx.replace('delivery-condition-history', historyKey, condition)) await tx.insert('delivery-condition-history', historyKey, condition)
    return condition
  }

  async reconcileFromSource(tx: AsyncTx, ticketId: string, event: { sourceInstanceId: string; text?: string }): Promise<DeliveryCondition[] | undefined> {
    // Only the adapter's structured header changes a condition; free text stays delivery evidence.
    const match = /^Pull request #([1-9]\d*) (created|edited|closed|merged|deleted)(?: \((open|draft|closed|merged)\))?\./u.exec(event.text ?? '')
    if (!match) return undefined
    const number = Number(match[1])
    const state = nativeConditionState(match[2], match[3])
    if (!Number.isSafeInteger(number) || !state) return undefined
    const id = `${conditionPrefix(ticketId)}${conditionKey(ticketId, event.sourceInstanceId, number)}`
    const condition = await tx.get<DeliveryCondition>('delivery-condition', id)
    if (!condition) return undefined
    const text = event.text ?? ''
    await this.updateState(tx, condition, state, text)
    return this.list(tx, ticketId)
  }

  async updateState(tx: AsyncTx, condition: DeliveryCondition, state: DeliveryConditionState, evidence: string) {
    const { result: _result, reason: _reason, ...current } = condition
    const stored: DeliveryCondition = state === 'merged' || state === 'closed'
      ? { ...current, state, updatedAt: this.now(), result: state === 'merged' ? 'merged' : 'dropped', reason: evidence.slice(0, 1024) }
      : { ...current, state, updatedAt: this.now() }
    await tx.replace('delivery-condition', condition.id, stored)
    const historyKey = `${JSON.stringify(['delivery-condition-history', condition.ticketId])}:${condition.id}:${this.now()}`
    if (!await tx.replace('delivery-condition-history', historyKey, stored)) await tx.insert('delivery-condition-history', historyKey, stored)
  }

  /** A Ticket with any open or draft P/R delivery condition is not finished by ready alone. */
  async outstanding(tx: AsyncTx, ticketId: string): Promise<DeliveryCondition[]> {
    return (await this.list(tx, ticketId)).filter(condition => condition.state === 'open' || condition.state === 'draft')
  }

  async list(tx: AsyncTx, ticketId: string): Promise<DeliveryCondition[]> {
    identifier(ticketId, 'ticketId')
    const items: DeliveryCondition[] = []
    let cursor = conditionPrefix(ticketId)
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await tx.scan<DeliveryCondition>('delivery-condition', { limit: 100, after: cursor })
      items.push(...page.items.map(item => item.value).filter(condition => condition.ticketId === ticketId))
      if (!page.cursor || !page.cursor.startsWith(conditionPrefix(ticketId))) return items
      cursor = page.cursor
    }
    throw new CoreError('DELIVERY_BUDGET', 'The Ticket delivery-condition history exceeds its 1000-record budget.')
  }

  async setTarget(tx: AsyncTx, request: { ticketId: string; purpose: 'result' | 'answer'; sourceInstanceId: string; actorId: string; threadId: string; objectId: string; evidence: string; evidenceEventId?: string; authorizedBy: string }): Promise<DeliveryTarget> {
    identifier(request.ticketId, 'ticketId'); identifier(request.sourceInstanceId, 'sourceInstanceId')
    identifier(request.actorId, 'actorId'); identifier(request.threadId, 'threadId'); identifier(request.objectId, 'objectId')
    if (!request.evidence.trim() || Buffer.byteLength(request.evidence) > 4096) throw new CoreError('INVALID_INPUT', 'A delivery-target change needs bounded evidence.')
    identifier(request.authorizedBy, 'authorizedBy')
    const target: DeliveryTarget = { id: `${targetPrefix(request.ticketId)}${request.purpose}`, instanceId: this.instanceId, ticketId: request.ticketId,
      purpose: request.purpose, destination: { sourceInstanceId: request.sourceInstanceId, actorId: request.actorId,
        threadId: request.threadId, objectId: request.objectId },
      evidence: request.evidence, ...(request.evidenceEventId ? { evidenceEventId: request.evidenceEventId } : {}), authorizedBy: request.authorizedBy, createdAt: this.now() }
    if (!await tx.replace('delivery-target', target.id, target)) await tx.insert('delivery-target', target.id, target)
    const decisionKey = `${JSON.stringify(['delivery-target-decision', request.ticketId])}:${createHash('sha256').update(JSON.stringify([request.purpose, request.sourceInstanceId, request.actorId, request.threadId, request.objectId, request.evidence])).digest('hex')}`
    if (!await tx.get('delivery-target-decision', decisionKey)) await tx.insert('delivery-target-decision', decisionKey, { ...target, recordedAt: this.now() })
    return target
  }

  async target(tx: AsyncTx, ticketId: string, purpose: 'result' | 'answer'): Promise<DeliveryTarget | undefined> {
    identifier(ticketId, 'ticketId')
    const target = await tx.get<DeliveryTarget>('delivery-target', `${targetPrefix(ticketId)}${purpose}`)
    if (!target || target.destination.actorId) return target
    const event = target.evidenceEventId ? await tx.get<SourceEvent>('source-event', target.evidenceEventId) : undefined
    if (!event?.authorId) throw new CoreError('INCOMPLETE_STATE', 'A stored delivery target is missing its evidence author identity.')
    const migrated: DeliveryTarget = { ...target, destination: { ...target.destination, actorId: event.authorId } }
    await tx.replace('delivery-target', target.id, migrated)
    return migrated
  }
}

function nativeConditionState(action: string | undefined, state: string | undefined): DeliveryConditionState | undefined {
  if (action === 'deleted') return 'closed'
  return state === 'open' || state === 'draft' || state === 'closed' || state === 'merged' ? state : undefined
}
