import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { checkPlaces, chooseLocations, placeProblem, saveLocations } = await import('../src/first-run.mjs')

test('saved locations inside DSH are rejected before the app writes there', async t => {
  t.after(() => rmSync(paths.root, { recursive: true, force: true }))
  const originalDsh = process.env.DSH_HOME
  const originalProductHome = process.env.DS_SUPERAGENT_HOME
  delete process.env.DS_SUPERAGENT_HOME
  const dshHome = join(paths.root, '.dsh-fixture')
  const dataDir = join(dshHome, 'product-data')
  const workspace = join(paths.root, 'workspace')
  mkdirSync(dshHome, { recursive: true })
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (originalDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDsh
    if (originalProductHome === undefined) delete process.env.DS_SUPERAGENT_HOME
    else process.env.DS_SUPERAGENT_HOME = originalProductHome
  })
  const locations = join(paths.userData, 'locations.json')
  writeFileSync(locations, JSON.stringify({ dataDir, workspace }))
  assert.match(placeProblem(null, dataDir, workspace), /DeepSeek Harness.?s data/u)
  assert.match(checkPlaces({ dataDir, workspace }), /DeepSeek Harness.?s data/u)
  assert.equal(chooseLocations().dataDir, dataDir, 'read-only resolution preserves the saved location')
  assert.equal(existsSync(dataDir), false, 'the rejected path was not created')
  assert.equal(readFileSync(locations, 'utf8'), JSON.stringify({ dataDir, workspace }), 'saved selection remains intact')
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(dshHome)), [])
})

test('location persistence uses only the app-owned location file', async t => {
  t.after(() => rmSync(paths.root, { recursive: true, force: true }))
  const originalProductHome = process.env.DS_SUPERAGENT_HOME
  delete process.env.DS_SUPERAGENT_HOME
  t.after(() => {
    if (originalProductHome === undefined) delete process.env.DS_SUPERAGENT_HOME
    else process.env.DS_SUPERAGENT_HOME = originalProductHome
  })
  const dataDir = join(paths.root, 'isolated-data')
  const workspace = join(paths.root, 'isolated-workspace')
  saveLocations({ dataDir, workspace })
  const locations = join(paths.userData, 'locations.json')
  assert.deepEqual(JSON.parse(readFileSync(locations, 'utf8')).dataDir, dataDir)
  assert.deepEqual(chooseLocations().workspace, workspace)
  assert.equal(existsSync(join(dataDir, 'superagent')), false, 'saving a location does not create product state')
})

test('a saved missing product home is reported instead of silently recreated', async t => {
  t.after(() => rmSync(paths.root, { recursive: true, force: true }))
  const originalProductHome = process.env.DS_SUPERAGENT_HOME
  delete process.env.DS_SUPERAGENT_HOME
  t.after(() => {
    if (originalProductHome === undefined) delete process.env.DS_SUPERAGENT_HOME
    else process.env.DS_SUPERAGENT_HOME = originalProductHome
  })
  const dataDir = join(paths.root, 'missing-saved-data')
  const workspace = join(paths.root, 'saved-workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
  const locations = join(paths.userData, 'locations.json')
  writeFileSync(locations, JSON.stringify({ dataDir, workspace }))
  const selected = chooseLocations()
  assert.equal(selected.saved, true)
  const missing = checkPlaces(selected, { saved: selected.saved })
  assert.equal(missing.code, 'ENOENT')
  assert.equal(missing.path, dataDir)
  assert.equal(existsSync(dataDir), false)
  assert.equal(readFileSync(locations, 'utf8'), JSON.stringify({ dataDir, workspace }))
})
