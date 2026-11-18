import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

function* maxTokensResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

test('a new GitHub request enters Main exclusively and later events stay on the same Ticket', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-main-github-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  let storage, native, sessions, desktop, github
  const deliveries = []
  t.after(async () => {
    const disposers = [
      () => desktop?.effects.stop(), () => github?.effects.stop(), () => desktop?.shutdown(), () => github?.shutdown(),
      () => sessions?.close(), () => native?.fiber.dispose(), () => storage?.close(),
      async () => { assert.ok(directory.startsWith(join(tmpdir(), 'ds-superagent-main-github-'))); await rm(directory, { recursive: true, force: true }) },
    ]
    const errors = []
    for (const dispose of disposers) try { await dispose() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Main GitHub intake fixture cleanup failed.')
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (text.includes('[GitHub request]') && completed === 0) {
        yield* toolResponse('delegate_work', { items: [{ goal: 'Fix the reported GitHub issue.', constraints: 'Use only the issue scope.',
          acceptanceCriteria: 'Return the verified fix to the original issue.' }] })
      } else yield* textResponse('Main accepted the GitHub request.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (text.includes('Ask for confirmation.') && completed === 0) {
      yield* toolResponse('ask_human', { question: 'Approve the verified login fix?', options: 'Yes\nNo' })
    } else if (completed === 0) yield* toolResponse('write_file', { path: 'issue-7.txt', text: 'Fix the login button.' })
    else if (completed === 1) yield* toolResponse('read_file', { path: 'issue-7.txt' })
    else if (completed === 2) yield* toolResponse('report_ready', { result: 'Issue fix verified.', evidence: 'Read back the scoped fix.', artifacts: 'issue-7.txt' })
    else yield* textResponse('Recorded.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const channel = { deliver: async delivery => { deliveries.push(structuredClone(delivery)); return { type: 'success' } } }
  const environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['desktop-owner'], permissions: ['read', 'write'], commands: {} })
  desktop = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner', allowedActorIds: ['desktop-owner'] },
    {}, sessions, [environment], {}, {}, {}, { channel })
  github = new core.Engine(storage, 'private', { kind: 'github', sourceInstanceId: 'github:acme/repo', actorId: 'github-receiver',
    allowedActorIds: ['github-receiver'], allowedThreadPrefixes: ['github:acme/repo#'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
    {}, sessions)
  await desktop.openMain({ instanceId: 'private' })
  const config = { owner: 'acme', repo: 'repo', mainIntake: true }
  const source = new core.GitHubSource(storage, 'private', github, config)
  const issue = { deliveryId: 'issue-created', cursor: '1', repo: 'acme/repo', kind: 'issue', action: 'created', number: 7,
    id: 'issue-7', authorId: 'alice', title: 'Fix the login bug', body: 'The login button does not respond.', updatedAt: '2026-11-15T00:00:00Z' }
  const receipt = await source.receive(issue)
  assert.equal(receipt.status, 'recorded')
  assert.equal((await desktop.listTickets()).items.length, 0, 'source intake must not create a Router Ticket')
  let sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.equal(sources.items.length, 1)
  assert.equal(sources.items[0].state, 'pending')

  const restartedSource = new core.GitHubSource(storage, 'private', github, config)
  assert.equal((await restartedSource.receive(issue)).eventId, receipt.eventId)
  sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.equal(sources.items.length, 1, 'replay and restart must not duplicate the Main handoff')
  assert.equal((await desktop.effects.list()).items.filter(effect => effect.payload.type === 'main-source-handoff').length, 1)
  assert.equal((await desktop.listTickets()).items.length, 0)
  const evaluated = await github.assessSourceBatch({ commandId: 'must-not-route', threadId: 'github:acme/repo#7', eventIds: [receipt.eventId] })
  assert.deepEqual([evaluated.items[0].outcome, evaluated.items[0].reason], ['rejected', 'ALREADY_OWNED'])
  assert.equal((await desktop.listTickets()).items.length, 0, 'a Main handoff must make the source event ineligible for Eval/Ticket intake')

  const drain = async () => { for (let index = 0; index < 12; index++) await desktop.effects.drain() }
  await drain()
  const tickets = (await desktop.listTickets()).items
  assert.equal(tickets.length, 1)
  const ticket = tickets[0]
  sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.equal(sources.items[0].state, 'delegated')
  assert.equal(sources.items[0].workBriefId !== undefined, true)
  assert.equal(sources.items[0].mainMessageId !== undefined, true)
  const mainPage = await desktop.getRecentMainConversation({ instanceId: 'private', limit: 20 })
  assert.equal(mainPage.sources[0].reference, sources.items[0].reference)
  assert.equal(mainPage.messages.some(message => message.source?.sourceInstanceId === 'github:acme/repo'
    && message.source.reference === sources.items[0].reference), true)
  const deliveriesForTicket = await desktop.getTicketDeliveries(ticket.ticket.id)
  assert.deepEqual(deliveriesForTicket.map(delivery => delivery.purpose), ['acknowledgement', 'result'])
  assert.deepEqual(deliveriesForTicket.map(delivery => [delivery.destination.sourceInstanceId, delivery.destination.actorId, delivery.destination.eventId]),
    [['github:acme/repo', 'alice', 'issue:7'], ['github:acme/repo', 'alice', 'issue:7']])
  assert.equal(deliveriesForTicket.every(delivery => delivery.state === 'sent'), true)
  assert.deepEqual(sources.items[0].deliveries.map(delivery => [delivery.purpose, delivery.state]),
    [['result', 'sent'], ['acknowledgement', 'sent']])
  const newestReceipt = await desktop.getMainSourceDeliveries({ instanceId: 'private', sourceId: sources.items[0].id, limit: 1 })
  assert.deepEqual([newestReceipt.items[0].purpose, newestReceipt.items[0].destination], ['result',
    { kind: 'github', sourceInstanceId: 'github:acme/repo', actorId: 'alice', eventId: 'issue:7', threadId: 'github:acme/repo#7' }])
  assert.equal(newestReceipt.hasMore, true)
  assert.equal(typeof newestReceipt.cursor, 'string')
  const olderReceipt = await desktop.getMainSourceDeliveries({ instanceId: 'private', sourceId: sources.items[0].id,
    after: newestReceipt.cursor, limit: 1 })
  assert.deepEqual(olderReceipt.items.map(delivery => delivery.purpose), ['acknowledgement'])
  assert.equal(olderReceipt.hasMore, false)
  await assert.rejects(desktop.getMainSourceDeliveries({ instanceId: 'private', sourceId: sources.items[0].id,
    after: 'not-a-source-cursor' }), { code: 'INVALID_INPUT' })
  await desktop.bindDeliveryCondition({ commandId: 'bind-source-pr', ticketId: ticket.ticket.id, kind: 'pr',
    sourceInstanceId: 'github:acme/repo', repo: 'acme/repo', number: 70, basis: 'The GitHub request authorized delivery condition tracking.' })
  await desktop.reconcileDeliveryCondition({ commandId: 'merge-source-pr', ticketId: ticket.ticket.id,
    sourceInstanceId: 'github:acme/repo', text: 'Pull request #70 merged (merged).' })
  sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.deepEqual(sources.items[0].conditions.map(condition => [condition.number, condition.state]), [[70, 'merged']])

  const before = await desktop.getTicketDirection(ticket.ticket.id)
  await source.poll([{ deliveryId: 'comment-1', cursor: '2', repo: 'acme/repo', kind: 'comment', action: 'created', number: 7,
    id: 'comment-1', authorId: 'alice', body: 'Ask for confirmation.', updatedAt: '2026-11-15T00:01:00Z' },
  { deliveryId: 'ci-1', cursor: '3', repo: 'acme/repo', kind: 'ci', action: 'completed', number: 7,
    id: 'check-1', authorId: 'github-actions', authorKind: 'ci', body: 'CI passed.', updatedAt: '2026-11-15T00:02:00Z' }])
  await drain()
  const after = await desktop.getTicketDirection(ticket.ticket.id)
  assert.equal((await desktop.listTickets()).items.length, 1)
  assert.equal(after.directionVersion, before.directionVersion + 1)
  assert.equal(after.inputs.length, 1)
  assert.equal(after.inputs[0].text.includes('Ask for confirmation.'), true)
  assert.equal((await desktop.getMainSources({ instanceId: 'private' })).items.length, 1, 'ordinary follow-ups and CI do not wake Main')
  const waiting = await desktop.conversation(ticket.ticket.id)
  assert.equal(waiting.status, 'waiting-human')
  await desktop.answerAttention({ commandId: 'answer-source-attention', attentionId: waiting.attention.id, text: 'Approve the verified fix.' })
  await drain()
  const answered = await desktop.conversation(ticket.ticket.id)
  assert.equal(answered.status, 'ready')
  assert.equal(answered.attention.answeredBy, 'desktop-owner')
  assert.equal(answered.assignments[0].sessionId, waiting.assignments[0].sessionId)
  const finalDeliveries = await desktop.getTicketDeliveries(ticket.ticket.id)
  assert.equal(finalDeliveries.find(delivery => delivery.purpose === 'attention')?.state, 'sent')
  assert.equal(finalDeliveries.filter(delivery => delivery.purpose === 'result').at(-1)?.state, 'sent')

  await github.addThreadSubscription({ commandId: 'context-only-github', ticketId: ticket.ticket.id,
    threadId: 'github:acme/repo#8', mode: 'context', reason: 'This discussion is background only.' })
  await source.receive({ deliveryId: 'context-thread-request', cursor: '4', repo: 'acme/repo', kind: 'issue', action: 'created',
    number: 8, id: 'issue-8', authorId: 'alice', title: 'Separate request', body: 'Handle this as new authorized work.',
    updatedAt: '2026-11-15T00:03:00Z' })
  assert.equal((await desktop.getMainSources({ instanceId: 'private' })).items.length, 2,
    'a context-only Thread cannot absorb a new human request')
  assert.equal((await desktop.listTickets()).items.length, 1, 'the context-only request remains a Main handoff')
})

test('pending Main handoffs recheck native currentness and authorization before notifying Main', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-main-github-stale-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  let storage, native, sessions, desktop, github
  t.after(async () => {
    const errors = []
    for (const dispose of [() => desktop?.effects.stop(), () => github?.effects.stop(), () => desktop?.shutdown(), () => github?.shutdown(),
      () => sessions?.close(), () => native?.fiber.dispose(), () => storage?.close(),
      async () => { assert.ok(directory.startsWith(join(tmpdir(), 'ds-superagent-main-github-stale-'))); await rm(directory, { recursive: true, force: true }) }]) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Stale Main handoff fixture cleanup failed.')
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).includes('[GitHub request]') && completed === 0) {
        yield* toolResponse('delegate_work', { items: [{ goal: 'Handle the current GitHub request.', constraints: 'Use the current event.',
          acceptanceCriteria: 'Return a verified result.' }] })
      } else yield* textResponse('Main handled the current request.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (completed === 0) yield* toolResponse('write_file', { path: 'current-request.txt', text: 'Current request.' })
    else if (completed === 1) yield* toolResponse('read_file', { path: 'current-request.txt' })
    else if (completed === 2) yield* toolResponse('report_ready', { result: 'Current request completed.', evidence: 'Read it back.',
      artifacts: 'current-request.txt' })
    else yield* textResponse('Recorded.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['desktop-owner'], permissions: ['read', 'write'], commands: {} })
  desktop = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner', allowedActorIds: ['desktop-owner'] },
    {}, sessions, [environment], {}, {}, {}, { channel: { deliver: async () => ({ type: 'success' }) } })
  github = new core.Engine(storage, 'private', { kind: 'github', sourceInstanceId: 'github:acme/repo', actorId: 'github-receiver',
    allowedActorIds: ['github-receiver'], allowedThreadPrefixes: ['github:acme/repo#'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
    {}, sessions)
  await desktop.openMain({ instanceId: 'private' })
  const source = new core.GitHubSource(storage, 'private', github, { owner: 'acme', repo: 'repo', mainIntake: true })
  await source.receive({ deliveryId: 'stale-created', cursor: '1', repo: 'acme/repo', kind: 'issue', action: 'created', number: 9,
    id: 'issue-9', authorId: 'alice', title: 'Old request', body: 'Old body.', updatedAt: '2026-11-15T01:00:00Z' })
  await source.receive({ deliveryId: 'stale-edited', cursor: '2', repo: 'acme/repo', kind: 'issue', action: 'edited', number: 9,
    id: 'issue-9', authorId: 'alice', title: 'Current request', body: 'Current body.', updatedAt: '2026-11-15T01:01:00Z' })
  await source.receive({ deliveryId: 'stale-deleted-created', cursor: '3', repo: 'acme/repo', kind: 'issue', action: 'created', number: 10,
    id: 'issue-10', authorId: 'alice', title: 'Deleted request', body: 'Delete before Main.', updatedAt: '2026-11-15T01:02:00Z' })
  await source.receive({ deliveryId: 'stale-deleted', cursor: '4', repo: 'acme/repo', kind: 'issue', action: 'deleted', number: 10,
    id: 'issue-10', authorId: 'alice', updatedAt: '2026-11-15T01:03:00Z',
    deletionEvidence: 'GitHub deleted issue 10.' })
  for (let index = 0; index < 14; index++) await desktop.effects.drain()
  const handoffs = (await desktop.getMainSources({ instanceId: 'private' })).items.sort((left, right) => left.createdAt - right.createdAt)
  assert.equal(handoffs.length, 3)
  assert.deepEqual(handoffs.map(handoff => [handoff.objectId, handoff.state, handoff.lastError]),
    [['issue:9', 'discarded', 'SOURCE_EVENT_SUPERSEDED'], ['issue:9', 'delegated', undefined],
      ['issue:10', 'discarded', 'SOURCE_EVENT_SUPERSEDED']])
  assert.equal((await desktop.listTickets()).items.length, 1, 'only the current edited request may create work')
})

test('a failed source Main turn recovers with a new stable turn while keeping the source request identity', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-main-github-recovery-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  let storage, native, sessions, desktop, github, sourceTurns = 0
  t.after(async () => {
    const errors = []
    for (const dispose of [() => desktop?.effects.stop(), () => github?.effects.stop(), () => desktop?.shutdown(), () => github?.shutdown(),
      () => sessions?.close(), () => native?.fiber.dispose(), () => storage?.close(),
      async () => { assert.ok(directory.startsWith(join(tmpdir(), 'ds-superagent-main-github-recovery-'))); await rm(directory, { recursive: true, force: true }) }]) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Main source recovery fixture cleanup failed.')
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).includes('[GitHub request') && completed === 0) {
        sourceTurns++
        if (sourceTurns === 1) throw new Error('First Main source turn failed.')
        yield* toolResponse('delegate_work', { items: [{ goal: 'Recover the GitHub request.', constraints: 'Continue the same source request.',
          acceptanceCriteria: 'Return a verified result.' }] })
      } else yield* textResponse('Recovered the source request.')
      return
    }
    if (options.model === 'router') yield* routerResponse(options)
    else yield* textResponse('Worker pending.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['desktop-owner'], permissions: ['read', 'write'], commands: {} })
  desktop = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner', allowedActorIds: ['desktop-owner'] },
    { retryDelayMs: 1 }, sessions, [environment], {}, {}, {}, { channel: { deliver: async () => ({ type: 'success' }) } })
  github = new core.Engine(storage, 'private', { kind: 'github', sourceInstanceId: 'github:acme/repo', actorId: 'github-receiver',
    allowedActorIds: ['github-receiver'], allowedThreadPrefixes: ['github:acme/repo#'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
    {}, sessions)
  await desktop.openMain({ instanceId: 'private' })
  const source = new core.GitHubSource(storage, 'private', github, { owner: 'acme', repo: 'repo', mainIntake: true })
  await source.receive({ deliveryId: 'recovery-created', cursor: '1', repo: 'acme/repo', kind: 'issue', action: 'created', number: 11,
    id: 'issue-11', authorId: 'alice', title: 'Recovery request', body: 'Run this once.', updatedAt: '2026-11-15T02:00:00Z' })
  await desktop.effects.drain()
  await new Promise(resolve => setTimeout(resolve, 10))
  for (let index = 0; index < 10; index++) await desktop.effects.drain()
  const handoff = (await desktop.getMainSources({ instanceId: 'private' })).items[0]
  assert.equal(handoff.state, 'delegated')
  const page = await desktop.getRecentMainConversation({ instanceId: 'private', limit: 20 })
  const sourceMessages = page.messages.filter(message => message.source?.eventId === handoff.sourceEventId)
  assert.equal(sourceMessages.length, 1)
  assert.equal(sourceMessages[0].status, 'completed')
  assert.equal(page.messages.some(message => message.role === 'main' && message.text === 'Recovered the source request.'), true)
  assert.equal(sourceTurns, 2)
})

test('a context-full source Main turn rolls over durably and retries the same handoff in the child Session', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-main-github-rollover-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  let storage, native, sessions, desktop, github
  const sourceTurns = []
  t.after(async () => {
    const errors = []
    for (const dispose of [() => desktop?.effects.stop(), () => github?.effects.stop(), () => desktop?.shutdown(), () => github?.shutdown(),
      () => sessions?.close(), () => native?.fiber.dispose(), () => storage?.close(),
      async () => { assert.ok(directory.startsWith(join(tmpdir(), 'ds-superagent-main-github-rollover-'))); await rm(directory, { recursive: true, force: true }) }]) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Main source rollover fixture cleanup failed.')
  })
  native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (text.includes('[GitHub request')) {
        if (completed === 0) sourceTurns.push({ sessionId: options.sessionId, recovery: text.includes('recovery') })
        if (sourceTurns.length === 1) {
          yield* maxTokensResponse('Main filled its context while reading the source.')
        } else if (completed === 0) {
          yield* toolResponse('delegate_work', { items: [{ goal: 'Finish the source request after rollover.',
            constraints: 'Continue the same source request through its durable handoff.', acceptanceCriteria: 'Return the verified result to the original source.' }] })
        } else yield* textResponse('Main completed the source request in its child Session.')
      } else yield* textResponse('Main idle.')
      return
    }
    if (options.model === 'router') yield* routerResponse(options)
    else yield* textResponse('Worker pending.')
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const environment = await core.LocalEnvironment.open({ id: 'workspace', instanceId: 'private', root: workspace,
    allowedActorIds: ['desktop-owner'], permissions: ['read', 'write'], commands: {} })
  desktop = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner', allowedActorIds: ['desktop-owner'] },
    { retryDelayMs: 1 }, sessions, [environment], {}, {}, {}, { channel: { deliver: async () => ({ type: 'success' }) } })
  github = new core.Engine(storage, 'private', { kind: 'github', sourceInstanceId: 'github:acme/repo', actorId: 'github-receiver',
    allowedActorIds: ['github-receiver'], allowedThreadPrefixes: ['github:acme/repo#'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
    {}, sessions)
  const initial = await desktop.openMain({ instanceId: 'private' })
  const source = new core.GitHubSource(storage, 'private', github, { owner: 'acme', repo: 'repo', mainIntake: true })
  await source.receive({ deliveryId: 'rollover-created', cursor: '1', repo: 'acme/repo', kind: 'issue', action: 'created', number: 13,
    id: 'issue-13', authorId: 'alice', title: 'Roll over this request', body: 'Complete this request without duplicating it.',
    updatedAt: '2026-11-15T03:00:00Z' })
  await desktop.effects.drain()
  await new Promise(resolve => setTimeout(resolve, 10))
  for (let index = 0; index < 12; index++) await desktop.effects.drain()

  const handoff = (await desktop.getMainSources({ instanceId: 'private' })).items[0]
  assert.equal(handoff.state, 'delegated')
  const page = await desktop.getRecentMainConversation({ instanceId: 'private', limit: 20 })
  assert.notEqual(page.mainSessionId, initial.mainSessionId)
  assert.equal(page.generation, initial.generation + 1)
  const sourceMessages = page.messages.filter(message => message.source?.eventId === handoff.sourceEventId)
  assert.equal(sourceMessages.length, 1)
  assert.equal(sourceMessages[0].status, 'completed')
  assert.equal(page.messages.some(message => message.role === 'main' && message.text === 'Main completed the source request in its child Session.'), true)
  assert.equal(sourceTurns.length, 2)
  assert.deepEqual(sourceTurns.map(turn => turn.sessionId), [initial.mainSessionId, page.mainSessionId])
  assert.deepEqual(sourceTurns.map(turn => turn.recovery), [false, true])
  assert.equal((await desktop.listTickets()).items.length, 1)
  assert.equal((await desktop.getMainWorkPlan({ instanceId: 'private', workBriefId: handoff.workBriefId })).items.length, 1)

  const oldEvents = await sessions.readSession(initial.mainSessionId, { limit: 100 })
  const childEvents = await sessions.readSession(page.mainSessionId, { limit: 100 })
  const userIds = session => session.events.filter(event => event.type === 'user/message').map(event => event.data.id)
  const oldTurn = userIds(oldEvents).find(id => id.startsWith('main-source-message:'))
  const childRecovery = userIds(childEvents).find(id => id.startsWith('main-source-recovery:'))
  assert.equal(typeof oldTurn, 'string')
  assert.equal(typeof childRecovery, 'string')
  assert.notEqual(oldTurn, childRecovery)
  const rollover = await storage.transaction('private', tx => tx.get('main-source-rollover',
    `${JSON.stringify(['main-source-rollover', handoff.id])}:${page.mainSessionId}`))
  assert.deepEqual([rollover.previousSessionId, rollover.sessionId, rollover.previousGeneration, rollover.sessionGeneration],
    [initial.mainSessionId, page.mainSessionId, initial.generation, page.generation])
  assert.deepEqual([rollover.handoffId, rollover.reason], [handoff.id, 'CONTEXT_WINDOW'])
})
