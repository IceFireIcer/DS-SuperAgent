import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectNativeTurnCards, projectTurnCards } from '../src/client/product-state.js'

test('cards follow their exact Main turn across interleaved messages and history paging', () => {
  const works = [{ brief: { mainMessageId: 'request', workItemId: 'work' } }]
  const sources = [{ id: 'handoff', sourceInstanceId: 'feed', sourceEventId: 'event', mainMessageId: 'inbound' }]
  const preparations = [{ id: 'notice', sourceInstanceId: 'feed', eventId: 'event' },
    { id: 'different-feed', sourceInstanceId: 'other', eventId: 'event' }]
  const messages = [{ id: 'reply:request' }, { id: 'unrelated' }, { id: 'source-reply:handoff' }]
  const projected = projectTurnCards({ messages, works, sources, preparations })
  assert.deepEqual(projected.byMessage.get('reply:request'), { works, sources: [], preparations: [] })
  assert.deepEqual(projected.byMessage.get('source-reply:handoff'), { works: [], sources, preparations: [preparations[0]] })
  assert.equal(projected.byMessage.has('unrelated'), false)
  assert.deepEqual(projected.unplaced, { works: [], sources: [], preparations: [preparations[1]] })

  const early = projectTurnCards({ messages: [{ id: 'request' }], works, sources, preparations })
  assert.deepEqual(early.byMessage.get('request').works, works)
  assert.deepEqual(early.unplaced.sources, sources)
  assert.deepEqual(early.unplaced.preparations, preparations)
})

test('native tail associates work and sources with the originating input, and keeps unlinked preparation visible', () => {
  const work = { brief: { mainMessageId: 'request' } }
  const source = { sourceInstanceId: 'feed', sourceEventId: 'event', mainMessageId: 'inbound' }
  const pending = { sourceInstanceId: 'feed', sourceEventId: 'pending' }
  const preparation = { sourceInstanceId: 'feed', eventId: 'event' }
  const unlinked = { sourceInstanceId: 'other-feed', eventId: 'event' }
  const state = { works: [work], sources: [source, pending], preparations: [preparation, unlinked] }
  assert.deepEqual(projectNativeTurnCards(state, new Set(['request'])), { works: [work], sources: [], preparations: [] })
  assert.deepEqual(projectNativeTurnCards(state, new Set(['inbound'])), { works: [], sources: [source], preparations: [preparation] })
  assert.deepEqual(projectNativeTurnCards(state, new Set(['request', 'inbound']), true),
    { works: [], sources: [pending], preparations: [unlinked] })
  assert.deepEqual(projectNativeTurnCards(state, new Set(['request']), true),
    { works: [], sources: [source, pending], preparations: [preparation, unlinked] })
})
