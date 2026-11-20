import { createHash } from 'node:crypto'
import type { Engine } from '../engine.js'
import { CoreError } from '../model.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import type { DeliveryChannel, DeliveryResult, DeliveryView } from '../deliveries.js'
import type { ReceiveSourceEvent } from '../source-events.js'
import { ImServiceError, safeError } from './errors.js'
import { imRequesterId, parseImThread } from './main.js'
import { createImService, type ImService, type ImServiceOptions } from './service.js'
import { CredentialImPersistence, CredentialImReceipts } from './store.js'
import type { ImMainEvent, ImPlatformId, ImRegistryView } from './types.js'

export interface ImHostOptions extends Omit<ImServiceOptions, 'instanceId' | 'main' | 'persistence'> {
  instanceId: string
  credentialRecords: ProductCredentialRecords
  onLog?: { warn?(template: string, ...args: unknown[]): void }
}

export type ImEngineBinding = Pick<Engine,
  'receiveSourceForMain' | 'getIntakePolicy' | 'updateIntakePolicy'>
  & { effects: Pick<Engine['effects'], 'start'> }

export interface ImSourceReply {
  id: string
  text: string
  destination: { sourceInstanceId: string; actorId: string; eventId: string; threadId?: string }
  createdAt: number
  attempts?: number
}

export interface ImSourceReplyContext {
  idempotencyKey: string
  signal: AbortSignal
}

export interface ImHostDeliveryChannel extends DeliveryChannel {
  deliverSourceReply(reply: ImSourceReply, context: ImSourceReplyContext): Promise<DeliveryResult>
  reconcileSourceReply(reply: ImSourceReply, context: ImSourceReplyContext): Promise<DeliveryResult>
}

export interface ImHost {
  readonly service: ImService
  readonly deliveryChannel: ImHostDeliveryChannel
  bindEngine(engine: ImEngineBinding): void
  start(): Promise<ImRegistryView>
  dispatch(endpoint: string, payload?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

const transient = (reason: string): DeliveryResult => ({ type: 'transient', reason })
const permanent = (reason: string): DeliveryResult => ({ type: 'permanent', reason })
const unknown = (reason: string): DeliveryResult => ({ type: 'unknown', reason })

function deliveryFingerprint(delivery: DeliveryView): string {
  return createHash('sha256').update(JSON.stringify([
    delivery.destination,
    delivery.text,
    delivery.purpose,
    delivery.basis,
  ])).digest('hex')
}

/**
 * Host-owned IM assembly. Bind an Engine created with imHostSourceBinding() and this
 * deliveryChannel, then start it after the Host has acquired its Engine lease.
 */
export function createImHost(options: ImHostOptions): ImHost {
  if (typeof options.instanceId !== 'string' || options.instanceId.trim() === '') {
    throw new CoreError('INVALID_CONFIG', 'IM Host assembly needs an Instance ID.')
  }
  const persistence = new CredentialImPersistence(options.credentialRecords, options.instanceId)
  const receipts = new CredentialImReceipts(options.credentialRecords, options.instanceId)
  const service = createImService({
    ...options,
    instanceId: options.instanceId,
    persistence,
    ...(options.onLog ?? options.log ? { log: options.onLog ?? options.log } : {}),
    authorizeSend: async request => {
      await options.authorizeSend?.(request)
      if (!engine) throw new ImServiceError('The IM Host has no bound Engine.', { code: 'IM_ENGINE_UNBOUND', permanent: true })
      const policy = await engine.getIntakePolicy()
      if (policy.processingPaused) {
        throw new ImServiceError('Main processing is paused.', { code: 'PROCESSING_PAUSED', retryable: true })
      }
      if (!policy.policy.allowedRequesterIds.includes(request.requesterId)) {
        throw new ImServiceError('The original IM requester is no longer authorized.', {
          code: 'SOURCE_POLICY_REVOKED', permanent: true,
        })
      }
    },
  })
  let engine: ImEngineBinding | undefined
  let startPromise: Promise<ImRegistryView> | undefined
  let closePromise: Promise<void> | undefined
  let closed = false

  const requesterIds = (registry: ImRegistryView) => [...new Set(registry.connections.flatMap(connection =>
    connection.paired.map(account => imRequesterId(connection.platform, connection.id, account.id))))].sort()

  const syncPolicy = async () => {
    if (!engine) throw new CoreError('IM_ENGINE_UNBOUND', 'Bind the IM Host to its Engine before starting connections.')
    const allowedRequesterIds = requesterIds(service.registry(options.instanceId))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await engine.getIntakePolicy()
      const currentIds = [...current.policy.allowedRequesterIds].sort()
      if (JSON.stringify(currentIds) === JSON.stringify(allowedRequesterIds)) return
      const sourceRevision = createHash('sha256').update(JSON.stringify([current.revision, allowedRequesterIds])).digest('hex')
      try {
        await engine.updateIntakePolicy({
          commandId: `im-policy-sync:${sourceRevision}`,
          expectedRevision: current.revision,
          origin: 'sync',
          sourceRevision,
          policy: { ...current.policy, allowedRequesterIds },
        })
        return
      } catch (error) {
        if (!(error instanceof CoreError) || error.code !== 'POLICY_REVISION_CONFLICT' || attempt === 2) throw error
      }
    }
  }

  const receiveMain = async (event: ImMainEvent) => {
    if (!engine) throw new CoreError('IM_ENGINE_UNBOUND', 'The IM Host has no bound Engine.')
    const input: ReceiveSourceEvent = {
      commandId: event.commandId,
      threadId: event.threadId,
      objectId: event.objectId,
      type: 'created',
      version: event.version,
      text: event.text,
      authorId: event.requesterId,
      authorKind: 'human',
      addressing: event.addressing,
    }
    return engine.receiveSourceForMain(input)
  }

  const sendDurably = async (key: string, threadId: string, requesterId: string, text: string,
    buttons?: { label: string; data: string }[]) => {
    const existing = await receipts.get(key)
    if (existing?.state === 'sent') return { type: 'success' as const }
    if (existing) return unknown('IM_SEND_OUTCOME_UNKNOWN: a prior Host attempt may already have reached the platform.')
    try {
      await service.checkSendAuthorization(options.instanceId, threadId, requesterId)
    } catch (error) {
      const safe = safeError(error)
      if (safe.code === 'PROCESSING_PAUSED') return transient(safe.code)
      return safe.permanent ? permanent(safe.code) : transient(safe.code)
    }
    const reserved = await receipts.begin(key, Date.now())
    if (!reserved.created) {
      if (reserved.receipt.state === 'sent') return { type: 'success' as const }
      return unknown('IM_SEND_OUTCOME_UNKNOWN: another or previous Host attempt owns this delivery.')
    }
    try {
      const result = await service.sendOnce(options.instanceId, threadId, requesterId, text, buttons)
      await receipts.finish(key, {
        state: 'sent',
        sentAt: Date.now(),
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
      })
      return { type: 'success' as const }
    } catch (error) {
      const safe = safeError(error)
      if (safe.status === 429) {
        await receipts.abandon(key).catch(() => {})
        return transient(safe.code)
      }
      if (safe.permanent) {
        await receipts.abandon(key).catch(() => {})
        return permanent(safe.code)
      }
      await receipts.finish(key, { state: 'unknown', sentAt: Date.now() }).catch(() => {})
      return unknown('IM_SEND_OUTCOME_UNKNOWN: the platform did not confirm whether it accepted the message.')
    }
  }

  const deliveryChannel: ImHostDeliveryChannel = {
    deliver: async (delivery, context) => {
      if (delivery.destination.sourceInstanceId !== 'im' || !delivery.destination.threadId) {
        return permanent('DESTINATION_SOURCE_DISABLED')
      }
      const route = parseImThread(delivery.destination.threadId)
      if (!route) return permanent('DESTINATION_INVALID')
      context.signal.throwIfAborted()
      return sendDurably(`delivery:${context.idempotencyKey}:${deliveryFingerprint(delivery)}`,
        delivery.destination.threadId, delivery.destination.actorId, delivery.text)
    },
    reconcile: async (delivery, context) => {
      if (delivery.destination.sourceInstanceId !== 'im' || !delivery.destination.threadId) return permanent('DESTINATION_SOURCE_DISABLED')
      const key = `delivery:${context.idempotencyKey}:${deliveryFingerprint(delivery)}`
      const receipt = await receipts.get(key)
      if (receipt?.state === 'sent') return { type: 'success' }
      if (receipt) return unknown('IM_SEND_OUTCOME_UNKNOWN: the original platform send needs human reconciliation.')
      return unknown('IM_SEND_OUTCOME_UNKNOWN: no Host receipt proves that retrying the original send is safe.')
    },
    deliverSourceReply: async (reply, context) => {
      if (reply.destination.sourceInstanceId !== 'im' || !reply.destination.threadId) return permanent('DESTINATION_SOURCE_DISABLED')
      if (!parseImThread(reply.destination.threadId)) return permanent('DESTINATION_INVALID')
      context.signal.throwIfAborted()
      return sendDurably(`main-source-reply:${context.idempotencyKey}:${reply.id}`,
        reply.destination.threadId, reply.destination.actorId, reply.text)
    },
    reconcileSourceReply: async (reply, context) => {
      if (reply.destination.sourceInstanceId !== 'im' || !reply.destination.threadId) return permanent('DESTINATION_SOURCE_DISABLED')
      const key = `main-source-reply:${context.idempotencyKey}:${reply.id}`
      const receipt = await receipts.get(key)
      if (receipt?.state === 'sent') return { type: 'success' }
      return unknown('IM_SEND_OUTCOME_UNKNOWN: the original Main reply requires reconciliation before another send.')
    },
  }

  return {
    service,
    deliveryChannel,
    bindEngine(value) {
      if (engine && engine !== value) throw new CoreError('IM_ENGINE_BOUND', 'The IM Host is already bound to another Engine.')
      engine = value
      service.setMainSink({ accept: receiveMain })
    },
    async start() {
      if (closed) throw new CoreError('IM_HOST_CLOSED', 'The IM Host has been closed.')
      if (startPromise) return startPromise
      if (!engine) throw new CoreError('IM_ENGINE_UNBOUND', 'Bind the IM Host to its Engine before starting it.')
      startPromise = (async () => {
        await service.initialize()
        await syncPolicy()
        engine!.effects.start()
        return service.startAll(options.instanceId)
      })()
      try { return await startPromise }
      catch (error) { startPromise = undefined; throw error }
    },
    async dispatch(endpoint, payload = {}) {
      if (closed) throw new CoreError('IM_HOST_CLOSED', 'The IM Host has been closed.')
      const result = await service.dispatch(endpoint, payload)
      if (endpoint === 'im-save' || endpoint === 'im-pair' || endpoint === 'im-login') await syncPolicy()
      return result
    },
    async close() {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        await service.dispose()
      })()
      return closePromise
    },
  }
}

export function imRequesterFor(platform: ImPlatformId, connectionId: string, senderId: string): string {
  return imRequesterId(platform, connectionId, senderId)
}
