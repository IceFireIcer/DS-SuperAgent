import { randomUUID } from 'node:crypto'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'

export interface RoleModel { provider: string; model: string; effort?: string }
export interface RoleAppearance { shape?: string; color?: string; image?: string }
export interface RoleProfile { name: string; model: RoleModel; instructions: string; skills: string[]; appearance?: RoleAppearance }
export interface RoleConfig { main?: RoleProfile; router: RoleProfile; worker: RoleProfile }
export interface StoredRoleConfig { revision: number; roles: RoleConfig; updatedAt: number }
export interface RoleConfigView { revision: number; roles: RoleConfig; updatedAt: number }
export interface RoleConfigUse {
  id: string
  instanceId: string
  sessionId: string
  role: 'main' | 'router' | 'worker'
  revision: number
  router: RoleModel
  worker: RoleModel
  main?: RoleModel
  createdAt: number
}
interface RoleConfigUseIndexMeta { sequence: number }
type RoleName = keyof RoleConfig
interface StoredRoleConfigRecord extends StoredRoleConfig { imageChunks?: Partial<Record<RoleName, number>> }

const configKey = 'role-config'
const historyKey = (revision: number) => `${JSON.stringify(['role-config-history'])}:${String(revision).padStart(10, '0')}`
const imageKey = (revision: number, role: RoleName, index: number) => JSON.stringify(['role-config-image', revision, role, index])
const imageChunkChars = 60_000
const maxImageBytes = 120_000
const usePrefix = (sessionId: string) => `${JSON.stringify(['role-config-use', sessionId])}:`
const recentUsePrefix = JSON.stringify(['role-config-use-recent'])
const recentUseMetaKey = JSON.stringify(['role-config-use-meta'])
const recentUseKey = (sequence: number) => `${recentUsePrefix}:${String(sequence).padStart(16, '0')}`
const recentUseLimit = 100
const allowedPlaceholders = new Set(['goal', 'constraints', 'evidence'])
const reservedSkills = new Set(['superagent-role', 'superagent-skills'])

function validImage(value: unknown): value is string {
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

export function parseRoleAppearance(value: unknown, code = 'INVALID_CONFIG'): RoleAppearance | undefined {
  if (value === undefined) return undefined
  const invalid = (message: string): never => { throw new CoreError(code, message) }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['shape', 'color', 'image'].includes(key))) {
    invalid('Appearance accepts shape, color and an embedded image only.')
  }
  const input = value as RoleAppearance
  const clean: RoleAppearance = {}
  if (input.shape !== undefined) {
    if (typeof input.shape !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(input.shape)) invalid('The appearance shape is invalid.')
    clean.shape = input.shape
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !/^(?:#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{0,31})$/u.test(input.color)) invalid('The appearance color is invalid.')
    clean.color = input.color
  }
  if (input.image !== undefined) {
    if (!validImage(input.image)) invalid('The appearance image must be a bounded PNG, JPEG, GIF or WebP data URL.')
    clean.image = input.image
  }
  return Object.keys(clean).length ? clean : undefined
}

function validateModel(model: RoleModel, label: string) {
  if (!model || Object.keys(model).some(key => !['provider', 'model', 'effort'].includes(key))) throw new CoreError('INVALID_CONFIG', `${label} model accepts provider, model and effort only.`)
  identifier(model.provider, `${label} provider`); identifier(model.model, `${label} model`)
  if (model.effort !== undefined) identifier(model.effort, `${label} effort`)
}

function validateProfile(profile: RoleProfile, label: string) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
    Object.keys(profile).some(key => !['name', 'model', 'instructions', 'skills', 'appearance'].includes(key))) {
    throw new CoreError('INVALID_CONFIG', `${label} accepts name, model, instructions, skills and appearance only.`)
  }
  if (typeof profile.name !== 'string' || !profile.name.trim() || Buffer.byteLength(profile.name) > 128) throw new CoreError('INVALID_CONFIG', `${label} needs a bounded nonempty name.`)
  validateModel(profile.model, label)
  if (typeof profile.instructions !== 'string' || Buffer.byteLength(profile.instructions) > 16384) throw new CoreError('INVALID_CONFIG', `${label} instructions exceed the 16384-byte budget.`)
  for (const match of profile.instructions.matchAll(/\{\{([^}]+)\}\}/gu)) {
    if (!allowedPlaceholders.has(match[1]!)) throw new CoreError('INVALID_CONFIG', `${label} instructions use an unknown placeholder.`)
  }
  if (label === 'Router' && profile.instructions.trim() && !profile.instructions.includes('{{goal}}')) {
    throw new CoreError('INVALID_CONFIG', 'The Router prompt must keep the {{goal}} placeholder.')
  }
  if (label === 'Worker' && profile.instructions.trim()
    && (!profile.instructions.includes('{{goal}}') || !profile.instructions.includes('{{constraints}}'))) {
    throw new CoreError('INVALID_CONFIG', 'The Worker prompt must keep the {{goal}} and {{constraints}} placeholders.')
  }
  if (!Array.isArray(profile.skills) || profile.skills.length > 20 || new Set(profile.skills).size !== profile.skills.length) {
    throw new CoreError('INVALID_CONFIG', `${label} needs at most 20 distinct skills.`)
  }
  for (const skill of profile.skills) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(skill)) throw new CoreError('INVALID_CONFIG', `${label} skill names must be lowercase identifiers.`)
    if (reservedSkills.has(skill)) throw new CoreError('INVALID_CONFIG', `${label} cannot override the reserved ${skill} skill.`)
  }
  parseRoleAppearance(profile.appearance)
}

export function validateRoleConfig(roles: RoleConfig) {
  if (!roles || Object.keys(roles).some(key => !['main', 'router', 'worker'].includes(key))) throw new CoreError('INVALID_CONFIG', 'Role configuration accepts main, router and worker only.')
  if (roles.main !== undefined) validateProfile(roles.main, 'Main')
  validateProfile(roles.router, 'Router'); validateProfile(roles.worker, 'Worker')
}

export class RoleConfigStore {
  constructor(
    private readonly storage: Storage,
    private readonly instanceId: string,
    private readonly defaults: RoleConfig,
    private readonly now: () => number = Date.now,
  ) { validateRoleConfig(defaults) }

  async ensure(): Promise<RoleConfigView> {
    const stored = await this.storage.transaction(this.instanceId, async transaction => {
      const record = await transaction.get<StoredRoleConfigRecord>('role-config', configKey)
      return record && this.view(transaction, record)
    })
    if (stored) return stored
    // Defaults are virtual until the first explicit save. Persisting them from a
    // session-less source engine would clobber another engine's model routes.
    const initial: StoredRoleConfig = { revision: 1, roles: structuredClone(this.defaults), updatedAt: this.now() }
    return initial
  }

  async currentView(): Promise<RoleConfigView> {
    return this.ensure()
  }

  async write(transaction: AsyncTx, expectedRevision: number, roles: RoleConfig): Promise<RoleConfigView> {
    validateRoleConfig(roles)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new CoreError('INVALID_CONFIG', 'Role configuration needs a positive expected revision.')
    const current = await transaction.get<StoredRoleConfig>('role-config', configKey)
    const baseRevision = current?.revision ?? 1
    if (baseRevision !== expectedRevision) throw new CoreError('CONFIG_REVISION_CONFLICT', 'The role configuration changed after this update was prepared.')
    const revision = baseRevision + 1
    const compact = structuredClone(roles)
    const imageChunks: StoredRoleConfigRecord['imageChunks'] = {}
    for (const role of ['main', 'router', 'worker'] as const) {
      const image = compact[role]?.appearance?.image
      if (image === undefined) continue
      const chunks = Math.ceil(image.length / imageChunkChars)
      for (let index = 0; index < chunks; index++) {
        await transaction.insert('role-preset-image', imageKey(revision, role, index),
          { data: image.slice(index * imageChunkChars, (index + 1) * imageChunkChars) })
      }
      imageChunks[role] = chunks
      delete compact[role]!.appearance!.image
    }
    const next: StoredRoleConfigRecord = { revision, roles: compact, updatedAt: this.now(),
      ...(Object.keys(imageChunks).length ? { imageChunks } : {}) }
    if (!await transaction.replace('role-config', configKey, next)) await transaction.insert('role-config', configKey, next)
    await transaction.insert('role-config-history', historyKey(next.revision), next)
    return { revision, roles: structuredClone(roles), updatedAt: next.updatedAt }
  }

  async recordUse(transaction: AsyncTx, request: { sessionId: string; role: 'main' | 'router' | 'worker'; revision: number; router: RoleModel; worker: RoleModel; main?: RoleModel }) {
    const use: RoleConfigUse = { id: `${usePrefix(request.sessionId)}${randomUUID()}`, instanceId: this.instanceId, ...request, createdAt: this.now() }
    await transaction.insert('role-config-use', use.id, use)
    const prior = await transaction.get<RoleConfigUseIndexMeta>('role-config-use-meta', recentUseMetaKey)
    const sequence = (prior?.sequence ?? 0) + 1
    await transaction.insert('role-config-use-recent', recentUseKey(sequence), use)
    const meta: RoleConfigUseIndexMeta = { sequence }
    if (!await transaction.replace('role-config-use-meta', recentUseMetaKey, meta)) await transaction.insert('role-config-use-meta', recentUseMetaKey, meta)
    if (sequence > recentUseLimit) await transaction.remove('role-config-use-recent', recentUseKey(sequence - recentUseLimit))
    return use
  }

  async uses(sessionId: string): Promise<RoleConfigUse[]> {
    identifier(sessionId, 'sessionId')
    return this.storage.transaction(this.instanceId, async transaction => {
      const items: RoleConfigUse[] = []
      let cursor = usePrefix(sessionId)
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<RoleConfigUse>('role-config-use', { limit: 100, after: cursor })
        items.push(...page.items.map(item => item.value).filter(use => use.sessionId === sessionId))
        if (!page.cursor || !page.cursor.startsWith(usePrefix(sessionId))) return items
        cursor = page.cursor
      }
      throw new CoreError('CONFIG_BUDGET', 'The Session role-config history exceeds its 1000-record budget.')
    })
  }

  async recentUses(limit = 50): Promise<RoleConfigUse[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_CONFIG', 'Role configuration use history needs a limit from 1 to 100.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const meta = await transaction.get<RoleConfigUseIndexMeta>('role-config-use-meta', recentUseMetaKey)
      if (!meta?.sequence) return []
      const first = Math.max(1, meta.sequence - limit + 1)
      const page = await transaction.scan<RoleConfigUse>('role-config-use-recent', { limit,
        after: recentUseKey(first - 1) })
      return page.items.map(item => item.value).reverse()
    })
  }

  async atRevision(revision: number): Promise<RoleConfigView | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new CoreError('INVALID_CONFIG', 'A role configuration revision must be a positive integer.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const stored = await transaction.get<StoredRoleConfigRecord>('role-config-history', historyKey(revision))
      return stored ? this.view(transaction, stored) : undefined
    })
  }

  async history(limit = 20): Promise<StoredRoleConfig[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_CONFIG', 'Role configuration history needs a limit from 1 to 100.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const pages: StoredRoleConfigRecord[] = []
      let cursor: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<StoredRoleConfigRecord>('role-config-history', { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) })
        pages.push(...page.items.map(item => item.value))
        if (!page.cursor) break
        cursor = page.cursor
        if (pageCount === 9) throw new CoreError('CONFIG_BUDGET', 'The role configuration history exceeds its 1000-version budget.')
      }
      return Promise.all(pages.sort((left, right) => right.revision - left.revision).slice(0, limit)
        .map(record => this.view(transaction, record)))
    })
  }

  private async view(transaction: AsyncTx, stored: StoredRoleConfigRecord): Promise<RoleConfigView> {
    const roles = structuredClone(stored.roles)
    for (const role of ['main', 'router', 'worker'] as const) {
      const chunks = stored.imageChunks?.[role] ?? 0
      if (!chunks) continue
      if (!roles[role] || chunks > Math.ceil((Math.ceil(maxImageBytes * 4 / 3) + 64) / imageChunkChars)) {
        throw new CoreError('CONFIG_UNAVAILABLE', 'A stored role image is incomplete.')
      }
      let image = ''
      for (let index = 0; index < chunks; index++) {
        const part = await transaction.get<{ data: string }>('role-preset-image', imageKey(stored.revision, role, index))
        if (!part || typeof part.data !== 'string') throw new CoreError('CONFIG_UNAVAILABLE', 'A stored role image is incomplete.')
        image += part.data
      }
      if (!validImage(image)) throw new CoreError('CONFIG_UNAVAILABLE', 'A stored role image is invalid.')
      roles[role].appearance = { ...roles[role].appearance, image }
    }
    return { revision: stored.revision, roles, updatedAt: stored.updatedAt }
  }
}
