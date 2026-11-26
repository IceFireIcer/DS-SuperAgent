import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const files = [
  'superagent/package.json',
  'app/package.json',
  'superagent/package-lock.json',
  'app/package-lock.json',
]

export function setReleaseVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Invalid release version: ${version}`)
  const changed = []
  for (const relative of files) {
    const path = join(root, relative)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const before = JSON.stringify(parsed)
    parsed.version = version
    if (parsed.packages?.['']) parsed.packages[''].version = version
    if (parsed.packages?.['node_modules/ds-superagent']) parsed.packages['node_modules/ds-superagent'].version = version
    if (JSON.stringify(parsed) === before) continue
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
    changed.push(relative)
  }
  return changed
}

function main() {
  const version = process.argv[2]
  if (!version) throw new Error('Usage: node scripts/set-release-version.mjs <version>')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const changed = setReleaseVersion(root, version)
  console.log(`Release version ${version}: ${changed.length === 0 ? 'already set' : changed.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
