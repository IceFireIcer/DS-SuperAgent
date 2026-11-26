import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setReleaseVersion } from './set-release-version.mjs'

const write = (root, file, value) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`)
}

test('all app and package-lock releases share one version', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-superagent-release-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'superagent/package.json', { name: 'ds-superagent', version: '1.0.0' })
  write(root, 'app/package.json', { name: 'ds-superagent-desktop', version: '1.0.0' })
  write(root, 'superagent/package-lock.json', { name: 'ds-superagent', version: '1.0.0', packages: { '': { version: '1.0.0' } } })
  write(root, 'app/package-lock.json', { name: 'ds-superagent-desktop', version: '1.0.0',
    packages: { '': { version: '1.0.0' }, 'node_modules/ds-superagent': { version: '1.0.0' } } })

  assert.deepEqual(setReleaseVersion(root, '1.0.1'), [
    'superagent/package.json', 'app/package.json', 'superagent/package-lock.json', 'app/package-lock.json',
  ])
  for (const file of ['superagent/package.json', 'app/package.json']) {
    assert.equal(JSON.parse(readFileSync(join(root, file), 'utf8')).version, '1.0.1')
  }
  for (const file of ['superagent/package-lock.json', 'app/package-lock.json']) {
    const value = JSON.parse(readFileSync(join(root, file), 'utf8'))
    assert.equal(value.version, '1.0.1')
    assert.equal(value.packages[''].version, '1.0.1')
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'app/package-lock.json'), 'utf8'))
    .packages['node_modules/ds-superagent'].version, '1.0.1')
  assert.deepEqual(setReleaseVersion(root, '1.0.1'), [])
})
