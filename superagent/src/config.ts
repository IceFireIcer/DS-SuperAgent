import { randomUUID } from 'node:crypto'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'

export interface RoleModel { provider: string; model: string; effort?: string }
export interface RoleProfile { name: string; model: RoleModel; instructions: string; skills: string[] }
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

const configKey = 'role-config'
const historyKey = (revision: number) => `${JSON.stringify(['role-config-history'])}:${String(revision).padStart(10, '0')}`
const usePrefix = (sessionId: string) => `${JSON.stringify(['role-config-use', sessionId])}:`
const recentUsePrefix = JSON.stringify(['role-config-use-recent'])
const recentUseMetaKey = JSON.stringify(['role-config-use-meta'])
const recentUseKey = (sequence: number) => `${recentUsePrefix}:${String(sequence).padStart(16, '0')}`
const recentUseLimit = 100
const allowedPlaceholders = new Set(['goal', 'constraints', 'evidence'])
const reservedSkills = new Set(['superagent-role', 'superagent-skills'])

function validateModel(model: RoleModel, label: string) {
  if (!model || Object.keys(model).some(key => !['provider', 'model', 'effort'].includes(key))) throw new CoreError('INVALID_CONFIG', `${label} model accepts provider, model and effort only.`)
  identifier(model.provider, `${label} provider`); identifier(model.model, `${label} model`)
  if (model.effort !== undefined) identifier(model.effort, `${label} effort`)
}

function validateProfile(profile: RoleProfile, label: string) {
  if (!profile || Object.keys(profile).some(key => !['name', 'model', 'instructions', 'skills'].includes(key))) {
    throw new CoreError('INVALID_CONFIG', `${label} accepts name, model, instructions and skills only.`)
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
}

export function validateRoleConfig(roles: RoleConfig) {
  if (!roles || Object.keys(roles).some(key => !['main', 'router', 'worker'].includes(key))) throw new CoreError('INVALID_CONFIG', 'Role configuration accepts main, router and worker only.')
  if (roles.main !== undefined) validateProfile(roles.main, 'Main')
  validateProfile(roles.router, 'Router'); validateProfile(roles.worker, 'Worker')
}

export class RoleConfigStore {
  private current: StoredRoleConfig | undefined
  constructor(
    private readonly storage: Storage,
    private readonly instanceId: string,
    private readonly defaults: RoleConfig,
    private readonly now: () => number = Date.now,
  ) { validateRoleConfig(defaults) }

  async ensure(): Promise<RoleConfigView> {
    const stored = await this.storage.transaction(this.instanceId, transaction => transaction.get<StoredRoleConfig>('role-config', configKey))
    if (stored) { this.current = stored; return this.view(stored) }
    // Defaults are virtual until the first explicit save. Persisting them from a
    // session-less source engine would clobber another engine's model routes.
    const initial: StoredRoleConfig = { revision: 1, roles: structuredClone(this.defaults), updatedAt: this.now() }
    this.current = initial
    return this.view(initial)
  }

  async currentView(): Promise<RoleConfigView> {
    if (!this.current) return this.ensure()
    return this.view(this.current)
  }

  async write(transaction: AsyncTx, expectedRevision: number, roles: RoleConfig): Promise<RoleConfigView> {
    validateRoleConfig(roles)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new CoreError('INVALID_CONFIG', 'Role configuration needs a positive expected revision.')
    const current = await transaction.get<StoredRoleConfig>('role-config', configKey)
    const baseRevision = current?.revision ?? 1
    if (baseRevision !== expectedRevision) throw new CoreError('CONFIG_REVISION_CONFLICT', 'The role configuration changed after this update was prepared.')
    const next: StoredRoleConfig = { revision: baseRevision + 1, roles: structuredClone(roles), updatedAt: this.now() }
    if (!await transaction.replace('role-config', configKey, next)) await transaction.insert('role-config', configKey, next)
    await transaction.insert('role-config-history', historyKey(next.revision), next)
    this.current = next
    return this.view(next)
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
    const stored = await this.storage.transaction(this.instanceId, transaction =>
      transaction.get<StoredRoleConfig>('role-config-history', historyKey(revision)))
    return stored ? this.view(stored) : undefined
  }

  async history(limit = 20): Promise<StoredRoleConfig[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_CONFIG', 'Role configuration history needs a limit from 1 to 100.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const pages = []
      let cursor: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<StoredRoleConfig>('role-config-history', { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) })
        pages.push(...page.items.map(item => item.value))
        if (!page.cursor) break
        cursor = page.cursor
        if (pageCount === 9) throw new CoreError('CONFIG_BUDGET', 'The role configuration history exceeds its 1000-version budget.')
      }
      return pages.sort((left, right) => right.revision - left.revision).slice(0, limit)
    })
  }

  private view(stored: StoredRoleConfig): RoleConfigView {
    return { revision: stored.revision, roles: structuredClone(stored.roles), updatedAt: stored.updatedAt }
  }
}
