import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { chooseLocations } = await import('../src/first-run.mjs')

test('a saved workspace that cannot be opened goes back to folder setup', async t => {
  t.after(() => rmSync(paths.root, { recursive: true, force: true }))
  const override = process.env.DS_SUPERAGENT_HOME
  delete process.env.DS_SUPERAGENT_HOME
  t.after(() => { if (override !== undefined) process.env.DS_SUPERAGENT_HOME = override })
  const dataDir = join(paths.root, '.ds-superagent')
  const blocked = join(paths.root, 'not-a-folder')
  const workspace = join(paths.root, 'workspace')
  mkdirSync(join(dataDir, 'superagent'), { recursive: true })
  writeFileSync(blocked, 'do not overwrite')
  const locations = join(paths.userData, 'locations.json')
  writeFileSync(locations, JSON.stringify({ dataDir, workspace: blocked }))
  state.dialogAnswer = options => ({ response: state.dialogs.length > 4 ? 2 : options.type === 'warning' ? 1 : 0 })
  state.openAnswer = options => ({ canceled: false, filePaths: [options.title.includes('data') ? dataDir : workspace] })

  assert.deepEqual(await chooseLocations(new AbortController().signal), { dataDir, workspace })
  assert.match(state.dialogs[0].message, /Cannot write to .*not-a-folder/u)
  assert.equal(state.dialogs[0].defaultId, 1)
  assert.deepEqual(JSON.parse(readFileSync(locations, 'utf8')), { dataDir, workspace })
  assert.equal(readFileSync(blocked, 'utf8'), 'do not overwrite')
})
