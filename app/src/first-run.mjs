// Adapted and modified by DS SuperAgent from DS Bot v0.3.8 (Apache-2.0),
// app/src/first-run.mjs and place.mjs.
// The first start's data and workspace choices, plus the saved-location checks. The start window
// shows the default place and can replace it through the app's own picker; nothing here reads or
// writes the user's DSH home.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { isolationProblem } from './copy-tree.mjs'
import { userDshHomes } from './dsh-home.mjs'
import { installFolder } from './move-data.mjs'
import { freeSpace } from './place.mjs'
import { DATA_DIRECTORY, PRODUCT_NAME, ensureWritableFolder, formerDataFolders } from './product.mjs'
import { profileHome } from './profile.mjs'
import { langOf, t } from './start/text.mjs'

export const lang = () => langOf(app.getLocale())
export const tx = (key, vars) => t(lang(), key, vars)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')
const roomOf = bytes => (Number.isFinite(bytes) && bytes > 0 ? bytes : undefined)

const PICKER_LABELS = ['places', 'drives', 'home', 'desktop', 'documents', 'downloads', 'path', 'go', 'up',
  'newFolder', 'newName', 'create', 'name', 'cancel', 'chooseFolder', 'open', 'save', 'replace', 'loading']
const PICKER_LINES = ['empty', 'noFolders', 'more']
const PICKER_ERRORS = ['missing', 'drive', 'denied', 'notFolder', 'notFile', 'tooLong', 'unreadable', 'name',
  'exists', 'isFolder', 'replace']

export function pickerLabels() {
  return Object.fromEntries([
    ...PICKER_LABELS.map(key => [key, tx(`picker.${key}`)]),
    ...PICKER_LINES.map(key => [key, tx(`dialog.picker.${key}`)]),
    ...PICKER_ERRORS.map(key => [`error.${key}`, tx(`dialog.picker.${key}`)]),
  ])
}

export const programFolder = () => installFolder(app.getPath('exe'))

export const defaultPlaces = () => ({
  dataDir: join(homedir(), DATA_DIRECTORY),
  workspace: join(homedir(), PRODUCT_NAME),
})

export function placeProblem(_text, dataDir, workspace, { layout = true } = {}) {
  if (!isAbsolute(dataDir) || (workspace !== undefined && !isAbsolute(workspace))) {
    return tx('reason.place.permission', { path: dataDir })
  }
  const program = programFolder()
  const problem = isolationProblem(dataDir, workspace, {
    dshHomes: userDshHomes(),
    program: app.isPackaged ? program : undefined,
    formerData: formerDataFolders(app),
    layout,
  })
  const key = {
    dataInWorkspace: 'reason.place.workspace',
    workspaceInData: 'reason.place.workspace',
    inDsh: 'reason.place.dsh',
    inFormerData: 'reason.place.foreign',
    inProgram: 'reason.place.program',
  }[problem]
  return key === undefined ? undefined : tx(key, { path: problem === 'inProgram' ? program : dataDir })
}

/** Save the chosen places once they are accepted. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  const saved = readSaved(file)
  const kept = saved !== undefined && typeof saved.dataDir === 'string' && saved.dataDir === dataDir
    && roomOf(saved.freeAtStart) !== undefined
  const freeAtStart = kept ? saved.freeAtStart : roomOf(freeSpace(dataDir))
  writeFileSync(`${file}.tmp`, `${JSON.stringify({
    dataDir,
    ...(typeof workspace === 'string' ? { workspace } : {}),
    ...(freeAtStart === undefined ? {} : { freeAtStart }),
  }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

function readSaved(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The app's own places. A throwaway run never asks and never reads a saved location.
 * @returns {{ dataDir: string, workspace?: string, freeAtStart?: number }}
 */
export function chooseLocations() {
  const home = process.env.DS_SUPERAGENT_HOME
  if (home) return { dataDir: home, workspace: process.env.DS_SUPERAGENT_WORKSPACE || undefined }
  const file = locationsFile()
  const saved = readSaved(file)
  if (saved !== undefined && typeof saved.dataDir === 'string' && isAbsolute(saved.dataDir)) {
    return {
      dataDir: saved.dataDir,
      ...(typeof saved.workspace === 'string' && isAbsolute(saved.workspace) ? { workspace: saved.workspace } : {}),
      ...(roomOf(saved.freeAtStart) === undefined ? {} : { freeAtStart: saved.freeAtStart }),
      saved: true,
    }
  }
  const places = defaultPlaces()
  return places
}

/** Check a place before the app starts the Host or moves data into it. */
export function checkPlaces({ dataDir, workspace }, { saved = false } = {}) {
  const problem = placeProblem(tx, dataDir, workspace)
  if (problem !== undefined) return problem
  if (saved) {
    for (const path of [dataDir, profileHome(dataDir), workspace].filter(Boolean)) {
      if (!existsSync(path)) return Object.assign(
        new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT', path },
      )
    }
  }
  try {
    ensureWritableFolder(profileHome(dataDir))
    if (workspace !== undefined) ensureWritableFolder(workspace)
  } catch {
    return tx('reason.place.permission', { path: dataDir })
  }
  return undefined
}

/**
 * The app picker used by the start page's place line. A cancelled picker is undefined.
 * @param {string} from the folder the picker opens in
 * @param {AbortSignal} [signal]
 * @param {{ asking: (promise: Promise<unknown>) => Promise<unknown>, pick: (request: object) => Promise<unknown> }} [ui]
 */
export async function pickRoot(from, signal, ui) {
  if (ui === undefined) return undefined
  try {
    const picked = await ui.asking(ui.pick({ mode: 'folder', title: tx('dialog.pickRoot'),
      start: existsSync(from) ? from : dirname(from) }))
    if (signal?.aborted) return undefined
    return typeof picked === 'string' ? picked : undefined
  } catch {
    return undefined
  }
}

/** User-facing strings still used by the main process's non-start dialogs. */
export const localeText = table => (lang() === 'zh' || lang() === 'zh-TW' ? table.zh : table.en)
export const text = () => ({
  pickMove: tx('dialog.pickMove'),
  moveDrive: tx('dialog.move.drive'),
  moveNested: tx('dialog.move.nested'),
  moveWorkspace: tx('dialog.move.workspace'),
  moveNotEmpty: tx('dialog.move.notEmpty'),
  moveConfirm: to => tx('dialog.move.confirm', { to }),
  moveDetail: from => tx('dialog.move.detail', { from }),
  move: tx('btn.move'),
  cancel: tx('btn.cancel'),
  moving: lang() === 'zh' ? `正在复制 ${PRODUCT_NAME} 的数据…` : `Copying ${PRODUCT_NAME} data…`,
  starting: lang() === 'zh' ? `正在启动 ${PRODUCT_NAME}…` : `Starting ${PRODUCT_NAME}…`,
  moveInUse: tx('dialog.move.inUse'),
  moveFailed: message => tx('dialog.move.failed', { message }),
  quit: tx('btn.quit'),
  tryAgain: tx('btn.retry'),
  notStarted: tx('voice.failed'),
  inDsh: tx('dialog.move.inDsh', { home: userDshHomes().join(', ') }),
})
