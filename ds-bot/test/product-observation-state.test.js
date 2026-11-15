import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeMessages, mergeObservationItems, rebaseRoleDraft } from '../src/client/product-state.js'

test('observation polling merges a new first page without discarding older loaded pages', () => {
  const older = Array.from({ length: 31 }, (_, index) => ({
    id: `worker-${String(index).padStart(2, '0')}`,
    role: 'worker',
    createdAt: 1_000 - index,
  }))
  const refreshed = [
    { id: 'worker-new', role: 'worker', createdAt: 1_001 },
    { ...older[0], status: 'success' },
  ]
  const merged = mergeObservationItems(older, refreshed)
  assert.equal(merged.length, 32)
  assert.equal(merged[0].id, 'worker-new')
  assert.equal(merged.find(item => item.id === older[0].id).status, 'success')
  assert.equal(merged.at(-1).id, 'worker-30')
})

test('Main history merging keeps loaded older pages in sequence order and updates existing facts', () => {
  const existing = [
    { id: 'old', sequence: 1, status: 'completed' },
    { id: 'middle', sequence: 2, status: 'running' },
  ]
  const latest = [
    { id: 'middle', sequence: 2, status: 'completed' },
    { id: 'new', sequence: 3, status: 'completed' },
  ]
  assert.deepEqual(mergeMessages(existing, latest), [
    { id: 'old', sequence: 1, status: 'completed' },
    { id: 'middle', sequence: 2, status: 'completed' },
    { id: 'new', sequence: 3, status: 'completed' },
  ])
})

test('a revision conflict rebases only locally changed role fields over the newer settings', () => {
  const profile = (provider, model, instructions) => ({ name: 'Role', model: { provider, model }, instructions, skills: [] })
  const base = { main: profile('p', 'one', 'Base main.'), router: profile('p', 'router', '{{goal}} Base router.'), worker: profile('p', 'worker', '{{goal}} {{constraints}} Base worker.') }
  const draft = structuredClone(base)
  draft.worker.instructions = '{{goal}} {{constraints}} My draft.'
  const latest = structuredClone(base)
  latest.worker.instructions = '{{goal}} {{constraints}} Newer worker.'
  latest.router.model = { provider: 'q', model: 'router-next' }
  const merged = rebaseRoleDraft(base, draft, latest)
  assert.equal(merged.worker.instructions, '{{goal}} {{constraints}} My draft.')
  assert.deepEqual(merged.router.model, { provider: 'q', model: 'router-next' })
  assert.equal(draft.worker.instructions, '{{goal}} {{constraints}} My draft.', 'rebase leaves the saved draft intact')
})
