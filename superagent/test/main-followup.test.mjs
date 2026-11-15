import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
    if (Date.now() >= deadline) throw new Error(`Main follow-up did not reach ${label}.`)
    await sleep(20)
  }
}

function messageText(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function allSessionEvents(sessions, sessionId) {
  const events = []
  let after
  do {
    const page = await sessions.readSession(sessionId, { limit: 100, ...(after === undefined ? {} : { after }) })
    events.push(...page.events)
    after = page.cursor
  } while (after !== undefined)
  return events
}

function priorWorkCards(options) {
  return options.messages
    .flatMap(message => {
      const text = messageText(message)
      try {
        const value = message.role === 'user' && text.startsWith('[Work update]')
          ? JSON.parse(text.split('\n').at(-1))
          : message.role === 'tool' ? JSON.parse(text) : undefined
        if (Array.isArray(value?.items)) return value.items
        if (value?.receipt?.workItemId) return [{ workItemId: value.receipt.workItemId, goal: value.update?.summary ?? '' }]
        if (value?.brief?.workItemId) return [value]
      } catch {
        return []
      }
      return []
    })
}

function retainedAlpha(options, purpose) {
  const alpha = priorWorkCards(options).find(work => work.goal?.includes('alpha'))
  if (!alpha) throw new Error(`The Main session did not retain the alpha work identity for ${purpose}.`)
  return alpha
}

function* mainUpdateResponse(text) {
  const update = JSON.parse(text.split('\n').at(-1))
  const latest = update.followUps?.at(-1)
  if (latest?.status === 'handed-back') yield* textResponse('Alpha handed the direction back because it exceeded its scope.')
  else if (latest?.status === 'waiting') yield* textResponse('Alpha is waiting for a human decision.')
  else if (latest?.status === 'ready') yield* textResponse('Alpha adopted and completed the new direction.')
  else yield* textResponse('The target item reported its result.')
}

function mainFollowUpResponse(options, text, calls) {
  if (text === 'Change only A.') {
    const alpha = retainedAlpha(options, 'the retry check')
    const direction = calls === 2 ? 'Replace the direction with different text.' : 'Use the revised alpha direction.'
    if (calls < 3) {
      return [...toolResponse('follow_up_work', { workItemId: alpha.workItemId, text: direction }, `follow-up-${calls}`)]
    }
    return [...textResponse('The alpha direction was recorded once; the conflicting retry was rejected.')]
  }
  if (text === 'Change the unclear item.') {
    return !calls
      ? [...toolResponse('follow_up_work', { workItemId: 'not-a-visible-work-item', text: 'Apply the unclear direction.' })]
      : [...textResponse('I need a precise work item before I can apply that change.')]
  }
  const directions = {
    'Follow the stopped alpha.': ['Apply direction after stop.', 'The direction remains waiting because alpha is stopped.'],
    'Try an out-of-scope alpha change.': ['Make alpha publish itself.', 'The alpha Worker will decide whether that is inside its scope.'],
    'Ask me for the alpha decision.': ['Ask me before continuing alpha.', 'Alpha is waiting for your decision.'],
    'Ignore the waiting question and continue alpha.': ['Continue alpha without answering.', 'I will not bypass the pending alpha question.'],
  }
  const direction = directions[text]
  if (!direction) return false
  return !calls
    ? [...toolResponse('follow_up_work', { workItemId: retainedAlpha(options, text).workItemId, text: direction[0] })]
    : [...textResponse(direction[1])]
}

function* workerResponse(text, calls, workerTurns) {
  workerTurns.push(text)
  if (text === 'Ask me before continuing alpha.') {
    if (!calls) yield* toolResponse('ask_human', { question: 'Continue alpha?', options: 'Yes\nNo' })
    else yield* textResponse('Waiting.')
    return
  }
  if (text === 'Make alpha publish itself.') {
    yield* toolResponse('handback_input', { reason: 'Publishing is outside this alpha note work item.' })
    return
  }
  const file = text.includes('Write the alpha note.') ? 'alpha.txt' : 'beta.txt'
  const plan = [
    ['write_file', { path: file, text: `${file}\n` }],
    ['read_file', { path: file }],
    ['report_ready', { result: `Handled: ${text}`, evidence: `Read ${file} after writing it.`, artifacts: file }],
  ][calls]
  if (plan) yield* toolResponse(plan[0], plan[1], `worker-${calls}`)
  else yield* textResponse('Recorded.')
}

test('an explicit Main follow-up changes only the named original work item and reuses its Ticket', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-followup-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const workerTurns = []

  async function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* mainUpdateResponse(text)
        return
      }
      const followUpResponse = mainFollowUpResponse(options, text, calls)
      if (followUpResponse) {
        yield* followUpResponse
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          items: [
            { goal: 'Write the alpha note.', constraints: 'Do not touch beta.txt.', acceptanceCriteria: 'Report the alpha result.' },
            { goal: 'Write the beta note.', constraints: 'Do not touch alpha.txt.', acceptanceCriteria: 'Report the beta result.' },
          ],
        })
        return
      }
      yield* textResponse('A and B are separate work items.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    yield* workerResponse(text, calls, workerTurns)
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'two-items', text: 'Do A and B independently.' })
  try {
    await until(async () => {
      const page = await engine.getMainConversation({ instanceId: 'personal' })
      return page.works.filter(work => work.outcome?.status === 'success').length === 2
    }, 'both initial results')
  } catch (error) {
    console.error(JSON.stringify({
      workerTurns,
      page: await engine.getMainConversation({ instanceId: 'personal' }),
      tickets: await engine.listTickets(),
      effects: await engine.effects.list(),
    }, null, 2))
    throw error
  }
  const before = await engine.getMainConversation({ instanceId: 'personal' })
  const alpha = before.works.find(work => work.brief.goal === 'Write the alpha note.')
  const beta = before.works.find(work => work.brief.goal === 'Write the beta note.')
  assert.ok(alpha?.receipt.ticketId)
  assert.ok(beta?.receipt.ticketId)
  const alphaBefore = await engine.getTicketDirection(alpha.receipt.ticketId)
  const betaBefore = await engine.getTicketDirection(beta.receipt.ticketId)
  const alphaSession = (await engine.conversation(alpha.receipt.ticketId)).assignments[0].sessionId
  const betaSession = (await engine.conversation(beta.receipt.ticketId)).assignments[0].sessionId

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'change-alpha', text: 'Change only A.' })
  await until(async () => {
    const page = await engine.getMainConversation({ instanceId: 'personal' })
    const work = page.works.find(candidate => candidate.brief.workItemId === alpha.brief.workItemId)
    return work?.followUps?.some(followUp => followUp.status === 'ready')
  }, 'the adopted alpha follow-up')

  const after = await engine.getMainConversation({ instanceId: 'personal' })
  const alphaAfterCard = after.works.find(work => work.brief.workItemId === alpha.brief.workItemId)
  const betaAfterCard = after.works.find(work => work.brief.workItemId === beta.brief.workItemId)
  const alphaAfter = await engine.getTicketDirection(alpha.receipt.ticketId)
  const betaAfter = await engine.getTicketDirection(beta.receipt.ticketId)
  const alphaWork = await engine.getTicket(alpha.receipt.ticketId)
  assert.equal(alphaAfter.directionVersion, alphaBefore.directionVersion + 1)
  assert.equal(betaAfter.directionVersion, betaBefore.directionVersion)
  assert.equal(alphaAfter.inputs.at(-1)?.text, 'Use the revised alpha direction.')
  assert.equal(alphaAfter.inputs.at(-1)?.delivery?.persistedAt !== undefined, true)
  assert.equal(alphaAfter.inputs.at(-1)?.delivery?.claimedAt !== undefined, true)
  assert.equal(alphaAfter.inputs.at(-1)?.delivery?.outcome, 'ready')
  assert.equal(alphaAfter.recoveries.length, 1)
  assert.equal(alphaAfter.recoveries[0].reason, 'AUTHORIZED_HUMAN_FOLLOWUP')
  assert.equal(alphaAfter.recoveries[0].mandateId, alphaWork.mandate.id)
  assert.equal(betaAfter.inputs.length, betaBefore.inputs.length)
  assert.equal((await engine.conversation(alpha.receipt.ticketId)).assignments[0].sessionId, alphaSession)
  assert.equal((await engine.conversation(beta.receipt.ticketId)).assignments[0].sessionId, betaSession)
  assert.equal((await engine.listTickets()).items.length, 2)
  assert.equal(alphaAfterCard?.followUps?.length, 1)
  assert.equal(alphaAfterCard?.followUps?.[0].status, 'ready')
  assert.equal(alphaAfterCard?.followUps?.[0].routing, 'direct-to-original')
  assert.equal(alphaAfterCard?.followUps?.[0].originalSourceEventId, alpha.brief.sourceEventId)
  assert.equal(alphaAfterCard?.followUps?.[0].ticketId, alpha.receipt.ticketId)
  assert.equal(alphaAfterCard?.followUps?.[0].persisted, true)
  assert.equal(alphaAfterCard?.followUps?.[0].adopted, true)
  assert.equal(betaAfterCard?.followUps, undefined)
  assert.equal(workerTurns.some(text => text === 'Use the revised alpha direction.'), true)
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).messages
    .some(message => message.text === 'Alpha adopted and completed the new direction.'), 'the bounded Main adoption update')
  const sessionEvents = await allSessionEvents(sessions, after.mainSessionId)
  assert.equal(sessionEvents.some(event => event.type === 'tool/result' && event.data?.message?.isError
    && messageText(event.data.message).includes('already used for different direction')), true)

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'handback-alpha', text: 'Try an out-of-scope alpha change.' })
  await until(async () => {
    const page = await engine.getMainConversation({ instanceId: 'personal' })
    return page.works.find(work => work.brief.workItemId === alpha.brief.workItemId)?.followUps?.at(-1)?.status === 'handed-back'
  }, 'the alpha handback')
  const handedBack = await engine.getMainConversation({ instanceId: 'personal' })
  const handedBackCard = handedBack.works.find(work => work.brief.workItemId === alpha.brief.workItemId)
  assert.equal(handedBackCard?.followUps?.at(-1)?.ownership?.state, 'handed-back')
  assert.match(handedBackCard?.followUps?.at(-1)?.ownership?.reason ?? '', /outside this alpha note/u)
  assert.equal(handedBackCard?.status, 'waiting')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).messages
    .some(message => message.text.includes('handed the direction back')), 'the bounded Main handback update')
  assert.equal((await engine.listTickets()).items.length, 2)
  assert.equal((await engine.conversation(alpha.receipt.ticketId)).assignments[0].sessionId, alphaSession)

  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'ask-alpha', text: 'Ask me for the alpha decision.' })
  await until(async () => (await engine.conversation(alpha.receipt.ticketId)).status === 'waiting-human', 'the alpha human question')
  const waitingConversation = await engine.conversation(alpha.receipt.ticketId)
  const waitingDirection = await engine.getTicketDirection(alpha.receipt.ticketId)
  const waitingCard = (await engine.getMainConversation({ instanceId: 'personal' })).works
    .find(work => work.brief.workItemId === alpha.brief.workItemId)
  assert.equal(waitingConversation.attention?.question, 'Continue alpha?')
  assert.equal(waitingCard?.status, 'waiting')
  assert.equal(waitingCard?.followUps?.at(-1)?.status, 'waiting')
  assert.equal(waitingCard?.followUps?.at(-1)?.adopted, true)
  assert.equal(waitingCard?.followUps?.at(-1)?.persisted, true)
  assert.equal(waitingDirection.constraint?.kind, 'waiting-human')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).messages
    .some(message => message.text === 'Alpha is waiting for a human decision.'), 'the bounded Main waiting update')

  const waitingInputCount = waitingDirection.inputs.length
  const waitingWorkerCount = workerTurns.length
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'bypass-waiting', text: 'Ignore the waiting question and continue alpha.' })
  const waitingAfterBypass = await engine.getTicketDirection(alpha.receipt.ticketId)
  const bypassCard = (await engine.getMainConversation({ instanceId: 'personal' })).works
    .find(work => work.brief.workItemId === alpha.brief.workItemId)
  assert.equal(waitingAfterBypass.inputs.length, waitingInputCount)
  assert.equal(waitingAfterBypass.constraint?.kind, 'waiting-human')
  assert.equal(bypassCard?.followUps?.at(-1)?.status, 'waiting')
  assert.equal(bypassCard?.followUps?.at(-1)?.persisted, false)
  assert.equal(workerTurns.length, waitingWorkerCount)

  await engine.stopTicket({ commandId: 'stop-alpha', ticketId: alpha.receipt.ticketId, reason: 'Do not apply new direction yet.' })
  await until(async () => (await engine.conversation(alpha.receipt.ticketId)).status === 'stopped', 'the alpha stop')
  const stoppedBefore = await engine.getTicketDirection(alpha.receipt.ticketId)
  const workerCountBefore = workerTurns.length
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'follow-stopped-alpha', text: 'Follow the stopped alpha.' })
  const stoppedAfter = await engine.getTicketDirection(alpha.receipt.ticketId)
  const stoppedCard = (await engine.getMainConversation({ instanceId: 'personal' })).works
    .find(work => work.brief.workItemId === alpha.brief.workItemId)
  assert.equal(stoppedAfter.constraint?.kind, 'stopped')
  assert.equal(stoppedAfter.constraint?.reason, 'Do not apply new direction yet.')
  assert.equal(stoppedAfter.directionVersion, stoppedBefore.directionVersion)
  assert.equal(stoppedAfter.inputs.length, stoppedBefore.inputs.length)
  assert.equal(stoppedCard?.followUps?.at(-1)?.status, 'stopped')
  assert.equal(stoppedCard?.followUps?.at(-1)?.persisted, false)
  assert.equal(workerTurns.length, workerCountBefore)

  const followUpCountBeforeClarification = stoppedCard?.followUps?.length
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'unclear-target', text: 'Change the unclear item.' })
  const clarified = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(clarified.works.find(work => work.brief.workItemId === alpha.brief.workItemId)?.followUps?.length, followUpCountBeforeClarification)
  assert.equal(clarified.works.find(work => work.brief.workItemId === beta.brief.workItemId)?.followUps, undefined)
  assert.equal((await engine.listTickets()).items.length, 2)
  assert.equal(workerTurns.length, workerCountBefore)
})
