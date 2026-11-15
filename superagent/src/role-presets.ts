import { createHash } from 'node:crypto'
import { validateRoleConfig, type RoleConfig, type RoleConfigView, type RoleModel, type RoleProfile } from './config.js'
import { CoreError, identifier } from './model.js'

export type PresetRole = 'main' | 'router' | 'worker'
export interface PresetAppearance { shape?: string; color?: string; image?: string }
export interface RolePreset extends RoleProfile { id: string; appearance?: PresetAppearance }
export interface LegacyPresetSource { identity: string; botId: string; digest: string }
export interface LegacyPresetPreview {
  key: string
  source: LegacyPresetSource
  targetRole: PresetRole
  draft: Omit<RoleProfile, 'model'> & { model?: RoleModel; appearance?: PresetAppearance }
  fields: Array<{ from: string; to: string }>
  ignored: string[]
  issues: Array<{ field: string; reason: string }>
}
export interface LegacyPresetCopy { sourceIdentity: string; sourceBotId: string; state: unknown; targetRole: PresetRole }
export interface LegacyPresetDecision extends Pick<LegacyPresetPreview, 'key' | 'source' | 'targetRole'> {
  status: 'selected' | 'skipped'
  fingerprint: string
  preset?: RolePreset
}

const baseProfile: RoleProfile = { name: 'Unconfigured', model: { provider: 'unconfigured', model: 'unconfigured' }, instructions: '', skills: [] }
const maxImageBytes = 120_000
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalid(message: string): never { throw new CoreError('INVALID_PRESET', message) }

function role(value: unknown): asserts value is PresetRole {
  if (value !== 'main' && value !== 'router' && value !== 'worker') invalid('The target must be Main, Router or Worker.')
}

function safeId(value: unknown, label: string) {
  try { identifier(value, label) }
  catch { invalid(`${label} must be a bounded nonempty identifier.`) }
}

function validLegacyName(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128) return false
  try { identifier(value, 'name'); return true }
  catch { return false }
}

function image(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(maxImageBytes * 4 / 3) + 64) return false
  const matched = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value)
  if (!matched) return false
  const bytes = Buffer.from(matched[2]!, 'base64')
  if (!bytes.length || bytes.length > maxImageBytes || bytes.toString('base64') !== matched[2]) return false
  if (matched[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (matched[1] === 'jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (matched[1] === 'gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function appearance(value: unknown): PresetAppearance | undefined {
  if (value === undefined) return undefined
  if (!object(value)) invalid('Appearance accepts shape, color and an embedded image only.')
  if (Object.keys(value).some(key => !['shape', 'color', 'image'].includes(key))) invalid('Appearance accepts shape, color and an embedded image only.')
  const clean: PresetAppearance = {}
  if (value.shape !== undefined) {
    if (typeof value.shape !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.shape)) invalid('The appearance shape is invalid.')
    clean.shape = value.shape
  }
  if (value.color !== undefined) {
    if (typeof value.color !== 'string' || !/^(?:#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{0,31})$/u.test(value.color)) invalid('The appearance color is invalid.')
    clean.color = value.color
  }
  if (value.image !== undefined) {
    if (!image(value.image)) invalid('The appearance image must be a bounded PNG, JPEG, GIF or WebP data URL.')
    clean.image = value.image
  }
  return Object.keys(clean).length ? clean : undefined
}

/** Pure preset data. It carries no Bot identity, resource grant or execution permission. */
export function createRolePreset(input: unknown): RolePreset {
  if (!object(input)) invalid('A role preset accepts id, name, model, instructions, skills and appearance only.')
  if (Object.keys(input).some(key => !['id', 'name', 'model', 'instructions', 'skills', 'appearance'].includes(key))) invalid('A role preset accepts id, name, model, instructions, skills and appearance only.')
  safeId(input.id, 'presetId')
  if (typeof input.id !== 'string' || typeof input.name !== 'string' || typeof input.instructions !== 'string' ||
    !Array.isArray(input.skills) || !input.skills.every(skill => typeof skill === 'string')) invalid('A role preset needs a name, model, instructions and skills.')
  safeId(input.name, 'presetName')
  const rawModel = input.model
  if (!object(rawModel) || typeof rawModel.provider !== 'string' || typeof rawModel.model !== 'string' ||
    rawModel.effort !== undefined && typeof rawModel.effort !== 'string') invalid('A role preset needs a provider/model route.')
  const model: RoleModel = { provider: rawModel.provider, model: rawModel.model,
    ...(rawModel.effort === undefined ? {} : { effort: rawModel.effort }) }
  if (Object.keys(rawModel).some(key => !['provider', 'model', 'effort'].includes(key))) {
    throw new CoreError('INVALID_CONFIG', 'A preset model accepts provider, model and effort only.')
  }
  const profile: RoleProfile = { name: input.name, model, instructions: input.instructions, skills: [...input.skills] }
  validateRoleConfig({ main: profile, router: baseProfile, worker: baseProfile })
  const look = appearance(input.appearance)
  return { id: input.id, ...structuredClone(profile), ...(look === undefined ? {} : { appearance: look }) }
}

function legacyModel(bot: Record<string, unknown>): RoleModel | undefined {
  if (typeof bot.model !== 'string') return undefined
  const slash = bot.model.indexOf('/')
  if (slash < 1 || slash === bot.model.length - 1) return undefined
  const model: RoleModel = { provider: bot.model.slice(0, slash), model: bot.model.slice(slash + 1) }
  if (bot.effort !== undefined) {
    if (typeof bot.effort !== 'string') return undefined
    model.effort = bot.effort
  }
  try { validateRoleConfig({ main: { ...baseProfile, model }, router: baseProfile, worker: baseProfile }) }
  catch { return undefined }
  return model
}

/** The caller supplies a copy of bot/state.json. This function never opens the old home or runs its code. */
export function previewLegacyRolePreset(input: LegacyPresetCopy): LegacyPresetPreview {
  if (!input || !object(input)) invalid('An explicit legacy copy is required.')
  safeId(input.sourceIdentity, 'sourceIdentity'); safeId(input.sourceBotId, 'sourceBotId'); role(input.targetRole)
  const state = input.state
  if (!object(state) || !object(state.bots) || !Object.hasOwn(state.bots, input.sourceBotId)) {
    throw new CoreError('INVALID_PRESET_SOURCE', 'The copy has no selected Bot configuration.')
  }
  const bot = state.bots[input.sourceBotId]
  if (!object(bot)) throw new CoreError('INVALID_PRESET_SOURCE', 'The copy has no selected Bot configuration.')
  const issues: LegacyPresetPreview['issues'] = []
  const fields: LegacyPresetPreview['fields'] = []
  const map = (from: string, to: string) => { if (Object.hasOwn(bot, from)) fields.push({ from: `bot.${from}`, to: `preset.${to}` }) }
  map('name', 'name'); map('model', 'model'); map('effort', 'model.effort'); map('instructions', 'instructions')
  map('skills', 'skills'); map('color', 'appearance'); map('avatar', 'appearance')

  const name = validLegacyName(bot.name) ? bot.name : input.sourceBotId
  if (name !== bot.name) issues.push({ field: 'name', reason: 'The old name is missing or invalid; review the fallback.' })
  const model = legacyModel(bot)
  if (!model) issues.push({ field: 'model', reason: 'Choose a provider/model route before creating this preset.' })
  const instructions = typeof bot.instructions === 'string' && Buffer.byteLength(bot.instructions) <= 16384 ? bot.instructions : ''
  if (instructions !== bot.instructions && bot.instructions !== undefined) issues.push({ field: 'instructions', reason: 'The old instructions exceed the supported format or budget.' })
  let skills: string[] = []
  if (bot.skills !== undefined) {
    if (Array.isArray(bot.skills) && bot.skills.length <= 20 && bot.skills.every(skill => typeof skill === 'string')) {
      try {
        validateRoleConfig({ main: { ...baseProfile, skills: bot.skills }, router: baseProfile, worker: baseProfile })
        skills = [...bot.skills]
      } catch { issues.push({ field: 'skills', reason: 'Review the old skill names; none were selected.' }) }
    } else issues.push({ field: 'skills', reason: 'Review the old skill names; none were selected.' })
  }
  const look: PresetAppearance = {}
  const addAppearance = (field: keyof PresetAppearance, value: unknown) => {
    if (value === undefined) return
    try { Object.assign(look, appearance({ [field]: value })) }
    catch { issues.push({ field: 'appearance', reason: `The old ${field} is invalid; choose a new one.` }) }
  }
  addAppearance('color', bot.color)
  if (bot.avatar !== undefined) {
    if (object(bot.avatar)) {
      addAppearance('shape', bot.avatar.shape)
      addAppearance('image', bot.avatar.image)
    } else issues.push({ field: 'appearance', reason: 'The old appearance is invalid; choose a new one.' })
  }

  const draft: LegacyPresetPreview['draft'] = { name, ...(model === undefined ? {} : { model }), instructions, skills,
    ...(Object.keys(look).length ? { appearance: look } : {}) }
  if (model !== undefined) {
    const profile: RoleProfile = { name, model, instructions, skills }
    try { validateRoleConfig({ main: baseProfile, router: baseProfile, worker: baseProfile, [input.targetRole]: profile }) }
    catch { issues.push({ field: 'targetRole', reason: 'Review the prompt requirements for the selected role.' }) }
  }
  const ignored = [
    ...(Object.hasOwn(state, 'mainBotIds') ? ['state.mainBotIds'] : []),
    ...['main', 'admin', 'permissions', 'capabilities', 'workDir', 'createdBy', 'sessionId', 'segments', 'grants']
      .filter(key => Object.hasOwn(bot, key)).map(key => `bot.${key}`),
    ...(Object.keys(bot).some(key => !['id', 'name', 'model', 'effort', 'instructions', 'skills', 'color', 'avatar',
      'main', 'admin', 'permissions', 'capabilities', 'workDir', 'createdBy', 'sessionId', 'segments', 'grants'].includes(key)) ? ['bot.otherFields'] : []),
  ]
  const source: LegacyPresetSource = { identity: input.sourceIdentity, botId: input.sourceBotId,
    digest: hash([bot.name, bot.model, bot.effort, bot.instructions, bot.skills, bot.color, bot.avatar]) }
  return { key: JSON.stringify(['legacy-preset', source.identity, source.botId, input.targetRole]), source,
    targetRole: input.targetRole, draft, fields, ignored, issues }
}

/** A reviewed choice is a pure fact for a future transactional storage command. */
export function prepareLegacyPresetDecision(input: LegacyPresetCopy & { expectedDigest: string; decision: 'select' | 'skip'; preset?: unknown }): LegacyPresetDecision {
  const preview = previewLegacyRolePreset(input)
  if (input.expectedDigest !== preview.source.digest) throw new CoreError('PRESET_SOURCE_CONFLICT', 'The legacy copy changed after preview; review it again.')
  if (input.decision !== 'select' && input.decision !== 'skip') invalid('Choose select or skip explicitly.')
  if (input.decision === 'skip') {
    if (input.preset !== undefined) invalid('A skipped import cannot carry a preset.')
    return { key: preview.key, source: preview.source, targetRole: preview.targetRole, status: 'skipped',
      fingerprint: hash([preview.key, preview.source.digest, 'skipped']) }
  }
  const preset = createRolePreset(input.preset)
  return { key: preview.key, source: preview.source, targetRole: preview.targetRole, status: 'selected', preset,
    fingerprint: hash([preview.key, preview.source.digest, 'selected', preset]) }
}

/** Submit the returned command to the trusted Engine updateRoleConfig path for CAS and authorization. */
export function prepareRolePresetApplication(input: { commandId: string; current: RoleConfigView; targetRole: PresetRole; preset: unknown }):
  { commandId: string; expectedRevision: number; roles: RoleConfig } {
  if (!input || !object(input) || !input.current || !Number.isSafeInteger(input.current.revision) || input.current.revision < 1) {
    invalid('A positive current role configuration revision is required.')
  }
  safeId(input.commandId, 'commandId'); role(input.targetRole)
  validateRoleConfig(input.current.roles)
  const { name, model, instructions, skills } = createRolePreset(input.preset)
  const roles: RoleConfig = { ...structuredClone(input.current.roles), [input.targetRole]: { name, model, instructions, skills } }
  validateRoleConfig(roles)
  return { commandId: input.commandId, expectedRevision: input.current.revision, roles }
}
