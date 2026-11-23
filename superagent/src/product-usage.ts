import type { Assignment } from './execution.js'
import type { NativeSessions, SessionTokenUsage, SessionUsageSnapshot } from './native-sessions.js'
import type { RecordKind } from './model.js'
import type { Storage } from './storage.js'
import type { MainWorkBrief, MainWorkItem } from './work-delegation.js'
import { readRecentRoleUses, type RoleConfigUse } from './config.js'
const pageSize = 100
const maxWorkPages = 10
const maxAssignmentPages = 100

export interface ProductUsageOptions {
  maxRoleUses?: number
  maxSessions?: number
  maxSessionEvents?: number
}

export interface ProductUsageSummary extends SessionTokenUsage {
  status: 'none' | 'available' | 'partial' | 'unavailable'
  sessions: number
  unavailableSessions: number
}

export interface ProductUsageReport {
  createdAt: number
  roles: Record<'main' | 'router' | 'worker', ProductUsageSummary>
  planning: { id: string; title: string; total: SessionTokenUsage }[]
  works: { id: string; title: string; total: SessionTokenUsage }[]
  unattributed: SessionTokenUsage
  hourly?: ProductUsageBucket[]
  cost: { status: 'unavailable'; reason: string }
  coverage: {
    status: 'available' | 'partial' | 'unavailable' | 'none'
    scope: 'recent-role-sessions'
    totalRoleUses: number
    includedRoleUses: number
    omittedRoleUses: number
    knownSessions: number
    includedSessions: number
    omittedSessions: number
    omittedEvents: number
    missingSessions: number
    overBudgetSessions: number
    conflictingSessions: number
    unattributedCalls: number
    workRecordsTruncated: boolean
    limits: { roleUses: number; sessions: number; eventsPerSession: number }
  }
}

export interface ProductUsageBucket {
  at: number
  owner: RoleConfigUse['role']
  provider: string
  model: string
  kind: 'conversation' | 'planning' | 'execution'
  usage: SessionTokenUsage
}

type UsageRange = { id: string; startSeq: number; endSeq: number; kind: 'planning' | 'worker'; workId: string; title: string }

const emptyUsage = (): SessionTokenUsage => ({ calls: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 })

function add(target: SessionTokenUsage, value: SessionTokenUsage) {
  for (const key of ['calls', 'reportedCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
    target[key] += value[key]
  }
}

function summaryStatus(usage: SessionTokenUsage, sessions: number, unavailableSessions: number): ProductUsageSummary['status'] {
  if (!sessions) return 'none'
  if (unavailableSessions) return usage.reportedCalls ? 'partial' : 'unavailable'
  if (!usage.calls) return 'none'
  if (!usage.reportedCalls) return 'unavailable'
  return usage.reportedCalls < usage.calls ? 'partial' : 'available'
}

async function scanRows<T>(storage: Storage, instanceId: string, kind: RecordKind, maxPages: number) {
  const items: T[] = []
  let after: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const batch = await storage.transaction(instanceId, tx => tx.scan<T>(kind, { limit: pageSize,
      ...(after === undefined ? {} : { after }) }))
    items.push(...batch.items.map(item => item.value))
    if (!batch.cursor) return { items, truncated: false }
    after = batch.cursor
  }
  return { items, truncated: true }
}

export class ProductUsage {
  private readonly maxRoleUses: number
  private readonly maxSessions: number
  private readonly maxSessionEvents: number

  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly sessions: NativeSessions | undefined,
    options: ProductUsageOptions = {}, private readonly now: () => number = Date.now) {
    this.maxRoleUses = options.maxRoleUses ?? 100
    this.maxSessions = options.maxSessions ?? 100
    this.maxSessionEvents = options.maxSessionEvents ?? 20_000
    for (const budget of [this.maxRoleUses, this.maxSessions, this.maxSessionEvents]) {
      if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('Product usage budgets must be positive safe integers.')
    }
  }

  async read(hourly = false): Promise<ProductUsageReport> {
    const useIndex = await readRecentRoleUses(this.storage, this.instanceId, this.maxRoleUses)
    const [briefRows, itemRows, ticketRows, turnRows, assignmentRows, currentRows] = await Promise.all([
      scanRows<MainWorkBrief>(this.storage, this.instanceId, 'work-brief', maxWorkPages),
      scanRows<MainWorkItem>(this.storage, this.instanceId, 'work-item', maxWorkPages),
      scanRows<{ ticketId: string; workBriefId: string; workItemId: string }>(this.storage, this.instanceId, 'work-ticket', maxWorkPages),
      scanRows<{ id: string; workBriefId: string; sessionId: string; startSeq?: number; endSeq?: number; createdAt: number }>(
        this.storage, this.instanceId, 'work-router-turn', maxWorkPages),
      scanRows<Assignment>(this.storage, this.instanceId, 'assignment-history', maxAssignmentPages),
      scanRows<Assignment>(this.storage, this.instanceId, 'assignment', maxWorkPages),
    ])
    let truncated = [briefRows, itemRows, ticketRows, turnRows, assignmentRows, currentRows].some(value => value.truncated)
    const briefs = new Map(briefRows.items.map(brief => [brief.id, brief]))
    const items = new Map(itemRows.items.map(item => [item.id, item]))
    const rangesBySession = new Map<string, UsageRange[]>()
    const addRange = (sessionId: string, range: UsageRange) => {
      const list = rangesBySession.get(sessionId) ?? []
      list.push(range)
      rangesBySession.set(sessionId, list)
    }
    for (const turn of turnRows.items) {
      const brief = briefs.get(turn.workBriefId)
      if (!brief || turn.startSeq === undefined || turn.endSeq === undefined || turn.endSeq < turn.startSeq) continue
      addRange(turn.sessionId, { id: `router:${turn.id}`, kind: 'planning', workId: `brief:${brief.id}`,
        title: brief.goal, startSeq: turn.startSeq, endSeq: turn.endSeq })
    }
    const workByTicket = new Map(ticketRows.items.map(item => [item.ticketId, item]))
    const assignments = new Map<string, Assignment>()
    for (const assignment of [...assignmentRows.items, ...currentRows.items]) assignments.set(assignment.id, assignment)
    for (const assignment of assignments.values()) {
      const { ticketId, sessionStartSeq, sessionEndSeq } = assignment
      if (sessionStartSeq === undefined || sessionEndSeq === undefined || sessionEndSeq < sessionStartSeq) continue
      const link = workByTicket.get(ticketId)
      const item = link ? items.get(link.workItemId) : undefined
      addRange(assignment.sessionId, { id: `worker:${assignment.id}`, kind: 'worker', workId: link?.workItemId ? `item:${link.workItemId}` : `ticket:${ticketId}`,
        title: item?.goal ?? `Ticket ${ticketId}`, startSeq: sessionStartSeq, endSeq: sessionEndSeq })
    }

    const usesBySession = new Map<string, { role: RoleConfigUse['role']; createdAt: number; conflict: boolean }>()
    for (const use of useIndex.items) {
      const previous = usesBySession.get(use.sessionId)
      if (!previous || use.createdAt > previous.createdAt) usesBySession.set(use.sessionId, {
        role: use.role, createdAt: use.createdAt, conflict: previous?.conflict === true || previous !== undefined && previous.role !== use.role,
      })
      else if (previous.role !== use.role) previous.conflict = true
    }
    const recentSessions = [...usesBySession.entries()].sort((left, right) => right[1].createdAt - left[1].createdAt || left[0].localeCompare(right[0]))
    const selected = recentSessions.slice(0, this.maxSessions)
    const roles = Object.fromEntries(['main', 'router', 'worker'].map(role => [role, {
      ...emptyUsage(), sessions: 0, unavailableSessions: 0,
    }])) as ProductUsageReport['roles']
    const workTotals = new Map<string, { title: string; usage: SessionTokenUsage }>()
    const planningTotals = new Map<string, { title: string; usage: SessionTokenUsage }>()
    const unattributed = emptyUsage()
    const buckets = new Map<string, ProductUsageBucket>()
    let missingSessions = 0
    let overBudgetSessions = 0
    let omittedEvents = 0
    let unattributedCalls = 0
    let conflicts = 0
    for (const [sessionId, mapping] of selected) {
      const role = roles[mapping.role]
      role.sessions++
      if (mapping.conflict) { conflicts++; role.unavailableSessions++; continue }
      const ranges = (rangesBySession.get(sessionId) ?? []).filter(range => mapping.role === 'router' && range.kind === 'planning'
        || mapping.role === 'worker' && range.kind === 'worker')
      if (ranges.length > 1000) truncated = true
      const attribution = new Map((ranges.length <= 1000 ? ranges : []).map(range => [range.id, range]))
      let snapshot: SessionUsageSnapshot
      try { snapshot = this.sessions ? await this.sessions.readUsageSnapshot(sessionId, { maxEvents: this.maxSessionEvents, ranges: [...attribution.values()], hourly })
        : { status: 'missing' as const, eventCount: 0, usage: emptyUsage(), ranges: [] }}
      catch { snapshot = { status: 'missing' as const, eventCount: 0, usage: emptyUsage(), ranges: [] } }
      if (snapshot.status !== 'available') {
        role.unavailableSessions++
        if (snapshot.status === 'missing') missingSessions++
        else { overBudgetSessions++; omittedEvents += snapshot.eventCount }
        continue
      }
      add(role, snapshot.usage)
      for (const { at, provider, model, usage } of snapshot.buckets ?? []) {
        const owner = mapping.role
        const key = JSON.stringify([at, owner, provider, model])
        let bucket = buckets.get(key)
        if (!bucket) {
          if (buckets.size >= 10_000) { truncated = true; continue }
          bucket = { at, owner, provider, model, kind: owner === 'main' ? 'conversation' : owner === 'router' ? 'planning' : 'execution', usage: emptyUsage() }
          buckets.set(key, bucket)
        }
        add(bucket.usage, usage)
      }
      const attributed = emptyUsage()
      for (const result of snapshot.ranges) {
        const descriptor = attribution.get(result.id)
        if (!descriptor || result.usage.calls === 0) continue
        add(attributed, result.usage)
        const destination = descriptor.kind === 'planning' ? planningTotals : workTotals
        const value = destination.get(descriptor.workId) ?? { title: descriptor.title, usage: emptyUsage() }
        add(value.usage, result.usage)
        destination.set(descriptor.workId, value)
      }
      const remainder = emptyUsage()
      for (const key of ['calls', 'reportedCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
        remainder[key] = Math.max(0, snapshot.usage[key] - attributed[key])
      }
      add(unattributed, remainder)
      unattributedCalls += remainder.calls
    }
    for (const value of Object.values(roles)) {
      value.status = summaryStatus(value, value.sessions, value.unavailableSessions)
    }
    if (planningTotals.size > 100 || workTotals.size > 100) truncated = true
    const omittedRoleUses = Math.max(0, useIndex.total - useIndex.items.length)
    const includedSessions = selected.length - missingSessions - overBudgetSessions - conflicts
    const partial = omittedRoleUses > 0 || includedSessions < recentSessions.length || truncated
      || Object.values(roles).some(role => role.status === 'partial' || role.status === 'unavailable')
    const knownSessions = recentSessions.length
    const coverage: ProductUsageReport['coverage'] = {
      status: useIndex.total === 0 ? 'none' : !includedSessions ? 'unavailable' : partial ? 'partial' : 'available',
      scope: 'recent-role-sessions',
      totalRoleUses: useIndex.total, includedRoleUses: useIndex.items.length,
      omittedRoleUses, knownSessions, includedSessions, omittedSessions: Math.max(0, knownSessions - includedSessions),
      omittedEvents, missingSessions, overBudgetSessions, conflictingSessions: conflicts, unattributedCalls, workRecordsTruncated: truncated,
      limits: { roleUses: this.maxRoleUses, sessions: this.maxSessions, eventsPerSession: this.maxSessionEvents },
    }
    const rank = (values: Map<string, { title: string; usage: SessionTokenUsage }>) => [...values].map(([id, value]) => ({ id, title: value.title, total: value.usage }))
      .sort((left, right) => right.total.totalTokens - left.total.totalTokens || left.title.localeCompare(right.title))
    return { createdAt: this.now(), roles, planning: rank(planningTotals).slice(0, 100), works: rank(workTotals).slice(0, 100),
      ...(hourly ? { hourly: [...buckets.values()].sort((left, right) => left.at - right.at) } : {}),
      unattributed, cost: { status: 'unavailable', reason: 'No model price catalog is configured.' }, coverage }
  }
}
