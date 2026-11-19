import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { UUID } from 'builder-util-runtime'
import { configureIdentity } from '../src/product.mjs'

function fixture(testContext) {
  const root = mkdtempSync(join(tmpdir(), 'ds-superagent-identity-'))
  testContext.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = { appData: root, userData: join(root, 'DS SuperAgent') }
  const app = {
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value },
    setName: name => { app.name = name },
    setAppUserModelId: id => { app.id = id },
  }
  const env = { DSH_HOME: join(root, 'personal-dsh') }
  return { root, paths, app, env }
}

test('the desktop opens its own shell storage with former product folders present', t => {
  const { root, paths, app, env } = fixture(t)
  const legacyFiles = ['DS Bot', 'DeepSeek Bot'].map(name => {
    const dir = join(root, name)
    mkdirSync(dir)
    const file = join(dir, 'locations.json')
    writeFileSync(file, 'sentinel')
    return file
  })
  const settings = join(root, 'DS SuperAgent')
  assert.equal(configureIdentity(app, { env, platform: 'win32' }), settings)
  assert.equal(paths.userData, settings)
  assert.equal(paths.sessionData, settings)
  assert.equal(app.name, 'DS SuperAgent')
  assert.equal(app.id, 'io.github.icefireicer.ds-superagent')
  assert.throws(() => readFileSync(join(settings, 'locations.json')), { code: 'ENOENT' })
  assert.throws(() => configureIdentity(app, { env: { ...env, DS_SUPERAGENT_SHELL_DATA: join(root, 'DS Bot') } }), /previous product data/u)
  for (const file of legacyFiles) assert.equal(readFileSync(file, 'utf8'), 'sentinel')
})

test('a standalone test data override also isolates the desktop settings', t => {
  const { root, app, env } = fixture(t)
  const data = join(root, 'test-data')
  assert.equal(configureIdentity(app, { env: { ...env, DS_SUPERAGENT_HOME: data } }), join(data, 'desktop'))
})

test('the standalone installer does not take ownership of the former application', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const nsisNamespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')
  const identity = config.nsis.guid ?? UUID.v5(config.appId, nsisNamespace)
  const legacyInstaller = UUID.v5('io.github.fei2411.deepseekbot', nsisNamespace)
  assert.notEqual(identity, legacyInstaller)
  assert.equal(config.productName, 'DS SuperAgent')
  assert.match(config.copyright, /DS SuperAgent contributors/u)
  assert.match(config.artifactName, /^DS-SuperAgent-/u)
  assert.equal(config.linux.executableName, 'ds-superagent')
  assert.notEqual(identity, UUID.v5('io.github.fei2411.dsbot', nsisNamespace))
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  assert.equal(config.deb.packageName, 'ds-superagent')
  assert.ok(!config.deb.fpm?.includes('--conflicts'))
})
