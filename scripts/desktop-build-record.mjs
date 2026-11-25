import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const RECORD_TYPE = 'desktop-release-candidate-build'
export const SUPPORT_STATUS = 'not_declared'
export const ARTIFACT_ACCEPTANCE = 'not_assessed'

const COMMIT_SHA = /^[0-9a-f]{40}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u

const ARTIFACT_SPECS = [
  {
    platform: 'windows',
    architecture: 'x64',
    distributionForm: 'nsis-installer',
    filename: version => `DS-SuperAgent-${version}-win-x64.exe`,
  },
  {
    platform: 'macos',
    architecture: 'arm64',
    distributionForm: 'zip',
    filename: version => `DS-SuperAgent-${version}-mac-arm64.zip`,
  },
  {
    platform: 'macos',
    architecture: 'x64',
    distributionForm: 'zip',
    filename: version => `DS-SuperAgent-${version}-mac-x64.zip`,
  },
  {
    platform: 'linux',
    architecture: 'x64',
    distributionForm: 'deb',
    filename: version => `DS-SuperAgent-${version}-linux-amd64.deb`,
  },
  {
    platform: 'linux',
    architecture: 'x64',
    distributionForm: 'appimage',
    filename: version => `DS-SuperAgent-${version}-linux-x86_64.AppImage`,
  },
]

function checkCommitSha(commitSha) {
  if (typeof commitSha !== 'string' || !COMMIT_SHA.test(commitSha)) {
    throw new Error(`commit SHA must be a full 40-character lowercase Git SHA; got ${JSON.stringify(commitSha)}`)
  }
}

function checkVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`version must be a semantic version without path separators; got ${JSON.stringify(version)}`)
  }
}

export function requiredArtifactNames(version) {
  checkVersion(version)
  return ARTIFACT_SPECS.map(spec => spec.filename(version))
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function checkArtifactDirectory(artifactDirectory, version) {
  let entries
  try {
    entries = await readdir(artifactDirectory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read artifact directory ${artifactDirectory}: ${error.message}`)
  }

  const expected = requiredArtifactNames(version)
  const actual = entries.map(entry => entry.name).sort()
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter(name => !actualSet.has(name))
  const unexpected = actual.filter(name => !expectedSet.has(name))
  if (missing.length || unexpected.length) {
    const details = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(unexpected.length ? [`unexpected: ${unexpected.join(', ')}`] : []),
    ]
    throw new Error(`artifact set does not match the required desktop build matrix (${details.join('; ')})`)
  }

  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`artifact is not a regular file: ${entry.name}`)
    const info = await stat(join(artifactDirectory, entry.name))
    if (info.size === 0) throw new Error(`artifact is empty: ${entry.name}`)
  }
  return expected
}

export async function createBuildRecord({ artifactDirectory, commitSha, version }) {
  checkCommitSha(commitSha)
  checkVersion(version)
  const filenames = await checkArtifactDirectory(artifactDirectory, version)
  const artifacts = []
  for (const spec of ARTIFACT_SPECS) {
    const filename = spec.filename(version)
    const file = join(artifactDirectory, filename)
    const info = await stat(file)
    artifacts.push({
      commitSha,
      version,
      platform: spec.platform,
      architecture: spec.architecture,
      distributionForm: spec.distributionForm,
      filename,
      sha256: await hashFile(file),
      sizeBytes: info.size,
      supportStatus: SUPPORT_STATUS,
      artifactAcceptance: ARTIFACT_ACCEPTANCE,
    })
  }
  if (artifacts.length !== filenames.length) throw new Error('the build record did not include every required artifact')
  return {
    schemaVersion: 1,
    recordType: RECORD_TYPE,
    status: 'complete',
    candidate: { commitSha, version },
    matrix: {
      requiredArtifactCount: ARTIFACT_SPECS.length,
      producedArtifactCount: artifacts.length,
      complete: true,
    },
    supportStatus: SUPPORT_STATUS,
    artifactAcceptance: ARTIFACT_ACCEPTANCE,
    supportNote: 'A complete build record certifies artifact generation only; it is not package acceptance or a platform support declaration.',
    artifacts,
  }
}

export async function writeBuildRecord({ artifactDirectory, commitSha, version, output }) {
  const record = await createBuildRecord({ artifactDirectory, commitSha, version })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

async function main() {
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string' },
      'commit-sha': { type: 'string' },
      version: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  })
  for (const name of ['artifacts', 'commit-sha', 'version', 'output']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  const record = await writeBuildRecord({
    artifactDirectory: values.artifacts,
    commitSha: values['commit-sha'],
    version: values.version,
    output: values.output,
  })
  console.log(`Desktop build matrix complete: ${record.matrix.producedArtifactCount} artifacts at ${record.candidate.commitSha}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`desktop build record: ${error.message}`)
    process.exitCode = 1
  })
}
