import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mountProduct } from './helpers/mount-product.js'

function voiceFixture() {
  const recognitions = []
  const spoken = []
  let stoppedReading = 0
  const extensions = window => {
    window.SpeechRecognition = class {
      start() { recognitions.push(this) }
      abort() { this.aborted = true }
      speak(text) {
        this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] })
      }
    }
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    window.speechSynthesis = { speak: utterance => spoken.push(utterance), cancel() { stoppedReading += 1 } }
  }
  return { recognitions, spoken, extensions, stoppedReading: () => stoppedReading }
}

const voiceDirectory = () => ({ directories: [], default: { environmentId: 'local-fixture', root: '/fixture' } })

test('continuous voice reads only the complete Main reply for its accepted input and then listens again', async context => {
  const { recognitions, spoken, extensions } = voiceFixture()
  const receipt = Promise.withResolvers()
  const messages = [{ id: 'reply:some-other-input', sequence: 1, role: 'main', status: 'completed', text: 'Unrelated reply' }]
  const { act, click, document, findButton, requests } = await mountProduct(context, {
    extensions,
    responses: {
      send: () => receipt.promise,
      history: () => ({ mainSessionId: 'main-fixture', messages, works: [], health: { state: 'ready' } }),
      'directory-options': voiceDirectory,
    },
  })
  const enable = findButton('Start voice chat')
  assert.ok(enable, 'the Main input offers continuous voice')
  await click(enable)
  assert.match(document.querySelector('.bt-voice-status').textContent, /Listening/u)
  assert.equal(document.activeElement, findButton('Pause voice chat'))
  await act(async () => {
    recognitions[0].speak('One transcript')
    recognitions[0].speak('Duplicate transcript')
  })
  assert.match(document.querySelector('.bt-voice-status').textContent, /Waiting for Main/u)
  assert.equal(recognitions[0].aborted, true)
  assert.deepEqual(requests.filter(request => request.endpoint === 'send').map(request => request.payload.text), ['One transcript'])
  assert.equal(spoken.length, 0)
  messages.push({ id: 'reply:voice-input', sequence: 2, role: 'main', status: 'running', text: 'Partial reply' })
  await act(async () => receipt.resolve({ messageId: 'voice-input', status: 'queued' }))
  assert.equal(spoken.length, 0, 'an accepted input and partial reply are not spoken')
  messages[1] = { ...messages[1], status: 'completed', text: 'Here is **your** reply.' }
  await act(async () => delay(800))
  assert.deepEqual(spoken.map(utterance => utterance.text), ['Here is your reply.'])
  assert.match(document.querySelector('.bt-voice-status').textContent, /Speaking/u)
  await act(async () => spoken[0].onend())
  assert.equal(recognitions.length, 2)
  assert.match(document.querySelector('.bt-voice-status').textContent, /Listening/u)
})

test('pause and window visibility drop stale audio and a late Main receipt, and Escape restores input focus', async context => {
  const { recognitions, spoken, extensions } = voiceFixture()
  const receipt = Promise.withResolvers()
  const messages = []
  const { act, click, document, findButton, key, window, requests } = await mountProduct(context, {
    extensions,
    responses: {
      send: () => receipt.promise,
      history: () => ({ mainSessionId: 'main-fixture', messages, works: [], health: { state: 'ready' } }),
      'directory-options': voiceDirectory,
    },
  })
  await click(findButton('Start voice chat'))
  await act(async () => recognitions[0].speak('Accepted while voice was waiting'))
  await click(findButton('Pause voice chat'))
  messages.push({ id: 'reply:late-receipt', sequence: 2, role: 'main', status: 'completed', text: 'Too late' })
  await act(async () => receipt.resolve({ messageId: 'late-receipt', status: 'completed' }))
  assert.equal(spoken.length, 0)
  await click(findButton('Resume voice chat'))
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(recognitions[1].aborted, true)
  await act(async () => recognitions[1].speak('Discarded final transcript'))
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(recognitions.length, 2, 'becoming visible requires a new user action')
  assert.equal(requests.filter(request => request.endpoint === 'send').length, 1)
  await key(findButton('Resume voice chat'), 'Escape')
  assert.ok(!document.querySelector('.bt-main-voice'))
  assert.equal(document.activeElement, findButton('Start voice chat'))
})

test('microphone denial and Main refusal pause continuous voice for an explicit retry', async context => {
  const { recognitions, extensions } = voiceFixture()
  const { act, click, document, findButton, requests } = await mountProduct(context, {
    extensions,
    responses: { send: () => { throw new Error('Main cannot accept this input.') }, 'directory-options': voiceDirectory },
  })
  await click(findButton('Start voice chat'))
  await act(async () => recognitions[0].onerror({ error: 'not-allowed' }))
  assert.match(document.querySelector('.bt-voice-note').textContent, /Microphone access is blocked/u)
  assert.equal(recognitions[0].aborted, true)
  await act(async () => recognitions[0].speak('Ignored after denial'))
  assert.equal(requests.filter(request => request.endpoint === 'send').length, 0)
  await click(findButton('Resume voice chat'))
  await act(async () => recognitions[1].speak('Retry from the same Main'))
  assert.match(document.querySelector('.bt-voice-note').textContent, /Main cannot accept this input/u)
  assert.ok(findButton('Resume voice chat'))
  assert.equal(recognitions.length, 2)
})

test('a Ticket question owns the input and interrupts speech until the user resumes voice', async context => {
  const { recognitions, spoken, extensions, stoppedReading } = voiceFixture()
  const messages = []
  const works = []
  const question = { brief: { id: 'brief', workItemId: 'item', goal: 'Review a note' },
    receipt: { status: 'accepted', ticketId: 'ticket' }, status: 'waiting',
    control: { workItemId: 'item', ticketId: 'ticket', assignment: { generation: 'generation' },
      permissions: { actorId: 'fixture', canAnswer: true },
      attention: { id: 'attention', status: 'waiting', version: 1, question: 'Keep the heading?', options: ['Keep it'] } } }
  const { act, click, document, findButton, requests } = await mountProduct(context, {
    extensions,
    responses: {
      send: () => {
        messages.push({ role: 'main', status: 'completed', id: 'reply:voice-input', sequence: 2, text: 'Reviewing the note' })
        return { messageId: 'voice-input', status: 'completed' }
      },
      history: () => ({ mainSessionId: 'main-fixture', messages, works, health: { state: 'ready' } }),
      'work-answer': () => { works.length = 0; return { status: 'answered' } },
      'directory-options': voiceDirectory,
    },
  })
  await click(findButton('Start voice chat'))
  await act(async () => recognitions[0].speak('Review the note'))
  assert.equal(spoken.length, 1)
  const cancels = stoppedReading()
  works.push(question)
  await act(async () => delay(800))
  assert.ok(stoppedReading() > cancels)
  assert.equal(document.querySelector('.bt-main-voice'), null)
  assert.equal(document.querySelector('#main-message'), null)
  assert.match(document.querySelector('.bt-q-dock').textContent, /Keep the heading/u)
  await click(findButton('Keep it'))
  await click(findButton('Send answer'))
  assert.equal(requests.find(request => request.endpoint === 'work-answer')?.payload.ticketId, 'ticket')
  assert.equal(recognitions.length, 1)
  await click(findButton('Resume voice chat'))
  assert.equal(recognitions.length, 2)
  await click(findButton('Activity'))
  assert.equal(recognitions[1].aborted, true)
})

test('stopping a background Ticket leaves voice waiting, while stopping Main pauses it', async context => {
  const { recognitions, spoken, extensions } = voiceFixture()
  let activeTurn
  let workers = [{ sessionId: 'worker', state: 'running', item: { id: 'item', ticketId: 'ticket', goal: 'Write a note',
    stop: { expectedTicketVersion: 1, expectedGeneration: 'generation' } } }]
  const { act, click, document, findButton, requests } = await mountProduct(context, {
    extensions,
    responses: {
      send: () => { activeTurn = { messageId: 'voice-turn', status: 'running' }; return { messageId: 'voice-turn', status: 'queued' } },
      history: () => ({ mainSessionId: 'main-fixture', messages: [], works: [], health: { state: 'ready' }, activeTurn }),
      'work-members': () => ({ workers }),
      'work-stop': () => { workers = []; return { state: 'stopped' } },
      'stop-main': () => { activeTurn = undefined; return { state: 'stopped' } },
      'directory-options': voiceDirectory,
    },
  })
  await click(findButton('Start voice chat'))
  await act(async () => recognitions[0].speak('Check the note'))
  await click(findButton('Stop work: Write a note'))
  await click(findButton('Confirm stop for Write a note'))
  assert.match(document.querySelector('.bt-voice-status').textContent, /Waiting for Main/u)
  await click(findButton('Stop reply'))
  assert.match(document.querySelector('.bt-voice-status').textContent, /Paused/u)
  assert.equal(spoken.length, 0)
  const stops = requests.filter(request => ['work-stop', 'stop-main'].includes(request.endpoint))
  assert.equal(stops[0].payload.ticketId, 'ticket')
  assert.equal(stops[1].payload.messageId, 'voice-turn')
})
