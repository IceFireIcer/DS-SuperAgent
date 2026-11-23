import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))

test('published product metadata names DS SuperAgent and its author', async () => {
  const [superagent, app, mobile] = await Promise.all([
    readJson('../package.json'),
    readJson('../../app/package.json'),
    readJson('../../mobile/package.json'),
  ])
  assert.equal(superagent.name, 'ds-superagent')
  assert.equal(superagent.author, 'IceFireIcer')
  assert.match(superagent.description, /DS SuperAgent/u)
  assert.doesNotMatch(superagent.description, /ds[- ]?bot|\bbot\b/iu)
  assert.equal(app.productName, 'DS SuperAgent')
  assert.equal(app.author, 'IceFireIcer')
  assert.match(app.description, /DS SuperAgent/u)
  assert.equal(mobile.author, 'IceFireIcer')
  assert.match(mobile.description, /DS SuperAgent/u)
})
