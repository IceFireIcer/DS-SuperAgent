import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import type { RoleProfile } from './config.js'
import { CoreError, identifier } from './model.js'
import type { CredentialResourceView, CredentialUse } from './resource-credentials.js'
import type { AsyncTx, Storage } from './storage.js'
import { workerMcpName, type WorkerMcpBinding, type WorkerMcpConfig } from './worker-mcp-tool.js'

type CapabilityScope = { role: 'main' | 'router' | 'worker'; workItemId?: string; environmentId?: string }
type Definition = { kind: 'skill'; instructions: string }
  | { kind: 'mcp'; tool: WorkerMcpConfig }
  | { kind: 'bundle'; members: string[] }
interface Capability {
  id: string
  name: string
  revision: number
  definition: Definition
  approved: boolean
  bindings: CapabilityScope[]
}
type Receipt = { fingerprint: string; result: Capability | { id: string; deleted: true } }
const appFields = ['instanceId', 'id', 'expectedRevision', 'commandId'] as const
export const capabilityFields = {
  'capability-list': ['instanceId'],
  'capability-resolve': ['instanceId', 'scope'],
  'capability-save': [...appFields, 'name', 'definition'],
  'capability-delete': appFields,
  'capability-approve': [...appFields, 'approved'],
  'capability-bind': [...appFields, 'scope', 'enabled'],
} as const

const catalogLimit = 200
const bindingLimit = 64

function checkedObject(value: unknown, fields: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !fields.includes(key))) throw new CoreError('INVALID_INPUT', `Invalid ${label} fields.`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new CoreError('INVALID_INPUT', `Enter ${label} within the ${limit}-byte limit.`)
  }
  return value.trim()
}

function scopeOf(value: unknown): CapabilityScope {
  const { role, workItemId, environmentId } = checkedObject(value, ['role', 'workItemId', 'environmentId'], 'capability scope')
  if (role !== 'main' && role !== 'router' && role !== 'worker') throw new CoreError('INVALID_INPUT', 'Choose Main, Router or Worker.')
  if (role !== 'worker' && (workItemId !== undefined || environmentId !== undefined)) {
    throw new CoreError('INVALID_INPUT', 'Work and Environment selectors are only available for Worker.')
  }
  if (workItemId !== undefined) identifier(workItemId, 'workItemId')
  if (environmentId !== undefined) identifier(environmentId, 'environmentId')
  return { role, ...(workItemId === undefined ? {} : { workItemId }), ...(environmentId === undefined ? {} : { environmentId }) }
}

function definitionOf(value: unknown): Definition {
  if (!value || typeof value !== 'object' || !('kind' in value)) throw new CoreError('INVALID_INPUT', 'Choose a capability kind.')
  if (value.kind === 'skill') {
    const { instructions } = checkedObject(value, ['kind', 'instructions'], 'skill')
    return { kind: 'skill', instructions: text(instructions, 'skill instructions', 16384) }
  }
  if (value.kind === 'mcp') {
    const { tool } = checkedObject(value, ['kind', 'tool'], 'MCP capability')
    const { serverName, toolName, url, resourceId } = checkedObject(tool, ['serverName', 'toolName', 'url', 'resourceId'], 'MCP tool')
    if (typeof serverName !== 'string' || typeof toolName !== 'string' || typeof url !== 'string') {
      throw new CoreError('INVALID_INPUT', 'Enter the MCP server name, tool name and endpoint.')
    }
    identifier(resourceId, 'resourceId')
    const config = { serverName, toolName, url, resourceId }
    workerMcpName(config)
    if (new URL(url).search) throw new CoreError('INVALID_INPUT', 'Use a credential resource for authentication instead of URL parameters.')
    return { kind: 'mcp', tool: config }
  }
  if (value.kind === 'bundle') {
    const { members } = checkedObject(value, ['kind', 'members'], 'capability bundle')
    if (!Array.isArray(members) || !members.length || members.length > 16 || new Set(members).size !== members.length) {
      throw new CoreError('INVALID_INPUT', 'Choose up to 16 distinct bundle members.')
    }
    for (const member of members) identifier(member, 'member')
    return { kind: 'bundle', members }
  }
  throw new CoreError('INVALID_INPUT', 'Choose a skill, MCP tool or bundle.')
}

const matches = (binding: CapabilityScope, scope: CapabilityScope) => binding.role === scope.role
  && (binding.workItemId === undefined || binding.workItemId === scope.workItemId)
  && (binding.environmentId === undefined || binding.environmentId === scope.environmentId)

function mcpScope(scope: CapabilityScope) {
  return scope.role === 'worker' && scope.workItemId !== undefined && scope.environmentId !== undefined
}

export class CapabilityLibrary {
  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly assertHost: (tx: AsyncTx) => Promise<void>, private readonly credentials?: WorkerMcpBinding['credentials']) {}

  private async catalog(tx: AsyncTx) {
    const rows: Capability[] = []
    let after: string | undefined
    do {
      const page = await tx.scan<Capability>('capability-definition', { limit: 100, ...(after ? { after } : {}) })
      rows.push(...page.items.map(item => item.value))
      after = page.cursor
      if (rows.length > catalogLimit) throw new CoreError('CAPABILITY_BUDGET', 'The capability library exceeds its size limit.')
    } while (after)
    return rows
  }

  private async toolAuthorized(tx: AsyncTx, tool: WorkerMcpConfig, scope: CapabilityScope) {
    if (!this.credentials || !mcpScope(scope)) return false
    const resource = await tx.get<CredentialResourceView>('resource-credential', tool.resourceId)
    return resource?.status === 'active' && resource.grants.some(grant => grant.purposes.includes('tool')
      && grant.scope.sourceInstanceId === undefined && matches(grant.scope, scope))
  }

  private async resolve(tx: AsyncTx, scope: CapabilityScope) {
    const catalog = await this.catalog(tx)
    const byId = new Map(catalog.map(record => [record.id, record]))
    const effective = new Map<string, Capability>()
    for (const record of catalog) {
      if (!record.approved || !record.bindings.some(binding => matches(binding, scope))) continue
      const members = record.definition.kind === 'bundle' ? record.definition.members.map(id => byId.get(id)) : [record]
      for (const member of members) {
        if (!member?.approved || member.definition.kind === 'bundle') continue
        if (member.definition.kind === 'mcp' && !await this.toolAuthorized(tx, member.definition.tool, scope)) continue
        effective.set(member.id, member)
      }
    }
    return [...effective.values()]
  }

  async runtime(scope: CapabilityScope) {
    const items = await this.storage.transaction(this.instanceId, tx => this.resolve(tx, scope))
    const instructions = items.flatMap(item => item.definition.kind === 'skill' ? [item.definition.instructions] : [])
    if (Buffer.byteLength(instructions.join('\n\n')) > 32768) {
      throw new CoreError('CAPABILITY_BUDGET', 'The bound skills exceed the execution instruction budget.')
    }
    const bindings: WorkerMcpBinding[] = items.flatMap(item => {
      if (item.definition.kind !== 'mcp' || !this.credentials) return []
      const tool = item.definition.tool
      const credentials = this.credentials
      return [{ config: tool, credentials: { use: async <Result>(use: CredentialUse,
        consume: (secret: string) => Promise<Result>) => {
        if (use.instanceId !== this.instanceId || use.resourceId !== tool.resourceId || use.purpose !== 'tool'
          || !matches(scope, use) || !mcpScope(use)) throw new CoreError('GRANT_DENIED', 'The MCP request is outside the current execution scope.')
        const check = () => this.storage.transaction(this.instanceId, async tx => {
          await this.assertHost(tx)
          const current = (await this.resolve(tx, scope)).find(entry => entry.id === item.id)
          if (current?.revision !== item.revision) throw new CoreError('GRANT_DENIED', 'The capability or its credential grant changed.')
        })
        await check()
        return credentials.use(use, async secret => {
          await check()
          return consume(secret)
        })
      } } }]
    })
    if (bindings.length > 8) throw new CoreError('CAPABILITY_BUDGET', 'Bind at most eight MCP tools to one execution.')
    return { instructions, bindings }
  }

  async profile(profile: RoleProfile, scope: CapabilityScope) {
    const { instructions } = await this.runtime(scope)
    return withCapabilityInstructions(profile, instructions)
  }

  async dispatch(endpoint: string, payload: Record<string, unknown>, summaryOnly = false) {
    if (!Object.hasOwn(capabilityFields, endpoint)) throw new CoreError('UNAVAILABLE', 'This capability action is unavailable.')
    const action = endpoint as keyof typeof capabilityFields
    checkedObject(payload, capabilityFields[action], 'capability request')
    if (payload.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The capability belongs to another Instance.')
    if (action === 'capability-list' || action === 'capability-resolve') {
      const scope = action === 'capability-resolve' ? scopeOf(payload.scope) : undefined
      return this.storage.transaction(this.instanceId, async tx => {
        const items = scope ? await this.resolve(tx, scope) : await this.catalog(tx)
        return { items: summaryOnly ? items.map(({ id, name, revision, definition, approved }) =>
          ({ id, name, revision, kind: definition.kind, approved })) : items }
      })
    }
    if (summaryOnly) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Capability administration requires the local product window.')
    const { id, commandId, expectedRevision } = payload
    identifier(commandId, 'commandId')
    const create = action === 'capability-save' && id === undefined
    if (!create) identifier(id, 'id')
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new CoreError('INVALID_INPUT', 'An expected capability revision is required.')
    }
    const fingerprint = createHash('sha256').update(canonicalJson([action, payload])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.assertHost(tx)
      const prior = await tx.get<Receipt>('capability-command', commandId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The command ID has different capability input.')
        return prior.result
      }
      const current = create ? undefined : await tx.get<Capability>('capability-definition', id as string)
      if (!create && !current) throw new CoreError('NOT_FOUND', 'This capability was deleted.')
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed. Reload it before saving.')
      }
      let result: Receipt['result']
      if (action === 'capability-save') {
        const definition = definitionOf(payload.definition)
        if (definition.kind === 'bundle') {
          for (const member of definition.members) {
            const entry = await tx.get<Capability>('capability-definition', member)
            if (!entry || entry.id === current?.id || entry.definition.kind === 'bundle') {
              throw new CoreError('INVALID_INPUT', 'A bundle can contain existing skills and MCP tools.')
            }
          }
        }
        if (definition.kind === 'mcp' && (await tx.get<CredentialResourceView>('resource-credential', definition.tool.resourceId))?.status !== 'active') {
          throw new CoreError('RESOURCE_UNAVAILABLE', 'Choose an active credential resource.')
        }
        if (create && (await this.catalog(tx)).length >= catalogLimit) throw new CoreError('CAPABILITY_BUDGET', 'The capability library is full.')
        result = { id: current?.id ?? randomUUID(), name: text(payload.name, 'a capability name', 128), revision: expectedRevision + 1,
          definition, approved: false, bindings: current?.bindings ?? [] }
      } else if (action === 'capability-delete') {
        await tx.remove('capability-definition', current!.id)
        result = { id: current!.id, deleted: true }
      } else {
        result = { ...current!, revision: expectedRevision + 1 }
        if (action === 'capability-approve') {
          if (typeof payload.approved !== 'boolean') throw new CoreError('INVALID_INPUT', 'Choose approval or revocation.')
          result.approved = payload.approved
        } else {
          const scope = scopeOf(payload.scope)
          if (typeof payload.enabled !== 'boolean') throw new CoreError('INVALID_INPUT', 'Choose whether to bind the capability.')
          if (payload.enabled && result.definition.kind === 'mcp'
            && (scope.role !== 'worker' || !(scope.workItemId || scope.environmentId))) {
            throw new CoreError('INVALID_INPUT', 'Bind MCP to a Worker work item or Environment.')
          }
          const key = canonicalJson(scope)
          result.bindings = result.bindings.filter(binding => canonicalJson(binding) !== key)
          if (payload.enabled) result.bindings.push(scope)
          if (result.bindings.length > bindingLimit) throw new CoreError('CAPABILITY_BUDGET', 'This capability has too many bindings.')
        }
      }
      if (!('deleted' in result)) {
        if (create) await tx.insert('capability-definition', result.id, result)
        else await tx.replace('capability-definition', result.id, result)
      }
      await tx.insert('capability-command', commandId, { fingerprint, result } satisfies Receipt)
      return result
    })
  }
}

export function withCapabilityInstructions(profile: RoleProfile, instructions: string[]) {
  return instructions.length ? { ...profile, instructions: [profile.instructions, ...instructions].filter(Boolean).join('\n\n') } : profile
}
