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
  function* respond(options) {
    if (options.model === 'main') {
      const text = lastUserText(options)
      if (text.startsWith('[Work update]')) {
        yield* textResponse('Work update received.')
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
  assert.equal(await readFile(externalFile, 'utf8'), 'outside the project\n')

  await engine.directMainWork({ instanceId: 'personal', commandId: 'follow-up-path-check',
    workItemId: granted.brief.workItemId, ticketId: granted.receipt.ticketId,
    text: 'follow-up path check: read the external note again and stay within this task.' })
  await until(async () => (await engine.conversation(granted.receipt.ticketId)).reports[0]?.directionVersion === 2,
    'the follow-up report')
  const followed = await engine.conversation(granted.receipt.ticketId)
  assert.ok(followed.reports[0].toolFacts.some(fact => fact.tool === 'read_file'
    && fact.outcome === 'failed' && fact.output.code === 'PATH_DENIED'))
  const afterFollowUpTicket = await storage.transaction('personal', tx => tx.get('ticket', granted.receipt.ticketId))
  const afterFollowUpTrigger = await storage.transaction('personal', tx => tx.get('trigger', firstTicket.triggerId))
  assert.equal(afterFollowUpTicket.directionVersion, 2)
  assert.equal(afterFollowUpTrigger.pathGrantVersion, 1)
  assert.deepEqual(afterFollowUpTrigger.pathGrants, [{ path: externalFile, operations: ['read'] }])
  assert.equal(await readFile(externalFile, 'utf8'), 'outside the project\n')
})
