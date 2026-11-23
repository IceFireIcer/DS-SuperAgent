// Copying a folder of the user's whole, with its links, for the first-run import and the data move.
import { existsSync, realpathSync } from 'node:fs'
import { cp, lstat, readlink, realpath, stat, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const within = (inner, outer) => {
  const path = relative(resolve(outer), resolve(inner))
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Whether two app folders may share the user's DSH data or the program folder, judged through
 * links and junctions rather than by their text.
 * @param {string} dataDir @param {string | undefined} workspace
 * @param {{ dshHomes?: string[], program?: string, formerData?: string[], layout?: boolean }} [places] `layout: false`
 *   keeps a saved data/workspace arrangement that an earlier version accepted
 * @returns {'dataInWorkspace' | 'workspaceInData' | 'inDsh' | 'inProgram' | 'inFormerData' | undefined}
 */
export function isolationProblem(dataDir, workspace, { dshHomes = [], program, formerData = [], layout = true } = {}) {
  const data = real(dataDir)
  const space = workspace === undefined ? undefined : real(workspace)
  if (layout) {
    if (space !== undefined && within(data, space)) return 'dataInWorkspace'
    if (space !== undefined && within(space, data)) return 'workspaceInData'
  }
  const dsh = dshHomes.map(real)
  const app = program === undefined ? undefined : real(program)
  const former = formerData.map(real)
  for (const path of [data, ...(space === undefined ? [] : [space])]) {
    if (dsh.some(root => within(path, root) || within(root, path))) return 'inDsh'
    if (app !== undefined && (within(path, app) || within(app, path))) return 'inProgram'
    if (former.some(root => within(path, root) || within(root, path))) return 'inFormerData'
  }
  return undefined
}

// The path as the file system has it: through links and junctions, from the deepest part that
// exists. A link can make a path that looks apart from a folder lead into it.
export function real(path) {
  const rest = []
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) return resolve(path)
    rest.unshift(basename(at))
    at = up
  }
  return join(realpathSync.native(at), ...rest)
}

// A link that leads inside the copied folder leads to the same place inside the copy: a relative
// one keeps its text, an absolute one is moved over. One that leads outside keeps leading
// there, as an absolute link. Windows gives a junction's target with \\?\, and makes only
// junctions, which hold absolute paths, without special rights.
async function relink(source, path, roots, to) {
  const text = (await readlink(source)).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '')
  const written = resolve(dirname(source), text)
  // Through another link the target can lead inside the copied folder too.
  const physical = await realpath(written).catch(() => written)
  const direct = roots.some(folder => within(written, folder))
  const target = direct ? written : physical
  const root = roots.find(folder => within(target, folder))
  const folder = (await stat(source).catch(() => undefined))?.isDirectory() === true
  const windows = process.platform === 'win32'
  const inside = root === undefined ? written : join(to, relative(root, target))
  await symlink(direct && !isAbsolute(text) && !(windows && folder) ? text : inside, path, folder ? (windows ? 'junction' : 'dir') : 'file')
}

/**
 * Copy the folder `from` into `into`, making its links again (fs.cp makes symbolic links, which
 * Windows refuses without special rights). With `skip`, an entry that cannot be read, such as a
 * junction to nothing, or a link that cannot be made again, is skipped and listed; otherwise it
 * fails the copy.
 * @param {string} from
 * @param {string} into
 * @param {{ force?: boolean, skip?: boolean, leave?: (path: string) => boolean, as?: string, signal?: AbortSignal, beforeCopy?: () => void }} [options]
 *   force: false keeps what is there already; leave: relative paths not to copy; as: where the
 *   copy will end up, when `into` is a staging folder that takes that name later
 * @returns {Promise<string[]>} the relative paths that were skipped
 */
export async function copyTree(from, into, { force = true, skip = false, leave = () => false, as = into, signal, beforeCopy } = {}) {
  // The folder can itself be a link; its contents are what is copied.
  const origin = real(from)
  const links = []
  const skipped = []
  await cp(origin, into, {
    recursive: true,
    force,
    filter: async (source) => {
      signal?.throwIfAborted()
      beforeCopy?.()
      const path = relative(origin, source)
      if (path !== '' && leave(path)) return false
      if (path === '') return true
      const info = await lstat(source).catch((error) => { if (!skip) throw error })
      beforeCopy?.()
      if (info === undefined) skipped.push(path)
      else if (info.isSymbolicLink()) links.push(path)
      return info?.isSymbolicLink() === false
    },
  })
  const roots = [...new Set([resolve(from), origin])]
  for (const path of links) {
    signal?.throwIfAborted()
    beforeCopy?.()
    const at = join(into, path)
    if (!force && await lstat(at).then(() => true, () => false)) continue
    await relink(join(origin, path), at, roots, resolve(as)).catch((error) => {
      if (!skip) throw error
      skipped.push(path)
    })
  }
  return skipped
}
