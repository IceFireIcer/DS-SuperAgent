import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectTurnCards } from '../src/client/product-state.js'

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
