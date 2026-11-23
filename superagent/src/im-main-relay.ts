import { createHash } from 'node:crypto'
import type { DeliveryDestination, DeliveryResult } from './deliveries.js'
import type { ImAccounts, ImAddress, ImInbound } from './im-accounts/index.js'
import { CoreError, type DesktopSource } from './model.js'
import type { ReceiveSourceEvent } from './source-events.js'
import type { AsyncTx, Storage } from './storage.js'

export const imSource = 'im:paired'
const threadPrefix = 'im-thread:'

function digest(parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function imMainBinding(actorId: string): DesktopSource {
  return { kind: 'im', sourceInstanceId: imSource, actorId, allowedActorIds: [actorId],
    allowedThreadPrefixes: [threadPrefix], versionOrder: 'opaque',
    intake: { mode: 'off', rules: [], allowedRequesterIds: [actorId], allowedBotActorIds: [],
      maxBatchSize: 1, maxAttempts: 1, timeoutMs: 1000 } }
}

export class ImMainRelay {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly actorId: string,
    private readonly accept: (event: ReceiveSourceEvent) => Promise<unknown>, private readonly accounts: Pick<ImAccounts, 'send' | 'isPaired'>) {}

  async receive(message: ImInbound) {
    const { text, ...address } = message
    if (!this.accounts.isPaired(address)) return
    const threadId = `${threadPrefix}${digest([address.platform, address.accountId, address.pairId, address.conversationId, address.senderId])}`
    const objectId = digest([threadId, address.senderId, address.messageId])
    await this.storage.transaction(this.instanceId, async tx => {
      if (!await tx.get('im-main-address', objectId)) await tx.insert('im-main-address', objectId, { threadId, address })
    })
    if (!this.accounts.isPaired(address)) return
    await this.accept({ type: 'created', commandId: objectId, threadId, objectId, text,
      version: '1', authorId: this.actorId, authorKind: 'human', addressing: 'direct' })
  }

  async authorizedIn(tx: AsyncTx, threadId: string, objectId: string) {
    const route = await tx.get<{ threadId: string; address: ImAddress }>('im-main-address', objectId)
    return Boolean(route && route.threadId === threadId && this.accounts.isPaired(route.address))
  }

  async deliver(destination: DeliveryDestination, text: string, context: { idempotencyKey: string; signal: AbortSignal }): Promise<DeliveryResult> {
    if (destination.sourceInstanceId !== imSource || destination.actorId !== this.actorId || !destination.threadId) {
      return { type: 'permanent', reason: 'IM_AUDIENCE_CHANGED' }
    }
    const route = await this.storage.transaction(this.instanceId, tx =>
      tx.get<{ threadId: string; address: ImAddress }>('im-main-address', destination.eventId))
    if (!route || route.threadId !== destination.threadId) return { type: 'permanent', reason: 'IM_AUDIENCE_CHANGED' }
    try {
      await this.accounts.send(route.address, text, context.idempotencyKey, context.signal)
      return { type: 'success' }
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'IM_SEND_UNKNOWN'
      if (code === 'SOURCE_NOT_AUTHORIZED' || code === 'IM_SEND_REJECTED' || code === 'INVALID_INPUT') {
        return { type: 'permanent', reason: code }
      }
      if (code === 'IM_UNAVAILABLE' && !context.signal.aborted) return { type: 'transient', reason: code }
      return { type: 'unknown', reason: 'IM_SEND_UNKNOWN' }
    }
  }
}
