import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Path-grant test did not reach ${label}.`)
    await sleep(20)
  }
}

test('delegated path grants are Ticket-scoped, operation-specific and expire on follow-up', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-path-grants-'))
  const root = join(directory, 'workspace')
  const external = join(directory, 'external')
  await mkdir(root)
  await mkdir(external)
  const externalFile = join(external, 'shared.txt')
  await writeFile(externalFile, 'outside the project\n')
  const canonicalExternalFile = await realpath(externalFile)
  let firstGrantRead = false
  let grantedWorkItemId
  function* respond(options) {
    if (options.model === 'main') {
      const text = lastUserText(options)
      if (text.startsWith('[Work update]')) {
        yield* textResponse('Work update received.')
        return
      }
      if (text.includes('Authorize external write')) {
        if (completedToolCount(options) === 0) {
          yield* toolResponse('follow_up_work', {
            workItemId: grantedWorkItemId,
            text: 'Append the authorized line to the external note and report it.',
            reason: 'The user explicitly authorized the external path for this task.',
            pathGrants: [{ path: externalFile, operations: ['read', 'write'] }],
          })
        } else yield* textResponse('The authorized write was directed to the original work item.')
        return
      }
      if (completedToolCount(options) === 0) {
        yield* toolResponse('delegate_work', {
          goal: text.includes('without path grant')
            ? 'Complete unrelated project work while refusing ungranted external access.'
            : 'Read the explicitly granted external note.',
          constraints: text.includes('without path grant')
            ? 'The previous task grant must not be reused.'
            : 'Read only; do not modify the external note.',
          acceptanceCriteria: 'Report the observed access behavior with durable result evidence.',
          ...(text.includes('without path grant') ? {} : {
            pathGrants: [{ path: externalFile, operations: ['read'] }],
          }),
        })
        return
      }
      yield* textResponse('Work accepted.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (text.startsWith('Read the granted external file for the parent')) {
      const child = [
        ['read_file', { path: externalFile }],
      ][calls]
      yield* child ? toolResponse(child[0], child[1], `child-${calls}`)
        : textResponse('The child read the parent-granted external file: outside the project')
      return
    }
    if (text.startsWith('Subagent ')) {
      if (calls === 1) firstGrantRead = true
      const resumed = [
        ['read_file', { path: externalFile }],
        ['report_ready', { result: 'Read the explicitly granted external note through a shared child.',
          evidence: 'The child read under the same Ticket grant, then the parent read the file back before reporting.',
          artifacts: externalFile }],
      ][calls]
      yield* resumed ? toolResponse(resumed[0], resumed[1], `resumed-${calls}`) : textResponse('Parent finished after its child.')
      return
    }
    if (text.includes('Append the authorized line')) {
      const expanded = [
        ['read_file', { path: externalFile }],
        ['write_file', { path: externalFile, text: 'outside the project\nauthorized write\n' }],
        ['read_file', { path: externalFile }],
        ['report_ready', { result: 'The authorized external file was updated.',
          evidence: 'Read the newly granted path, wrote it, and read the result back.',
          artifacts: externalFile }],
      ][calls]
      yield* expanded ? toolResponse(expanded[0], expanded[1], `expanded-${calls}`) : textResponse('Expanded work done.')
      return
    }
    if (text.includes('without path grant')) {
      const second = [
        ['read_file', { path: externalFile }],
        ['write_file', { path: 'second-note.txt', text: 'second task\n' }],
        ['read_file', { path: 'second-note.txt' }],
        ['report_ready', { result: 'Unrelated project work completed.',
          evidence: 'The external read was refused before execution; the project file was written and read back.',
          artifacts: 'second-note.txt' }],
      ][calls]
      yield* second ? toolResponse(second[0], second[1], `second-${calls}`) : textResponse('Second task done.')
      return
    }
    if (firstGrantRead) {
      const followUp = [
        ['read_file', { path: externalFile }],
        ['read_file', { path: 'second-note.txt' }],
        ['report_ready', { result: 'Follow-up completed without external access.',
          evidence: 'The expired path grant refused the external read; unrelated project work remained readable.',
          artifacts: 'second-note.txt' }],
      ][calls]
      yield* followUp ? toolResponse(followUp[0], followUp[1], `follow-${calls}`) : textResponse('Follow-up done.')
      return
    }
    const first = calls === 0 ? ['delegate_subagent', { task: 'Read the granted external file for the parent and return its text.' }] : undefined
    yield* first ? toolResponse(first[0], first[1], `first-${calls}`) : textResponse('The child is working under the shared Task grant.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'granted-read',
    text: 'Read the granted external note.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.[0]?.outcome?.status === 'success',
    'the first Ticket result')

  let history = await engine.getMainConversation({ instanceId: 'personal' })
  const granted = history.works[0]
  grantedWorkItemId = granted.brief.workItemId
  assert.deepEqual(granted.brief.pathGrants, [{ path: externalFile, operations: ['read'] }])
  assert.equal(granted.outcome.artifacts[0].path, canonicalExternalFile)
  const firstTicket = await storage.transaction('personal', tx => tx.get('ticket', granted.receipt.ticketId))
  const firstTrigger = await storage.transaction('personal', tx => tx.get('trigger', firstTicket.triggerId))
  assert.equal(firstTrigger.pathGrantVersion, 1)
  assert.deepEqual(firstTrigger.pathGrants, [{ path: externalFile, operations: ['read'] }])
  const [child] = await engine.listSubagents(granted.receipt.ticketId)
  assert.equal(child.state, 'completed')
  assert.match(child.result.text, /outside the project/u)
  await until(async () => (await storage.transaction('personal', tx => tx.get('ticket', granted.receipt.ticketId)))?.state === 'ended',
    'the first Ticket to end')

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'authorize-external-write',
    text: 'Authorize external write for this work item and append a line.' })
  await until(async () => await readFile(externalFile, 'utf8') === 'outside the project\nauthorized write\n',
    'the authorized external write')
  const expandedTicket = await storage.transaction('personal', tx => tx.get('ticket', granted.receipt.ticketId))
  const expandedTrigger = await storage.transaction('personal', tx => tx.get('trigger', firstTicket.triggerId))
  assert.equal(expandedTicket.directionVersion, 2)
  assert.equal(expandedTrigger.pathGrantVersion, 2)
  assert.deepEqual(expandedTrigger.pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
  history = await engine.getMainConversation({ instanceId: 'personal' })
  const expandedCard = history.works.find(work => work.brief.workItemId === granted.brief.workItemId)
  assert.deepEqual(expandedCard.brief.pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
  assert.deepEqual(expandedCard.followUps.at(-1).pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'ungranted-read',
    text: 'Read the external note without path grant and finish unrelated project work.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.some(work =>
    work.brief.goal.startsWith('Complete unrelated') && work.outcome?.status === 'success'), 'the second Ticket result')
  history = await engine.getMainConversation({ instanceId: 'personal' })
  const second = history.works.find(work => work.brief.goal.startsWith('Complete unrelated'))
  assert.equal(second.brief.pathGrants, undefined)
  const secondConversation = await engine.conversation(second.receipt.ticketId)
  assert.equal(secondConversation.reports[0].toolFacts[0].tool, 'read_file')
  assert.equal(secondConversation.reports[0].toolFacts[0].outcome, 'failed')
  assert.equal(secondConversation.reports[0].toolFacts[0].output.code, 'PATH_DENIED')
  assert.equal(await readFile(join(root, 'second-note.txt'), 'utf8'), 'second task\n')
  assert.equal(await readFile(externalFile, 'utf8'), 'outside the project\nauthorized write\n')

  await engine.directMainWork({ instanceId: 'personal', commandId: 'follow-up-path-check',
    workItemId: granted.brief.workItemId, ticketId: granted.receipt.ticketId,
    text: 'follow-up path check: read the external note again and stay within this task.' })
  await until(async () => (await engine.conversation(granted.receipt.ticketId)).reports[0]?.directionVersion === 3,
    'the follow-up report')
  const followed = await engine.conversation(granted.receipt.ticketId)
  assert.ok(followed.reports[0].toolFacts.some(fact => fact.tool === 'read_file'
    && fact.outcome === 'failed' && fact.output.code === 'PATH_DENIED'))
  const afterFollowUpTicket = await storage.transaction('personal', tx => tx.get('ticket', granted.receipt.ticketId))
  const afterFollowUpTrigger = await storage.transaction('personal', tx => tx.get('trigger', firstTicket.triggerId))
  assert.equal(afterFollowUpTicket.directionVersion, 3)
  assert.equal(afterFollowUpTrigger.pathGrantVersion, 2)
  assert.deepEqual(afterFollowUpTrigger.pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
  assert.equal(await readFile(externalFile, 'utf8'), 'outside the project\nauthorized write\n')
})

test('a waiting Worker can obtain and use a path grant from the exact approval answer', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-attention-path-grant-'))
  const root = join(directory, 'workspace')
  const external = join(directory, 'external')
  await mkdir(root)
  await mkdir(external)
  const externalFile = join(external, 'note.txt')
  await writeFile(externalFile, 'readable\n')
  function* respond(options) {
    if (options.model === 'main') {
      const text = lastUserText(options)
      if (text.startsWith('[Work update]')) {
        yield* textResponse('Work update received.')
        return
      }
      if (completedToolCount(options) === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Request write access after reading the granted note.',
          constraints: 'Ask for the exact missing write operation while the original Ticket waits; do not create another Ticket.',
          acceptanceCriteria: 'Only the exact approval grants write access; the original Ticket waits for the answer.',
          pathGrants: [{ path: externalFile, operations: ['read'] }],
        })
      } else yield* textResponse('Work accepted.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (text.includes('Request write access after reading the granted note.')) {
      if (calls === 0) yield* toolResponse('read_file', { path: externalFile }, 'ask-path-read')
      else if (calls === 1) yield* toolResponse('ask_human', {
        question: 'The external note is readable. Allow write access for this same task?',
        options: 'Not now',
        pathGrants: JSON.stringify([{ path: externalFile, operations: ['write'] }]),
      }, 'ask-path-write')
      else yield* textResponse('Waiting for the exact path decision.')
      return
    }
    if (text === 'Not now') {
      if (calls === 0) yield* toolResponse('write_file', { path: externalFile, text: 'refused write\n' }, 'refused-path-write')
      else if (calls === 1) yield* toolResponse('read_file', { path: externalFile }, 'refused-path-read-authorized')
      else if (calls === 2) yield* toolResponse('write_file', { path: 'after-refusal.txt', text: 'unrelated work continued\n' },
        'refused-path-local-write')
      else if (calls === 3) yield* toolResponse('read_file', { path: 'after-refusal.txt' }, 'refused-path-local-read')
      else if (calls === 4) yield* toolResponse('ask_human', {
        question: 'The refused write is still blocked. Allow the exact write operation now?',
        options: 'Keep blocked',
        pathGrants: JSON.stringify([{ path: externalFile, operations: ['write'] }]),
      }, 'ask-path-write-after-refusal')
      else yield* textResponse('Waiting for the exact path decision.')
      return
    }
    if (text === 'Allow this path access') {
      const approved = [
        ['write_file', { path: externalFile, text: 'readable\napproved write\n' }],
        ['read_file', { path: externalFile }],
        ['report_ready', { result: 'The approved external write completed in the original Ticket.',
          evidence: 'The exact approval answer added write access, then the write and read-back succeeded.',
          artifacts: externalFile }],
      ][calls]
      yield* approved ? toolResponse(approved[0], approved[1], `approved-path-${calls}`) : textResponse('Approved path work done.')
      return
    }
    yield* textResponse('Waiting or complete.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close(); await native.fiber.dispose()
    await environment.close(); await storage.close(); await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'waiting-path-grant',
    text: 'Read the external note, then ask me before writing to it.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.[0]?.control?.attention?.status === 'waiting',
    'the first path approval question')
  let history = await engine.getMainConversation({ instanceId: 'personal' })
  const work = history.works[0]
  const ticketId = work.receipt.ticketId
  let conversation = await engine.conversation(ticketId)
  assert.equal(conversation.attention.options.at(-1), 'Allow this path access')
  assert.match(conversation.attention.question, /write:/u)
  assert.match(conversation.attention.question, /note\.txt/u)

  await engine.answerMainAttention({ instanceId: 'personal', commandId: 'deny-path-write',
    workItemId: work.brief.workItemId, ticketId, expectedGeneration: conversation.assignments[0].generation,
    attentionId: conversation.attention.id, attentionVersion: conversation.attention.sequence, text: 'Not now' })
  await until(async () => (await engine.conversation(ticketId)).attention?.sequence === 2,
    'the second path approval question')
  let storedTicket = await storage.transaction('personal', tx => tx.get('ticket', ticketId))
  let storedTrigger = await storage.transaction('personal', tx => tx.get('trigger', storedTicket.triggerId))
  assert.equal(storedTicket.directionVersion, 2)
  assert.equal(storedTrigger.pathGrantVersion, 2)
  assert.deepEqual(storedTrigger.pathGrants, [{ path: externalFile, operations: ['read'] }])
  assert.equal(await readFile(externalFile, 'utf8'), 'readable\n')
  assert.equal(await readFile(join(root, 'after-refusal.txt'), 'utf8'), 'unrelated work continued\n')
  conversation = await engine.conversation(ticketId)

  await engine.answerMainAttention({ instanceId: 'personal', commandId: 'approve-path-write',
    workItemId: work.brief.workItemId, ticketId, expectedGeneration: conversation.assignments[0].generation,
    attentionId: conversation.attention.id, attentionVersion: conversation.attention.sequence, text: 'Allow this path access' })
  await until(async () => await readFile(externalFile, 'utf8') === 'readable\napproved write\n',
    'the approved external write')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.[0]?.outcome?.status === 'success',
    'the approved path result')
  storedTicket = await storage.transaction('personal', tx => tx.get('ticket', ticketId))
  storedTrigger = await storage.transaction('personal', tx => tx.get('trigger', storedTicket.triggerId))
  assert.equal(storedTicket.directionVersion, 3)
  assert.equal(storedTrigger.pathGrantVersion, 3)
  assert.deepEqual(storedTrigger.pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
  conversation = await engine.conversation(ticketId)
  assert.deepEqual(conversation.attention.approvedPathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
  history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.deepEqual(history.works[0].brief.pathGrants, [{ path: externalFile, operations: ['read', 'write'] }])
})
