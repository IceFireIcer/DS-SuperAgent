import { createHash } from 'node:crypto'
import { identifier, CoreError, type DesktopSource } from '../model.js'
import type { ReceiveSourceEvent } from '../source-events.js'
import type { ImMainEvent, ImPlatformId } from './types.js'
import { IM_PLATFORM_IDS } from './types.js'

export const IM_SOURCE_INSTANCE_ID = 'im'

export interface ImMainBindingOptions {
  platform: ImPlatformId
  accountId: string
  allowedRequesterIds: string[]
  actorId?: string
}

export interface ImHostSourceBindingOptions {
  allowedRequesterIds?: string[]
  actorId?: string
}

export interface ImThreadRoute {
  platform: ImPlatformId
  accountId: string
  connectionId: string
  chatKind: 'direct' | 'group'
  chatKey: string
}

/**
 * The Host creates one Engine binding for an IM connection. The source identity is
 * "im:" but the existing Engine SourceKind stays desktop until the product adds a
 * first-class IM kind; no Bot or group runtime is involved.
 */
export function imMainSourceBinding(options: ImMainBindingOptions): DesktopSource {
  const actorId = options.actorId ?? 'im-receiver'
  return {
    sourceInstanceId: imSourceInstanceId(options.platform, options.accountId),
    actorId,
    allowedActorIds: [actorId],
    allowedThreadPrefixes: [`${imSourceInstanceId(options.platform, options.accountId)}:`],
    versionOrder: 'sequence',
    intake: {
      mode: 'auto',
      maxBatchSize: 5,
      maxAttempts: 1,
      timeoutMs: 30_000,
      allowedRequesterIds: [...new Set(options.allowedRequesterIds)],
      allowedBotActorIds: [],
      rules: [],
    },
  }
}

export function imSourceInstanceId(platform: ImPlatformId, accountId: string): string {
  const result = `im:${platform}:${encodeIdentity(accountId)}`
  identifier(result, 'imSourceInstanceId')
  return result
}

export function imRequesterId(platform: ImPlatformId, connectionId: string, senderId: string): string {
  const connection = boundedIdentity(connectionId, 'connectionId')
  const sender = boundedIdentity(senderId, 'senderId')
  return `im:${platform}:${createHash('sha256').update(JSON.stringify([connection, sender])).digest('hex')}`
}

/**
 * One Host-owned Engine receives every IM conversation. Per-connection identity lives
 * in the Thread ID, while the Intake Policy holds qualified "platform:sender" IDs.
 */
export function imHostSourceBinding(options: ImHostSourceBindingOptions = {}): DesktopSource {
  const actorId = options.actorId ?? 'im-receiver'
  return {
    sourceInstanceId: IM_SOURCE_INSTANCE_ID,
    actorId,
    allowedActorIds: [actorId],
    allowedThreadPrefixes: ['im:'],
    versionOrder: 'sequence',
    intake: {
      mode: 'auto',
      maxBatchSize: 5,
      maxAttempts: 1,
      timeoutMs: 30_000,
      allowedRequesterIds: [...new Set(options.allowedRequesterIds ?? [])],
      allowedBotActorIds: [],
      rules: [],
    },
  }
}

export function imThreadId(route: ImThreadRoute): string {
  if (!['direct', 'group'].includes(route.chatKind)) throw new CoreError('INVALID_INPUT', 'IM chat kind is invalid.')
  const result = ['im', route.platform, encodeIdentity(route.accountId), encodeIdentity(route.connectionId),
    route.chatKind, encodeIdentity(route.chatKey)].join(':')
  identifier(result, 'imThreadId')
  return result
}

export function parseImThread(threadId: string): ImThreadRoute | undefined {
  if (typeof threadId !== 'string' || Buffer.byteLength(threadId) > 512 || !threadId.startsWith('im:')) return undefined
  const parts = threadId.split(':')
  if (parts.length !== 6) return undefined
  const [, platform, account, connectionId, chatKind, chatKey] = parts
  if (!platform || !account || !connectionId || !chatKey || chatKind !== 'direct' && chatKind !== 'group') return undefined
  try {
    const route: ImThreadRoute = {
      platform: platform as ImPlatformId,
      accountId: decodeIdentity(account, 'accountId'),
      connectionId: decodeIdentity(connectionId, 'connectionId'),
      chatKind: chatKind as ImThreadRoute['chatKind'],
      chatKey: decodeIdentity(chatKey, 'chatKey'),
    }
    if (!IM_PLATFORM_IDS.includes(route.platform) || imThreadId(route) !== threadId) return undefined
    return route
  } catch {
    return undefined
  }
}

function encodeIdentity(value: string): string {
  const bytes = Buffer.from(boundedIdentity(value, 'IM identity'), 'utf8')
  return bytes.toString('base64url')
}

function decodeIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new CoreError('INVALID_INPUT', `${label} has invalid encoding.`)
  const decoded = boundedIdentity(Buffer.from(value, 'base64url').toString('utf8'), label)
  if (encodeIdentity(decoded) !== value) throw new CoreError('INVALID_INPUT', `${label} has noncanonical encoding.`)
  return decoded
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > 112) {
    throw new CoreError('INVALID_INPUT', `${label} must contain 1 to 112 UTF-8 bytes.`)
  }
  identifier(value, label)
  return value
}

/** This is the direct input to Engine.receiveSourceForMain on the connection Engine. */
export function toReceiveSourceEvent(event: ImMainEvent): ReceiveSourceEvent {
  return {
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
}
