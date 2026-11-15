import { createHash } from 'node:crypto'
import { CoreError } from './model.js'
import type { DeliveryChannel, DeliveryContext, DeliveryResult, DeliveryView } from './deliveries.js'
import { FeishuApiError } from './feishu-api.js'

export interface FeishuReplyTransport {
  replyMessage(request: { messageId: string; text: string; uuid: string; signal: AbortSignal }): Promise<{ messageId: string }>
}

export interface FeishuDeliveryChannelOptions {
  /** IM replies are kept short; the full text remains in the Ticket. */
  maxTextChars?: number
  sourceInstanceId?: string
  /** Trusted runtime checks enabled state, account scope and native message access. */
  authorize?: (delivery: DeliveryView, signal: AbortSignal) => Promise<DeliveryResult | undefined>
  now?: () => number
  recordReceipt?: (receipt: { deliveryId: string; idempotencyKey: string; messageId: string; sourceInstanceId: string; fingerprint: string; recordedAt: number }) => Promise<void>
  findReceipt?: (deliveryId: string, idempotencyKey: string) => Promise<{ messageId: string; fingerprint: string } | undefined>
}

export function feishuQuestionCode(attentionId: string) {
  return createHash('sha256').update(attentionId).digest('hex').slice(0, 16)
}

/**
 * Deliver confirmations, questions, answers and results back into the exact Feishu
 * message that started the work. Feishu deduplicates the same uuid for one hour, so
 * a retry or reconcile inside that window cannot post twice.
 */
export class FeishuDeliveryChannel implements DeliveryChannel {
  private readonly maxTextChars: number
  constructor(private readonly transport: FeishuReplyTransport, private readonly options: FeishuDeliveryChannelOptions = {}) {
    this.maxTextChars = options.maxTextChars ?? 4000
    if (!Number.isInteger(this.maxTextChars) || this.maxTextChars < 200 || this.maxTextChars > 150000) {
      throw new CoreError('INVALID_CONFIG', 'A Feishu IM reply budget is 200–150000 characters.')
    }
  }

  deliver(delivery: DeliveryView, context: DeliveryContext): Promise<DeliveryResult> {
    return this.send(delivery, context)
  }

  reconcile(delivery: DeliveryView, context: DeliveryContext): Promise<DeliveryResult> {
    return this.send(delivery, context)
  }

  private async send(delivery: DeliveryView, context: DeliveryContext): Promise<DeliveryResult> {
    if (!delivery.destination.sourceInstanceId.startsWith('feishu:')) {
      return { type: 'permanent', reason: 'DESTINATION_MISMATCH: the delivery target is not a Feishu source.' }
    }
    if (this.options.sourceInstanceId && delivery.destination.sourceInstanceId !== this.options.sourceInstanceId) {
      return { type: 'permanent', reason: 'DESTINATION_MISMATCH: the delivery belongs to another Feishu instance.' }
    }
    const messageId = nativeMessageId(delivery.destination.eventId)
    if (!messageId) return { type: 'permanent', reason: 'DESTINATION_UNSUPPORTED: the target is not a Feishu message.' }
    const answerHint = delivery.purpose === 'attention' && delivery.basis.kind === 'waiting-attention'
      ? `\n\nReply with Q-${feishuQuestionCode(delivery.basis.attentionId)}: followed by your answer.` : ''
    const text = this.imText(delivery.text, this.maxTextChars - answerHint.length) + answerHint
    if (Buffer.byteLength(JSON.stringify({ text })) > 150 * 1024) {
      return { type: 'permanent', reason: 'MESSAGE_TOO_LARGE: the reply exceeds the Feishu text limit.' }
    }
    try {
      const fingerprint = createHash('sha256').update(JSON.stringify([delivery.destination, text])).digest('hex')
      const prior = await this.options.findReceipt?.(delivery.id, context.idempotencyKey)
      if (prior?.messageId) return prior.fingerprint === fingerprint ? { type: 'success' } : { type: 'unknown', reason: 'FEISHU_RECEIPT_CONFLICT' }
      const denied = await this.options.authorize?.(delivery, context.signal)
      if (denied) return denied
      // A delivery that never reached Feishu starts the one-hour window with its first request,
      // so time spent waiting in the local queue cannot block that send. After the window,
      // re-sending an uncertain attempt could duplicate a reply.
      const age = (this.options.now ?? Date.now)() - delivery.createdAt
      if ((delivery.attempts ?? 0) > 0 && (!Number.isFinite(age) || age < 0 || age >= 55 * 60 * 1000)) {
        return { type: 'unknown', reason: 'FEISHU_RECONCILIATION_REQUIRED: the safe uuid window has expired.' }
      }
      let receipt: { messageId: string }
      try {
        receipt = await this.transport.replyMessage({ messageId, text, uuid: uuidFor(context.idempotencyKey), signal: context.signal })
      } catch (error) {
        return this.failure(error, true)
      }
      if (!receipt.messageId) return { type: 'unknown', reason: 'FEISHU_RECEIPT_MISSING' }
      try {
        await this.options.recordReceipt?.({ deliveryId: delivery.id, idempotencyKey: context.idempotencyKey, messageId: receipt.messageId,
          sourceInstanceId: delivery.destination.sourceInstanceId, fingerprint, recordedAt: (this.options.now ?? Date.now)() })
      } catch {
        // Feishu accepted the reply; a missing local receipt is reconciled under the same uuid.
        return { type: 'unknown', reason: 'FEISHU_RECEIPT_UNRECORDED' }
      }
      return { type: 'success' }
    } catch (error) {
      return this.failure(error, false)
    }
  }

  private failure(error: unknown, mayHaveSent: boolean): DeliveryResult {
    if (error instanceof FeishuApiError) {
      const status = error.httpStatus ?? 0
      if (status === 429 || status >= 500) return { type: 'transient', reason: `FEISHU_HTTP_${status}` }
      if (status === 401 || status === 403) return { type: 'transient', reason: `FEISHU_PERMISSION_${status}` }
      if (error.feishuCode !== undefined && [99991400, 99991663, 230020].includes(error.feishuCode)) return { type: 'transient', reason: `FEISHU_${error.feishuCode}` }
      if (error.feishuCode === 230110) return { type: 'permanent', reason: 'DESTINATION_GONE: the Feishu message was deleted.' }
      if (error.feishuCode !== undefined && [230002, 230006, 230013, 230018, 230019, 230022, 230025, 230027, 230028, 230035, 230073, 230099, 231203, 231204].includes(error.feishuCode)) {
        return { type: 'permanent', reason: `FEISHU_${error.feishuCode}` }
      }
      return { type: 'unknown', reason: `FEISHU_${error.feishuCode ?? 'UNKNOWN'}` }
    }
    if (error instanceof CoreError && (error.code === 'INVALID_INPUT' || error.code === 'INVALID_CONFIG')) {
      return { type: 'permanent', reason: error.code }
    }
    if (error instanceof CoreError && ['GRANT_DENIED', 'RESOURCE_UNAVAILABLE', 'HOST_LEASED'].includes(error.code)) {
      // These checks run before the authorized callback can issue the HTTP request.
      return { type: 'transient', reason: error.code }
    }
    // A transport failure, timeout, stop or unreadable response may happen after Feishu took the
    // reply; only a failure before the request was made proves the reply does not exist.
    if (mayHaveSent) return { type: 'unknown', reason: error instanceof CoreError ? `FEISHU_${error.code}` : 'FEISHU_REQUEST_UNKNOWN' }
    return { type: 'transient', reason: error instanceof CoreError ? error.code : 'FEISHU_REQUEST_NOT_SENT' }
  }

  private imText(text: string, budget = this.maxTextChars) {
    if (text.length <= budget) return text
    const suffix = '\n\n[Truncated for Feishu. The full text is in the Ticket.]'
    return text.slice(0, Math.max(0, budget - suffix.length)) + suffix
  }
}

function nativeMessageId(eventId: string) {
  return eventId.startsWith('message:') ? eventId.slice('message:'.length) : undefined
}

/** Feishu accepts at most 50 characters and deduplicates this value for one hour. */
function uuidFor(idempotencyKey: string) {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
}
