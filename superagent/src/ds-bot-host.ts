import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DsBotExecutionAdapter, type DsBotEngineFactory, type DsBotEngineFactoryResult, type DsBotNativeSessions } from './ds-bot-adapter.js'
import { Engine } from './engine.js'
import { CoreError } from './model.js'
import { NativeSessions } from './native-sessions.js'
import { SqliteStorage } from './storage.js'
import { LocalEnvironment } from './local-environment.js'
import type { DeliveryOptions } from './deliveries.js'
import type { EffectsOptions } from './effects.js'
import type { RoleModel } from './config.js'
import type { EnvironmentConfig } from './environment.js'

export interface DsBotEnvironmentConfig extends Partial<Omit<EnvironmentConfig, 'instanceId' | 'allowedActorIds'>> {
  root: string
}

export interface DsBotHostConfig {
  databasePath: string
  sourceInstanceId?: string
  actorId?: string
  allowedActorIds?: string[]
  instanceIdPrefix?: string
  hostId?: string
  leaseMs?: number
  timeoutMs?: number
  router?: RoleModel
  worker?: RoleModel
  effects?: EffectsOptions
  delivery?: DeliveryOptions
  /** The isolated working directory for Workers. False keeps the explicit answer-only mode. */
  environment?: DsBotEnvironmentConfig | false
}

function routeOf(context: Context, configured: DsBotHostConfig['router']) {
  if (configured) {
    if (!configured.provider || !configured.model) throw new CoreError('INVALID_CONFIG', 'The Router route needs a provider and model.')
    return { provider: configured.provider, model: configured.model }
  }
  const selection = context.get?.('agentDefaultModel')?.currentSelection?.()
  if (!selection?.provider || !selection.model) {
    throw new CoreError('INVALID_CONFIG', 'The production factory needs a profile default model or explicit Router/Worker routes.')
  }
  return { provider: selection.provider, model: selection.model }
}

function environmentRoot(config: DsBotHostConfig) {
  if (config.environment === false) return undefined
  return config.environment?.root?.trim() || process.env.DS_BOT_WORKSPACE?.trim() || undefined
}

function readSessionPage(context: Context): NonNullable<DsBotNativeSessions['readSessionPage']> {
  return async (sessionId, options = {}) => {
    const persistence = context.get('sessionPersistence')
    if (!persistence) throw new CoreError('PERSISTENCE_REQUIRED', 'A native Session persistence provider is required before execution.')
    const stored = await persistence.stat(SessionId(sessionId))
    if (!stored) throw new CoreError('NOT_FOUND', 'The Session history does not exist.')
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CoreError('INVALID_INPUT', 'Use a bounded Session page and a non-negative sequence cursor.')
    }
    const handle = await persistence.open(SessionId(sessionId), 'read')
    try {
      const page = await handle.read(offset, limit)
      return { sessionId, events: page.events, ...(stored.eventCount === undefined ? {} : { total: stored.eventCount }) }
    } finally {
      await handle.close()
    }
  }
}

/**
 * Build the production adapter used by the existing ds-bot Host. Each UI Session gets
 * one Engine over the shared business store; the Host's public Session provider owns
 * the native Agent logs. The adapter is closed by the ds-bot plugin effect.
 */
export async function createDsBotHostAdapter(context: Context, config: DsBotHostConfig) {
  if (!config || typeof config.databasePath !== 'string' || config.databasePath.trim() === '') {
    throw new CoreError('INVALID_CONFIG', 'The production factory needs an absolute database path.')
  }
  const router = routeOf(context, config.router)
  const worker = routeOf(context, config.worker)
  const actorId = config.actorId ?? 'local-user'
  const source = {
    kind: 'desktop' as const,
    sourceInstanceId: config.sourceInstanceId ?? 'ds-bot-host',
    actorId,
    allowedActorIds: [...(config.allowedActorIds ?? [actorId])],
    versionOrder: 'sequence' as const,
  }
  if (!source.allowedActorIds.includes(actorId)) throw new CoreError('INVALID_CONFIG', 'The configured actor must be allowed by the source.')
  const environmentConfig = config.environment === false ? undefined : config.environment
  const root = environmentRoot(config)
  if (root !== undefined && !isAbsolute(root)) throw new CoreError('INVALID_CONFIG', 'The Worker environment needs an absolute working directory.')
  if (root !== undefined) await mkdir(root, { recursive: true })
  const storage = await SqliteStorage.open(config.databasePath)
  const factory: DsBotEngineFactory = async ({ sessionId }): Promise<DsBotEngineFactoryResult> => {
    const instanceId = `${config.instanceIdPrefix ?? 'ds-bot-ui'}:${sessionId}`
    const sessions = new NativeSessions(context, { router, worker, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
    const environment = root === undefined ? undefined : await LocalEnvironment.open({
      id: environmentConfig?.id ?? 'workspace',
      instanceId,
      root,
      allowedActorIds: [actorId],
      permissions: environmentConfig?.permissions
        ? [...environmentConfig.permissions]
        : Object.keys(environmentConfig?.commands ?? {}).length > 0
          ? ['read', 'write', 'search', 'command']
          : ['read', 'write', 'search'],
      commands: structuredClone(environmentConfig?.commands ?? {}),
      ...(environmentConfig?.assetsPath ? { assetsPath: environmentConfig.assetsPath } : {}),
      ...(environmentConfig?.skillsPath ? { skillsPath: environmentConfig.skillsPath } : {}),
      ...(environmentConfig?.setup ? { setup: environmentConfig.setup } : {}),
    })
    let engine: Engine | undefined
    try {
      engine = new Engine(storage, instanceId, {
        ...source, allowedThreadIds: [sessionId],
      }, config.effects ?? {}, sessions, environment ? [environment] : [], {}, {}, {}, config.delivery ?? {}, {
        hostId: config.hostId ?? 'ds-bot-host',
        ...(config.leaseMs === undefined ? {} : { leaseMs: config.leaseMs }),
      })
      await engine.acquireHost()
      engine.effects.start()
      return {
        engine,
        sessions: { readSession: (id, options) => sessions.readSession(id, options), readSessionPage: readSessionPage(context) },
        actorId,
        dispose: async () => {
          const errors: unknown[] = []
          try { await engine?.effects.stop() } catch (error) { errors.push(error) }
          try { await engine?.shutdown() } catch (error) { errors.push(error) }
          try { await sessions.close() } catch (error) { errors.push(error) }
          try { await environment?.close() } catch (error) { errors.push(error) }
          if (errors.length) throw new AggregateError(errors, 'The production factory did not close cleanly.')
        },
      }
    } catch (error) {
      await Promise.allSettled([engine?.shutdown(), sessions.close(), environment?.close()])
      throw error
    }
  }
  const adapter = new DsBotExecutionAdapter({ factory, dispose: () => storage.close() })
  return adapter
}

export const name = 'ds-bot-host'
export const inject = ['sessionPersistence', 'agents', 'sessions']

/** Publish one adapter and close it with the owning Host effect. */
export function mountBotExecutionAdapter(context: Context, adapter: DsBotExecutionAdapter) {
  context.provide('botExecutionAdapter', adapter)
  context.effect(() => () => adapter.close())
}

export async function apply(context: Context, config: DsBotHostConfig) {
  const adapter = await createDsBotHostAdapter(context, config)
  mountBotExecutionAdapter(context, adapter)
}
