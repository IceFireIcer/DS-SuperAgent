// The first start: where the app keeps its SuperAgent data and workspace. The answers are
// kept in the app's own data.
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { isolationProblem } from './copy-tree.mjs'
import { userDshHomes } from './dsh-home.mjs'
import { installFolder } from './move-data.mjs'
import { DATA_DIRECTORY, PRODUCT_NAME, ensureWritableFolder, formerDataFolders } from './product.mjs'
import { profileHome } from './profile.mjs'

const TEXT = {
  en: {
    welcome: `Welcome to ${PRODUCT_NAME}`,
    places: (data, workspace) => `Data: ${data}\nWorkspace: ${workspace}`,
    absoluteFolder: 'Choose an absolute path for each folder.',
    folderMissing: folder => `${folder} is missing. Restore the location, choose another folder, or select Start to create it.`,
    folderUnavailable: folder => `Cannot write to ${folder}. Restore write access or choose another folder.`,
    locationsUnavailable: folder => `Cannot save locations in ${folder}. Restore write access and reopen the app.`,
    start: 'Start', change: 'Change…',
    pickData: `Folder for ${PRODUCT_NAME} data`, pickWorkspace: 'Folder for Main and Worker files',
    dataInWorkspace: 'The data folder cannot be inside the workspace.',
    workspaceInData: 'The workspace cannot be inside the data folder.',
    inDsh: 'Choose a folder outside personal DeepSeek Harness data.',
    inFormerData: 'Choose a folder outside data from previous product installs.',
    inProgram: 'Choose a folder outside the program folder: uninstalling removes it.',
    pickMove: `New folder for ${PRODUCT_NAME} data`,
    moveDrive: 'Choose a folder, not a whole drive.',
    moveNested: 'Choose a folder outside the current data folder.',
    moveWorkspace: 'The data folder and workspace cannot hold each other.',
    moveNotEmpty: 'Choose an empty folder or a new one.',
    moveConfirm: to => `Move ${PRODUCT_NAME}'s data to ${to}?`,
    moveDetail: from => `${PRODUCT_NAME} copies its data there and starts again. ${from} stays as it is; you can delete it once everything works.`,
    move: 'Move and restart', cancel: 'Cancel',
    moving: `Copying ${PRODUCT_NAME}'s data…`,
    starting: `Starting ${PRODUCT_NAME}…`,
    moveInUse: 'Another DeepSeek Harness is using this data, so it was not moved. Close it, then try again.',
    moveFailed: message => `The data could not be copied: ${message}\n\n${PRODUCT_NAME} goes on with its data where it was.`,
    quit: 'Quit', tryAgain: 'Try again',
    notStarted: `${PRODUCT_NAME} could not start.`,
  },
  zh: {
    welcome: `欢迎使用 ${PRODUCT_NAME}`,
    places: (data, workspace) => `数据：${data}\n工作区：${workspace}`,
    absoluteFolder: '请为每个文件夹选择绝对路径。',
    folderMissing: folder => `${folder} 不存在。请恢复原位置、选择其他文件夹，或点击「开始使用」新建。`,
    folderUnavailable: folder => `无法写入 ${folder}。请恢复写入权限或选择其他文件夹。`,
    locationsUnavailable: folder => `无法在 ${folder} 保存位置设置。请恢复写入权限，然后重新打开应用。`,
    start: '开始使用', change: '更改位置…',
    pickData: `选择 ${PRODUCT_NAME} 的数据文件夹`, pickWorkspace: '选择存放 Main 与 Worker 文件的文件夹',
    dataInWorkspace: '数据文件夹不能放在工作区里面。',
    workspaceInData: '工作区不能放在数据文件夹里面。',
    inDsh: '请选择个人 DeepSeek Harness 数据以外的文件夹。',
    inFormerData: '请选择此前产品安装数据以外的文件夹。',
    inProgram: '请选择程序文件夹以外的位置：卸载时会删掉程序文件夹。',
    pickMove: `选择 ${PRODUCT_NAME} 数据的新文件夹`,
    moveDrive: '请选择一个文件夹，不要选整个磁盘。',
    moveNested: '请选择现在的数据文件夹以外的位置。',
    moveWorkspace: '数据文件夹和工作区不能互相包含。',
    moveNotEmpty: '请选择一个空文件夹，或者新建一个。',
    moveConfirm: to => `把 ${PRODUCT_NAME} 的数据移到 ${to} 吗？`,
    moveDetail: from => `${PRODUCT_NAME} 会把数据复制过去，然后重新启动。${from} 会原样保留，确认一切正常后可以自己删掉。`,
    move: '移动并重启', cancel: '取消',
    moving: `正在复制 ${PRODUCT_NAME} 的数据…`,
    starting: `正在启动 ${PRODUCT_NAME}…`,
    moveInUse: '另一个 DeepSeek Harness 正在使用这份数据，所以没有移动。请先关掉它，再重试。',
    moveFailed: message => `数据没有复制成功：${message}\n\n${PRODUCT_NAME} 会继续使用原来位置的数据。`,
    quit: '退出', tryAgain: '重试',
    notStarted: `${PRODUCT_NAME} 没能启动。`,
  },
}
export const localeText = table => (app.getLocale().toLowerCase().startsWith('zh') ? table.zh : table.en)
export const text = () => localeText(TEXT)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

// A quit request while a first-run dialog is open stops the first run right after that dialog.
class Quit extends Error {}

async function ask(options, signal) {
  const { response } = await dialog.showMessageBox({ title: PRODUCT_NAME, noLink: true, ...options, signal })
  // A quit that arrived while a synchronous macOS box was open gets to run first.
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return response
}

async function pick(title, current, signal) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, defaultPath: existsSync(current) ? current : dirname(current), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return canceled ? current : filePaths[0]
}

export const programFolder = () => installFolder(app.getPath('exe'))

export function placeProblem(t, dataDir, workspace, { layout = true } = {}) {
  if (!isAbsolute(dataDir) || (workspace !== undefined && !isAbsolute(workspace))) return t.absoluteFolder
  const program = programFolder()
  const problem = isolationProblem(dataDir, workspace, {
    dshHomes: userDshHomes(),
    program: app.isPackaged ? program : undefined,
    formerData: formerDataFolders(app),
    layout,
  })
  if (problem === 'dataInWorkspace') return t.dataInWorkspace
  if (problem === 'workspaceInData') return t.workspaceInData
  if (problem === 'inDsh') return t.inDsh
  if (problem === 'inFormerData') return t.inFormerData
  if (problem === 'inProgram') return t.inProgram
  return undefined
}

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

function checkLocations(t, dataDir, workspace, { saved = false } = {}) {
  let folder = dataDir
  try {
    const layoutProblem = placeProblem(t, dataDir, workspace, { layout: !saved })
    if (layoutProblem !== undefined) return layoutProblem
    const folders = [profileHome(dataDir), workspace]
    for (folder of folders) {
      const problem = placeProblem(t, folder)
      if (problem !== undefined) return problem
      if (saved && !existsSync(folder)) return t.folderMissing(folder)
    }
    for (folder of folders) ensureWritableFolder(folder)
  } catch { return t.folderUnavailable(folder) }
  return undefined
}

/**
 * Where the app keeps its data and the Bots' files, asked at the first start.
 * A run on throwaway folders (DS_SUPERAGENT_HOME, for development and tests) asks nothing and copies nothing.
 * @returns {Promise<{ dataDir: string, workspace?: string, quit?: true }>}
 */
export async function chooseLocations(signal) {
  const home = process.env.DS_SUPERAGENT_HOME
  if (home) return { dataDir: home, workspace: process.env.DS_SUPERAGENT_WORKSPACE || undefined }
  const t = text()
  const file = locationsFile()
  let dataDir = join(homedir(), DATA_DIRECTORY)
  let workspace = join(homedir(), PRODUCT_NAME)
  let problem
  if (existsSync(file)) {
    let saved
    try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    if (typeof saved?.dataDir === 'string' && isAbsolute(saved.dataDir)
      && typeof saved.workspace === 'string' && isAbsolute(saved.workspace)) {
      dataDir = saved.dataDir
      workspace = saved.workspace
      problem = checkLocations(t, dataDir, workspace, { saved: true })
      if (problem === undefined) return { dataDir, workspace }
    }
  }
  try {
    for (;;) {
      const choice = await ask({ type: problem ? 'warning' : 'info', message: problem ?? t.welcome, detail: t.places(dataDir, workspace),
        buttons: [t.start, t.change, t.quit], defaultId: problem ? 1 : 0, cancelId: 2 }, signal)
      if (choice === 2) return { quit: true }
      if (choice === 1) {
        dataDir = await pick(t.pickData, dataDir, signal)
        workspace = await pick(t.pickWorkspace, workspace, signal)
        problem = undefined
        continue
      }
      problem = checkLocations(t, dataDir, workspace)
      if (problem !== undefined) continue
      try { saveLocations({ dataDir, workspace }) }
      catch { throw new Error(t.locationsUnavailable(dirname(file))) }
      return { dataDir, workspace }
    }
  } catch (error) {
    if (error instanceof Quit) return { quit: true }
    throw error
  }
}
