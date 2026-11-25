import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { chooseLocations } = await import('../src/first-run.mjs')

after(() => rmSync(paths.root, { recursive: true, force: true }))

const useThrowawayHome = t => {
  const previous = process.env.DS_SUPERAGENT_HOME
  delete process.env.DS_SUPERAGENT_HOME
  t.after(() => {
    if (previous === undefined) delete process.env.DS_SUPERAGENT_HOME
    else process.env.DS_SUPERAGENT_HOME = previous
  })
}

test('a first start without a saved project asks only for the app data folder', async t => {
  useThrowawayHome(t)
  rmSync(join(paths.userData, 'locations.json'), { force: true })
  state.dialogs.length = 0
  state.openAnswer = undefined
  let boxes = 0
  state.dialogAnswer = options => {
    if (boxes++ === 0) {
      assert.match(options.detail, /^Data: /u)
      assert.doesNotMatch(options.detail, /Workspace:/u)
      return { response: 1 }
    }
    return { response: 2 }
  }

  assert.deepEqual(await chooseLocations(new AbortController().signal), { quit: true })
  const folders = state.dialogs.filter(options => options.properties?.includes('openDirectory'))
  assert.equal(folders.length, 1, 'the user is not asked for a project before Main starts')
  assert.match(folders[0].title, /data/iu)
  assert.doesNotMatch(folders[0].title, /Worker/u)
})

test('saved locations without a project stay Main-only and create no workspace', async t => {
  useThrowawayHome(t)
  const root = realpathSync.native(paths.root)
  const dataDir = join(root, '.ds-superagent')
  const locations = join(paths.userData, 'locations.json')
  mkdirSync(join(dataDir, 'superagent'), { recursive: true })
  writeFileSync(locations, JSON.stringify({ dataDir }))
  state.dialogs.length = 0
  state.dialogAnswer = undefined

  assert.deepEqual(await chooseLocations(new AbortController().signal), { dataDir })
  assert.deepEqual(JSON.parse(readFileSync(locations, 'utf8')), { dataDir })
  assert.equal(existsSync(join(dataDir, 'superagent')), true)
  assert.equal(existsSync(join(dataDir, 'workspace')), false)
})

test('a saved project remains selected instead of being replaced by a default', async t => {
  useThrowawayHome(t)
  const root = realpathSync.native(paths.root)
  const dataDir = join(root, '.ds-superagent')
  const workspace = join(root, 'my-project')
  mkdirSync(join(dataDir, 'superagent'), { recursive: true })
  mkdirSync(workspace)
  const locations = join(paths.userData, 'locations.json')
  writeFileSync(locations, JSON.stringify({ dataDir, workspace }))
  state.dialogs.length = 0
  state.dialogAnswer = undefined

  assert.deepEqual(await chooseLocations(new AbortController().signal), { dataDir, workspace })
  assert.deepEqual(JSON.parse(readFileSync(locations, 'utf8')), { dataDir, workspace })
})

test('finishing a first start stores only the chosen data folder', async t => {
  useThrowawayHome(t)
  const root = realpathSync.native(paths.root)
  const dataDir = join(root, 'fresh-data')
  const locations = join(paths.userData, 'locations.json')
  rmSync(locations, { force: true })
  state.dialogs.length = 0
  let boxes = 0
  state.dialogAnswer = () => ({ response: boxes++ === 0 ? 1 : 0 })
  state.openAnswer = { canceled: false, filePaths: [dataDir] }

  assert.deepEqual(await chooseLocations(new AbortController().signal), { dataDir })
  assert.deepEqual(JSON.parse(readFileSync(locations, 'utf8')), { dataDir })
  assert.equal(existsSync(join(dataDir, 'superagent')), true)
  assert.equal(existsSync(join(dataDir, 'workspace')), false)
})
