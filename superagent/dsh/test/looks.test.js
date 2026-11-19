import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_COLORS, DEFAULT_SHAPES, defaultColor, defaultShape, lookOf } from '../src/client/characters.js'

const ids = Array.from({ length: 3000 }, (_, index) => `session-${index.toString(16).padStart(8, '0')}-look`)

test('a Bot with no look of its own never gets the whale, gray, brown, or black', () => {
  assert.ok(!DEFAULT_SHAPES.includes('whale'))
  for (const color of ['gray', 'brown', 'black', 'aurora']) assert.ok(!DEFAULT_COLORS.includes(color), color)
  const shapes = new Set(ids.map(defaultShape))
  const colors = new Set(ids.map(defaultColor))
  assert.deepEqual([...shapes].sort(), [...DEFAULT_SHAPES].sort())
  assert.deepEqual([...colors].sort(), [...DEFAULT_COLORS].sort())
})

test('stored role art wins, while a missing look stays deterministic', () => {
  const stored = { id: 'chief', color: 'deepseek', avatar: { shape: 'whale' } }
  assert.deepEqual(lookOf(stored), { shape: 'whale', color: 'deepseek', image: undefined })
  assert.deepEqual(lookOf({ id: 'writer' }), {
    shape: defaultShape('writer'), color: defaultColor('writer'), image: undefined,
  })
  const photo = lookOf({ id: 'chief', avatar: { image: 'data:image/png;base64,AA==' } })
  assert.equal(photo.image, 'data:image/png;base64,AA==')
  assert.equal(photo.shape, defaultShape('chief'))
})
