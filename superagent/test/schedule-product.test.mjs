import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'r5-schedule-product-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const native = await nativeContext(join(directory, 'sessions'), function* (options) {
    const text = lastUserText(options)
    const completed = completedToolCount(options)
    if (options.model === 'main') {
      if (text.includes('[Scheduled occurrence]') || text === 'Create the original work.') {
        if (!completed) yield* toolResponse('delegate_work', { goal: 'Check the scheduled work.',
          constraints: 'Use only the authorized workspace.', acceptanceCriteria: 'Report a checked result.' })
        else yield* textResponse('The scheduled work was accepted.')
      } else yield* textResponse('Noted.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (!completed) yield* toolResponse('write_file', { path: 'scheduled.txt', text: 'checked\n' })
    else if (completed === 1) yield* toolResponse('read_file', { path: 'scheduled.txt' })
    else if (completed === 2) yield* toolResponse('report_ready', { result: 'Scheduled work checked.',
      evidence: 'Read back scheduled.txt.', artifacts: 'scheduled.txt' })
    else yield* textResponse('Recorded.')
  })
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const environment = await LocalEnvironment.open({ id: 'workspace', instanceId: 'personal', root,
    allowedActorIds: ['owner'], permissions: ['read', 'write'], commands: {} })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'owner', allowedActorIds: ['owner'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  await engine.openMain({ instanceId: 'personal' })
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })
  return { engine, storage, sessions, environment }
}

async function drain(engine) {
  for (let index = 0; index < 16; index++) await engine.effects.drain()
}

test('scheduled tasks and Calendar rules have separate lists, commands and source switches', async t => {
  const { engine } = await fixture(t)
  const instance = { instanceId: 'personal' }
  const draft = { ...instance, commandId: 'shared-id', title: 'Review', text: 'Check work.', timezone: 'UTC',
    when: { kind: 'at', at: Date.now() + 60_000 }, target: { kind: 'main' } }
  const calendar = await engine.createSchedule(draft)
  const task = await engine.createSchedule(draft, 'task')
  assert.notEqual(calendar.ruleId, task.ruleId)
  assert.deepEqual((await engine.listSchedules(instance)).items, [calendar])
  assert.deepEqual((await engine.listSchedules(instance, 'task')).items, [task])
  await engine.setScheduleSource({ ...instance, commandId: 'pause', enabled: false }, 'task')
  assert.equal((await engine.getScheduleSource(instance)).enabled, true)
  assert.equal((await engine.getScheduleSource(instance, 'task')).enabled, false)
  const result = await engine.tickSchedules(draft.when.at)
  assert.deepEqual(result.occurrences.map(item => item.ruleId), [calendar.ruleId])
  assert.deepEqual((await engine.getSchedule({ ...instance, ruleId: task.ruleId }, 'task')).occurrences, [])
  await assert.rejects(engine.getSchedule({ ...instance, ruleId: task.ruleId }), { code: 'NOT_FOUND' })
  await assert.rejects(engine.cancelSchedule({ ...instance, commandId: 'wrong-view', ruleId: task.ruleId }), { code: 'NOT_FOUND' })
  assert.equal((await engine.cancelSchedule({ ...instance, commandId: 'cancel', ruleId: task.ruleId }, 'task')).status, 'cancelled')
})

test('an authorized schedule enters Main once and links its occurrence to a work receipt', { timeout: 45000 }, async t => {
  const { engine } = await fixture(t)
  const at = Date.now() + 60_000
  const command = { instanceId: 'personal', commandId: 'create-schedule', title: 'Review', text: 'Review the changes.',
    timezone: 'UTC', when: { kind: 'at', at }, target: { kind: 'main' } }
  const rule = await engine.createSchedule(command)
  assert.deepEqual(await engine.createSchedule(command), rule)
  await assert.rejects(engine.createSchedule({ ...command, text: 'Different request.' }), { code: 'IDENTITY_CONFLICT' })
  assert.equal((await engine.listSchedules({ instanceId: 'personal' })).items.length, 1)
  await engine.tickSchedules(at)
  await drain(engine)
  const first = await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })
  assert.equal(first.occurrences.length, 1)
  assert.equal(first.occurrences[0].status, 'delegated')
  assert.equal(first.occurrences[0].ticketIds.length, 1)
  assert.equal((await engine.getTicketDeliveries(first.occurrences[0].ticketIds[0]))
    .every(delivery => delivery.destination.sourceInstanceId === 'product-desktop'), true)
  assert.equal((await engine.getMainConversation({ instanceId: 'personal' })).works.length, 1)
  await engine.tickSchedules(at)
  await drain(engine)
  assert.equal((await engine.listTickets()).items.length, 1)
  assert.equal((await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })).occurrences.length, 1)
})

test('a schedule aimed at one existing work cannot resume a stopped Ticket', { timeout: 45000 }, async t => {
  const { engine } = await fixture(t)
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'original', text: 'Create the original work.' })
  await drain(engine)
  const work = (await engine.getMainConversation({ instanceId: 'personal' })).works[0]
  assert.equal(work.receipt.status, 'accepted')
  const at = Date.now() + 60_000
  const rule = await engine.createSchedule({ instanceId: 'personal', commandId: 'targeted', title: 'Check again', text: 'Check the original work.',
    timezone: 'UTC', when: { kind: 'every', minutes: 1 }, target: { kind: 'work', workItemId: work.brief.workItemId, ticketId: work.receipt.ticketId } })
  await engine.tickSchedules(at + 1_000)
  await drain(engine)
  let view = await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })
  assert.equal(view.occurrences[0].ticketIds[0], work.receipt.ticketId)
  assert.equal((await engine.listTickets()).items.length, 1)
  const control = (await engine.getMainConversation({ instanceId: 'personal' })).works[0].control
  await engine.stopMainWork({ instanceId: 'personal', commandId: 'stop-original', workItemId: work.brief.workItemId,
    ticketId: work.receipt.ticketId, expectedGeneration: control.assignment.generation,
    expectedTicketVersion: control.ticketVersion, reason: 'Stop this work.' })
  await drain(engine)
  const before = (await engine.getTicketDirection(work.receipt.ticketId)).inputs.length
  await engine.tickSchedules(at + 61_000)
  await drain(engine)
  view = await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })
  assert.equal(view.occurrences.at(-1).status, 'blocked')
  assert.equal((await engine.getTicketDirection(work.receipt.ticketId)).inputs.length, before)
  assert.equal((await engine.getMainConversation({ instanceId: 'personal' })).works[0].status, 'stopped')
  await engine.cancelSchedule({ instanceId: 'personal', commandId: 'cancel', ruleId: rule.ruleId })
  await engine.tickSchedules(at + 121_000)
  assert.equal((await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })).occurrences.length, 2)
  await assert.rejects(engine.cancelSchedule({ instanceId: 'personal', commandId: 'cancel', ruleId: 'different-rule' }),
    { code: 'IDENTITY_CONFLICT' })
})

test('a missed one-time occurrence and a restart remain distinct from executed work', { timeout: 45000 }, async t => {
  const { engine, storage, sessions, environment } = await fixture(t)
  const at = Date.now() + 60_000
  const missed = await engine.createSchedule({ instanceId: 'personal', commandId: 'missed', title: 'Missed',
    text: 'Do not replay this after two days.', timezone: 'UTC', when: { kind: 'at', at }, target: { kind: 'main' } })
  const recurring = await engine.createSchedule({ instanceId: 'personal', commandId: 'restart', title: 'Restart',
    text: 'Review the current work.', timezone: 'UTC', when: { kind: 'every', minutes: 1 }, target: { kind: 'main' } })
  await engine.shutdown()
  const reopened = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'owner', allowedActorIds: ['owner'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  await reopened.openMain({ instanceId: 'personal' })
  try {
    await reopened.tickSchedules(at + 2 * 86_400_000)
    await drain(reopened)
    const late = await reopened.getSchedule({ instanceId: 'personal', ruleId: missed.ruleId })
    assert.deepEqual(late.occurrences.map(item => item.status), ['missed'])
    assert.equal(late.occurrences[0].eventId, undefined)
    const recovered = await reopened.getSchedule({ instanceId: 'personal', ruleId: recurring.ruleId })
    assert.equal(recovered.occurrences.filter(item => item.status === 'missed').length, 1)
    assert.equal(recovered.occurrences.filter(item => item.status === 'delegated').length, 1)
    await reopened.tickSchedules(at + 2 * 86_400_000)
    assert.equal((await reopened.getSchedule({ instanceId: 'personal', ruleId: recurring.ruleId })).occurrences.length, 2)
  } finally { await reopened.effects.stop(); await reopened.shutdown() }
})

test('closing the schedule source leaves the rule intact and does not dispatch until reopened', { timeout: 45000 }, async t => {
  const { engine } = await fixture(t)
  const at = Date.now() + 60_000
  const rule = await engine.createSchedule({ instanceId: 'personal', commandId: 'paused', title: 'Pause review',
    text: 'Review when the source is back.', timezone: 'UTC', when: { kind: 'at', at }, target: { kind: 'main' } })
  await engine.setScheduleSource({ instanceId: 'personal', commandId: 'close', enabled: false })
  await engine.tickSchedules(at)
  assert.equal((await engine.getScheduleSource({ instanceId: 'personal' })).enabled, false)
  assert.deepEqual((await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })).occurrences, [])
  await engine.setScheduleSource({ instanceId: 'personal', commandId: 'open', enabled: true })
  await engine.tickSchedules(at)
  await drain(engine)
  assert.deepEqual((await engine.getSchedule({ instanceId: 'personal', ruleId: rule.ruleId })).occurrences.map(item => item.status), ['delegated'])
  assert.equal((await engine.listTickets()).items.length, 1)
})

test('cancel and source closure discard a pending Main handoff before it can create work', { timeout: 45000 }, async t => {
  const { engine } = await fixture(t)
  const at = Date.now() + 60_000
  const cancelled = await engine.createSchedule({ instanceId: 'personal', commandId: 'cancel-handoff', title: 'Cancelled',
    text: 'Do not start after cancellation.', timezone: 'UTC', when: { kind: 'at', at }, target: { kind: 'main' } })
  await engine.tickSchedules(at)
  await engine.cancelSchedule({ instanceId: 'personal', commandId: 'cancel-first', ruleId: cancelled.ruleId })
  await drain(engine)
  assert.equal((await engine.getSchedule({ instanceId: 'personal', ruleId: cancelled.ruleId })).occurrences[0].status, 'blocked')
  assert.equal((await engine.listTickets()).items.length, 0)

  const closed = await engine.createSchedule({ instanceId: 'personal', commandId: 'closed-handoff', title: 'Closed',
    text: 'Do not start after closing the source.', timezone: 'UTC', when: { kind: 'at', at: at + 60_000 }, target: { kind: 'main' } })
  await engine.tickSchedules(at + 60_000)
  await engine.setScheduleSource({ instanceId: 'personal', commandId: 'close-during-handoff', enabled: false })
  await drain(engine)
  const view = await engine.getSchedule({ instanceId: 'personal', ruleId: closed.ruleId })
  assert.equal(view.occurrences[0].status, 'blocked')
  assert.equal(view.occurrences[0].reason, 'SCHEDULE_SOURCE_CLOSED')
  assert.equal((await engine.listTickets()).items.length, 0)
})

test('calendar rules retain their explicit timezone and weekday without replaying old Bot schedules', { timeout: 45000 }, async t => {
  const { engine } = await fixture(t)
  const weekday = (new Date(Date.now() + 86_400_000).getUTCDay() + 6) % 7 + 1
  const daily = await engine.createSchedule({ instanceId: 'personal', commandId: 'daily', title: 'Daily', text: 'Review at nine.',
    timezone: 'Asia/Tokyo', when: { kind: 'daily', time: '09:00' }, target: { kind: 'main' } })
  const weekly = await engine.createSchedule({ instanceId: 'personal', commandId: 'weekly', title: 'Weekly', text: 'Review on this day.',
    timezone: 'UTC', when: { kind: 'weekly', time: '00:00', weekdays: [weekday] }, target: { kind: 'main' } })
  assert.equal(new Date(daily.nextAt + 9 * 3_600_000).getUTCHours(), 9)
  assert.equal((new Date(weekly.nextAt).getUTCDay() + 6) % 7 + 1, weekday)
  assert.equal(weekly.nextAt > weekly.createdAt, true)
  assert.deepEqual((await engine.listSchedules({ instanceId: 'personal' })).items.map(rule => rule.ruleId).sort(), [daily.ruleId, weekly.ruleId].sort())
  await assert.rejects(engine.getSchedule({ instanceId: 'another-instance', ruleId: daily.ruleId }), { code: 'SOURCE_NOT_AUTHORIZED' })
})

test('a source receiver cannot inspect or control product schedules in the same Instance', async t => {
  const { engine, storage } = await fixture(t)
  const rule = await engine.createSchedule({ instanceId: 'personal', commandId: 'owner-rule', title: 'Owner only',
    text: 'Continue the authorized work.', timezone: 'UTC', when: { kind: 'at', at: Date.now() + 60_000 }, target: { kind: 'main' } })
  const receiver = new Engine(storage, 'personal', { kind: 'feishu', sourceInstanceId: 'feishu:tenant:chat',
    actorId: 'receiver', allowedActorIds: ['receiver'], allowedThreadPrefixes: ['feishu:tenant:'], versionOrder: 'sequence' })
  try {
    const scope = { instanceId: 'personal' }
    assert.throws(() => receiver.getScheduleSource(scope), { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.throws(() => receiver.setScheduleSource({ ...scope, commandId: 'source-stop', enabled: false }), { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.throws(() => receiver.listSchedules(scope), { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.throws(() => receiver.getSchedule({ ...scope, ruleId: rule.ruleId }), { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.throws(() => receiver.cancelSchedule({ ...scope, commandId: 'source-cancel', ruleId: rule.ruleId }), { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.throws(() => receiver.tickSchedules(rule.nextAt), { code: 'SOURCE_NOT_AUTHORIZED' })
    await assert.rejects(receiver.createSchedule({ instanceId: 'personal', commandId: 'source-create', title: 'Forbidden',
      text: 'Do not run.', timezone: 'UTC', when: { kind: 'at', at: Date.now() + 60_000 }, target: { kind: 'main' } }),
    { code: 'SOURCE_NOT_AUTHORIZED' })
    assert.equal((await engine.getScheduleSource(scope)).enabled, true)
    assert.equal((await engine.getSchedule({ ...scope, ruleId: rule.ruleId })).status, 'active')
  } finally { await receiver.shutdown() }
})
