import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isolationProblem } from './copy-tree.mjs'
import { userDshHomes } from './dsh-home.mjs'
import { installFolder } from './move-data.mjs'

export const PRODUCT_NAME = 'DS SuperAgent'
export const PRODUCT_SLUG = 'ds-superagent'
export const APP_ID = 'io.github.icefireicer.ds-superagent'
export const DATA_DIRECTORY = '.ds-superagent'
export const ARTIFACT_PREFIX = 'DS-SuperAgent'
export const REPOSITORY = 'IceFireIcer/DS-SuperAgent'

export function formerDataFolders(app) {
  const appData = app.getPath('appData')
  return [join(homedir(), '.ds-bot'), join(appData, 'DS Bot'), join(appData, 'DeepSeek Bot')]
}

export function ensureWritableFolder(folder) {
  mkdirSync(folder, { recursive: true })
  rmdirSync(mkdtempSync(join(folder, '.setup-')))
}

export function configureIdentity(app, { env = process.env, platform = process.platform } = {}) {
  const data = env.DS_SUPERAGENT_HOME
  const userData = env.DS_SUPERAGENT_SHELL_DATA || (data ? join(data, 'desktop') : join(app.getPath('appData'), PRODUCT_NAME))
  const program = app.isPackaged ? installFolder(app.getPath('exe'), platform) : undefined
  const formerData = formerDataFolders(app)
  if (!isAbsolute(userData) || isolationProblem(userData, undefined, { dshHomes: userDshHomes(env), program, formerData })) {
    throw new Error(`Choose an absolute desktop settings folder outside the program, DeepSeek Harness and former DS Bot data folders. Selected folder: ${userData}`)
  }
  try { ensureWritableFolder(userData) }
  catch { throw new Error(`Cannot write to the desktop settings folder at ${userData}. Restore write access and reopen ${PRODUCT_NAME}.`) }
  app.setName(PRODUCT_NAME)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  return userData
}
