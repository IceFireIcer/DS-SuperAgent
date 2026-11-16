import { CoreError } from './model.js'
import type { Engine } from './engine.js'
import type { NativeSessions } from './native-sessions.js'
import type { Storage } from './storage.js'
import { createSessionAssessor } from './supervisor-session.js'
import type { WatchdogState } from './watchdog.js'

interface Run { at: number; version: string; status: 'completed' | 'partial' | 'failed' | 'budget-exhausted';
  budget: { used: number; max: number; windowMs: number }; observations?: number; proposals?: number;
  inspectionBudget?: { inspected: number; maxTickets: number }; coverage?: { inspected: number; batches: number };
  partial?: boolean; nextCursor?: string; error?: string }
interface Checkpoint { cursor: string; inspected: number; batches: number; startedAt: number; lastTicketId?: string }
interface RunState { last: Run; history: Run[]; attempts?: number[]; checkpoint?: Checkpoint }
const key = 'product-supervisor'
const maxRuns = 24
const runWindowMs = 3_600_000

export function createProductSupervision(engine: Engine, sessions: NativeSessions, storage: Storage, instanceId: string,
  options: { watchdogConfigured: boolean; intervalMs?: number } ) {
  let closed = false
  let active: Promise<Run> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const runInspection = async (restart: boolean): Promise<Run> => {
    if (closed) throw new CoreError('RUNTIME_CLOSED', 'The product Supervisor is closed.')
    const at = Date.now()
    const previous = await storage.transaction(instanceId, tx => tx.get<RunState>('supervisor-run', key))
    const checkpoint = restart ? undefined : previous?.checkpoint
    const attempts = (previous?.attempts ?? previous?.history.filter(run => run.status !== 'budget-exhausted').map(run => run.at) ?? [])
      .filter(time => time > at - runWindowMs)
    const used = attempts.length
    if (restart && used >= maxRuns) throw new CoreError('SUPERVISOR_BUDGET', 'The hourly semantic inspection budget is exhausted.')
    const budget = { used: Math.min(maxRuns, used + 1), max: maxRuns, windowMs: runWindowMs }
    let version = previous?.last.version ?? 'supervisor-unconfigured'
    let result: Run
    let nextCheckpoint = checkpoint
    let incompleteCoverage: Run['coverage']
    try {
      if (used >= maxRuns) throw new CoreError('SUPERVISOR_BUDGET', 'The hourly semantic inspection budget is exhausted.')
      if (checkpoint && (typeof checkpoint.cursor !== 'string' || !Number.isSafeInteger(checkpoint.inspected)
        || checkpoint.inspected < 0 || !Number.isSafeInteger(checkpoint.batches) || checkpoint.batches < 1
        || checkpoint.lastTicketId !== undefined && typeof checkpoint.lastTicketId !== 'string')) {
        throw new CoreError('INCOMPLETE_STATE', 'The persisted supervision checkpoint is invalid.')
      }
      if (!restart && !checkpoint && previous?.last.partial) throw new CoreError('INCOMPLETE_STATE', 'The earlier partial inspection has no durable checkpoint.')
      const roles = await engine.getRoleConfig()
      version = `supervisor-r${roles.revision}`
      if (roles.roles.router.model.provider === 'unconfigured') throw new CoreError('ROLE_NOT_CONFIGURED', 'A Router model is needed for semantic supervision.')
      const assess = createSessionAssessor(sessions, { sessionId: `supervisor:${instanceId}`, version, model: roles.roles.router.model })
      const report = await engine.createSupervisor({ assess, version, maxPages: 1 }).inspect(
        AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), checkpoint?.cursor)
      if (report.inspectionBudget.inspected !== report.observations.length || report.partial === true && !report.nextCursor
        || report.partial !== true && report.nextCursor !== undefined) {
        throw new CoreError('INCOMPLETE_STATE', 'The supervision batch has inconsistent coverage.')
      }
      const ids = report.observations.map(observation => observation.ticketId).sort()
      if (checkpoint?.lastTicketId && ids[0] && ids[0] <= checkpoint.lastTicketId) {
        throw new CoreError('INCOMPLETE_STATE', 'The supervision batch repeated or moved behind a previous Ticket.')
      }
      const inspected = (checkpoint?.inspected ?? 0) + report.observations.length
      const batches = (checkpoint?.batches ?? 0) + 1
      const lastTicketId = ids.at(-1) ?? checkpoint?.lastTicketId
      if (!report.partial && await engine.countSupervisionTickets() !== inspected) {
        nextCheckpoint = undefined
        incompleteCoverage = { inspected, batches }
        throw new CoreError('INCOMPLETE_STATE', 'The Ticket set changed during the inspection; start a new verified pass.')
      }
      nextCheckpoint = report.partial ? { cursor: report.nextCursor!, inspected, batches,
        startedAt: checkpoint?.startedAt ?? at, ...(lastTicketId ? { lastTicketId } : {}) } : undefined
      result = { at, version, status: report.partial ? 'partial' : 'completed', budget,
        observations: report.observations.length, proposals: report.proposals.length,
        inspectionBudget: report.inspectionBudget, coverage: { inspected, batches },
        ...(nextCheckpoint ? { partial: true, nextCursor: nextCheckpoint.cursor } : {}) }
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'SUPERVISOR_FAILED'
      result = { at, version, status: code === 'SUPERVISOR_BUDGET' ? 'budget-exhausted' : 'failed', budget, error: code,
        ...(incompleteCoverage ? { partial: true, coverage: incompleteCoverage }
          : checkpoint ? { partial: true, nextCursor: checkpoint.cursor,
          coverage: { inspected: checkpoint.inspected, batches: checkpoint.batches } }
          : !restart && previous?.last.partial ? { partial: true,
            ...(previous.last.nextCursor ? { nextCursor: previous.last.nextCursor } : {}),
            coverage: previous.last.coverage ?? { inspected: previous.last.inspectionBudget?.inspected ?? 0, batches: 1 } } : {}) }
    }
    await storage.transaction(instanceId, async tx => {
      const current = await tx.get<RunState>('supervisor-run', key)
      if (current?.checkpoint?.cursor !== previous?.checkpoint?.cursor) throw new CoreError('INCOMPLETE_STATE', 'The supervision checkpoint changed during inspection.')
      const next: RunState = { last: result, history: [result, ...(current?.history ?? [])].slice(0, 50),
        attempts: result.status === 'budget-exhausted' ? attempts : [...attempts, at],
        ...(nextCheckpoint ? { checkpoint: nextCheckpoint } : {}) }
      if (!await tx.replace('supervisor-run', key, next)) await tx.insert('supervisor-run', key, next)
    })
    if (result.status === 'partial' && !closed) {
      resumeTimer = setTimeout(() => { resumeTimer = undefined; void inspect().catch(() => {}) }, 0)
      resumeTimer.unref()
    }
    return result
  }
  const inspect = (restart = false) => {
    if (restart && active) throw new CoreError('SUPERVISOR_BUSY', 'Wait for the current inspection before restarting it.')
    if (restart && resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined }
    return active ??= runInspection(restart).finally(() => { active = undefined })
  }
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
    async close() { closed = true; controller.abort(); if (timer) clearInterval(timer); if (resumeTimer) clearTimeout(resumeTimer); await active?.catch(() => {}) },
  }
}
