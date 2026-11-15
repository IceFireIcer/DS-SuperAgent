import { CoreError } from './model.js'
import type { Engine } from './engine.js'
import type { NativeSessions } from './native-sessions.js'
import type { Storage } from './storage.js'
import { createSessionAssessor } from './supervisor-session.js'
import type { WatchdogState } from './watchdog.js'

interface Run { at: number; version: string; status: 'completed' | 'failed' | 'budget-exhausted';
  budget: { used: number; max: number; windowMs: number }; observations?: number; proposals?: number; partial?: boolean; error?: string }
interface RunState { last: Run; history: Run[]; attempts?: number[] }
const key = 'product-supervisor'
const maxRuns = 24
const runWindowMs = 3_600_000

export function createProductSupervision(engine: Engine, sessions: NativeSessions, storage: Storage, instanceId: string,
  options: { watchdogConfigured: boolean; intervalMs?: number } ) {
  let closed = false
  let active: Promise<Run> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const controller = new AbortController()
  const inspect = () => active ??= (async () => {
    if (closed) throw new CoreError('RUNTIME_CLOSED', 'The product Supervisor is closed.')
    const at = Date.now()
    const previous = await storage.transaction(instanceId, tx => tx.get<RunState>('supervisor-run', key))
    const attempts = (previous?.attempts ?? previous?.history.filter(run => run.status !== 'budget-exhausted').map(run => run.at) ?? [])
      .filter(time => time > at - runWindowMs)
    const used = attempts.length
    const budget = { used: Math.min(maxRuns, used + 1), max: maxRuns, windowMs: runWindowMs }
    let version = 'supervisor-unconfigured'
    let result: Run
    try {
      if (used >= maxRuns) throw new CoreError('SUPERVISOR_BUDGET', 'The hourly semantic inspection budget is exhausted.')
      const roles = await engine.getRoleConfig()
      version = `supervisor-r${roles.revision}`
      if (roles.roles.router.model.provider === 'unconfigured') throw new CoreError('ROLE_NOT_CONFIGURED', 'A Router model is needed for semantic supervision.')
      const assess = createSessionAssessor(sessions, { sessionId: `supervisor:${instanceId}`, version, model: roles.roles.router.model })
      const report = await engine.createSupervisor({ assess, version }).inspect(AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
      result = { at, version, status: 'completed', budget, observations: report.observations.length, proposals: report.proposals.length,
        ...(report.partial ? { partial: true } : {}) }
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'SUPERVISOR_FAILED'
      result = { at, version, status: code === 'SUPERVISOR_BUDGET' ? 'budget-exhausted' : 'failed', budget, error: code }
    }
    await storage.transaction(instanceId, async tx => {
      const previous = await tx.get<RunState>('supervisor-run', key)
      const next: RunState = { last: result, history: [result, ...(previous?.history ?? [])].slice(0, 50),
        attempts: result.status === 'budget-exhausted' ? attempts : [...attempts, at] }
      if (!await tx.replace('supervisor-run', key, next)) await tx.insert('supervisor-run', key, next)
    })
    return result
  })().finally(() => { active = undefined })
  return {
    start() {
      timer = setInterval(() => { void inspect().catch(() => {}) }, options.intervalMs ?? 300_000)
      timer.unref()
      void inspect().catch(() => {})
    },
    inspect,
    async state(ticketId?: string) {
      const [run, watchdog, proposals, observation] = await Promise.all([
        storage.transaction(instanceId, tx => tx.get<RunState>('supervisor-run', key)),
        storage.transaction(instanceId, tx => tx.get<WatchdogState>('watchdog-state', JSON.stringify(['watchdog-state', instanceId]))),
        engine.getMainSupervisorProposals({ instanceId, ...(ticketId ? { ticketId } : {}) }),
        ticketId ? engine.getMainSupervisorState({ instanceId, ticketId }) : Promise.resolve(undefined),
      ])
      return { run: run ?? null, watchdog: options.watchdogConfigured ? watchdog ?? null : null,
        watchdogConfigured: options.watchdogConfigured, proposals, observation: observation ?? null }
    },
    async close() { closed = true; controller.abort(); if (timer) clearInterval(timer); await active?.catch(() => {}) },
  }
}
