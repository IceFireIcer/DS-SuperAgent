import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserResources } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

const allowHost = async () => {}

test('one Environment browser is leased to one Assignment, and an unknown operation blocks reuse across restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-browser-resource-'))
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const environment = { kind: 'local', config: { id: 'local', instanceId: 'personal', root: join(root, 'work'),
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} } }
  for (const id of ['A', 'B']) {
    await storage.transaction('personal', async tx => {
      await tx.insert('work-brief', `brief-${id}`, { id: `brief-${id}`, instanceId: 'personal', environmentId: 'local' })
      await tx.insert('work-item', `item-${id}`, { id: `item-${id}`, workBriefId: `brief-${id}` })
      await tx.insert('work-item-ticket', `item-${id}`, { ticketId: `ticket-${id}` })
      await tx.insert('ticket', `ticket-${id}`, { state: 'open' })
      await tx.insert('assignment', `ticket-${id}`, { id: `assignment-${id}`, ticketId: `ticket-${id}`,
        generation: `generation-${id}`, state: 'running', environment: { id: 'local', kind: 'local', root: environment.config.root } })
    })
  }
  const a = { instanceId: 'personal', ticketId: 'ticket-A', workItemId: 'item-A', assignmentId: 'assignment-A', generation: 'generation-A', environmentId: 'local' }
  const b = { ...a, ticketId: 'ticket-B', workItemId: 'item-B', assignmentId: 'assignment-B', generation: 'generation-B' }
  let started, release
  const waiting = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { release = resolve })
  let pause = true
  let fail = false
  const usedKeys = []
  const adapter = { async execute(request, signal) {
    usedKeys.push(request.profileKey)
    if (pause) { started(); await hold }
    signal.throwIfAborted()
    if (fail) throw new Error('Lost response after dispatch')
    return 'Mock page content'
  } }
  const browsers = new BrowserResources(storage, 'personal', 'alice', [environment], adapter, allowHost)
  const created = await browsers.create({ instanceId: 'personal', commandId: 'create-browser', environmentId: 'local', label: 'Research' })
  assert.equal((await browsers.create({ instanceId: 'personal', commandId: 'create-browser', environmentId: 'local', label: 'Research' })).id, created.id)
  await assert.rejects(browsers.create({ instanceId: 'personal', commandId: 'create-browser', environmentId: 'local', label: 'Different' }), { code: 'IDENTITY_CONFLICT' })
  assert.equal(created.state, 'available')
  await assert.rejects(browsers.read({ instanceId: 'foreign', resourceId: created.id }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(browsers.use(a, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_DENIED' })
  const grantA = await browsers.grant({ instanceId: 'personal', commandId: 'grant-a', resourceId: created.id, workItemId: 'item-A', expectedRevision: 1, active: true })
  const grantB = await browsers.grant({ instanceId: 'personal', commandId: 'grant-b', resourceId: created.id,
    workItemId: 'item-B', expectedRevision: grantA.revision, active: true })
  const stale = new BrowserResources(storage, 'personal', 'alice', [environment], adapter,
    async () => { throw Object.assign(new Error('The Host lease changed.'), { code: 'HOST_LEASED' }) })
  await assert.rejects(stale.create({ instanceId: 'personal', commandId: 'stale-create', environmentId: 'local', label: 'Denied' }),
    { code: 'HOST_LEASED' })
  await assert.rejects(stale.grant({ instanceId: 'personal', commandId: 'stale-grant', resourceId: created.id,
    workItemId: 'item-A', expectedRevision: grantB.revision, active: false }), { code: 'HOST_LEASED' })
  await assert.rejects(stale.use(a, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal),
    { code: 'HOST_LEASED' })
  assert.equal((await browsers.forWorker(a)).length, 1)
  await assert.rejects(browsers.forWorker({ ...a, workItemId: 'item-B' }), { code: 'BROWSER_DENIED' })

  const call = browsers.use(a, { resourceId: created.id, action: 'open', url: 'https://example.test/' }, new AbortController().signal)
  await waiting
  assert.equal((await browsers.read({ instanceId: 'personal', resourceId: created.id })).state, 'busy')
  assert.deepEqual((await browsers.forWorker(b)).map(item => item.state), ['busy'])
  assert.equal(JSON.stringify(await browsers.forWorker(b)).includes('ticket-A'), false, 'a Worker sees contention without another work identity')
  await assert.rejects(browsers.use(b, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_BUSY' })
  pause = false; release()
  const opened = await call
  assert.match(opened.operationId, /^[\da-f-]{36}$/u)
  assert.equal((await browsers.read({ instanceId: 'personal', resourceId: created.id })).operations.at(-1).state, 'succeeded')
  await assert.rejects(browsers.use(b, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_BUSY' })
  await storage.transaction('personal', async tx => {
    const assignment = await tx.get('assignment', 'ticket-A')
    await tx.replace('assignment', 'ticket-A', { ...assignment, state: 'ended' })
  })
  fail = true
  await assert.rejects(browsers.use(b, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  const unknown = await browsers.read({ instanceId: 'personal', resourceId: created.id })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.operations.at(-1).state, 'unknown')
  const afterRestart = new BrowserResources(storage, 'personal', 'alice', [environment], adapter, allowHost)
  await assert.rejects(afterRestart.use(b, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_RECONCILE_REQUIRED' })
  await assert.rejects(afterRestart.resolve({ instanceId: 'personal', commandId: 'resolve-wrong', resourceId: created.id,
    operationId: opened.operationId, reason: 'UNCHANGED' }), { code: 'BROWSER_RECONCILE_REQUIRED' })
  await afterRestart.resolve({ instanceId: 'personal', commandId: 'resolve-b', resourceId: created.id,
    operationId: unknown.operations.at(-1).id, reason: 'INSPECTED' })
  assert.equal((await afterRestart.read({ instanceId: 'personal', resourceId: created.id })).state, 'busy')
  fail = false
  await afterRestart.use(b, { resourceId: created.id, action: 'snapshot' }, new AbortController().signal)
  assert.equal(new Set(usedKeys).size, 1, 'one resource keeps its own Host profile across Assignments')
  assert.match(usedKeys[0], /^session-[\da-f-]{36}$/u)
  const another = await afterRestart.create({ instanceId: 'personal', commandId: 'create-second', environmentId: 'local', label: 'Private' })
  assert.notEqual(another.id, created.id)
  const grant = await afterRestart.grant({ instanceId: 'personal', commandId: 'grant-second', resourceId: another.id,
    workItemId: 'item-B', expectedRevision: 1, active: true })
  await afterRestart.use(b, { resourceId: another.id, action: 'snapshot' }, new AbortController().signal)
  assert.equal(new Set(usedKeys).size, 2, 'different resources never share a Host storage partition')
  await afterRestart.grant({ instanceId: 'personal', commandId: 'revoke-second-grant', resourceId: another.id,
    workItemId: 'item-B', expectedRevision: grant.revision, active: false })
  await assert.rejects(afterRestart.use(b, { resourceId: another.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_DENIED' })
})

test('stop or grant revocation during a browser request leaves a durable unknown, never a success', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-browser-stop-'))
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const environment = { kind: 'local', config: { id: 'local', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} } }
  const scope = { instanceId: 'personal', ticketId: 'ticket', workItemId: 'item', assignmentId: 'assignment',
    generation: 'generation', environmentId: 'local' }
  await storage.transaction('personal', async tx => {
    await tx.insert('work-brief', 'brief', { id: 'brief', instanceId: 'personal', environmentId: 'local' })
    await tx.insert('work-item', 'item', { id: 'item', workBriefId: 'brief' })
    await tx.insert('work-item-ticket', 'item', { ticketId: 'ticket' })
    await tx.insert('ticket', 'ticket', { state: 'open' })
    await tx.insert('assignment', 'ticket', { id: 'assignment', generation: 'generation', state: 'running',
      environment: { id: 'local', kind: 'local', root } })
  })
  let release, entered
  const held = new Promise(resolve => { release = resolve })
  const called = new Promise(resolve => { entered = resolve })
  const adapter = { execute: async (_request, signal) => { entered(); await held; signal.throwIfAborted(); return 'Page content' } }
  const browsers = new BrowserResources(storage, 'personal', 'alice', [environment], adapter, allowHost)
  const resource = await browsers.create({ instanceId: 'personal', commandId: 'create', environmentId: 'local', label: 'Only work' })
  await browsers.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id, workItemId: 'item', expectedRevision: 1, active: true })
  const controller = new AbortController()
  const call = browsers.use(scope, { resourceId: resource.id, action: 'snapshot' }, controller.signal)
  await called
  const pending = (await browsers.read({ instanceId: 'personal', resourceId: resource.id })).operations.at(-1)
  await storage.transaction('personal', async tx => {
    const assignment = await tx.get('assignment', 'ticket')
    await tx.replace('assignment', 'ticket', { ...assignment, state: 'stopping' })
  })
  await assert.rejects(browsers.resolve({ instanceId: 'personal', commandId: 'premature', resourceId: resource.id,
    operationId: pending.id, reason: 'CHANGED' }), { code: 'BROWSER_RECONCILE_REQUIRED' })
  await assert.rejects(browsers.resolve({ instanceId: 'personal', commandId: 'unsafe-note', resourceId: resource.id,
    operationId: pending.id, reason: 'https://private.example/reset?token=secret' }), { code: 'INVALID_INPUT' })
  controller.abort()
  release()
  await assert.rejects(call, { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal((await browsers.read({ instanceId: 'personal', resourceId: resource.id })).operations.at(-1).state, 'unknown')
  await browsers.resolve({ instanceId: 'personal', commandId: 'acknowledge', resourceId: resource.id,
    operationId: (await browsers.read({ instanceId: 'personal', resourceId: resource.id })).operations.at(-1).id,
    reason: 'INSPECTED' })
  await storage.transaction('personal', async tx => {
    const assignment = await tx.get('assignment', 'ticket')
    await tx.replace('assignment', 'ticket', { ...assignment, state: 'running' })
  })
  let secondEntered, secondRelease
  const secondCalled = new Promise(resolve => { secondEntered = resolve })
  const secondHeld = new Promise(resolve => { secondRelease = resolve })
  const second = new BrowserResources(storage, 'personal', 'alice', [environment], {
    execute: async () => { secondEntered(); await secondHeld; return 'Changed page' },
  }, allowHost)
  const attempt = second.use(scope, { resourceId: resource.id, action: 'snapshot' }, new AbortController().signal)
  await secondCalled
  await second.grant({ instanceId: 'personal', commandId: 'revoke-grant', resourceId: resource.id,
    workItemId: 'item', expectedRevision: 2, active: false })
  secondRelease()
  await assert.rejects(attempt, { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal((await second.read({ instanceId: 'personal', resourceId: resource.id })).operations.at(-1).state, 'unknown')
})
