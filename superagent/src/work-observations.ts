import { createHash } from 'node:crypto'
import { CoreError, identifier, type Work } from './model.js'
import type { NativeSessions } from './native-sessions.js'
import type { AsyncTx, Storage } from './storage.js'

type ObservationRole = 'router' | 'worker'

interface MainWorkBrief {
  id: string
  instanceId: string
  mainId: string
  routerSessionId: string
  goal: string
  constraints: string
  acceptanceCriteria: string
  configurationRevision: number
  createdAt: number
}

interface MainWorkItem {
  id: string
  workBriefId: string
  goal: string
  constraints: string
  acceptanceCriteria: string
  position: number
  createdAt: number
}

interface MainWorkReceipt {
  status: 'routing' | 'accepted' | 'rejected'
  ticketId?: string
  reason?: string
  nextStep: string
}

interface MainWorkUpdate {
  status: string
  summary: string
  createdAt: number
}

interface MainWorkOutcome {
  status: string
  summary: string
  nextStep: string
  updatedAt: number
}

interface Assignment {
  id: string
  ticketId: string
  sessionId: string
  state: 'pending' | 'running' | 'stopping' | 'ended'
  generation: string
  createdAt: number
}

interface WorkSplit {
  itemIds: string[]
}

interface WorkObservationItem {
  id: string
  role: ObservationRole
  workBriefId: string
  workItemId?: string
  ticketId?: string
  title: string
  status: string
  summary: string
  nextStep: string
  sessionId?: string
  generation?: string
  current: boolean
  createdAt: number
  updatedAt: number
}

interface WorkObservationFact {
  label: string
  value: string
}

interface WorkObservationGeneration {
  assignmentId: string
  generation: string
  sessionId: string
  state: Assignment['state']
  current: boolean
  createdAt: number
}

interface WorkObservationEvent {
  seq: number
  time?: number
  kind: 'user-message' | 'assistant-message' | 'tool-call' | 'tool-result' | 'turn'
  text: string
  tool?: string
  argumentKeys?: string[]
  isError?: boolean
  reason?: string
}

export interface WorkObservationPage {
  items: WorkObservationItem[]
  cursor?: string
}

export interface WorkObservationHistory {
  id: string
  role: ObservationRole
  workBriefId: string
  workItemId?: string
  ticketId?: string
  title: string
  status: string
  summary: string
  nextStep: string
  sessionId?: string
  generation?: string
  current: boolean
  facts: WorkObservationFact[]
  generations: WorkObservationGeneration[]
  events: WorkObservationEvent[]
  next?: number
  hasMore: boolean
}

interface ObservationAddress {
  version: 1
  role: ObservationRole
  workBriefId: string
  workItemId?: string
  ticketId?: string
}

interface ObservationCursor {
  version: 1
  fingerprint: string
  createdAt: number
  id: string
}

const observationId = (address: ObservationAddress) => Buffer.from(JSON.stringify(address)).toString('base64url')
const encodeCursor = (cursor: ObservationCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')
const messageText = (content: unknown) => Array.isArray(content) ? content
  .filter(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
  .map(block => (block as { text?: unknown }).text)
  .filter((text): text is string => typeof text === 'string').join('\n') : ''

function bounded(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) throw new CoreError('INVALID_INPUT', `${label} must be bounded text.`)
  return value.trim()
}

function summary(value: string, maximum = 512) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function redact(value: string) {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\x2f-]+=*/giu, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
}

function comparison(left: Pick<WorkObservationItem, 'createdAt' | 'id'>, right: Pick<WorkObservationItem, 'createdAt' | 'id'>) {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id)
}

function decodeObservationId(value: unknown): ObservationAddress {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2048) throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ObservationAddress>
    if (decoded.version !== 1 || decoded.role !== 'router' && decoded.role !== 'worker'
      || typeof decoded.workBriefId !== 'string' || !decoded.workBriefId
      || decoded.workItemId !== undefined && (typeof decoded.workItemId !== 'string' || !decoded.workItemId)
      || decoded.ticketId !== undefined && (typeof decoded.ticketId !== 'string' || !decoded.ticketId)) {
      throw new Error('invalid observation address')
    }
    return decoded as ObservationAddress
  } catch {
    throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
  }
}

function decodeCursor(value: unknown): ObservationCursor | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length < 8 || value.length > 2048) throw new CoreError('INVALID_INPUT', 'The work activity cursor is invalid.')
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ObservationCursor>
    if (decoded.version !== 1 || typeof decoded.fingerprint !== 'string' || !decoded.fingerprint
      || !Number.isSafeInteger(decoded.createdAt) || decoded.createdAt! < 0 || typeof decoded.id !== 'string' || !decoded.id) {
      throw new Error('invalid cursor')
    }
    return decoded as ObservationCursor
  } catch {
    throw new CoreError('INVALID_INPUT', 'The work activity cursor is invalid.')
  }
}

function projectEvent(raw: unknown): WorkObservationEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const event = raw as { seq?: unknown; time?: unknown; type?: unknown; data?: Record<string, unknown> }
  const seq = Number(event.seq)
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined
  const time = Number.isSafeInteger(event.time) ? Number(event.time) : undefined
  const common = { seq, ...(time === undefined ? {} : { time }) }
  if (event.type === 'user/message') {
    const text = redact(messageText(event.data?.content)).trim()
    if (text.startsWith('Current runtime context.') || text.startsWith('Generate the session title from this JSON array')) return undefined
    return text ? { ...common, kind: 'user-message', text: summary(text, 4096) } : undefined
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message as { content?: unknown } | undefined
    const text = redact(messageText(message?.content)).trim()
    return text ? { ...common, kind: 'assistant-message', text: summary(text, 4096) } : undefined
  }
  if (event.type === 'tool/call') {
    const tool = typeof event.data?.name === 'string' ? event.data.name.slice(0, 256) : 'tool'
    let argumentKeys: string[] = []
    try {
      const parsed = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) argumentKeys = Object.keys(parsed).sort().slice(0, 32)
    } catch { /* Invalid arguments are still only a tool-call fact. */ }
    return { ...common, kind: 'tool-call', tool, ...(argumentKeys.length ? { argumentKeys } : {}),
      text: `Called ${tool}.` }
  }
  if (event.type === 'tool/result') {
    const message = event.data?.message as { isError?: unknown } | undefined
    return { ...common, kind: 'tool-result', isError: message?.isError === true,
      text: message?.isError === true ? 'Tool call failed.' : 'Tool call completed.' }
  }
  if (event.type === 'turn/end') {
    const reason = event.data?.reason as { kind?: unknown } | undefined
    return { ...common, kind: 'turn', ...(typeof reason?.kind === 'string' ? { reason: reason.kind.slice(0, 128) } : {}),
      text: typeof reason?.kind === 'string' ? `Turn ended: ${reason.kind.slice(0, 128)}.` : 'Turn ended.' }
  }
  return undefined
}

function workerStatus(ticket: Work['ticket'] | undefined, intent: Work['intent'] | undefined,
  update: MainWorkUpdate | undefined, outcome: MainWorkOutcome | undefined) {
  if (ticket?.constraint?.kind === 'stopped') {
    return { status: 'stopped', summary: 'The Ticket is stopped.', nextStep: 'Review the stop before resuming.' }
  }
  if (ticket?.constraint?.kind === 'waiting-human') {
    return { status: 'waiting', summary: 'The Worker is waiting for an answer.', nextStep: 'Answer the current work question.' }
  }
  if (outcome?.status) return { status: outcome.status, summary: outcome.summary, nextStep: outcome.nextStep }
  if (update) return { status: update.status, summary: update.summary, nextStep: observationNextStep(update.status) }
  if (intent?.state === 'ready' || intent?.reason === 'ready-report') {
    return { status: 'success', summary: 'The Worker recorded a verified result.', nextStep: 'Review the verified result and evidence.' }
  }
  if (ticket?.state === 'ended' || intent?.reason === 'worker-idle') {
    return { status: 'failed', summary: 'The Worker ended without a verified result.', nextStep: 'Review the failure before deciding whether to retry.' }
  }
  if (intent?.reason === 'environment-waiting' || intent?.reason === 'setup-failed') {
    return { status: 'blocked', summary: 'The execution environment is not ready.', nextStep: 'Resolve the execution blocker.' }
  }
  if (intent?.state === 'running') {
    return { status: 'running', summary: 'The Worker is executing this Ticket.', nextStep: 'Inspect the execution history or wait for the next update.' }
  }
  return { status: 'pending', summary: 'The Ticket is waiting for Worker execution.', nextStep: 'Wait for the assigned Worker to start.' }
}

function observationNextStep(status: string) {
  if (status === 'success') return 'Review the verified result and evidence.'
  if (status === 'waiting') return 'Answer the current work question.'
  if (status === 'stopped') return 'Review the stop before resuming.'
  if (status === 'blocked') return 'Resolve the execution blocker.'
  if (status === 'unknown') return 'Reconcile the original work before retrying.'
  if (status === 'failed') return 'Review the failure before deciding whether to retry.'
  if (status === 'running') return 'Inspect the execution history or wait for the next update.'
  return 'Wait for the next durable work update.'
}

/** A read-only projection over durable Main work and its public native Session logs. */
export class WorkObservations {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly sessions: NativeSessions) {}

  async list(mainId: string, options: { limit?: number; after?: string; query?: string } = {}): Promise<WorkObservationPage> {
    identifier(mainId, 'mainId')
    const limit = options.limit ?? 30
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Work activity needs a bounded page.')
    const query = bounded(options.query ?? '', 'Work activity search', 256).toLocaleLowerCase()
    const fingerprint = createHash('sha256').update(JSON.stringify(['work-observation-list-v1', this.instanceId, mainId, query])).digest('hex')
    const cursor = decodeCursor(options.after)
    if (cursor && cursor.fingerprint !== fingerprint) throw new CoreError('INVALID_INPUT', 'The work activity cursor belongs to another search.')
    const items = await this.storage.transaction(this.instanceId, transaction => this.listIn(transaction, mainId))
    const matching = items.filter(item => !query || [
      item.role, item.title, item.status, item.summary, item.nextStep, item.ticketId ?? '',
      item.workBriefId, item.workItemId ?? '', item.generation ?? '',
    ].join('\n').toLocaleLowerCase().includes(query))
      .sort(comparison)
      .filter(item => !cursor || item.createdAt < cursor.createdAt || item.createdAt === cursor.createdAt && item.id < cursor.id)
    const page = matching.slice(0, limit)
    const last = page.at(-1)
    return { items: page, ...(matching.length > limit && last
      ? { cursor: encodeCursor({ version: 1, fingerprint, createdAt: last.createdAt, id: last.id }) } : {}) }
  }

  async read(mainId: string, request: { observationId: string; generation?: string; after?: number; limit?: number }): Promise<WorkObservationHistory> {
    identifier(mainId, 'mainId')
    const after = request.after
    const limit = request.limit ?? 50
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CoreError('INVALID_INPUT', 'Work observation history needs a bounded page and non-negative cursor.')
    }
    const address = decodeObservationId(request.observationId)
    const facts = await this.storage.transaction(this.instanceId, transaction => this.readFacts(transaction, mainId, address, request.generation))
    const history = await this.readSession(facts.sessionId, after, limit)
    return { id: observationId(address), ...facts, events: history.events, ...(history.next === undefined ? {} : { next: history.next }),
      hasMore: history.hasMore }
  }

  private async listIn(transaction: AsyncTx, mainId: string) {
    const briefs: MainWorkBrief[] = []
    let after: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<MainWorkBrief>('work-brief', { limit: 100, ...(after === undefined ? {} : { after }) })
      briefs.push(...page.items.map(item => item.value).filter(brief => brief.mainId === mainId))
      if (!page.cursor) break
      after = page.cursor
      if (pageCount === 9) throw new CoreError('WORK_OBSERVATION_BUDGET', 'The work activity index exceeds its 1000-brief budget.')
    }
    const items: WorkObservationItem[] = []
    for (const brief of briefs) {
      const split = await transaction.get<WorkSplit>('work-split', brief.id)
      const receipt = await transaction.get<MainWorkReceipt>('work-receipt', brief.id)
      const itemReceipts = split ? await Promise.all(split.itemIds.map(id => transaction.get<MainWorkReceipt>('work-receipt', id))) : []
      const routerStatus = itemReceipts.some(value => value?.status === 'rejected') ? 'rejected'
        : itemReceipts.some(value => value?.status === 'routing') ? 'routing'
          : receipt?.status ?? 'routing'
      items.push({
        id: observationId({ version: 1, role: 'router', workBriefId: brief.id }),
        role: 'router',
        workBriefId: brief.id,
        title: brief.goal,
        status: routerStatus,
        summary: split ? 'Router is coordinating the durable work plan.' : 'Router is deciding the work plan.',
        nextStep: receipt?.nextStep ?? 'Wait for Router to establish the durable work plan.',
        sessionId: brief.routerSessionId,
        current: true,
        createdAt: brief.createdAt,
        updatedAt: brief.createdAt,
      })
      if (!split) continue
      const workItems = await Promise.all(split.itemIds.map(id => transaction.get<MainWorkItem>('work-item', id)))
      for (const item of workItems.filter((value): value is MainWorkItem => !!value)) {
        const itemReceipt = await transaction.get<MainWorkReceipt>('work-receipt', item.id)
        const index = await transaction.get<{ ticketId: string }>('work-item-ticket', item.id)
        const ticketId = itemReceipt?.ticketId ?? index?.ticketId
        if (itemReceipt?.status !== 'accepted' || !ticketId || !await transaction.get<Work['ticket']>('ticket', ticketId)) continue
        const assignments = await this.assignments(transaction, ticketId)
        const currentAssignment = await transaction.get<Assignment>('assignment', ticketId)
        const generation = currentAssignment?.generation ?? assignments.at(-1)?.generation
        const sessionId = currentAssignment?.sessionId ?? assignments.at(-1)?.sessionId
        const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
        const intent = await transaction.get<Work['intent']>('intent', ticketId)
        const update = await transaction.get<MainWorkUpdate>('work-update-head', item.id)
        const outcome = await transaction.get<MainWorkOutcome>('work-outcome', item.id)
        const state = workerStatus(ticket, intent, update, outcome)
        items.push({
          id: observationId({ version: 1, role: 'worker', workBriefId: brief.id, workItemId: item.id, ticketId }),
          role: 'worker',
          workBriefId: brief.id,
          workItemId: item.id,
          ticketId,
          title: item.goal,
          ...state,
          ...(sessionId ? { sessionId } : {}),
          ...(generation ? { generation } : {}),
          current: !!currentAssignment,
          createdAt: item.createdAt,
          updatedAt: Math.max(item.createdAt, update?.createdAt ?? 0, outcome?.updatedAt ?? 0, currentAssignment?.createdAt ?? 0,
            assignments.at(-1)?.createdAt ?? 0),
        })
      }
    }
    return items
  }

  private async readFacts(transaction: AsyncTx, mainId: string, address: ObservationAddress, requestedGeneration?: string) {
    const brief = await transaction.get<MainWorkBrief>('work-brief', address.workBriefId)
    if (!brief || brief.instanceId !== this.instanceId || brief.mainId !== mainId) {
      throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
    }
    if (address.role === 'router') {
      if (address.workItemId !== undefined || address.ticketId !== undefined) throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
      const split = await transaction.get<WorkSplit>('work-split', brief.id)
      const receipts = split ? await Promise.all(split.itemIds.map(id => transaction.get<MainWorkReceipt>('work-receipt', id))) : []
      const status = receipts.some(value => value?.status === 'rejected') ? 'rejected'
        : receipts.some(value => value?.status === 'routing') ? 'routing' : receipts.length && receipts.every(value => value?.status === 'accepted')
          ? 'accepted' : 'routing'
      return {
        role: 'router' as const,
        workBriefId: brief.id,
        title: brief.goal,
        status,
        summary: split ? 'Router is coordinating the durable work plan.' : 'Router has not established a durable work plan.',
        nextStep: status === 'routing' ? 'Wait for Router to establish the remaining durable work.' : 'Review the independent Worker activity.',
        sessionId: brief.routerSessionId,
        current: true,
        facts: [
          { label: 'Role', value: 'Router' },
          { label: 'Work brief', value: brief.id },
          { label: 'Session', value: brief.routerSessionId },
          { label: 'Configuration revision', value: String(brief.configurationRevision) },
          { label: 'Goal', value: summary(brief.goal) },
          { label: 'Constraints', value: summary(brief.constraints) },
          { label: 'Acceptance criteria', value: summary(brief.acceptanceCriteria) },
        ],
        generations: [],
      }
    }
    if (!address.workItemId || !address.ticketId) throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
    const item = await transaction.get<MainWorkItem>('work-item', address.workItemId)
    const receipt = await transaction.get<MainWorkReceipt>('work-receipt', address.workItemId)
    const index = await transaction.get<{ ticketId: string }>('work-item-ticket', address.workItemId)
    const ticketId = receipt?.ticketId ?? index?.ticketId
    if (!item || item.workBriefId !== brief.id || receipt?.status !== 'accepted' || ticketId !== address.ticketId) {
      throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
    }
    const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket ? await transaction.get<Work['trigger']>('trigger', ticket.triggerId) : undefined
    if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The requested work observation is unavailable.')
    const assignments = await this.assignments(transaction, ticketId)
    const currentAssignment = await transaction.get<Assignment>('assignment', ticketId)
    const selected = typeof requestedGeneration === 'string'
      ? assignments.find(assignment => assignment.generation === requestedGeneration) : undefined
    if (!selected) throw new CoreError('NOT_FOUND', 'The requested work observation generation is unavailable.')
    const current = currentAssignment?.generation === selected.generation
    const intent = await transaction.get<Work['intent']>('intent', ticketId)
    const update = await transaction.get<MainWorkUpdate>('work-update-head', item.id)
    const outcome = await transaction.get<MainWorkOutcome>('work-outcome', item.id)
    const state = current ? workerStatus(ticket, intent, update, outcome)
      : { status: selected.state, summary: 'This Assignment generation is retained in history.',
        nextStep: 'Return to the current generation for the next executable step.' }
    const generations = assignments.map(assignment => ({
      assignmentId: assignment.id,
      generation: assignment.generation,
      sessionId: assignment.sessionId,
      state: assignment.state,
      current: currentAssignment?.generation === assignment.generation,
      createdAt: assignment.createdAt,
    }))
    return {
      role: 'worker' as const,
      workBriefId: brief.id,
      workItemId: item.id,
      ticketId,
      title: item.goal,
      ...state,
      sessionId: selected.sessionId,
      generation: selected.generation,
      current,
      facts: [
        { label: 'Role', value: 'Worker' },
        { label: 'Work item', value: item.id },
        { label: 'Ticket', value: ticketId },
        { label: 'Mandate', value: ticket.mandateId },
        { label: 'Session', value: selected.sessionId },
        { label: 'Generation', value: selected.generation },
        { label: 'Generation state', value: current ? 'Current' : 'Historical' },
        { label: 'Goal', value: summary(item.goal) },
        { label: 'Constraints', value: summary(item.constraints) },
        { label: 'Acceptance criteria', value: summary(item.acceptanceCriteria) },
      ],
      generations,
    }
  }

  private async assignments(transaction: AsyncTx, ticketId: string) {
    const prefix = `${JSON.stringify(['assignment-history', ticketId])}:`
    const records = new Map<string, Assignment>()
    let after = prefix
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<Assignment>('assignment-history', { limit: 100, after })
      for (const entry of page.items) {
        if (!entry.id.startsWith(prefix)) break
        records.set(entry.value.id, entry.value)
      }
      if (!page.cursor || !page.cursor.startsWith(prefix)) break
      after = page.cursor
      if (pageCount === 9) throw new CoreError('ASSIGNMENT_BUDGET', 'The observation Assignment history exceeds its 1000-record budget.')
    }
    return [...records.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  private async readSession(sessionId: string | undefined, after: number | undefined, limit: number) {
    if (!sessionId) return { events: [] as WorkObservationEvent[], next: after, hasMore: false }
    const events: WorkObservationEvent[] = []
    let rawAfter = after
    let next = after
    try {
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await this.sessions.readSession(sessionId, { limit: 100, ...(rawAfter === undefined ? {} : { after: rawAfter }) })
        for (let index = 0; index < page.events.length; index++) {
          const raw = page.events[index] as { seq?: unknown }
          const seq = Number(raw.seq)
          if (Number.isSafeInteger(seq) && seq >= 0) next = seq
          const event = projectEvent(raw)
          if (event) events.push(event)
          if (events.length === limit) {
            return { events, next, hasMore: index < page.events.length - 1 || page.cursor !== undefined }
          }
        }
        if (!page.cursor) return { events, next, hasMore: false }
        rawAfter = page.cursor
        if (pageCount === 9) return { events, next, hasMore: true }
      }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'NOT_FOUND') return { events, next, hasMore: false }
      throw error
    }
    return { events, next, hasMore: true }
  }
}
