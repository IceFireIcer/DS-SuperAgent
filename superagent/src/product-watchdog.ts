import { writeFile, rename } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CoreError } from './model.js'
import type { Engine } from './engine.js'
import type { ProcessWatchdogStatus } from './watchdog-process.js'
import type { WatchdogProbe } from './watchdog.js'

/** Only bounded operational facts cross the Host/process boundary; no prompts, paths or credentials. */
export async function productWatchdogProbe(engine: Engine, instanceId: string, source?: { id: string; state: string; error?: string }, setupError?: string, supervisorError?: string): Promise<WatchdogProbe> {
  const [main, supervision, observations, roleResult] = await Promise.all([
    engine.getMainConversation({ instanceId, limit: 1 }),
    engine.getSupervision(),
    engine.getWorkObservations({ instanceId, limit: 100 }),
    engine.getRoleConfig().then(roles => ({ roles }), error => {
      if (!(error instanceof CoreError) || !['INVALID_CONFIG', 'ROLE_NOT_CONFIGURED'].includes(error.code)) throw error
      return { error: error.code }
    }),
  ])
  const components: NonNullable<WatchdogProbe['components']> = []
  if (main.health.state === 'degraded') components.push({ id: 'main', kind: 'other', state: 'failed', error: main.health.errorCode ?? 'MAIN_DEGRADED' })
  if (supervisorError) components.push({ id: 'supervisor', kind: 'other', state: 'failed', error: supervisorError })
  if (supervision.hasMore || supervision.items.length > 100 || observations.cursor) components.push({ id: 'inspection-budget', kind: 'other', state: 'failed', error: 'PARTIAL_HEALTH' })
  const unknownJobs = supervision.items.reduce((sum, item) => sum + Number((item.health as { jobsUnknown?: number })?.jobsUnknown ?? 0), 0)
  if (unknownJobs > 0) components.push({ id: 'unknown-jobs', kind: 'other', state: 'failed', error: 'UNKNOWN_RESULTS' })
  for (const item of observations.items) {
    if (item.status === 'failed' && (item.role === 'router' || item.role === 'worker')) {
      components.push({ id: `${item.role}:${item.id}`, kind: 'other', state: 'failed', error: 'ROLE_FAILED' })
    }
  }
  return {
    service: 'healthy', normalWaits: supervision.counts.needsHuman + supervision.counts.stopped + supervision.counts.blocked,
    paused: supervision.processingPaused,
    unknownEffects: supervision.items.reduce((sum, item) => sum + Number((item.health as { effectsUnknown?: number })?.effectsUnknown ?? 0), 0),
    sources: source ? [{ id: source.id, state: source.state === 'running' ? 'polling' : source.state === 'failed' ? 'failed'
      : source.state === 'setup' ? 'setup' : source.state === 'stopped' ? 'stopped' : 'idle',
      ...(source.error ? { error: source.error } : {}) }] : [],
    setups: [ ...(setupError ? [{ id: 'feishu', state: 'failed' as const, error: setupError }] : []),
      ...('error' in roleResult ? [{ id: 'roles', state: 'failed' as const, error: roleResult.error }] : []),
      ...('roles' in roleResult ? (['main', 'router', 'worker'] as const).filter(role => roleResult.roles.roles[role]?.model.provider === 'unconfigured')
        .map(role => ({ id: role, state: 'missing' as const, error: 'MODEL_NOT_CONFIGURED' })) : []) ],
    components, detail: 'roles' in roleResult ? `role-config-r${roleResult.roles.revision}` : 'role-config-unavailable',
  }
}

export function productStatusPublisher(path: string, probe: () => Promise<WatchdogProbe>, lease: () => Promise<{ hostId: string; epoch: number } | undefined>) {
  if (!isAbsolute(path)) throw new CoreError('INVALID_CONFIG', 'The Watchdog status path must be absolute.')
  let closed = false
  let writing: Promise<void> | undefined
  const publish = () => writing ??= (async () => {
    if (closed) return
    const [observation, owner] = await Promise.all([probe(), lease()])
    if (!owner || closed) return
    const status: ProcessWatchdogStatus = { ...observation, hostId: owner.hostId, epoch: owner.epoch, pid: process.pid, at: Date.now() }
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 })
    if (!closed) await rename(temporary, path)
  })().finally(() => { writing = undefined })
  return { publish, async close() { closed = true; await writing } }
}
