import { createHash } from 'node:crypto'
import { canonicalJson } from './commands.js'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import { isCurrentSourceEvent, type SourceEvent } from './source-events.js'

export type MainSourceHandoffState = 'pending' | 'presented' | 'delegated' | 'discarded'

export interface MainSourceHandoff {
  id: string
  version: 1
  instanceId: string
  mainId: string
  sourceEventId: string
  sourceInstanceId: string
  threadId: string
  objectId: string
  authorId: string
  authorKind: SourceEvent['authorKind']
  addressing: SourceEvent['addressing']
  nativeVersion: SourceEvent['version']
  text: string
  reference: string
  state: MainSourceHandoffState
  mainMessageId?: string
  workBriefId?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface MainSourceDeliveryView {
  id: string
  ticketId: string
  purpose: 'acknowledgement' | 'answer' | 'attention' | 'result' | 'policy'
  state: 'pending' | 'sent' | 'dropped' | 'unknown'
  reconcileRequired: boolean
  attempts?: number
  reason?: string
  destination: { sourceInstanceId: string; actorId: string; eventId: string; threadId?: string }
}

export interface MainSourceView extends MainSourceHandoff {
  workItemIds: string[]
  ticketIds: string[]
  deliveries: MainSourceDeliveryView[]
  conditions: { ticketId: string; number: number; state: string; result?: string; reason?: string }[]
}

export const mainSourceHandoffID = (eventId: string) => `main-source-${createHash('sha256').update(eventId).digest('hex')}`
const commandKey = (eventId: string) => `main-source:${createHash('sha256').update(eventId).digest('hex')}`

/** A one-time, instance-qualified handoff from a trusted source adapter into the logical Main. */
export class MainSourceHandoffs {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly now: () => number = Date.now) {}

  async create(transaction: AsyncTx, request: { event: SourceEvent; mainId: string; commandId: string }): Promise<MainSourceHandoff> {
    identifier(request.mainId, 'mainId')
    identifier(request.commandId, 'commandId')
    const { event } = request
    if (event.instanceId !== this.instanceId || !await isCurrentSourceEvent(transaction, event)) {
      throw new CoreError('SOURCE_NOT_CURRENT', 'Only a current source event can be handed to Main.')
    }
    if (event.authorKind !== 'human' || event.addressing === 'ambient' || event.text === undefined || !event.text.trim()) {
      throw new CoreError('ACTOR_NOT_ALLOWED', 'Main source work requires an addressed current human request.')
    }
    const id = mainSourceHandoffID(event.id)
    const prior = await transaction.get<MainSourceHandoff>('main-source-handoff', id)
    if (prior) return prior
    const reference = `superagent://${encodeURIComponent(this.instanceId)}/source-events/${encodeURIComponent(event.id)}`
    const handoff: MainSourceHandoff = { id, version: 1, instanceId: this.instanceId, mainId: request.mainId,
      sourceEventId: event.id, sourceInstanceId: event.source.sourceInstanceId, threadId: event.threadId, objectId: event.objectId,
      authorId: event.authorId, authorKind: event.authorKind, addressing: event.addressing, nativeVersion: event.version,
      text: event.text, reference, state: 'pending', createdAt: this.now(), updatedAt: this.now() }
    await transaction.insert('main-source-handoff', id, handoff)
    await transaction.insert('main-source-command', commandKey(event.id), {
      fingerprint: createHash('sha256').update(canonicalJson(['main-source-handoff-v1', event.id, request.mainId])).digest('hex'),
      handoffId: id,
    })
    return handoff
  }

  async get(transaction: AsyncTx, id: string) {
    identifier(id, 'mainSourceHandoffId')
    return transaction.get<MainSourceHandoff>('main-source-handoff', id)
  }

  has(transaction: AsyncTx, eventId: string) {
    return transaction.get<MainSourceHandoff>('main-source-handoff', mainSourceHandoffID(eventId))
  }

  async update(transaction: AsyncTx, handoff: MainSourceHandoff, fields: Partial<Pick<MainSourceHandoff,
    'state' | 'mainMessageId' | 'workBriefId' | 'lastError'>>) {
    const next: MainSourceHandoff = { ...handoff, ...fields, updatedAt: this.now() }
    await transaction.replace('main-source-handoff', handoff.id, next)
    return next
  }

  async list(mainId: string, options: { limit?: number; after?: string } = {}) {
    identifier(mainId, 'mainId')
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.after !== undefined && (typeof options.after !== 'string' || options.after.length > 512)) {
      throw new CoreError('INVALID_INPUT', 'Main source history accepts a bounded page.')
    }
    return this.storage.transaction(this.instanceId, async transaction => {
      const items: MainSourceHandoff[] = []
      let scanAfter = options.after
      let lastIncluded = options.after
      for (let pages = 0; pages < 10; pages++) {
        const page = await transaction.scan<MainSourceHandoff>('main-source-handoff', { limit: 100, ...(scanAfter === undefined ? {} : { after: scanAfter }) })
        for (const entry of page.items) if (entry.value.mainId === mainId) {
          if (items.length === limit) return { items, cursor: lastIncluded }
          items.push(entry.value)
          lastIncluded = entry.id
        }
        scanAfter = page.cursor
        if (scanAfter === undefined) return { items }
      }
      throw new CoreError('MAIN_SOURCE_BUDGET', 'Main source history exceeds its 1000-record budget.')
    })
  }
}
