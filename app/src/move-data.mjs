// Moving the app's data to another folder. The copy is put together in a folder beside the new
// one and takes its name only once it is whole, so a copy that stopped or failed leaves nothing
// that looks like data. The old folder stays as it was.
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { copyTree, real, within } from './copy-tree.mjs'

const LEFT_BEHIND = [/^superagent[\\/]host\.lock(?:\.tmp)?$/u, /^bot[\\/]state\.lock$/u, /^\.import(-check)?-\d+$/u]
const MARK = '.ds-superagent-moving'

/** The folder that an update or uninstall replaces: on macOS the whole .app bundle. */
export function installFolder(exe, platform = process.platform) {
  if (platform === 'darwin') {
    for (let at = dirname(exe); dirname(at) !== at; at = dirname(at)) if (at.endsWith('.app')) return at
  }
  return dirname(exe)
}

/**
 * What keeps `to` from being the new data location, or undefined.
 * @param {{ from: string, to: string, workspace?: string, dshHome: string, program?: string }} places
 * @returns {'drive' | 'nested' | 'workspace' | 'dsh' | 'program' | 'notEmpty' | undefined}
 */
export function moveProblem(places) {
  const [from, to, dshHome] = [places.from, places.to, places.dshHome].map(real)
  const workspace = places.workspace === undefined ? undefined : real(places.workspace)
  const program = places.program === undefined ? undefined : real(places.program)
  if (dirname(to) === to) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (within(to, dshHome) || within(dshHome, to)) return 'dsh'
  if (program !== undefined && (within(to, program) || within(program, to))) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

function directoryIdentity(path) {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  return entry?.isDirectory() && !entry.isSymbolicLink() ? `${entry.dev}:${entry.ino}` : null
}

function sameDirectory(path, identity) {
  return identity !== null && real(path) === path && directoryIdentity(path) === identity
}

const changedLocation = () => new Error('The new data location changed during the move.')

async function removeCopy(path, parent, parentIdentity, identity, { marked = true } = {}) {
  if (!sameDirectory(parent, parentIdentity) || !sameDirectory(path, identity)) return
  if (marked && !lstatSync(join(path, MARK), { throwIfNoEntry: false })?.isFile()) return
  await rm(path, { recursive: true, force: true, maxRetries: 5 })
}

/**
 * Copy the data in `from` to `to`, an empty or new folder. The signal stops it between files.
 * @param {string} from @param {string} to @param {AbortSignal} [signal] @param {() => void} [commit]
 */
export async function copyData(from, to, signal, commit) {
  signal?.throwIfAborted()
  if (real(to) !== to) throw changedLocation()
  const parent = dirname(to)
  await mkdir(parent, { recursive: true })
  const parentIdentity = directoryIdentity(parent)
  const targetIdentity = directoryIdentity(to)
  const assertLocation = () => {
    if (!sameDirectory(parent, parentIdentity) || real(to) !== to) throw changedLocation()
  }
  assertLocation()
  const prefix = `.${basename(to)}.moving-`
  for (const name of await readdir(parent)) {
    if (!name.startsWith(prefix)) continue
    assertLocation()
    const previous = join(parent, name)
    await removeCopy(previous, parent, parentIdentity, directoryIdentity(previous))
  }
  assertLocation()
  const stage = await mkdtemp(join(parent, prefix))
  const stagedIdentity = directoryIdentity(stage)
  const assertStaging = () => {
    signal?.throwIfAborted()
    assertLocation()
    if (!sameDirectory(stage, stagedIdentity)) throw changedLocation()
  }
  let installed = false
  try {
    assertStaging()
    await writeFile(join(stage, MARK), '', { flag: 'wx' })
    await copyTree(from, stage, { as: to, leave: path => path === MARK || LEFT_BEHIND.some(pattern => pattern.test(path)),
      signal, beforeCopy: assertStaging })
    assertStaging()
    const target = await lstat(to).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    assertStaging()
    if (target) {
      if (!sameDirectory(to, targetIdentity)) throw changedLocation()
      await rmdir(to)
    } else if (targetIdentity !== null) {
      throw changedLocation()
    }
    assertStaging()
    if (lstatSync(to, { throwIfNoEntry: false })) throw changedLocation()
    await rename(stage, to)
    installed = true
    signal?.throwIfAborted()
    assertLocation()
    if (!sameDirectory(to, stagedIdentity)) throw changedLocation()
    commit?.()
  } catch (error) {
    await removeCopy(installed ? to : stage, parent, parentIdentity, stagedIdentity, { marked: installed })
    throw error
  }
  if (sameDirectory(parent, parentIdentity) && sameDirectory(to, stagedIdentity)) await rm(join(to, MARK), { force: true }).catch(() => {})
}
