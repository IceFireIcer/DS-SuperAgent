import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH home to keep away from, resolved exactly as DSH resolves its own default. */
export function userDshHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  return resolve(value === '~' ? homedir() : /^~[\\/]/u.test(value) ? join(homedir(), value.slice(2)) : value)
}
