// The app's single DS-SuperAgent DSH profile.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles,
  writeProfileManifest } from '@deepseek-ai/dsh-app-boot'

export const SUPERAGENT_PROFILE = 'ds-superagent'
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-voice-input-bundle', 'ds-superagent']

// Bundles that earlier builds put in this profile and that no current profile may load.
const LEGACY_BUNDLES = ['ds-bot', 'deepseek-bot-engine', 'dsbot-engine', 'ds-superagent-host', 'ds-superagent-ui']

// The app's own manifest is the installation: DSH imports plugins only from the installation's dependency
// graph, resolves bundles there first, and keeps the bundles it names as direct dependencies from removal.
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Put the app's bundles at the head of the single product profile and keep the user's after them.
 * initProfile writes the list only into a new profile, so a profile from an earlier build keeps its old list.
 */
export function claimBundles(dir, bundles = BUNDLES) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const next = [...bundles, ...listed.filter(name => !bundles.includes(name) && !LEGACY_BUNDLES.includes(name))]
  const updated = next.join('\n') !== listed.join('\n') ? writeProfileBundles(dir, manifest, next) : manifest
  let changed = updated !== manifest
  const cleaned = { ...updated }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (cleaned[field] === undefined) continue
    const entries = Object.entries(cleaned[field]).filter(([name]) => !LEGACY_BUNDLES.includes(name))
    if (entries.length === Object.keys(cleaned[field]).length) continue
    cleaned[field] = Object.fromEntries(entries)
    changed = true
  }
  if (changed) writeProfileManifest(dir, cleaned)
}

/** Create or update the one DS-SuperAgent profile under the current DSH_HOME and load it. */
export function loadAppProfile() {
  const dir = resolveProfileDir(SUPERAGENT_PROFILE)
  initProfile(dir, BUNDLES)
  claimBundles(dir)
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => BUNDLES.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}

/** Product state is always separate from the user's old DS Bot data. */
export function profileHome(dataDir) {
  return join(dataDir, 'superagent')
}
