import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { BUNDLES, SUPERAGENT_PROFILE, claimBundles, loadAppProfile, profileHome } from '../src/profile.mjs'

const DSH_WEB_FRONT_END = /^@deepseek-ai\/dsh-(client-ui-|web-app|web-frontend|client-modules|host-frontend-static|cordis-client-runner|client-hmr)/u

function rows(entries) {
  return entries.flatMap(entry => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

describe('the app profile', () => {
  let home
  let entries
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-superagent-app-profile-'))
    process.env.DSH_HOME = home
    const profile = loadAppProfile()
    assert.deepEqual(profile.layers.map(layer => layer.packageName), BUNDLES)
    assert.deepEqual(profile.skippedBundles, [])
    entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('mounts the one DS-SuperAgent product profile over DSH Web', () => {
    const on = new Set(entries.filter(entry => entry.disabled !== true).map(entry => entry.id))
    for (const id of ['superagent', 'webserver', 'connection']) assert.ok(on.has(id), `${id} is mounted`)
    assert.ok(rows(entries).some(entry => DSH_WEB_FRONT_END.test(entry.name ?? '')), 'the DSH Web front end is mounted')
  })
})

describe('product selection', () => {
  test('has no environment or legacy profile switch', () => {
    assert.equal(profileHome('/data'), join('/data', 'superagent'))
  })
})

describe('claimBundles', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-superagent-app-bundles-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (bundles, retiredDependency = false) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-superagent', private: true,
      dependencies: { 'a-plugin': '1.0.0', ...(retiredDependency ? { 'ds-bot': 'file:../ds-bot' } : {}) },
      dsh: { profile: { bundles } } }, undefined, 2)}\n`)
  }
  const read = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  test('puts product bundles first, keeps user bundles and drops every retired runtime', () => {
    const legacyBundles = ['@deepseek-ai/dsh-base', 'deepseek-bot-engine', 'dsbot-engine',
      'ds-superagent-host', 'ds-superagent-ui', 'ds-bot', 'a-plugin']
    write(legacyBundles, true)
    claimBundles(dir)
    assert.deepEqual(read().dsh.profile.bundles, [...BUNDLES, 'a-plugin'])
    assert.deepEqual(read().dependencies, { 'a-plugin': '1.0.0' })
  })

  test('leaves the single product profile unchanged when already claimed', () => {
    write([...BUNDLES, 'a-plugin'])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    claimBundles(dir)
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
  })
})
