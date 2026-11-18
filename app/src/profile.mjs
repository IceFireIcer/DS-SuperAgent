// The app's single DS-SuperAgent DSH profile.
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { composeEntries, initProfile, loadOptionalPatches, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles,
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

/** Product state stays separate from data created by previous product installs. */
export function profileHome(dataDir) {
  return join(dataDir, 'superagent')
}

/** Check the configured provider without loading plugins or evaluating user expressions. */
export function assertLocalBackupProfile(home) {
  const profile = loadProfileDirectory('dsh', resolveProfileDir(SUPERAGENT_PROFILE, home), INSTALL_ANCHOR)
  const layers = profile.layers.map(layer => layer.patches)
  const homeLayer = loadOptionalPatches('dsh', join(home, 'cordis.patch.yml')) ?? []
  const find = entries => entries.flatMap(entry => entry.group && Array.isArray(entry.config) ? find(entry.config) : [entry])
  const providers = entries => find(entries).filter(entry => entry.name === '@deepseek-ai/dsh-session-persistence-jsonl'
    || entry.name?.startsWith('ds-superagent/session-persistence'))
  const base = providers(composeEntries(layers.slice(0, 1)))[0]
  const configured = providers(composeEntries([...layers, profile.patches, homeLayer]))
    .filter(entry => entry.disabled !== true && entry.name === '@deepseek-ai/dsh-session-persistence-jsonl')
  const root = configured[0]?.config?.root
  const local = typeof root === 'string' && isAbsolute(root) ? resolve(root) === resolve(home, 'sessions')
    : base?.config?.root !== undefined && JSON.stringify(root) === JSON.stringify(base.config.root)
  const alternate = [...profile.patches, ...homeLayer].some(patch => patch.id === 'session-persistence-postgres'
    || patch.name?.startsWith('ds-superagent/session-persistence')
    || patch.insert?.some(entry => entry.name?.startsWith('ds-superagent/session-persistence')))
  if (profile.skippedBundles.length || configured.length !== 1 || !local || alternate) {
    throw Object.assign(new Error('The product Session store could not be verified for offline backup.'), { code: 'BACKUP_SESSION_STORE_MISMATCH' })
  }
}
