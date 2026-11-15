import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { Engine, FeishuSource, GitHubSource, LocalEnvironment, NativeSessions, ProductAttachments, WorkDelegation } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

const readArgs = reference => ({ kind: reference.kind, id: reference.id, sha256: reference.sha256,
  attachmentId: reference.attachmentId, bytes: String(reference.bytes), path: '', offset: '0', maxBytes: '1024' })

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await sleep(40)
  }
  throw new Error('The attached source work did not reach the expected state.')
}

test('an external source keeps admitted files and image blocks through a two-item Main grant', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-source-attachments-'))
  const work = join(root, 'work')
  await mkdir(work)
  let noteA, noteB, imageA, foreign, denied = '', ownReads = []
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[GitHub request]') && count === 0) yield* toolResponse('delegate_work', { items: [
        { goal: 'Inspect source A.', constraints: 'Use A only.', acceptanceCriteria: 'Verify A.', attachmentIds: [noteA.id, imageA.id] },
        { goal: 'Inspect source B.', constraints: 'Use B only.', acceptanceCriteria: 'Verify B.', attachmentIds: [noteB.id] },
      ] })
      else yield* textResponse('Source work recorded.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    const b = text.includes('Goal:\nInspect source B.')
    const resources = JSON.parse(/Attached resources for this work[^\n]*\n(\[[^\n]+\])/u.exec(text)?.[1] ?? 'null')
    assert.deepEqual(resources.map(reference => reference.attachmentId).sort(), b ? [noteB.id] : [noteA.id, imageA.id].sort())
    if (count === 0) yield* toolResponse('read_asset', readArgs(b ? foreign : resources.find(resource => resource.attachmentId === noteA.id)))
    else if (b && count === 1) {
      denied = JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content)
      yield* toolResponse('read_asset', readArgs(resources[0]))
    } else if (count === (b ? 2 : 1)) {
      ownReads.push(JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content))
      yield* toolResponse('write_file', { path: b ? 'source-b.txt' : 'source-a.txt', text: b ? 'B done\n' : 'A done\n' })
    } else if (count === (b ? 3 : 2)) yield* toolResponse('read_file', { path: b ? 'source-b.txt' : 'source-a.txt' })
    else if (count === (b ? 4 : 3)) yield* toolResponse('report_ready', { result: b ? 'B verified.' : 'A verified.',
      evidence: 'Read back the derived file.', artifacts: b ? 'source-b.txt' : 'source-a.txt' })
    else yield* textResponse('Finished.')
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'isolated-attachments') })
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const environment = await LocalEnvironment.open({ id: 'source-work', instanceId: 'private', root: work,
    allowedActorIds: ['desktop-owner', 'github-receiver', 'feishu-receiver'], permissions: ['read', 'write'], commands: {}, assetsPath: join(root, 'assets') })
  const attachments = new ProductAttachments(storage, 'private', native.attachments, id => id === 'source-work' ? environment : undefined)
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const desktop = new Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'desktop-owner', allowedActorIds: ['desktop-owner'] },
    { retryDelayMs: 1 }, sessions, [environment], {}, {}, {}, { channel: { deliver: async () => ({ type: 'success' }) } })
  const github = new Engine(storage, 'private', { kind: 'github', sourceInstanceId: 'github:sample/project', actorId: 'github-receiver',
    allowedActorIds: ['github-receiver'], allowedThreadPrefixes: ['github:sample/project#'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
  {}, sessions)
  const feishu = new Engine(storage, 'private', { kind: 'feishu', sourceInstanceId: 'feishu:tenant:group', actorId: 'feishu-receiver',
    allowedActorIds: ['feishu-receiver'], allowedThreadPrefixes: ['feishu:tenant:'], versionOrder: 'sequence',
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] } },
  {}, sessions)
  t.after(async () => { await desktop.effects.stop(); await github.effects.stop(); await feishu.effects.stop()
    await desktop.shutdown(); await github.shutdown(); await feishu.shutdown()
    await sessions.close(); await native.fiber.dispose(); await environment.close(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  await desktop.openMain({ instanceId: 'private' })
  const upload = (commandId, actorId, kind, name, bytes, mediaType) => attachments.upload({ instanceId: 'private', actorId,
    commandId, environmentId: 'source-work', kind, name, data: bytes.toString('base64'), ...(mediaType ? { mediaType } : {}) })
  noteA = await upload('source-a', 'github-receiver', 'file', 'A.txt', Buffer.from('Same bytes for both grants.'))
  noteB = await upload('source-b', 'github-receiver', 'file', 'B.txt', Buffer.from('Same bytes for both grants.'))
  imageA = await upload('source-image', 'github-receiver', 'image', 'A.png', await sharp({ create: {
    width: 2, height: 2, channels: 4, background: { r: 22, g: 115, b: 33, alpha: 1 },
  } }).png().toBuffer(), 'image/png')
  const borrowed = await upload('borrowed', 'desktop-owner', 'file', 'borrowed.txt', Buffer.from('private desktop resource'))
  const source = new GitHubSource(storage, 'private', github, { owner: 'sample', repo: 'project', mainIntake: true })
  const event = { deliveryId: 'source-1', cursor: '1', repo: 'sample/project', kind: 'issue', action: 'created',
    number: 7, id: 'issue-7', authorId: 'alice', body: 'Inspect the two sources.', updatedAt: '2026-11-16T00:00:00Z',
    environmentId: 'source-work', attachmentIds: [noteA.id, noteB.id, imageA.id] }
  const rejected = await source.receive({ ...event, deliveryId: 'borrowed-identity', cursor: '0', attachmentIds: [borrowed.id] })
  assert.deepEqual(rejected, { status: 'filtered', reason: 'NOT_FOUND' })
  assert.deepEqual(await source.receive({ ...event, deliveryId: 'missing-environment', cursor: '0', environmentId: undefined }),
    { status: 'filtered', reason: 'INVALID_INPUT' })
  const receipt = await source.receive(event)
  assert.equal(receipt.status, 'recorded')
  const history = await github.getSourceHistory({ threadId: 'github:sample/project#7', objectId: 'issue:7' })
  assert.deepEqual(history.items[0].attachments.map(item => item.id), event.attachmentIds)
  assert.equal(JSON.stringify(history).includes(root), false, 'source history exposes bounded metadata rather than Host paths')
  const sources = await desktop.getMainSources({ instanceId: 'private' })
  assert.deepEqual(sources.items[0].attachmentViews.map(item => item.id), event.attachmentIds)
  assert.equal(JSON.stringify(sources).includes(root), false, 'the Main projection cannot expose the Host asset path')
  const a = await attachments.read({ instanceId: 'private', actorId: 'github-receiver', id: noteA.id })
  foreign = { ...a.reference, attachmentId: noteA.id }
  assert.equal((await attachments.read({ instanceId: 'private', actorId: 'github-receiver', id: noteB.id })).sha256, foreign.sha256)
  for (let attempt = 0; attempt < 30; attempt++) await desktop.effects.drain()
  await waitFor(async () => (await desktop.getRecentMainConversation({ instanceId: 'private' })).works?.every(work => work.outcome?.status === 'success')
    && (await desktop.getRecentMainConversation({ instanceId: 'private' })).works.length === 2)
  const page = await desktop.getRecentMainConversation({ instanceId: 'private' })
  const [workA, workB] = [page.works.find(work => work.brief.goal === 'Inspect source A.'), page.works.find(work => work.brief.goal === 'Inspect source B.')]
  assert.ok(workA?.receipt.ticketId && workB?.receipt.ticketId)
  assert.deepEqual(workA.brief.attachmentIds, [noteA.id, imageA.id].sort())
  assert.deepEqual(workB.brief.attachmentIds, [noteB.id])
  assert.match(denied, /Error: The bound Environment operation failed/u)
  assert.equal(denied.includes('Same bytes for both grants.'), false)
  assert.equal(ownReads.length, 2)
  assert.equal(ownReads.every(read => read.includes('Same bytes for both grants.')), true)
  assert.deepEqual(page.messages.find(message => message.source?.eventId === receipt.eventId)?.attachments.map(item => item.id), event.attachmentIds)
  const reader = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  try {
    const main = await reader.readSession(page.mainSessionId, { limit: 100 })
    assert.equal(main.events.some(item => item.type === 'user/message' && item.data?.content?.some(block => block.type === 'file')
      && item.data?.content?.some(block => block.type === 'image')), true)
    const workerA = await reader.readSession(workA.control.assignment.sessionId, { limit: 100 })
    const workerB = await reader.readSession(workB.control.assignment.sessionId, { limit: 100 })
    assert.equal(workerA.events.some(item => item.type === 'user/message' && item.data?.content?.some(block => block.type === 'image')), true)
    assert.equal(workerB.events.some(item => item.type === 'user/message' && item.data?.content?.some(block => block.type === 'image')), false)
  } finally { await reader.close() }
  const before = (await desktop.listTickets()).items.length
  const revoked = await upload('source-revoked', 'github-receiver', 'file', 'revoked.txt', Buffer.from('revoked before Main'))
  const later = await source.receive({ ...event, deliveryId: 'source-2', cursor: '2', number: 8, id: 'issue-8',
    attachmentIds: [revoked.id] })
  assert.equal(later.status, 'recorded')
  let enteredMain, releaseMain
  const atMain = new Promise(resolve => { enteredMain = resolve })
  const heldMain = new Promise(resolve => { releaseMain = resolve })
  const run = sessions.run.bind(sessions)
  sessions.run = request => request.role === 'main' && request.content?.some(block => block.type === 'file')
    && request.text.includes('issue:8')
    ? (enteredMain(), heldMain.then(() => run(request))) : run(request)
  const draining = desktop.effects.drain()
  await atMain
  await attachments.revoke({ instanceId: 'private', actorId: 'github-receiver', id: revoked.id })
  releaseMain()
  await draining
  for (let attempt = 0; attempt < 5; attempt++) await desktop.effects.drain()
  const discarded = (await desktop.getMainSources({ instanceId: 'private' })).items.find(item => item.sourceEventId === later.eventId)
  assert.equal(discarded?.lastError, 'ATTACHMENT_REVOKED')
  assert.equal(discarded?.attachmentViews[0].state, 'revoked')
  assert.equal((await sessions.hasMessage(page.mainSessionId, `main-source-message:${discarded.id}`)).found, false)
  assert.equal((await desktop.listTickets()).items.length, before)
  const imageOnly = await upload('feishu-image', 'feishu-receiver', 'image', 'notice.png', await sharp({ create: {
    width: 2, height: 2, channels: 4, background: { r: 60, g: 40, b: 170, alpha: 1 },
  } }).png().toBuffer(), 'image/png')
  const feishuSource = new FeishuSource(storage, 'private', feishu, { tenantKey: 'tenant', chatIds: ['group'], mainIntake: true })
  const imageReceipt = await feishuSource.receive({ eventId: 'image-only', cursor: '3', tenantKey: 'tenant', chatId: 'group',
    chatType: 'p2p', messageId: 'native-image', senderId: 'alice', senderKind: 'human', text: '',
    createTime: '1700000000000', updateTime: '1700000000000', attachmentIds: [imageOnly.id], environmentId: 'source-work' })
  assert.equal(imageReceipt.status, 'recorded')
  const otherImage = await upload('feishu-other-image', 'feishu-receiver', 'image', 'other.png', await sharp({ create: {
    width: 2, height: 2, channels: 4, background: { r: 70, g: 200, b: 40, alpha: 1 },
  } }).png().toBuffer(), 'image/png')
  await assert.rejects(feishuSource.receive({ eventId: 'image-only', cursor: '3', tenantKey: 'tenant', chatId: 'group',
    chatType: 'p2p', messageId: 'native-image', senderId: 'alice', senderKind: 'human', text: '',
    createTime: '1700000000000', updateTime: '1700000000000', attachmentIds: [otherImage.id], environmentId: 'source-work' }),
  { code: 'IDENTITY_CONFLICT' })
  await waitFor(async () => { await desktop.effects.drain(); return (await desktop.getRecentMainConversation({ instanceId: 'private' }))
    .messages.some(message => message.source?.eventId === imageReceipt.eventId) })
  const imagePage = await desktop.getRecentMainConversation({ instanceId: 'private' })
  assert.deepEqual(imagePage.messages.find(message => message.source?.eventId === imageReceipt.eventId)?.attachments.map(item => item.id), [imageOnly.id])
  const imageTurn = await sessions.readSession(imagePage.mainSessionId, { limit: 100 })
  assert.equal(imageTurn.events.some(item => item.type === 'user/message' && item.data?.content?.some(block => block.type === 'image'
    && block.attachment.attachmentId !== imageA.id)), true)
  await assert.rejects(github.receiveSource({ commandId: 'attached-direct', threadId: 'github:sample/project#9',
    objectId: 'issue:9', type: 'created', version: '9', text: 'Do this without Main.', authorId: 'alice',
    attachmentIds: [noteA.id], environmentId: 'source-work' }), { code: 'ATTACHMENT_SCOPE_AMBIGUOUS' })
  assert.equal(await github.getSourceObject({ threadId: 'github:sample/project#9', objectId: 'issue:9' }), undefined)
})

test('revocation committed during an in-flight Worker read withholds the bytes and records the denial', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-asset-revoke-race-'))
  const work = join(root, 'work')
  await mkdir(work)
  let reading, releaseRead, readResult = ''
  const enteredRead = new Promise(resolve => { reading = resolve })
  const heldRead = new Promise(resolve => { releaseRead = resolve })
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) yield* textResponse('Work updated.')
      else if (count === 0) yield* toolResponse('delegate_work', { goal: 'Read the attached resource.',
        constraints: 'Use the exact original attachment.', acceptanceCriteria: 'Verify the resource.' })
      else yield* textResponse('Delegated.')
    } else if (options.model === 'router') yield* routerResponse(options)
    else if (count === 0) {
      const reference = JSON.parse(/Attached resources for this work[^\n]*\n(\[[^\n]+\])/u.exec(lastUserText(options))?.[1] ?? 'null')[0]
      yield* toolResponse('read_asset', readArgs(reference))
    } else {
      readResult = JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content)
      yield* textResponse('Resource access was denied.')
    }
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'isolated-attachments') })
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const environment = await LocalEnvironment.open({ id: 'work', instanceId: 'private', root: work,
    allowedActorIds: ['owner'], permissions: ['read', 'write'], commands: {}, assetsPath: join(root, 'assets') })
  const prepare = environment.prepare.bind(environment)
  environment.prepare = async (...args) => {
    const bound = await prepare(...args)
    const invoke = bound.invoke.bind(bound)
    bound.invoke = async (name, ...rest) => {
      if (name === 'read_asset') { reading(); await heldRead }
      return invoke(name, ...rest)
    }
    return bound
  }
  const attachments = new ProductAttachments(storage, 'private', native.attachments, id => id === 'work' ? environment : undefined)
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const engine = new Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'owner', allowedActorIds: ['owner'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment], {}, {}, {}, {}, {}, undefined, attachments)
  t.after(async () => { releaseRead(); await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  const uploaded = await attachments.upload({ instanceId: 'private', actorId: 'owner', commandId: 'upload',
    environmentId: 'work', kind: 'file', name: 'private-note.txt', data: Buffer.from('Never return these bytes after revocation.').toString('base64') })
  await engine.openMain({ instanceId: 'private' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'private', commandId: 'send', text: 'Use the attached resource.', attachments: [uploaded.id] })
  await enteredRead
  await attachments.revoke({ instanceId: 'private', actorId: 'owner', id: uploaded.id })
  releaseRead()
  await waitFor(async () => readResult !== '')
  assert.match(readResult, /Error: The bound Environment operation failed/u)
  assert.equal(readResult.includes('Never return these bytes'), false)
  const page = await engine.getRecentMainConversation({ instanceId: 'private' })
  assert.notEqual(page.works[0]?.outcome?.status, 'success')
  const reader = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  try {
    const worker = await reader.readSession(page.works[0].control.assignment.sessionId, { limit: 100 })
    assert.equal(JSON.stringify(worker.events).includes('Never return these bytes after revocation.'), false)
  } finally { await reader.close() }
})

test('a product download rechecks revocation after the Environment returns bytes', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-asset-download-race-'))
  const work = join(root, 'work')
  await mkdir(work)
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const environment = await LocalEnvironment.open({ id: 'work', instanceId: 'private', root: work,
    allowedActorIds: ['owner'], permissions: ['read', 'write'], commands: {}, assetsPath: join(root, 'assets') })
  let reading, releaseRead
  const enteredRead = new Promise(resolve => { reading = resolve })
  const heldRead = new Promise(resolve => { releaseRead = resolve })
  const prepare = environment.prepare.bind(environment)
  environment.prepare = async (...args) => {
    const bound = await prepare(...args)
    const read = bound.readProductAsset.bind(bound)
    bound.readProductAsset = async (...params) => {
      const page = await read(...params)
      reading()
      await heldRead
      return page
    }
    return bound
  }
  t.after(async () => { releaseRead(); await environment.close(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  const attachments = new ProductAttachments(storage, 'private', { admitEncodedFile: async () => ({ attachmentId: 'fixture' }) },
    id => id === 'work' ? environment : undefined)
  const uploaded = await attachments.upload({ instanceId: 'private', actorId: 'owner', commandId: 'upload',
    environmentId: 'work', kind: 'file', name: 'private.txt', data: Buffer.from('Sensitive fixture bytes').toString('base64') })
  const read = attachments.read({ instanceId: 'private', actorId: 'owner', id: uploaded.id })
  await enteredRead
  await attachments.revoke({ instanceId: 'private', actorId: 'owner', id: uploaded.id })
  releaseRead()
  await assert.rejects(read, { code: 'ATTACHMENT_REVOKED' })
})

test('revoking one grant before Router establishment rejects only its own work item', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-item-revoke-before-ticket-'))
  const work = join(root, 'work')
  await mkdir(work)
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const environment = await LocalEnvironment.open({ id: 'work', instanceId: 'private', root: work,
    allowedActorIds: ['owner'], permissions: ['read', 'write'], commands: {}, assetsPath: join(root, 'assets') })
  t.after(async () => { await environment.close(); await storage.close(); await rm(root, { recursive: true, force: true }) })
  const attachments = new ProductAttachments(storage, 'private', { admitEncodedFile: async () => ({ attachmentId: 'fixture' }) },
    id => id === 'work' ? environment : undefined)
  const upload = (commandId, text) => attachments.upload({ instanceId: 'private', actorId: 'owner', commandId,
    environmentId: 'work', kind: 'file', name: `${commandId}.txt`, data: Buffer.from(text).toString('base64') })
  const a = await upload('a', 'A alone')
  const b = await upload('b', 'B alone')
  const resolved = await storage.transaction('private', tx => attachments.resolve(tx, {
    instanceId: 'private', actorId: 'owner', environmentId: 'work', ids: [a.id, b.id],
  }))
  const created = []
  const delegation = new WorkDelegation({ storage, instanceId: 'private',
    source: { sourceInstanceId: 'desktop', actorId: 'owner', allowedActorIds: ['owner'] },
    environmentId: 'work', environmentRoot: () => work,
    sessions: { routerSessionId: 'router-session', run: async request => {
      const brief = JSON.parse(request.text.slice(request.text.indexOf('{')))
      await request.tools[0].execute({ items: brief.requestedItems }, new AbortController().signal)
      return { sessionId: request.sessionId, events: [], stepCount: 1 }
    } },
    effects: { enqueue: async () => {} },
    createTicket: async (_brief, item) => { created.push(item.goal); return { ticketId: `ticket-${item.goal[0]}` } },
    readTicket: async () => { throw new Error('No Worker was started by this test.') },
    routerProfile: async () => ({ revision: 1, roles: { router: { model: { provider: 'mock', model: 'router' } } } }),
    recordRouterUse: async () => {}, notifyMain: async () => {}, notifyMainSource: async () => {},
    applyFollowUp: async () => { throw new Error('No follow-up was requested.') },
    readContext: async () => { throw new Error('No context was requested.') },
  })
  const brief = await delegation.create({ commandId: 'two-items', mainId: 'main', mainSessionId: 'main-session',
    routerSessionId: 'router-session', mainMessageId: 'main-message', originalUserText: 'Handle A and B.',
    environmentId: 'work', configurationRevision: 1,
    attachments: [{ id: a.id, asset: resolved.assets[0] }, { id: b.id, asset: resolved.assets[1] }],
    items: [
      { goal: 'A task', constraints: 'Only A.', acceptanceCriteria: 'Verify A.', attachmentIds: [a.id] },
      { goal: 'B task', constraints: 'Only B.', acceptanceCriteria: 'Verify B.', attachmentIds: [b.id] },
    ] })
  await attachments.revoke({ instanceId: 'private', actorId: 'owner', id: a.id })
  await delegation.route(brief.id, new AbortController().signal)
  const plan = await delegation.plan('main', brief.id)
  assert.deepEqual(plan.items.map(item => [item.goal, item.receipt.status, item.receipt.reason]),
    [['A task', 'rejected', 'ATTACHMENT_REVOKED'], ['B task', 'accepted', undefined]])
  assert.deepEqual(created, ['B task'])
})
