import { createHash } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { localToInstant, zoneOffsetMs } from './channels.js'
import { CoreError, identifier } from './model.js'
import { isCurrentSourceEvent, type SourceEvent } from './source-events.js'
import type { AsyncTx, Storage } from './storage.js'

export type ScheduleWhen = { kind: 'at'; at: number } | { kind: 'every'; minutes: number }
  | { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; weekdays: number[] }
export type ScheduleTarget = { kind: 'main' } | { kind: 'work'; workItemId: string; ticketId: string }
export interface ProductSchedule {
  ruleId: string
  instanceId: string
  title: string
  text: string
  timezone: string
  when: ScheduleWhen
  target: ScheduleTarget
  authorizedBy: string
  status: 'active' | 'cancelled' | 'completed'
  nextAt?: number | undefined
  createdAt: number
  updatedAt: number
}
export interface ScheduledOccurrence {
  ruleId: string
  dueAt: number
  status: 'pending' | 'accepted' | 'delegated' | 'blocked' | 'cancelled' | 'missed' | 'failed'
  eventId?: string
  handoffId?: string
  workBriefId?: string
  ticketIds: string[]
  inputId?: string
  executionStatus?: string
  reason?: string
  throughAt?: number
  attempts: number
  updatedAt: number
}
export interface ScheduleCreate {
  instanceId: string
  commandId: string
  title: string
  text: string
  timezone: string
  when: ScheduleWhen
  target: ScheduleTarget
}

const key = (ruleId: string) => JSON.stringify(['product-schedule', ruleId])
const occurrencePrefix = (ruleId: string) => JSON.stringify(['product-schedule-occurrence', ruleId])
const occurrenceKey = (ruleId: string, dueAt: number) => `${occurrencePrefix(ruleId)}:${String(dueAt).padStart(16, '0')}`
export const scheduledOccurrenceKey = occurrenceKey
const dayMs = 86_400_000
const catchUpMs = dayMs
const sourceKey = 'product-schedule-source'

function timeMinutes(time: string): number {
  if (typeof time !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(time)) {
    throw new CoreError('INVALID_INPUT', 'A daily or weekly schedule needs a time in HH:mm format.')
  }
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}

function validWhen(value: ScheduleWhen): ScheduleWhen {
  if (!value || typeof value !== 'object') throw new CoreError('INVALID_INPUT', 'Choose when this schedule runs.')
  if (value.kind === 'at' && Object.keys(value).length === 2 && Number.isSafeInteger(value.at) && value.at > 0) return value
  if (value.kind === 'every' && Object.keys(value).length === 2 && Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 525_600) return value
  if (value.kind === 'daily' && Object.keys(value).length === 2) { timeMinutes(value.time); return value }
  if (value.kind === 'weekly' && Object.keys(value).length === 3 && Array.isArray(value.weekdays)
    && value.weekdays.length >= 1 && value.weekdays.length <= 7
    && value.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)
    && new Set(value.weekdays).size === value.weekdays.length) { timeMinutes(value.time); return value }
  throw new CoreError('INVALID_INPUT', 'Choose a valid one-time, interval, daily or weekly schedule.')
}

function localDay(timezone: string, instant: number) {
  const local = instant + zoneOffsetMs(timezone, instant)
  return Math.floor(local / dayMs) * dayMs
}

function onWeekday(when: ScheduleWhen, local: number) {
  if (when.kind !== 'weekly') return true
  const iso = (new Date(local).getUTCDay() + 6) % 7 + 1
  return when.weekdays.includes(iso)
}

function nextAt(rule: Pick<ProductSchedule, 'when' | 'timezone' | 'createdAt'>, after: number): number | undefined {
  const { when } = rule
  if (when.kind === 'at') return when.at > after ? when.at : undefined
  if (when.kind === 'every') {
    const interval = when.minutes * 60_000
    return rule.createdAt + (Math.floor((after - rule.createdAt) / interval) + 1) * interval
  }
  const minutes = timeMinutes(when.time)
  const start = localDay(rule.timezone, after)
  for (let offset = 0; offset <= 8; offset++) {
    const local = start + offset * dayMs + minutes * 60_000
    if (!onWeekday(when, local)) continue
    const instant = localToInstant(local, rule.timezone)
    if (instant !== undefined && instant > after) return instant
  }
  throw new CoreError('INVALID_CONFIG', 'No valid local schedule time exists within eight days.')
}

function latestDue(rule: ProductSchedule, now: number): number {
  const { when } = rule
  if (when.kind === 'at') return when.at
  if (when.kind === 'every') {
    const interval = when.minutes * 60_000
    return rule.createdAt + Math.floor((now - rule.createdAt) / interval) * interval
  }
  const minutes = timeMinutes(when.time)
  const today = localDay(rule.timezone, now)
  for (let offset = 0; offset <= 8; offset++) {
    const local = today - offset * dayMs + minutes * 60_000
    if (!onWeekday(when, local)) continue
    const instant = localToInstant(local, rule.timezone)
    if (instant !== undefined && instant <= now) return instant
  }
  return rule.nextAt!
}

export async function authorizedScheduleEvent(tx: AsyncTx, event: SourceEvent, authorizedBy: string, target: ScheduleTarget['kind']) {
  const source = await tx.get<{ enabled: boolean }>('product-schedule-source', sourceKey)
  const ruleId = event.source.sourceInstanceId.startsWith('schedule:') ? event.source.sourceInstanceId.slice('schedule:'.length) : ''
  const rule = ruleId && await tx.get<ProductSchedule>('product-schedule', key(ruleId))
  if (source?.enabled === false || !rule || rule.instanceId !== tx.instanceId || rule.authorizedBy !== authorizedBy || rule.target.kind !== target
    || rule.status === 'cancelled' || event.source.kind !== 'schedule' || event.source.actorId !== 'schedule'
    || event.authorKind !== 'system' || event.authorId !== 'schedule' || event.addressing !== 'direct'
    || event.threadId !== `schedule:${ruleId}` || event.objectId !== `occurrence:${event.version.value}`
    || event.type !== 'created' || !await isCurrentSourceEvent(tx, event)) {
    throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The scheduled occurrence is no longer authorized for this target.')
  }
  const occurrence = await tx.get<ScheduledOccurrence>('product-schedule-occurrence', occurrenceKey(ruleId, Number(event.version.value)))
  if (!occurrence || occurrence.status === 'cancelled' || occurrence.status === 'missed' || occurrence.eventId && occurrence.eventId !== event.id) {
    throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The scheduled occurrence is no longer current.')
  }
  return rule
}

export class ProductSchedules {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly actorId: string,
    private readonly authorizeTarget: (tx: AsyncTx, target: ScheduleTarget) => Promise<void>,
    private readonly deliver: (rule: ProductSchedule, occurrence: ScheduledOccurrence) => Promise<Partial<ScheduledOccurrence>>,
    private readonly now: () => number = Date.now) {}

  private authorize(instanceId: string) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The schedule belongs to a different Instance.')
  }

  async sourceState(request: { instanceId: string }) {
    this.authorize(request?.instanceId)
    return this.storage.transaction(this.instanceId, async tx => ({ enabled:
      (await tx.get<{ enabled: boolean }>('product-schedule-source', sourceKey))?.enabled !== false }))
  }

  async setSource(command: { instanceId: string; commandId: string; enabled: boolean }) {
    if (!command || Object.keys(command).some(field => !['instanceId', 'commandId', 'enabled'].includes(field))
      || typeof command.enabled !== 'boolean') throw new CoreError('INVALID_INPUT', 'Schedule source control needs an enabled state.')
    this.authorize(command.instanceId); identifier(command.commandId, 'commandId')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const fingerprint = createHash('sha256').update(canonicalJson(['schedule-source-v1', command.enabled])).digest('hex')
      const prior = await tx.get<{ fingerprint: string; enabled: boolean }>('product-schedule-command', `source:${command.commandId}`)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This source control was reused for another state.')
        return { enabled: prior.enabled }
      }
      if (!await tx.replace('product-schedule-source', sourceKey, { enabled: command.enabled, updatedAt: this.now() })) {
        await tx.insert('product-schedule-source', sourceKey, { enabled: command.enabled, updatedAt: this.now() })
      }
      await tx.insert('product-schedule-command', `source:${command.commandId}`, { fingerprint, enabled: command.enabled })
      return { enabled: command.enabled }
    })
  }

  async create(command: ScheduleCreate): Promise<ProductSchedule> {
    if (!command || Object.keys(command).some(field => !['instanceId', 'commandId', 'title', 'text', 'timezone', 'when', 'target'].includes(field))) {
      throw new CoreError('INVALID_INPUT', 'Creating a schedule accepts a title, request, timezone, timing and target.')
    }
    this.authorize(command.instanceId); identifier(command.commandId, 'commandId')
    if (typeof command.title !== 'string' || !command.title.trim() || Buffer.byteLength(command.title) > 120
      || typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 32_768) {
      throw new CoreError('INVALID_INPUT', 'A schedule needs a bounded title and request.')
    }
    if (typeof command.timezone !== 'string' || !command.timezone || command.timezone.length > 128) throw new CoreError('INVALID_INPUT', 'Choose a timezone.')
    try { new Intl.DateTimeFormat('en-US', { timeZone: command.timezone }) }
    catch { throw new CoreError('INVALID_INPUT', 'The schedule timezone is not recognized.') }
    const when = validWhen(command.when)
    const target = command.target
    if (!target || target.kind !== 'main' && target.kind !== 'work'
      || target.kind === 'main' && Object.keys(target).length !== 1
      || target.kind === 'work' && (Object.keys(target).length !== 3 || typeof target.workItemId !== 'string' || typeof target.ticketId !== 'string')) {
      throw new CoreError('INVALID_INPUT', 'Choose Main or one exact authorized work item.')
    }
    if (target.kind === 'work') { identifier(target.workItemId, 'workItemId'); identifier(target.ticketId, 'ticketId') }
    const id = `schedule-${createHash('sha256').update(JSON.stringify([this.instanceId, this.actorId, command.commandId])).digest('hex')}`
    const fingerprint = createHash('sha256').update(canonicalJson(command)).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; ruleId: string }>('product-schedule-command', `create:${command.commandId}`)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This schedule command was reused for different input.')
        const existing = await tx.get<ProductSchedule>('product-schedule', key(prior.ruleId))
        if (!existing) throw new CoreError('INCOMPLETE_STATE', 'The accepted schedule rule is missing.')
        return existing
      }
      await this.authorizeTarget(tx, target)
      const createdAt = this.now()
      if (when.kind === 'at' && when.at <= createdAt) throw new CoreError('INVALID_INPUT', 'A one-time schedule must be in the future.')
      const rule: ProductSchedule = { ruleId: id, instanceId: this.instanceId, title: command.title.trim(), text: command.text.trim(),
        timezone: command.timezone, when: structuredClone(when), target: structuredClone(target), authorizedBy: this.actorId,
        status: 'active', createdAt, updatedAt: createdAt,
        nextAt: nextAt({ when, timezone: command.timezone, createdAt }, createdAt) }
      await tx.insert('product-schedule', key(id), rule)
      await tx.insert('product-schedule-command', `create:${command.commandId}`, { fingerprint, ruleId: id })
      return rule
    })
  }

  async cancel(command: { instanceId: string; commandId: string; ruleId: string }) {
    if (!command || Object.keys(command).some(field => !['instanceId', 'commandId', 'ruleId'].includes(field))) throw new CoreError('INVALID_INPUT', 'Cancel one schedule by ID.')
    this.authorize(command.instanceId); identifier(command.commandId, 'commandId'); identifier(command.ruleId, 'ruleId')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const commandKey = `cancel:${command.commandId}`
      const fingerprint = createHash('sha256').update(canonicalJson(['schedule-cancel-v1', command.ruleId])).digest('hex')
      const prior = await tx.get<{ fingerprint: string }>('product-schedule-command', commandKey)
      if (prior && prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This schedule cancellation was reused for a different rule.')
      const rule = await tx.get<ProductSchedule>('product-schedule', key(command.ruleId))
      if (!rule || rule.authorizedBy !== this.actorId) throw new CoreError('NOT_FOUND', 'This schedule is unavailable.')
      if (rule.status === 'cancelled') {
        if (!prior) await tx.insert('product-schedule-command', commandKey, { fingerprint, ruleId: rule.ruleId })
        return rule
      }
      const next: ProductSchedule = { ...rule, status: 'cancelled', nextAt: undefined, updatedAt: this.now() }
      await tx.replace('product-schedule', key(rule.ruleId), next)
      if (!prior) await tx.insert('product-schedule-command', commandKey, { fingerprint, ruleId: rule.ruleId })
      return next
    })
  }

  async list(request: { instanceId: string }) {
    this.authorize(request?.instanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      const items: ProductSchedule[] = []
      let after = ''
      for (let page = 0; page < 10; page++) {
        const batch = await tx.scan<ProductSchedule>('product-schedule', { limit: 100, after })
        items.push(...batch.items.map(entry => entry.value).filter(rule => rule.authorizedBy === this.actorId))
        if (!batch.cursor) return { items }
        after = batch.cursor
      }
      throw new CoreError('SCHEDULE_LIMIT', 'Schedule history exceeds the 1000-rule budget.')
    })
  }

  async get(request: { instanceId: string; ruleId: string }) {
    this.authorize(request?.instanceId); identifier(request.ruleId, 'ruleId')
    return this.storage.transaction(this.instanceId, async tx => {
      const rule = await tx.get<ProductSchedule>('product-schedule', key(request.ruleId))
      if (!rule || rule.authorizedBy !== this.actorId) throw new CoreError('NOT_FOUND', 'This schedule is unavailable.')
      const occurrences: ScheduledOccurrence[] = []
      let after = occurrencePrefix(rule.ruleId)
      for (let page = 0; page < 10; page++) {
        const batch = await tx.scan<ScheduledOccurrence>('product-schedule-occurrence', { limit: 100, after })
        for (const entry of batch.items) {
          if (!entry.id.startsWith(`${occurrencePrefix(rule.ruleId)}:`)) return { ...rule, occurrences }
          let occurrence = entry.value
          if (occurrence.handoffId) {
            const handoff = await tx.get<{ state: string; workBriefId?: string; lastError?: string }>('main-source-handoff', occurrence.handoffId)
            const split = handoff?.workBriefId ? await tx.get<{ itemIds: string[] }>('work-split', handoff.workBriefId) : undefined
            const receipts = await Promise.all((split?.itemIds ?? []).map(id => tx.get<{ ticketId?: string; status?: string; reason?: string }>('work-receipt', id)))
            const rejection = receipts.find(receipt => receipt?.status === 'rejected')
            const reason = rejection?.reason ?? handoff?.lastError
            occurrence = { ...occurrence, status: rejection || handoff?.state === 'discarded' ? 'blocked'
              : handoff?.state === 'delegated' && receipts.some(receipt => receipt?.ticketId) ? 'delegated' : occurrence.status,
              ...(handoff?.workBriefId ? { workBriefId: handoff.workBriefId } : {}),
              ...(reason ? { reason } : {}),
              ticketIds: receipts.flatMap(receipt => receipt?.ticketId ? [receipt.ticketId] : []) }
          }
          const workItemIds = occurrence.workBriefId
            ? (await tx.get<{ itemIds: string[] }>('work-split', occurrence.workBriefId))?.itemIds ?? [] : []
          const outcomes = await Promise.all(workItemIds.map(id => tx.get<{ status: string }>('work-outcome', id)))
          const ticket = occurrence.ticketIds[0] ? await tx.get<{ constraint?: { kind: string }; state: string }>('ticket', occurrence.ticketIds[0]) : undefined
          const intent = occurrence.ticketIds[0] ? await tx.get<{ reason: string }>('intent', occurrence.ticketIds[0]) : undefined
          const executionStatus = ticket?.constraint?.kind ?? outcomes.find(outcome => outcome?.status)?.status ?? intent?.reason
          if (executionStatus) occurrence = { ...occurrence, executionStatus }
          occurrences.push(occurrence)
        }
        if (!batch.cursor) return { ...rule, occurrences }
        after = batch.cursor
      }
      throw new CoreError('SCHEDULE_LIMIT', 'Occurrence history exceeds the 1000-entry budget.')
    })
  }

  async tick(now = this.now()) {
    if (!Number.isSafeInteger(now)) throw new CoreError('INVALID_INPUT', 'A schedule tick needs a safe millisecond timestamp.')
    if (!(await this.sourceState({ instanceId: this.instanceId })).enabled) return { occurrences: [] }
    const { items } = await this.list({ instanceId: this.instanceId })
    const processed: ScheduledOccurrence[] = []
    for (const item of items.filter(rule => rule.status === 'active')) {
      const occurrence = await commandTransaction(this.storage, this.instanceId, async tx => {
        const rule = await tx.get<ProductSchedule>('product-schedule', key(item.ruleId))
        if (!rule || rule.status !== 'active' || rule.nextAt === undefined || rule.nextAt > now) return undefined
        const latest = latestDue(rule, now)
        if (latest > rule.nextAt) {
          const missed: ScheduledOccurrence = { ruleId: rule.ruleId, dueAt: rule.nextAt, throughAt: latest,
            status: 'missed', ticketIds: [], attempts: 0, updatedAt: this.now() }
          if (!await tx.get('product-schedule-occurrence', occurrenceKey(rule.ruleId, missed.dueAt))) {
            await tx.insert('product-schedule-occurrence', occurrenceKey(rule.ruleId, missed.dueAt), missed)
          }
        }
        if (rule.when.kind === 'at' && now - latest > catchUpMs) {
          const missed: ScheduledOccurrence = { ruleId: rule.ruleId, dueAt: latest, status: 'missed', ticketIds: [], attempts: 0, updatedAt: this.now() }
          if (!await tx.get('product-schedule-occurrence', occurrenceKey(rule.ruleId, latest))) {
            await tx.insert('product-schedule-occurrence', occurrenceKey(rule.ruleId, latest), missed)
          }
          await tx.replace('product-schedule', key(rule.ruleId), { ...rule, status: 'completed', nextAt: undefined, updatedAt: this.now() })
          return undefined
        }
        const due: ScheduledOccurrence = { ruleId: rule.ruleId, dueAt: latest, status: 'pending', ticketIds: [], attempts: 0, updatedAt: this.now() }
        if (!await tx.get('product-schedule-occurrence', occurrenceKey(rule.ruleId, latest))) {
          await tx.insert('product-schedule-occurrence', occurrenceKey(rule.ruleId, latest), due)
        }
        const upcoming = nextAt(rule, latest)
        await tx.replace('product-schedule', key(rule.ruleId), { ...rule, status: upcoming === undefined ? 'completed' : 'active', nextAt: upcoming, updatedAt: this.now() })
        return due
      })
      if (occurrence) processed.push(occurrence)
    }
    for (const rule of items) {
      const pending = await this.storage.transaction(this.instanceId, async tx => {
        const due: ScheduledOccurrence[] = []
        let after = occurrencePrefix(rule.ruleId)
        for (let page = 0; page < 10; page++) {
          const batch = await tx.scan<ScheduledOccurrence>('product-schedule-occurrence', { limit: 100, after })
          for (const entry of batch.items) {
            if (!entry.id.startsWith(`${occurrencePrefix(rule.ruleId)}:`)) return due
            if (entry.value.status === 'pending' || entry.value.status === 'failed' && entry.value.attempts < 3) due.push(entry.value)
          }
          if (!batch.cursor) return due
          after = batch.cursor
        }
        return due
      })
      for (const occurrence of pending) {
        const current = await this.storage.transaction(this.instanceId, tx => tx.get<ProductSchedule>('product-schedule', key(rule.ruleId)))
        if (current?.status === 'cancelled') {
          await this.updateOccurrence(occurrence, { status: 'cancelled', reason: 'SCHEDULE_CANCELLED' })
          continue
        }
        try {
          const result = await this.deliver(current!, occurrence)
          await this.updateOccurrence(occurrence, result)
        } catch (error) {
          const latest = await this.storage.transaction(this.instanceId, async tx => ({
            rule: await tx.get<ProductSchedule>('product-schedule', key(rule.ruleId)),
            source: await tx.get<{ enabled: boolean }>('product-schedule-source', sourceKey),
          }))
          const patch: Partial<ScheduledOccurrence> = latest.rule?.status === 'cancelled'
            ? { status: 'cancelled', reason: 'SCHEDULE_CANCELLED' }
            : latest.source?.enabled === false ? { status: 'pending', reason: 'SCHEDULE_SOURCE_CLOSED' }
              : { status: 'failed', reason: error instanceof CoreError ? error.code : 'DELIVERY_FAILED' }
          await this.updateOccurrence(occurrence, patch)
        }
      }
    }
    return { occurrences: processed }
  }

  private async updateOccurrence(occurrence: ScheduledOccurrence, patch: Partial<ScheduledOccurrence>) {
    await this.storage.transaction(this.instanceId, async tx => {
      const current = await tx.get<ScheduledOccurrence>('product-schedule-occurrence', occurrenceKey(occurrence.ruleId, occurrence.dueAt))
      if (current && current.status !== 'cancelled') await tx.replace('product-schedule-occurrence', occurrenceKey(occurrence.ruleId, occurrence.dueAt),
        { ...current, ...patch, attempts: current.attempts + 1, updatedAt: this.now() })
    })
  }
}
