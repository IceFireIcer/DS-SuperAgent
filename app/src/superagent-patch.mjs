// The Super-agent profile keeps the existing Main conversation and removes
// native Session surfaces that bypass its authorization.
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

export const SUPERAGENT_PATCH_NAME = 'superagent.patch.yml'

/**
 * @param {{ dir: string }} profile - the loaded profile
 * @param {boolean} enabled - whether this launch uses the Super-agent profile
 * @returns {string[]} the patchFiles addition for this launch
 */
export function reconcileSuperagentProfile(profile, enabled) {
  const file = join(dirname(profile.dir), SUPERAGENT_PATCH_NAME)
  if (!enabled) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, stringify([
    { id: 'session-log-download', disabled: true },
    { id: 'session-reference', disabled: true },
    { id: 'ui-reference', disabled: true },
  ]), 'utf8')
  return [file]
}
