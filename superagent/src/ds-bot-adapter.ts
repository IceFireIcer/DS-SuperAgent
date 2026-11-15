import { createHash, randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Engine } from './engine.js'
import type { Receipt } from './model.js'

export interface DsBotOwner {
  kind: string
  botId?: string
  roomId?: string
}

export interface DsBotAdapterContext {
  ctx: unknown
  rt: {
    chatOwners?: Map<string, string>
    displayItems?: (sessionId: string, events: readonly unknown[]) => unknown[]
  }
  signal?: AbortSignal
}

export interface DsBotNativeSessions {
  readSession(sessionId: string, options?: { limit?: number; after?: number }): Promise<{
    sessionId: string
    events: readonly SessionEvent[]
    cursor?: number
  }>
  readSessionPage?(sessionId: string, options?: { offset?: number; limit?: number }): Promise<{
    sessionId: string
    events: readonly SessionEvent[]
    total?: number
  }>
}

export interface DsBotEngineFactoryResult {
  engine: Pick<Engine, 'receiveSource' | 'acceptSource' | 'getReceipt' | 'conversation' | 'getTicket' | 'answerAttention' | 'stopTicket' | 'resumeTicket' | 'effects'>
  sessions: DsBotNativeSessions
  actorId: string
  dispose?: () => Promise<void> | void
}

interface AdapterRequest {
  requestId?: string
  sessionId: string
  owner?: DsBotOwner
  [key: string]: unknown
}

export type DsBotEngineFactory = (scope: {
  owner: DsBotOwner
  sessionId: string
  ctx: unknown
  rt: DsBotAdapterContext['rt']
}) => Promise<DsBotEngineFactoryResult> | DsBotEngineFactoryResult

export interface DsBotAdapterOptions {
  factory: DsBotEngineFactory
  authorize?: (scope: { owner: DsBotOwner; sessionId: string; ctx: unknown; rt: DsBotAdapterContext['rt'] }) => boolean | Promise<boolean>
  dispose?: () => Promise<void> | void
}

type Scope = { owner: DsBotOwner; sessionId: string; runtime: DsBotEngineFactoryResult; ctx: unknown; rt: DsBotAdapterContext['rt'] }
type ConversationView = Awaited<ReturnType<Engine['conversation']>>
interface FallbackItem { kind: 'user' | 'bot'; text: string; time: number; seq?: number }

const unsupported = (operation: string) => Object.assign(new Error(`The DS Bot Engine adapter does not support ${operation} for this scope.`), { code: 'bot/execution-unsupported' })
const invalid = (message: string) => Object.assign(new Error(message), { code: 'bot/invalid' })

function textOf(message: unknown): string {
  if (typeof message === 'string') return message.trim()
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message) ? message : (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  if (content.some(block => !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text')) throw unsupported('non-text content')
  return content.filter((block): block is { type: 'text'; text: string } => Boolean(block && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'))
    .map(block => block.text).join('\n').trim()
}

function requireRequestId(request: { requestId?: unknown }): string {
  if (typeof request.requestId !== 'string' || request.requestId.trim() === '') throw invalid('A stable requestId is required.')
  return request.requestId
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is { type: 'text'; text: string } => Boolean(block && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'))
    .map(block => block.text).join('\n').trim()
}

function itemKind(item: unknown) {
  return item && typeof item === 'object' ? (item as { kind?: unknown }).kind : undefined
}

function itemText(item: unknown) {
  return item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
    ? (item as { text: string }).text : ''
}

function itemTime(item: unknown) {
  return item && typeof item === 'object' && typeof (item as { time?: unknown }).time === 'number'
    ? (item as { time: number }).time : undefined
}

/**
 * Binds one DS Bot UI chat identity to one public Super-agent Engine.
 * The binding receipt is a normal Engine command, so a new adapter instance can
 * recover it without opening the Engine storage or maintaining a second ledger.
 */
export class DsBotExecutionAdapter {
  readonly version = 1 as const
  private readonly scopes = new Map<string, Promise<Scope>>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly options: DsBotAdapterOptions) {
    if (!options || typeof options.factory !== 'function') throw new TypeError('A public Engine factory is required.')
  }

  async supports({ operation, sessionId, owner }: { operation: string; sessionId: string; owner: DsBotOwner }, context: DsBotAdapterContext) {
    if (this.closed) return false
    if (operation === 'live') return true
    if (operation === 'projectSession') return typeof sessionId === 'string' && sessionId !== ''
    // A Bot's first Session is resolved before the roster knows its owner. The
    // Host-created Session still needs its real DSH Agent for title and tools.
    if (operation === 'resolveAgent' && sessionId && owner?.kind === 'agent') return true
    if (!sessionId || owner?.kind !== 'bot' || typeof owner.botId !== 'string' || owner.botId === '') return false
    if (!['prompt', 'deliver', 'answer', 'stop', 'resume', 'conversation', 'chatPage', 'live', 'projectSession', 'resolveAgent'].includes(operation)) return false
    return this.authorized({ owner, sessionId, ctx: context.ctx, rt: context.rt })
  }

  async prompt(request: AdapterRequest & { content: unknown }, context: DsBotAdapterContext) {
    return this.record(request, textOf(request.content), context)
  }

  async deliver(request: AdapterRequest & { message?: unknown; text?: string; exchangeId?: string; steer?: boolean }, context: DsBotAdapterContext) {
    if (request.steer) throw unsupported('steer')
    const requestId = requireRequestId({ requestId: request.requestId ?? request.exchangeId })
    return this.record({ ...request, requestId }, request.text ?? textOf(request.message), context)
  }

  private async record(request: AdapterRequest, text: string, context: DsBotAdapterContext) {
    if (!text.trim()) throw invalid('A prompt needs text content.')
    const id = requireRequestId(request)
    const scope = await this.scope(request.sessionId, request.owner, context)
    return this.serial(scope, async () => {
      context.signal?.throwIfAborted()
      const received = await scope.runtime.engine.receiveSource({ commandId: this.eventId(scope, id), threadId: scope.sessionId,
        objectId: this.eventId(scope, id), type: 'created', version: '1', text,
        authorId: scope.runtime.actorId, authorKind: 'human', addressing: 'direct' })
      if (received.status !== 'recorded' || !received.eventId) throw invalid('The UI input was not durably recorded.')
      let binding = await this.requireBinding(scope, false)
      if (!binding) {
        binding = await scope.runtime.engine.acceptSource({ commandId: this.bindingId(scope), threadId: scope.sessionId,
          objectId: this.eventId(scope, id), expectedEventId: received.eventId })
      }
      scope.runtime.engine.effects.start()
      scope.runtime.engine.effects.wake()
      return { durable: true as const, sessionId: scope.sessionId, ticketId: binding.ticketId }
    })
  }

  async answer(request: AdapterRequest & { questionId?: string; attentionId?: string; answer?: string; text?: string }, context: DsBotAdapterContext) {
    if (request.viewId || request.browserHold) throw unsupported('non-Attention answer')
    const attentionId = request.questionId ?? request.attentionId
    const answer = (typeof request.answer === 'string' ? request.answer : request.text ?? textOf(request.message)).trim()
    if (!attentionId || !answer) throw invalid('An answer needs an attention ID and text.')
    const scope = await this.scope(request.sessionId, request.owner, context)
    const binding = await this.requireBinding(scope)
    const conversation = await scope.runtime.engine.conversation(binding.ticketId)
    const replay = conversation.attention?.answerCommandId === requireRequestId(request) && conversation.attention.answerText === answer
    if (conversation.attention?.id !== attentionId || conversation.attention.status !== 'waiting' && !replay) throw Object.assign(new Error('The Attention is stale.'), { code: 'bot/stale' })
    await scope.runtime.engine.answerAttention({ commandId: requireRequestId(request), attentionId, text: answer })
    scope.runtime.engine.effects.start()
    scope.runtime.engine.effects.wake()
    return { durable: true as const, sessionId: request.sessionId, ticketId: binding.ticketId }
  }

  async stop(request: AdapterRequest & { reason?: string }, context: DsBotAdapterContext) {
    const scope = await this.scope(request.sessionId, request.owner, context)
    const binding = await this.requireBinding(scope)
    if (!binding) throw Object.assign(new Error('This UI Session has no durable Engine binding.'), { code: 'bot/not-found' })
    await scope.runtime.engine.stopTicket({ commandId: requireRequestId(request), ticketId: binding.ticketId, reason: request.reason ?? 'Stopped by the user.' })
    scope.runtime.engine.effects.start()
    scope.runtime.engine.effects.wake()
    return { durable: true as const, sessionId: request.sessionId, ticketId: binding.ticketId }
  }

  async resume(request: AdapterRequest, context: DsBotAdapterContext) {
    const scope = await this.scope(request.sessionId, request.owner, context)
    const binding = await this.requireBinding(scope)
    if (!binding) throw Object.assign(new Error('This UI Session has no durable Engine binding.'), { code: 'bot/not-found' })
    await scope.runtime.engine.resumeTicket({ commandId: requireRequestId(request), ticketId: binding.ticketId })
    scope.runtime.engine.effects.start()
    scope.runtime.engine.effects.wake()
    return { durable: true as const, sessionId: request.sessionId, ticketId: binding.ticketId }
  }

  async conversation(request: { sessionId: string; owner?: DsBotOwner }, context: DsBotAdapterContext) {
    const scope = await this.scope(request.sessionId, request.owner, context)
    const binding = await this.requireBinding(scope, false)
    return binding ? scope.runtime.engine.conversation(binding.ticketId) : undefined
  }

  async resolveAgent(request: { sessionId: string }, context: DsBotAdapterContext) {
    const botId = context.rt.chatOwners?.get(request.sessionId)
    if (!botId) {
      const controller = (context.ctx as { sessionController?: { resolveAgent(id: string): Promise<{
        agent?: { session?: { id?: string } }
        error?: { message?: string; code?: string }
      }> } }).sessionController
      if (!controller) throw unsupported('resolveAgent')
      const resolved = await controller.resolveAgent(request.sessionId)
      if (!resolved.agent || resolved.agent.session?.id !== request.sessionId) {
        throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
      }
      return resolved.agent
    }
    const owner = { kind: 'bot', botId }
    const scope = await this.scope(request.sessionId, owner, context)
    const binding = await this.requireBinding(scope, false)
    const conversation = binding ? await scope.runtime.engine.conversation(binding.ticketId) : undefined
    const running = conversation?.status === 'running' || conversation?.status === 'pending'
    return {
      session: { id: request.sessionId },
      status: running ? 'running' : 'idle',
      followup: (message: unknown) => this.deliver({ requestId: String((message as { id?: unknown })?.id ?? randomUUID()),
        sessionId: request.sessionId, owner, message }, context),
      steer: () => { throw unsupported('steer') },
      cancel: (options?: { reason?: string }) => this.stop({ requestId: `cancel:${randomUUID()}`, sessionId: request.sessionId,
        owner, reason: options?.reason ?? 'Cancelled by the Host.' }, context),
      inbox: { nextStep: [], nextTurn: [], remove: () => false, prepend: () => {} },
      whenIdle: async () => {
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          const current = binding ? await scope.runtime.engine.conversation(binding.ticketId) : undefined
          if (current?.status !== 'running' && current?.status !== 'pending') return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      },
    }
  }

  async projectSession(request: { sessionId: string }, context: DsBotAdapterContext) {
    await this.restoreScopes(context)
    for (const scopePromise of this.scopes.values()) {
      const scope = await scopePromise
      if (!await this.authorized({ ...scope, ctx: context.ctx, rt: context.rt })) continue
      const binding = await this.requireBinding(scope, false)
      if (!binding) continue
      const conversation = await scope.runtime.engine.conversation(binding.ticketId)
      if (conversation.assignments.some(assignment => assignment.sessionId === request.sessionId)) {
        return { botId: scope.owner.botId, sessionId: scope.sessionId }
      }
    }
    return undefined
  }

  async chatPage(request: { botId: string; sessionId: string; cursor?: unknown }, context: DsBotAdapterContext) {
    const scope = await this.scope(request.sessionId, { kind: 'bot', botId: request.botId }, context)
    if (typeof context.rt.displayItems !== 'function') throw unsupported('chat renderer')
    const binding = await this.requireBinding(scope, false)
    if (!binding) return { sessionId: scope.sessionId, items: [], cursor: null }
    const conversation = await scope.runtime.engine.conversation(binding.ticketId)
    const sessions = [...new Set([...conversation.assignmentHistory, ...conversation.assignments].map(assignment => assignment.sessionId))]
    if (sessions.length > 100) throw unsupported('Session history budget')
    const cursor = request.cursor as { sessionId?: unknown; beforeSeq?: unknown } | undefined
    if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Object.keys(cursor).some(key => !['sessionId', 'beforeSeq'].includes(key))
      || typeof cursor.sessionId !== 'string' || !sessions.includes(cursor.sessionId)
      || cursor.beforeSeq !== undefined && (!Number.isSafeInteger(cursor.beforeSeq) || Number(cursor.beforeSeq) < 0))) throw invalid('Invalid chat cursor.')
    const index = cursor ? sessions.indexOf(cursor.sessionId as string) : sessions.length - 1
    const sessionId = sessions[index]
    if (!sessionId) return { sessionId: scope.sessionId, items: [], cursor: null }
    const recent = await this.readRecentEvents(scope, sessionId,
      cursor?.beforeSeq === undefined ? undefined : Number(cursor.beforeSeq))
    const selected = recent.events
    const next = recent.more && selected.length > 0 ? { sessionId, beforeSeq: Number(selected[0]!.seq) }
      : index > 0 ? { sessionId: sessions[index - 1]! } : null
    const items = context.rt.displayItems(request.sessionId, selected)
    if (items.length > 0) {
      const renderedConversation = items.some(item => itemKind(item) === 'user' || itemKind(item) === 'bot')
      const needsFallback = renderedConversation && (cursor === undefined || items.some(item => itemKind(item) === 'user'))
      return { sessionId: request.sessionId,
        items: needsFallback ? this.mergeFallback(items, this.resultItems(conversation), selected, cursor === undefined) : items,
        cursor: next }
    }
    // The Engine's worker Session is a private execution log, not the copied UI's
    // message shape. Project the complete durable conversation instead of only
    // the first request and latest result, so multi-turn chats stay readable.
    const fallback = await this.fallbackItems(scope, conversation)
    return { sessionId: request.sessionId, items: fallback, cursor: fallback.length > 0 ? null : next }
  }

  private async readRecentEvents(scope: Scope, sessionId: string, before?: number) {
    const sessions = scope.runtime.sessions
    if (sessions.readSessionPage) {
      try {
        if (before !== undefined) {
          if (before === 0) return { events: [] as SessionEvent[], more: false }
          const start = Math.max(0, before - 20)
          const page = await sessions.readSessionPage(sessionId, { offset: start, limit: before - start })
          return { events: page.events.filter(event => Number(event.seq) < before).slice(-20), more: start > 0 }
        }
        const head = await sessions.readSessionPage(sessionId, { offset: 0, limit: 1 })
        if (head.total === undefined) {
          // A provider that cannot describe its log still needs the forward fallback.
        } else if (head.total === 0) {
          return { events: [] as SessionEvent[], more: false }
        } else {
          const start = Math.max(0, head.total - 20)
          const page = await sessions.readSessionPage(sessionId, { offset: start, limit: head.total - start })
          return { events: page.events.slice(-20), more: start > 0 }
        }
      } catch (error) {
        if (!this.missingSession(error)) throw error
        return { events: [] as SessionEvent[], more: false }
      }
    }
    const selected: SessionEvent[] = []
    let after: number | undefined
    let more = false
    for (;;) {
      let result: Awaited<ReturnType<DsBotNativeSessions['readSession']>>
      try {
        result = await sessions.readSession(sessionId, { limit: 100, ...(after === undefined ? {} : { after }) })
      } catch (error) {
        if (selected.length === 0 && this.missingSession(error)) break
        throw error
      }
      for (const event of result.events) {
        if (before !== undefined && Number(event.seq) >= before) continue
        selected.push(event)
        if (selected.length > 20) {
          selected.shift()
          more = true
        }
      }
      if (result.cursor === undefined) break
      if (result.cursor === after) throw invalid('The Session cursor did not advance.')
      after = result.cursor
    }
    return { events: selected, more }
  }

  private async fallbackItems(scope: Scope, conversation: ConversationView): Promise<FallbackItem[]> {
    const items: FallbackItem[] = []
    const add = (kind: 'user' | 'bot', text: string, time: number, seq?: number) => {
      const value = text.trim()
      if (!value) return
      items.push({ kind, text: value, time, ...(seq === undefined ? {} : { seq }) })
    }
    const sessionIds = [...new Set([...conversation.assignmentHistory, ...conversation.assignments].map(assignment => assignment.sessionId))]
    for (const sessionId of sessionIds) {
      let events: readonly SessionEvent[]
      try {
        events = await this.allSessionEvents(scope, sessionId)
      } catch (error) {
        if (this.missingSession(error)) continue
        throw error
      }
      for (const event of events) {
        if (event.type === 'user/message') {
          const data = event.data as { source?: { kind?: string }; content?: unknown }
          if (data.source?.kind === 'user') add('user', visibleText(data.content), event.time, Number(event.seq))
        }
      }
    }
    items.push(...this.resultItems(conversation))
    return items.sort((left, right) => left.time - right.time || (left.seq ?? -1) - (right.seq ?? -1))
  }

  private resultItems(conversation: ConversationView): FallbackItem[] {
    const items: FallbackItem[] = []
    for (const message of conversation.messageHistory) {
      if (message.purpose !== 'result' || message.state !== 'sent' || !message.text.trim()) continue
      items.push({ kind: 'bot', text: message.text.trim(), time: message.createdAt })
    }
    if (items.length === 0) {
      for (const report of conversation.reports) {
        if (report.result.trim()) items.push({ kind: 'bot', text: report.result.trim(), time: report.createdAt })
      }
    }
    return items.sort((left, right) => left.time - right.time || (left.seq ?? -1) - (right.seq ?? -1))
  }

  private async allSessionEvents(scope: Scope, sessionId: string): Promise<readonly SessionEvent[]> {
    const sessions = scope.runtime.sessions
    if (sessions.readSessionPage) {
      const events: SessionEvent[] = []
      let offset = 0
      for (;;) {
        const page = await sessions.readSessionPage(sessionId, { offset, limit: 100 })
        events.push(...page.events)
        if (page.events.length < 100) break
        offset += page.events.length
        if (page.total !== undefined && offset >= page.total) break
      }
      return events
    }
    const events: SessionEvent[] = []
    let after: number | undefined
    for (;;) {
      const page = await sessions.readSession(sessionId, { limit: 100, ...(after === undefined ? {} : { after }) })
      events.push(...page.events)
      if (page.cursor === undefined) break
      if (page.cursor === after) throw invalid('The Session cursor did not advance.')
      after = page.cursor
    }
    return events
  }

  private mergeFallback(items: unknown[], fallback: FallbackItem[], selected: readonly SessionEvent[], includeLatest: boolean) {
    const times = selected.map(event => event.time).filter(Number.isFinite)
    if (times.length === 0) return items
    const start = Math.min(...times)
    const end = Math.max(...times)
    const counts = new Map<string, number>()
    const merged = [...items]
    for (const item of items) {
      const kind = itemKind(item)
      const text = itemText(item).trim()
      if ((kind === 'user' || kind === 'bot') && text) {
        const identity = `${kind}\u0000${text}`
        counts.set(identity, (counts.get(identity) ?? 0) + 1)
      }
    }
    for (const item of fallback) {
      if (item.time < start || item.time > end) continue
      const identity = `${item.kind}\u0000${item.text}`
      const remaining = counts.get(identity) ?? 0
      if (remaining > 0) {
        counts.set(identity, remaining - 1)
        continue
      }
      merged.push({ kind: item.kind, text: item.text, time: item.time })
    }
    if (includeLatest) {
      const latest = fallback.findLast(item => item.kind === 'bot')
      if (latest && !merged.some(item => itemKind(item) === 'bot' && itemText(item) === latest.text)) {
        merged.push({ kind: latest.kind, text: latest.text, time: latest.time })
      }
    }
    if (merged.every(item => itemTime(item) !== undefined)) {
      merged.sort((left, right) => itemTime(left)! - itemTime(right)!)
    }
    return merged
  }

  private missingSession(error: unknown) {
    const failure = error as { code?: unknown; name?: unknown }
    return failure?.code === 'NOT_FOUND' || failure?.name === 'SessionPersistenceNotFoundError'
  }

  async live(_request: unknown, context: DsBotAdapterContext) {
    await this.restoreScopes(context)
    const activity: Record<string, string> = {}
    const bots: Record<string, { since: number; said?: string }> = {}
    const questions: Record<string, { id: string; callId: string; question: string; options: { label: string }[]; multiSelect: false }> = {}
    for (const scopePromise of this.scopes.values()) {
      try {
        const scope = await scopePromise
        if (!await this.authorized({ ...scope, ctx: context.ctx, rt: context.rt })) continue
        const binding = await this.requireBinding(scope, false)
        if (!binding) continue
        const conversation = await scope.runtime.engine.conversation(binding.ticketId)
        if (conversation.attention?.status === 'waiting') {
          const attention = conversation.attention
          questions[scope.sessionId] = { id: attention.id, callId: attention.id, question: attention.question,
            options: attention.options.map(label => ({ label })), multiSelect: false }
        }
        if (conversation.stage === 'draft' || conversation.stage === 'pending' || conversation.stage === 'waiting-human') {
          activity[scope.owner.botId!] = conversation.stage === 'waiting-human' ? 'alert' : 'thinking'
          bots[scope.owner.botId!] = { since: conversation.assignments[0]?.createdAt ?? 0, ...(conversation.request ? { said: conversation.request } : {}) }
        }
      } catch {
        // One unavailable historical chat must not erase the whole live projection.
      }
    }
    return { activity, questions, work: { bots, rooms: {}, waiting: {}, turns: {}, steered: {} } }
  }

  /** Release every UI scope and the production factory's shared resources. */
  async close() {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      const scopes = [...this.scopes.values()]
      this.scopes.clear()
      const errors: unknown[] = []
      for (const scopePromise of scopes) {
        try {
          const scope = await scopePromise
          if (scope.runtime.dispose) await scope.runtime.dispose()
          else await scope.runtime.engine.effects.stop()
        } catch (error) { errors.push(error) }
      }
      try { await this.options.dispose?.() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'The DS Bot execution adapter did not close cleanly.')
    })()
    return this.closing
  }

  private async authorized(scope: { owner: DsBotOwner; sessionId: string; ctx: unknown; rt: DsBotAdapterContext['rt'] }) {
    if (scope.owner?.kind !== 'bot' || !scope.owner.botId || scope.owner.roomId || !scope.sessionId) return false
    if (scope.rt.chatOwners?.get(scope.sessionId) !== scope.owner.botId) return false
    return this.options.authorize ? await this.options.authorize(scope) === true : true
  }

  private async scope(sessionId: string, owner: DsBotOwner | undefined, context: DsBotAdapterContext): Promise<Scope> {
    if (this.closed) throw unsupported('closed adapter')
    context.signal?.throwIfAborted()
    if (!owner || !await this.authorized({ owner, sessionId, ctx: context.ctx, rt: context.rt })) throw unsupported('scope')
    if (this.closed) throw unsupported('closed adapter')
    const existing = this.scopes.get(sessionId)
    if (existing) {
      const value = await existing
      if (value.owner.botId !== owner.botId || value.ctx !== context.ctx || value.rt !== context.rt) throw unsupported('owner or Host change')
      return value
    }
    const promise = Promise.resolve(this.options.factory({ owner: { ...owner }, sessionId, ctx: context.ctx, rt: context.rt }))
      .then(runtime => {
        if (!runtime?.engine?.effects || !runtime.sessions || !runtime.actorId) throw new TypeError('The Engine factory returned an incomplete public runtime.')
        return { owner: { ...owner }, sessionId, runtime, ctx: context.ctx, rt: context.rt }
      })
    this.scopes.set(sessionId, promise)
    if (this.closed) {
      this.scopes.delete(sessionId)
      void promise.then(scope => scope.runtime.dispose?.()).catch(() => {})
      throw unsupported('closed adapter')
    }
    try { return await promise } catch (error) { this.scopes.delete(sessionId); throw error }
  }

  private bindingId(scope: Scope) { return `ui-accept:${this.scopeId(scope)}` }
  private scopeId(scope: Scope) { return createHash('sha256').update(JSON.stringify([scope.owner.botId, scope.sessionId])).digest('hex') }
  private eventId(scope: Scope, requestId: string) { return `ui-input:${this.scopeId(scope)}:${createHash('sha256').update(requestId).digest('hex')}` }

  private requireBinding(scope: Scope, required?: true): Promise<Receipt>
  private requireBinding(scope: Scope, required: false): Promise<Receipt | undefined>
  private async requireBinding(scope: Scope, required = true): Promise<Receipt | undefined> {
    const receipt = await scope.runtime.engine.getReceipt(this.bindingId(scope))
    if (!receipt) {
      if (required) throw Object.assign(new Error('This UI Session has no durable Engine binding.'), { code: 'bot/not-found' })
      return undefined
    }
    const work = await scope.runtime.engine.getTicket(receipt.ticketId)
    if (!work || work.trigger.threadId !== scope.sessionId || work.trigger.source.actorId !== scope.runtime.actorId) throw unsupported('binding scope')
    return receipt
  }

  private async restoreScopes(context: DsBotAdapterContext) {
    const entries = [...context.rt.chatOwners?.entries() ?? []]
    const retired: Promise<void>[] = []
    for (const [sessionId, scopePromise] of this.scopes) {
      const botId = context.rt.chatOwners?.get(sessionId)
      if (botId !== undefined && await this.authorized({ owner: { kind: 'bot', botId }, sessionId, ctx: context.ctx, rt: context.rt })) continue
      this.scopes.delete(sessionId)
      retired.push((async () => {
        try {
          const scope = await scopePromise
          if (scope.runtime.dispose) await scope.runtime.dispose()
          else await scope.runtime.engine.effects.stop()
        } catch { /* An already failed scope has nothing left to release. */ }
      })())
    }
    await Promise.all(retired)
    for (const [sessionId, botId] of entries) {
      const owner = { kind: 'bot', botId }
      if (!await this.authorized({ owner, sessionId, ctx: context.ctx, rt: context.rt })) continue
      try {
        await this.scope(sessionId, owner, context)
      } catch (error) {
        if (this.closed) throw error
        // A local failure is not a budget for every other chat.
      }
    }
  }

  private async serial<T>(scope: Scope, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(scope.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    this.pending.set(scope.sessionId, current)
    try { return await current } finally { if (this.pending.get(scope.sessionId) === current) this.pending.delete(scope.sessionId) }
  }
}
