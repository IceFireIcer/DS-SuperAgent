import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// npm does not install a file: dependency's dependencies, so the app declares
// deep-view itself. The version must match both the product UI and Super-agent validator.
test('the app carries the deep-view version used by ds-bot and Super-agent', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const dsbot = JSON.parse(readFileSync(join(root, '..', 'ds-bot', 'package.json'), 'utf8'))
  const superagent = JSON.parse(readFileSync(join(root, '..', 'superagent', 'package.json'), 'utf8'))
  assert.equal(app.dependencies['deep-view'], dsbot.dependencies['deep-view'])
  assert.equal(app.dependencies['deep-view'], superagent.dependencies['deep-view'])
})
