import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_ACCEPTANCE,
  createBuildRecord,
  RECORD_TYPE,
  SUPPORT_STATUS,
  writeBuildRecord,
} from './desktop-build-record.mjs'

const VERSION = '1.2.3'
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const script = fileURLToPath(new URL('./desktop-build-record.mjs', import.meta.url))
const FILES = new Map([
  [`DS-SuperAgent-${VERSION}-win-x64.exe`, 'windows installer\n'],
  [`DS-SuperAgent-${VERSION}-mac-arm64.zip`, 'mac arm64 zip\n'],
  [`DS-SuperAgent-${VERSION}-mac-x64.zip`, 'mac x64 zip\n'],
  [`DS-SuperAgent-${VERSION}-linux-amd64.deb`, 'linux deb\n'],
  [`DS-SuperAgent-${VERSION}-linux-x86_64.AppImage`, 'linux appimage\n'],
])

async function fixture(context, { omit, extra } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-superagent-build-record-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts)
  for (const [file, content] of FILES) {
    if (file !== omit) writeFileSync(join(artifacts, file), content)
  }
  if (extra) writeFileSync(join(artifacts, extra), 'unexpected\n')
  return { artifacts, output: join(root, 'record', 'build-record.json') }
}

const identity = { commitSha: COMMIT_SHA, version: VERSION }

test('the complete matrix binds every package to one commit and does not declare support', async context => {
  const { artifacts, output } = await fixture(context)
  const record = await writeBuildRecord({ ...identity, artifactDirectory: artifacts, output })

  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), record)
  assert.equal(record.recordType, RECORD_TYPE)
  assert.equal(record.status, 'complete')
  assert.deepEqual(record.candidate, identity)
  assert.deepEqual(record.matrix, { requiredArtifactCount: 5, producedArtifactCount: 5, complete: true })
  assert.equal(record.supportStatus, SUPPORT_STATUS)
  assert.equal(record.artifactAcceptance, ARTIFACT_ACCEPTANCE)
  assert.equal(record.supportStatus, 'not_declared')
  assert.equal(record.artifactAcceptance, 'not_assessed')
  assert.equal(record.artifacts.length, 5)

  assert.deepEqual(record.artifacts.map(({ platform, architecture, distributionForm, filename }) => ({
    platform, architecture, distributionForm, filename,
  })), [
    { platform: 'windows', architecture: 'x64', distributionForm: 'nsis-installer', filename: `DS-SuperAgent-${VERSION}-win-x64.exe` },
    { platform: 'macos', architecture: 'arm64', distributionForm: 'zip', filename: `DS-SuperAgent-${VERSION}-mac-arm64.zip` },
    { platform: 'macos', architecture: 'x64', distributionForm: 'zip', filename: `DS-SuperAgent-${VERSION}-mac-x64.zip` },
    { platform: 'linux', architecture: 'x64', distributionForm: 'deb', filename: `DS-SuperAgent-${VERSION}-linux-amd64.deb` },
    { platform: 'linux', architecture: 'x64', distributionForm: 'appimage', filename: `DS-SuperAgent-${VERSION}-linux-x86_64.AppImage` },
  ])
  for (const artifact of record.artifacts) {
    assert.equal(artifact.commitSha, COMMIT_SHA)
    assert.equal(artifact.version, VERSION)
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u)
    assert.ok(artifact.sizeBytes > 0)
    assert.equal(artifact.supportStatus, 'not_declared')
    assert.equal(artifact.artifactAcceptance, 'not_assessed')
  }
  assert.equal(record.artifacts[0].sha256, '41034fb5f33b87f7d0555627f91d9c8aa8e35d58449905741af32d0ac6766252')
})

test('a missing required package fails without writing a complete record', async context => {
  const { artifacts, output } = await fixture(context, { omit: `DS-SuperAgent-${VERSION}-mac-x64.zip` })
  await assert.rejects(
    writeBuildRecord({ ...identity, artifactDirectory: artifacts, output }),
    /artifact set does not match.*missing: DS-SuperAgent-1\.2\.3-mac-x64\.zip/u,
  )
  assert.equal(existsSync(output), false)
})

test('an unexpected package fails the exact artifact set', async context => {
  const { artifacts } = await fixture(context, { extra: `DS-SuperAgent-${VERSION}-mac-universal.zip` })
  await assert.rejects(
    createBuildRecord({ ...identity, artifactDirectory: artifacts }),
    /artifact set does not match.*unexpected: DS-SuperAgent-1\.2\.3-mac-universal\.zip/u,
  )
})

test('an invalid SHA or a package set for another version is rejected', async context => {
  const { artifacts } = await fixture(context)
  await assert.rejects(
    createBuildRecord({ artifactDirectory: artifacts, commitSha: 'abc', version: VERSION }),
    /commit SHA must be a full 40-character lowercase Git SHA/u,
  )
  await assert.rejects(
    createBuildRecord({ artifactDirectory: artifacts, commitSha: COMMIT_SHA, version: '1.2.4' }),
    error => {
      assert.match(error.message, /artifact set does not match/u)
      assert.match(error.message, /missing: DS-SuperAgent-1\.2\.4-win-x64\.exe/u)
      assert.match(error.message, /unexpected: .*DS-SuperAgent-1\.2\.3-win-x64\.exe/u)
      return true
    },
  )
})

test('artifact hashes are stable across repeated builds', async context => {
  const { artifacts } = await fixture(context)
  const first = await createBuildRecord({ ...identity, artifactDirectory: artifacts })
  const second = await createBuildRecord({ ...identity, artifactDirectory: artifacts })
  assert.deepEqual(
    first.artifacts.map(({ filename, sha256 }) => ({ filename, sha256 })),
    second.artifacts.map(({ filename, sha256 }) => ({ filename, sha256 })),
  )
})

test('the CLI writes the record after validating the complete matrix', async context => {
  const { artifacts, output } = await fixture(context)
  const result = spawnSync(process.execPath, [
    script,
    '--artifacts', artifacts,
    '--commit-sha', COMMIT_SHA,
    '--version', VERSION,
    '--output', output,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const record = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(record.status, 'complete')
  assert.equal(record.artifacts.length, 5)
  assert.match(result.stdout, /Desktop build matrix complete: 5 artifacts/u)
})
