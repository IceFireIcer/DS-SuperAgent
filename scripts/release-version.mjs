import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const INITIAL_VERSION = '1.0.0'
export const SCALE = Object.freeze({
  majorFiles: 250,
  majorLines: 12_000,
  minorFiles: 30,
  minorLines: 2_000,
})

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(String(value).trim())
  if (!match) throw new Error(`Invalid semantic version: ${value}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function bumpVersion(value, kind) {
  const version = parseVersion(value)
  if (kind === 'major') return `${version.major + 1}.0.0`
  if (kind === 'minor') return `${version.major}.${version.minor + 1}.0`
  if (kind === 'patch') return `${version.major}.${version.minor}.${version.patch + 1}`
  throw new Error(`Unknown version bump: ${kind}`)
}

export function classifyScale({ breaking = false, feature = false, files = 0, lines = 0 }) {
  if (breaking || files >= SCALE.majorFiles || lines >= SCALE.majorLines) return 'major'
  if (feature || files >= SCALE.minorFiles || lines >= SCALE.minorLines) return 'minor'
  return 'patch'
}

export function nextVersion({ current, hasTag, bump = 'auto', commits = 0,
  breaking = false, feature = false, files = 0, lines = 0 }) {
  parseVersion(current)
  if (!hasTag) return { release: true, version: INITIAL_VERSION, bump: 'initial', files, lines }
  if (commits === 0) return { release: false, version: current, bump: 'none', files, lines }
  if (!['auto', 'patch', 'minor', 'major'].includes(bump)) throw new Error(`Unknown version policy: ${bump}`)
  const kind = bump === 'auto' ? classifyScale({ breaking, feature, files, lines }) : bump
  return { release: true, version: bumpVersion(current, kind), bump: kind, files, lines }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

function changeFacts(root, from) {
  if (!from) return { commits: Number(git(root, ['rev-list', '--count', 'HEAD'])), files: 0, lines: 0, breaking: false, feature: false }
  const commits = Number(git(root, ['rev-list', '--count', `${from}..HEAD`]))
  if (commits === 0) return { commits, files: 0, lines: 0, breaking: false, feature: false }
  const log = git(root, ['log', '--format=%s%n%b', `${from}..HEAD`])
  const numstat = git(root, ['diff', '--numstat', `${from}..HEAD`])
  let files = 0
  let lines = 0
  for (const line of numstat.split(/\r?\n/u).filter(Boolean)) {
    const [added, removed] = line.split('\t')
    files += 1
    lines += (added === '-' ? 0 : Number(added)) + (removed === '-' ? 0 : Number(removed))
  }
  return {
    commits,
    files,
    lines,
    breaking: /(?:^|\n)BREAKING[ -]CHANGE:/u.test(log) || /^[a-z]+(?:\([^)]*\))?!:/mu.test(log),
    feature: /^feat(?:\([^)]*\))?:/mu.test(log),
  }
}

function main() {
  const arguments_ = process.argv.slice(2)
  const value = name => {
    const index = arguments_.indexOf(`--${name}`)
    return index >= 0 ? arguments_[index + 1] : undefined
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const current = JSON.parse(readFileSync(join(root, 'superagent', 'package.json'), 'utf8')).version
  const from = value('from') || undefined
  const bump = value('bump') ?? 'auto'
  const facts = changeFacts(root, from)
  const result = nextVersion({ current, hasTag: Boolean(from), bump, ...facts })
  console.log(JSON.stringify({ current, from: from ?? null, ...facts, ...result }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
