import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INITIAL_VERSION, SCALE, bumpVersion, classifyScale, nextVersion, parseVersion,
} from './release-version.mjs'

test('semantic versions bump without carrying prerelease text', () => {
  assert.deepEqual(parseVersion('1.0.0'), { major: 1, minor: 0, patch: 0 })
  assert.equal(bumpVersion('1.0.0', 'patch'), '1.0.1')
  assert.equal(bumpVersion('1.0.9', 'minor'), '1.1.0')
  assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0')
  assert.throws(() => bumpVersion('1.0', 'patch'), /Invalid semantic version/u)
})

test('the first release starts at 1.0.0', () => {
  assert.deepEqual(nextVersion({ current: '1.0.0', hasTag: false, commits: 12 }), {
    release: true, version: INITIAL_VERSION, bump: 'initial', files: 0, lines: 0,
  })
})

test('an unchanged tree does not release', () => {
  assert.deepEqual(nextVersion({ current: '1.2.3', hasTag: true, commits: 0 }), {
    release: false, version: '1.2.3', bump: 'none', files: 0, lines: 0,
  })
})

test('automatic bumps follow breaking, feature and changed-size scope', () => {
  assert.equal(classifyScale({ breaking: true }), 'major')
  assert.equal(classifyScale({ files: SCALE.majorFiles }), 'major')
  assert.equal(classifyScale({ lines: SCALE.majorLines }), 'major')
  assert.equal(classifyScale({ feature: true }), 'minor')
  assert.equal(classifyScale({ files: SCALE.minorFiles }), 'minor')
  assert.equal(classifyScale({ lines: SCALE.minorLines }), 'minor')
  assert.equal(classifyScale({ files: SCALE.minorFiles - 1, lines: SCALE.minorLines - 1 }), 'patch')
  assert.deepEqual(nextVersion({ current: '1.0.0', hasTag: true, commits: 2, files: SCALE.minorFiles }), {
    release: true, version: '1.1.0', bump: 'minor', files: SCALE.minorFiles, lines: 0,
  })
})

test('the manual bump overrides the automatic scope', () => {
  assert.equal(nextVersion({ current: '1.0.0', hasTag: true, commits: 1, bump: 'major' }).version, '2.0.0')
  assert.equal(nextVersion({ current: '1.0.0', hasTag: true, commits: 1, bump: 'patch', files: SCALE.majorFiles }).version, '1.0.1')
})
