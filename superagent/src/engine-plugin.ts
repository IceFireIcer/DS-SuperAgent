import type { Context } from '@deepseek-ai/cordis'
import { Engine } from './engine.js'
import { SqliteStorage, type Storage } from './storage.js'
import type { DesktopSource } from './model.js'
import type { EffectsOptions } from './effects.js'
import type { NativeSessions } from './native-sessions.js'
import type { ExecutionEnvironment } from './environment.js'
import type { SlotOptions } from './slots.js'
import type { JobsOptions } from './jobs.js'
import type { SubagentsOptions } from './subagents.js'
import type { DeliveryOptions } from './deliveries.js'
import type { HostOptions } from './host.js'
import type { ProactiveOptions } from './proactive.js'

export interface Config {
  databasePath: string
  instanceId: string
  source: DesktopSource
  storage?: Storage
  effects?: EffectsOptions
  sessions?: NativeSessions
  environments?: ExecutionEnvironment[]
  slots?: SlotOptions
  jobs?: JobsOptions
  subagents?: SubagentsOptions
  delivery?: DeliveryOptions
  host?: HostOptions
  proactive?: ProactiveOptions
}

export const name = 'ds-superagent-engine'

declare module '@deepseek-ai/cordis' {
  interface Context { superagent: Engine }
}

export async function apply(ctx: Context, config: Config) {
  const storage = config.storage ?? await SqliteStorage.open(config.databasePath)
  let engine: Engine | undefined
  ctx.effect(() => async () => {
    // Stop background work before releasing the lease, so the release is not lost to a racing transaction.
    try { await engine?.effects.stop(); await engine?.shutdown() } finally { await storage.close() }
  })
  engine = new Engine(storage, config.instanceId, config.source, config.effects, config.sessions, config.environments, config.slots, config.jobs, config.subagents, config.delivery, config.host, config.proactive)
  // A process may only serve an Instance after it holds the lease. A replacement reconciles the prior Host first.
  await engine.acquireHost()
  ctx.provide('superagent', engine)
  engine.effects.start()
}

export const enginePlugin = { name, apply }
