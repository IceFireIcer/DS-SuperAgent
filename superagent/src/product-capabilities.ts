import { createHash } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier } from './model.js'
import type { CredentialResourceView, CredentialUse } from './resource-credentials.js'
import type { AsyncTx, Storage } from './storage.js'
import { workerMcpName, type WorkerMcpConfig } from './worker-mcp-tool.js'

export type ProductCapabilityKind = 'mcp' | 'skill' | 'pack'
export type ProductCapabilityRole = 'main' | 'router' | 'worker'
export type ProductCapabilityState = 'ready' | 'partial' | 'blocked' | 'unbound'
export type ProductCapabilityBindingStatus = 'ready' | 'needs-approval' | 'needs-grant'
  | 'needs-scope' | 'resource-unavailable' | 'blocked' | 'disabled'
export type ProductCapabilityResolveState = 'ready' | 'partial' | 'blocked' | 'empty'
export type ProductCapabilityEndpoint =
  | 'capability-list'
  | 'capability-read'
  | 'capability-resolve'
  | 'capability-save'
  | 'capability-delete'
  | 'capability-approve'
  | 'capability-bind'

export interface ProductCapabilityScope {
  role: ProductCapabilityRole
  workItemId?: string
  environmentId?: string
}

export type ProductMcpCapability = WorkerMcpConfig

export interface ProductCapabilityBinding {
  id: string
  scope: ProductCapabilityScope
  active: boolean
  updatedAt: number
}

export interface ProductCapabilityBindingView extends ProductCapabilityBinding {
  status: ProductCapabilityBindingStatus
  reasons: string[]
}

export interface ProductCapabilityResourceView {
  id: string
  label?: string
  status: 'active' | 'deleted' | 'missing'
}

export interface ProductCapabilityView {
  id: string
  name: string
  kind: ProductCapabilityKind
  description: string
  approved: boolean
  revision: number
  state: ProductCapabilityState
  bindings: ProductCapabilityBindingView[]
  mcp?: ProductMcpCapability
  content?: string
  items?: string[]
  resource?: ProductCapabilityResourceView
  createdAt: number
  updatedAt: number
}

export interface ProductCapabilityResolution {
  id: string
  name: string
  kind: ProductCapabilityKind
  status: ProductCapabilityBindingStatus
  reasons: string[]
  effective: boolean
  source: 'direct' | 'pack'
  parent?: string
  mcp?: ProductMcpCapability
  content?: string
}

export interface ProductCapabilityResolveView {
  scope: ProductCapabilityScope
  status: ProductCapabilityResolveState
  items: ProductCapabilityResolution[]
  capabilities: ProductCapabilityResolution[]
}

export interface SaveProductCapabilityInput {
  instanceId: string
  commandId: string
  expectedRevision: number
  name: string
  kind: ProductCapabilityKind
  description?: string
  mcp?: ProductMcpCapability
  content?: string
  items?: string[]
}

export interface ProductCapabilityCredentialConsumer {
  use<T>(request: CredentialUse, consume: (secret: string) => Promise<T>): Promise<T>
}

export interface ProductCapabilityWorkerMcpBinding {
  capabilityId: string
  config: WorkerMcpConfig
  use<T>(request: CredentialUse, consume: (secret: string) => Promise<T>): Promise<T>
}

export interface ProductCapabilityWorkerMcpProvider {
  workerMcpBindings(input: { instanceId: string; scope: ProductCapabilityScope }): Promise<ProductCapabilityWorkerMcpBinding[]>
  skillInstructions(input: { instanceId: string; scope: ProductCapabilityScope }): Promise<string[]>
}

export interface ProductCapabilitiesOptions {
  storage: Storage
  instanceId: string
  authorize(tx: AsyncTx): Promise<void>
  credentials?: ProductCapabilityCredentialConsumer
  now?: () => number
}

export const productCapabilityEndpointFields = {
  'capability-list': ['instanceId'],
  'capability-read': ['instanceId', 'capabilityId'],
  'capability-resolve': ['instanceId', 'scope'],
  'capability-save': ['instanceId', 'commandId', 'expectedRevision', 'name', 'kind', 'description', 'mcp', 'content', 'items'],
  'capability-delete': ['instanceId', 'commandId', 'capabilityId', 'expectedRevision'],
  'capability-approve': ['instanceId', 'commandId', 'capabilityId', 'expectedRevision', 'approved'],
  'capability-bind': ['instanceId', 'commandId', 'capabilityId', 'expectedRevision', 'scope', 'active'],
} as const satisfies Record<ProductCapabilityEndpoint, readonly string[]>

export const productCapabilityEndpoints = Object.freeze(
  Object.keys(productCapabilityEndpointFields) as ProductCapabilityEndpoint[],
)

// Existing exact-key product record kinds avoid a schema edit in this slice. Every
// capability key is namespaced, so the Worker MCP selection and command receipts stay separate.
const dataKind = 'product-mcp-selection'
const commandKind = 'product-mcp-command'
const dataPrefix = 'product-capability:v1:'
const indexKey = `${dataPrefix}index`
const recordPrefix = `${dataPrefix}record:`
const commandPrefix = `${dataPrefix}command:`
const roles: readonly ProductCapabilityRole[] = ['main', 'router', 'worker']
const kinds: readonly ProductCapabilityKind[] = ['mcp', 'skill', 'pack']
const reservedNames = new Set(['github', 'mail'])
const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const maxBindings = 100
const maxPackItems = 32
const maxWorkerCapabilityMcpTools = 8
const maxContentBytes = 32 * 1024
const maxDescriptionBytes = 2_000

interface StoredCapability {
  version: 1
  id: string
  name: string
  kind: ProductCapabilityKind
  description: string
  approved: boolean
  revision: number
  bindings: ProductCapabilityBinding[]
  mcp?: ProductMcpCapability
  content?: string
  items?: string[]
  createdAt: number
  updatedAt: number
}

interface CapabilityIndex {
  version: 1
  names: string[]
  updatedAt: number
}

interface CapabilityCommand {
  fingerprint: string
  result: unknown
}

interface CapabilityCatalog {
  records: StoredCapability[]
  byName: Map<string, StoredCapability>
  resources: Map<string, CredentialResourceView | undefined>
}

interface CapabilityStatus {
  status: ProductCapabilityBindingStatus
  reasons: string[]
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CoreError('INVALID_INPUT', `${label} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function fields(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  const input = plainObject(value, label)
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new CoreError('INVALID_INPUT', `The ${label} contains unsupported fields.`)
  }
}

function boundedText(value: unknown, label: string, maxBytes: number, allowEmpty = false) {
  if (typeof value !== 'string') throw new CoreError('INVALID_INPUT', `${label} must be text.`)
  const text = value.trim()
  if ((!allowEmpty && !text) || Buffer.byteLength(text) > maxBytes) {
    throw new CoreError('INVALID_INPUT', `${label} exceeds its allowed length.`)
  }
  return text
}

export function validateProductCapabilityName(value: unknown) {
  if (typeof value !== 'string') throw new CoreError('INVALID_INPUT', 'A capability needs a name.')
  const name = value.trim()
  if (Buffer.byteLength(name) > 32 || !namePattern.test(name) || reservedNames.has(name)) {
    throw new CoreError('INVALID_INPUT', 'Use lowercase letters, digits and single hyphens; connector names are reserved.')
  }
  return name
}

function capabilityKind(value: unknown): ProductCapabilityKind {
  if (!kinds.includes(value as ProductCapabilityKind)) {
    throw new CoreError('INVALID_INPUT', 'Choose an MCP capability, skill or pack.')
  }
  return value as ProductCapabilityKind
}

function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CoreError('INVALID_INPUT', 'A nonnegative capability revision is required.')
  }
  return value as number
}

function capabilityScope(value: unknown): ProductCapabilityScope {
  fields(value, ['role', 'workItemId', 'environmentId'], 'capability scope')
  if (!roles.includes(value.role as ProductCapabilityRole)) {
    throw new CoreError('INVALID_INPUT', 'A capability scope needs an explicit Main, Router or Worker role.')
  }
  const scope: ProductCapabilityScope = { role: value.role as ProductCapabilityRole }
  for (const key of ['workItemId', 'environmentId'] as const) {
    if (value[key] !== undefined) {
      identifier(value[key], key)
      scope[key] = value[key]
    }
  }
  return scope
}

function capabilityMcp(value: unknown): ProductMcpCapability {
  fields(value, ['resourceId', 'serverName', 'toolName', 'url'], 'MCP capability')
  identifier(value.resourceId, 'resourceId')
  const config = {
    resourceId: value.resourceId,
    serverName: boundedText(value.serverName, 'MCP server name', 32),
    toolName: boundedText(value.toolName, 'MCP tool name', 24),
    url: boundedText(value.url, 'MCP endpoint', 2_048),
  }
  workerMcpName(config)
  return config
}

function packItems(value: unknown, ownName: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPackItems) {
    throw new CoreError('INVALID_INPUT', `A pack needs 1 to ${maxPackItems} capabilities.`)
  }
  const items = value.map(validateProductCapabilityName)
  if (new Set(items).size !== items.length) throw new CoreError('INVALID_INPUT', 'A pack cannot repeat a capability.')
  if (items.includes(ownName)) throw new CoreError('INVALID_INPUT', 'A pack cannot include itself.')
  return items
}

function scopeMatches(binding: ProductCapabilityScope, requested: ProductCapabilityScope) {
  return binding.role === requested.role
    && (binding.workItemId === undefined || binding.workItemId === requested.workItemId)
    && (binding.environmentId === undefined || binding.environmentId === requested.environmentId)
}

function assertCapabilityExecutionScope(scope: ProductCapabilityScope) {
  if (scope.role === 'worker') {
    if (scope.workItemId === undefined && scope.environmentId === undefined) {
      throw new CoreError('INVALID_INPUT', 'A Worker capability scope needs a work item or Environment.')
    }
  } else if (scope.workItemId !== undefined || scope.environmentId !== undefined) {
    throw new CoreError('INVALID_INPUT', 'Main and Router capability execution uses role-only scope.')
  }
}

function sameScope(left: ProductCapabilityScope, right: ProductCapabilityScope) {
  return canonicalJson(left) === canonicalJson(right)
}

function bindingId(scope: ProductCapabilityScope) {
  return createHash('sha256').update(canonicalJson(['product-capability-binding-v1', scope])).digest('hex')
}

function hasToolGrant(resource: CredentialResourceView | undefined, scope: ProductCapabilityScope) {
  return resource?.status === 'active' && resource.grants.some(grant => grant.purposes.includes('tool')
    && grant.scope.role === scope.role
    && (grant.scope.workItemId === undefined || grant.scope.workItemId === scope.workItemId)
    && (grant.scope.environmentId === undefined || grant.scope.environmentId === scope.environmentId)
    && (scope.role !== 'worker' || grant.scope.workItemId !== undefined || grant.scope.environmentId !== undefined))
}

function leafStatus(record: StoredCapability, scope: ProductCapabilityScope,
  catalog: CapabilityCatalog): CapabilityStatus {
  if (record.kind === 'skill') return { status: 'ready', reasons: [] }
  if (record.kind !== 'mcp' || !record.mcp) {
    return { status: 'blocked', reasons: ['The capability has no executable definition.'] }
  }
  if (scope.role === 'worker' && scope.workItemId === undefined && scope.environmentId === undefined) {
    return { status: 'needs-scope', reasons: ['A Worker MCP capability needs a work item or Environment.'] }
  }
  if (!record.approved) {
    return { status: 'needs-approval', reasons: ['Approve this MCP capability in local settings.'] }
  }
  const resource = catalog.resources.get(record.mcp.resourceId)
  if (!resource || resource.status !== 'active') {
    return { status: 'resource-unavailable', reasons: ['The credential resource is unavailable.'] }
  }
  if (!hasToolGrant(resource, scope)) {
    return { status: 'needs-grant', reasons: ['Grant the credential resource for this role and work scope.'] }
  }
  return { status: 'ready', reasons: [] }
}

function packStatus(record: StoredCapability, scope: ProductCapabilityScope,
  catalog: CapabilityCatalog): CapabilityStatus {
  const items = record.items ?? []
  if (!items.length) return { status: 'blocked', reasons: ['The pack has no capabilities.'] }
  const reasons: string[] = []
  for (const name of items) {
    const child = catalog.byName.get(name)
    if (!child || child.kind === 'pack') {
      reasons.push(`${name} is unavailable.`)
      continue
    }
    const result = leafStatus(child, scope, catalog)
    for (const reason of result.reasons) reasons.push(`${name}: ${reason}`)
  }
  return reasons.length
    ? { status: 'blocked', reasons }
    : { status: 'ready', reasons: [] }
}

function capabilityState(bindings: ProductCapabilityBindingView[]): ProductCapabilityState {
  const active = bindings.filter(binding => binding.active)
  if (!active.length) return 'unbound'
  if (active.every(binding => binding.status === 'ready')) return 'ready'
  if (active.some(binding => binding.status === 'ready')) return 'partial'
  return 'blocked'
}

function projectCapability(record: StoredCapability, catalog: CapabilityCatalog): ProductCapabilityView {
  const bindings = record.bindings.map(binding => {
    const status = binding.active
      ? record.kind === 'pack' ? packStatus(record, binding.scope, catalog) : leafStatus(record, binding.scope, catalog)
      : { status: 'disabled' as const, reasons: [] }
    return { id: binding.id, scope: { ...binding.scope }, active: binding.active, updatedAt: binding.updatedAt,
      status: status.status, reasons: [...status.reasons] }
  })
  const resource = record.kind === 'mcp' && record.mcp
    ? catalog.resources.get(record.mcp.resourceId)
    : undefined
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    description: record.description,
    approved: record.approved,
    revision: record.revision,
    state: capabilityState(bindings),
    bindings,
    ...(record.mcp ? { mcp: { ...record.mcp } } : {}),
    ...(record.content !== undefined ? { content: record.content } : {}),
    ...(record.items ? { items: [...record.items] } : {}),
    ...(record.kind === 'mcp' && record.mcp ? {
      resource: resource
        ? { id: resource.id, label: resource.label, status: resource.status }
        : { id: record.mcp.resourceId, status: 'missing' as const },
    } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function resolution(record: StoredCapability, scope: ProductCapabilityScope, catalog: CapabilityCatalog,
  source: 'direct' | 'pack', parent?: string): ProductCapabilityResolution {
  const status = leafStatus(record, scope, catalog)
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    status: status.status,
    reasons: [...status.reasons],
    effective: status.status === 'ready',
    source,
    ...(parent ? { parent } : {}),
    ...(status.status === 'ready' && record.mcp ? { mcp: { ...record.mcp } } : {}),
    ...(status.status === 'ready' && record.content !== undefined ? { content: record.content } : {}),
  }
}

function resolveInCatalog(catalog: CapabilityCatalog, scope: ProductCapabilityScope): ProductCapabilityResolveView {
  const matched = catalog.records.filter(record => record.bindings.some(binding =>
    binding.active && scopeMatches(binding.scope, scope)))
  const items: ProductCapabilityResolution[] = []
  const add = (item: ProductCapabilityResolution) => {
    const existing = items.find(candidate => candidate.id === item.id)
    if (!existing) {
      items.push(item)
      return
    }
    if (existing.effective) return
    if (item.effective) {
      items.splice(items.indexOf(existing), 1, item)
      return
    }
    for (const reason of item.reasons) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
    }
    if (item.source === 'direct') {
      existing.source = 'direct'
      delete existing.parent
    }
  }
  for (const record of matched) {
    if (record.kind !== 'pack') {
      add(resolution(record, scope, catalog, 'direct'))
      continue
    }
    const pack = packStatus(record, scope, catalog)
    add({ id: record.id, name: record.name, kind: 'pack', status: pack.status,
      reasons: [...pack.reasons], effective: false, source: 'direct' })
    for (const name of record.items ?? []) {
      const child = catalog.byName.get(name)
      if (!child || child.kind === 'pack') continue
      add(resolution(child, scope, catalog, 'pack', record.name))
    }
  }
  const leaves = items.filter(item => item.kind !== 'pack')
  const capabilities = leaves.filter(item => item.effective)
  const status: ProductCapabilityResolveState = !items.length ? 'empty'
    : !leaves.length || !capabilities.length ? 'blocked'
      : capabilities.length === leaves.length ? 'ready' : 'partial'
  return { scope: { ...scope }, status, items, capabilities }
}

/**
 * Product capability commands. Every operation calls the trusted Host authorization seam inside
 * its transaction. Capability records use namespaced keys in existing exact-key product record
 * kinds because this module may not extend the storage schema.
 */
export class ProductCapabilities {
  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly authorize: (tx: AsyncTx) => Promise<void>,
    private readonly credentials?: ProductCapabilityCredentialConsumer,
    private readonly now: () => number = Date.now) {
    identifier(instanceId, 'instanceId')
    if (typeof authorize !== 'function') {
      throw new CoreError('INVALID_CONFIG', 'Product capabilities need the Host authorization seam.')
    }
  }

  private assertInstance(instanceId: unknown) {
    if (instanceId !== this.instanceId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The capability belongs to another Instance.')
    }
  }

  private async query<T>(operation: (tx: AsyncTx) => Promise<T>): Promise<T> {
    return this.storage.transaction(this.instanceId, async tx => {
      await this.authorize(tx)
      return operation(tx)
    })
  }

  private async command<T>(input: { instanceId: string; commandId: string }, operation: string,
    value: unknown, apply: (tx: AsyncTx) => Promise<T>): Promise<T> {
    this.assertInstance(input.instanceId)
    identifier(input.commandId, 'commandId')
    const fingerprint = createHash('sha256')
      .update(canonicalJson([operation, this.instanceId, value])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorize(tx)
      const key = `${commandPrefix}${input.commandId}`
      const prior = await tx.get<CapabilityCommand>(commandKind, key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new CoreError('IDENTITY_CONFLICT', 'This capability command ID has different input.')
        }
        return prior.result as T
      }
      const result = await apply(tx)
      await tx.insert<CapabilityCommand>(commandKind, key, { fingerprint, result })
      return result
    })
  }

  private async readIndex(tx: AsyncTx) {
    const index = await tx.get<CapabilityIndex>(dataKind, indexKey)
    return index ? [...new Set(index.names)] : []
  }

  private async writeIndex(tx: AsyncTx, names: string[]) {
    const value: CapabilityIndex = { version: 1, names: [...new Set(names)], updatedAt: this.now() }
    if (!await tx.replace(dataKind, indexKey, value)) await tx.insert(dataKind, indexKey, value)
  }

  private async readRecords(tx: AsyncTx) {
    const records: StoredCapability[] = []
    for (const name of await this.readIndex(tx)) {
      const record = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${name}`)
      if (record) records.push(record)
    }
    return records.sort((left, right) => left.name.localeCompare(right.name))
  }

  private async catalog(tx: AsyncTx): Promise<CapabilityCatalog> {
    const records = await this.readRecords(tx)
    const byName = new Map(records.map(record => [record.name, record]))
    const resources = new Map<string, CredentialResourceView | undefined>()
    for (const record of records) {
      if (record.kind !== 'mcp' || !record.mcp || resources.has(record.mcp.resourceId)) continue
      resources.set(record.mcp.resourceId,
        await tx.get<CredentialResourceView>('resource-credential', record.mcp.resourceId))
    }
    return { records, byName, resources }
  }

  private async activeResource(tx: AsyncTx, resourceId: string) {
    const resource = await tx.get<CredentialResourceView>('resource-credential', resourceId)
    if (resource?.status !== 'active') {
      throw new CoreError('RESOURCE_UNAVAILABLE', 'Choose an active credential resource.')
    }
    return resource
  }

  async list(input: { instanceId: string }) {
    fields(input, ['instanceId'], 'capability list')
    this.assertInstance(input.instanceId)
    return this.query(async tx => {
      const catalog = await this.catalog(tx)
      return { items: catalog.records.map(record => projectCapability(record, catalog)) }
    })
  }

  async read(input: { instanceId: string; capabilityId: string }) {
    fields(input, ['instanceId', 'capabilityId'], 'capability read')
    this.assertInstance(input.instanceId)
    const capabilityId = validateProductCapabilityName(input.capabilityId)
    return this.query(async tx => {
      const catalog = await this.catalog(tx)
      const record = catalog.byName.get(capabilityId)
      if (!record) throw new CoreError('NOT_FOUND', 'The capability is unavailable.')
      return projectCapability(record, catalog)
    })
  }

  async resolve(input: { instanceId: string; scope: ProductCapabilityScope }) {
    fields(input, ['instanceId', 'scope'], 'capability resolution')
    this.assertInstance(input.instanceId)
    const scope = capabilityScope(input.scope)
    assertCapabilityExecutionScope(scope)
    return this.query(async tx => {
      const catalog = await this.catalog(tx)
      return resolveInCatalog(catalog, scope)
    })
  }

  /** Returns only active, effective skill content for one exact execution scope. */
  async skillInstructions(input: { instanceId: string; scope: ProductCapabilityScope }) {
    fields(input, ['instanceId', 'scope'], 'skill resolution')
    this.assertInstance(input.instanceId)
    const scope = capabilityScope(input.scope)
    assertCapabilityExecutionScope(scope)
    return this.query(async tx => {
      const catalog = await this.catalog(tx)
      const resolved = resolveInCatalog(catalog, scope)
      return resolved.capabilities
        .filter(item => item.kind === 'skill' && item.effective && item.content)
        .map(item => item.content!)
    })
  }

  /** Host-only Worker execution view. A saved binding is not executable until all live checks pass. */
  async workerMcpBindings(input: { instanceId: string; scope: ProductCapabilityScope }) {
    fields(input, ['instanceId', 'scope'], 'Worker capability resolution')
    this.assertInstance(input.instanceId)
    const scope = capabilityScope(input.scope)
    if (scope.role !== 'worker' || scope.workItemId === undefined || scope.environmentId === undefined) {
      throw new CoreError('INVALID_INPUT', 'Worker MCP execution needs an exact work item and Environment.')
    }
    assertCapabilityExecutionScope(scope)
    return this.query(async tx => {
      const catalog = await this.catalog(tx)
      const resolved = resolveInCatalog(catalog, scope)
      const ready = resolved.capabilities.filter(item => item.kind === 'mcp')
      if (!ready.length) return []
      if (!this.credentials) {
        throw new CoreError('UNAVAILABLE', 'Worker MCP execution needs the Host credential consumer.')
      }
      if (ready.length > maxWorkerCapabilityMcpTools) {
        throw new CoreError('CAPABILITY_BUDGET', `At most ${maxWorkerCapabilityMcpTools} capability MCP tools can run in one Worker turn.`)
      }
      const names = new Set<string>()
      return ready.map(item => {
        const record = catalog.byName.get(item.id)
        if (!record?.mcp) throw new CoreError('INCOMPLETE_STATE', 'The ready MCP capability is unavailable.')
        const config = { ...record.mcp }
        const name = workerMcpName(config)
        if (names.has(name)) {
          throw new CoreError('CAPABILITY_TOOL_CONFLICT', `More than one ready capability defines ${name}.`)
        }
        names.add(name)
        return {
          capabilityId: record.id,
          config,
          use: <T>(request: CredentialUse, consume: (secret: string) => Promise<T>) =>
            this.useWorkerMcp(record.id, config, request, consume),
        } satisfies ProductCapabilityWorkerMcpBinding
      })
    })
  }

  private async assertWorkerMcpUse(tx: AsyncTx, capabilityId: string, config: WorkerMcpConfig,
    request: CredentialUse) {
    if (request.role !== 'worker' || request.purpose !== 'tool') {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only an exact Worker tool use may consume an MCP capability.')
    }
    if (request.workItemId === undefined || request.environmentId === undefined) {
      throw new CoreError('INVALID_INPUT', 'Worker MCP use needs an exact work item and Environment.')
    }
    identifier(request.workItemId, 'workItemId')
    identifier(request.environmentId, 'environmentId')
    const record = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${capabilityId}`)
    if (!record || record.kind !== 'mcp' || !record.mcp || record.mcp.resourceId !== request.resourceId) {
      throw new CoreError('CAPABILITY_NOT_BOUND', 'The MCP capability is no longer bound to this execution scope.')
    }
    if (canonicalJson(record.mcp) !== canonicalJson(config)) {
      throw new CoreError('CONFIG_CHANGED', 'The MCP capability changed after this Worker turn was configured.')
    }
    if (!record.approved) {
      throw new CoreError('MCP_NOT_APPROVED', 'This MCP capability is no longer approved.')
    }
    const scope: ProductCapabilityScope = { role: 'worker', workItemId: request.workItemId,
      environmentId: request.environmentId }
    if (!record.bindings.some(binding => binding.active && scopeMatches(binding.scope, scope))) {
      throw new CoreError('CAPABILITY_NOT_BOUND', 'The MCP capability is no longer bound to this execution scope.')
    }
    const resource = await tx.get<CredentialResourceView>('resource-credential', request.resourceId)
    if (resource?.status !== 'active') {
      throw new CoreError('RESOURCE_UNAVAILABLE', 'The MCP credential resource is unavailable.')
    }
    if (!hasToolGrant(resource, scope)) {
      throw new CoreError('GRANT_DENIED', 'The MCP credential grant was revoked for this execution scope.')
    }
  }

  private async useWorkerMcp<T>(capabilityId: string, config: WorkerMcpConfig, request: CredentialUse,
    consume: (secret: string) => Promise<T>): Promise<T> {
    fields(request, ['instanceId', 'resourceId', 'role', 'workItemId', 'environmentId', 'purpose'],
      'Worker capability use')
    this.assertInstance(request.instanceId)
    identifier(request.resourceId, 'resourceId')
    if (typeof consume !== 'function') throw new CoreError('INVALID_INPUT', 'A trusted MCP consumer is required.')
    await this.query(tx => this.assertWorkerMcpUse(tx, capabilityId, config, request))
    if (!this.credentials) {
      throw new CoreError('UNAVAILABLE', 'Worker MCP execution needs the Host credential consumer.')
    }
    let authorizationFailure: CoreError | undefined
    try {
      return await this.credentials.use(request, async secret => {
        try { await this.query(tx => this.assertWorkerMcpUse(tx, capabilityId, config, request)) }
        catch (error) {
          if (error instanceof CoreError) authorizationFailure = error
          throw error
        }
        return consume(secret)
      })
    } catch (error) {
      if (authorizationFailure) throw authorizationFailure
      throw error
    }
  }

  async save(input: SaveProductCapabilityInput) {
    fields(input, ['instanceId', 'commandId', 'expectedRevision', 'name', 'kind', 'description',
      'mcp', 'content', 'items'], 'capability save')
    this.assertInstance(input.instanceId)
    identifier(input.commandId, 'commandId')
    const expectedRevision = revision(input.expectedRevision)
    const name = validateProductCapabilityName(input.name)
    const kind = capabilityKind(input.kind)
    const description = input.description === undefined ? ''
      : boundedText(input.description, 'Capability description', maxDescriptionBytes, true)
    let mcp: ProductMcpCapability | undefined
    let content: string | undefined
    let items: string[] | undefined
    if (kind === 'mcp') {
      if (input.content !== undefined || input.items !== undefined) {
        throw new CoreError('INVALID_INPUT', 'An MCP capability accepts only MCP configuration.')
      }
      mcp = capabilityMcp(input.mcp)
    } else if (kind === 'skill') {
      if (input.mcp !== undefined || input.items !== undefined) {
        throw new CoreError('INVALID_INPUT', 'A skill accepts only skill instructions.')
      }
      content = boundedText(input.content, 'Skill instructions', maxContentBytes)
    } else {
      if (input.mcp !== undefined || input.content !== undefined) {
        throw new CoreError('INVALID_INPUT', 'A pack accepts only capability names.')
      }
      items = packItems(input.items, name)
    }
    const body = { name, kind, description, ...(mcp ? { mcp } : {}), ...(content !== undefined ? { content } : {}),
      ...(items ? { items } : {}) }
    return this.command(input, 'save', { expectedRevision, body }, async tx => {
      const current = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${name}`)
      if (!current && expectedRevision !== 0) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed; review it before saving.')
      }
      if (current && current.revision !== expectedRevision) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed; review it before saving.')
      }
      if (current && current.kind !== kind) {
        throw new CoreError('CAPABILITY_KIND_CONFLICT', 'A capability cannot change its kind.')
      }
      if (mcp) {
        await this.activeResource(tx, mcp.resourceId)
        const toolName = workerMcpName(mcp)
        for (const candidate of await this.readRecords(tx)) {
          if (candidate.name === name || candidate.kind !== 'mcp' || !candidate.mcp) continue
          if (workerMcpName(candidate.mcp) === toolName) {
            throw new CoreError('CAPABILITY_TOOL_CONFLICT', `${candidate.name} already defines ${toolName}.`)
          }
        }
      }
      if (items) {
        const catalog = await this.catalog(tx)
        for (const item of items) {
          const child = catalog.byName.get(item)
          if (!child || child.kind === 'pack') {
            throw new CoreError('INVALID_INPUT', `Packs can include only saved MCP capabilities and skills; ${item} is not one.`)
          }
        }
      }
      const at = this.now()
      const configUnchanged = current?.kind === 'mcp' && current.mcp && mcp
        ? canonicalJson(current.mcp) === canonicalJson(mcp)
        : false
      const record: StoredCapability = {
        version: 1,
        id: name,
        name,
        kind,
        description,
        approved: kind === 'mcp' ? current?.kind === 'mcp' && configUnchanged && current.approved === true : true,
        revision: current ? current.revision + 1 : 1,
        bindings: current ? current.bindings.map(binding => ({ ...binding, scope: { ...binding.scope } })) : [],
        ...(mcp ? { mcp: { ...mcp } } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(items ? { items: [...items] } : {}),
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
      }
      if (!await tx.replace(dataKind, `${recordPrefix}${name}`, record)) {
        await tx.insert(dataKind, `${recordPrefix}${name}`, record)
      }
      const names = await this.readIndex(tx)
      if (!names.includes(name)) await this.writeIndex(tx, [...names, name])
      const catalog = await this.catalog(tx)
      return projectCapability(record, catalog)
    })
  }

  async remove(input: { instanceId: string; commandId: string; capabilityId: string; expectedRevision: number }) {
    fields(input, ['instanceId', 'commandId', 'capabilityId', 'expectedRevision'], 'capability deletion')
    this.assertInstance(input.instanceId)
    identifier(input.commandId, 'commandId')
    const capabilityId = validateProductCapabilityName(input.capabilityId)
    const expectedRevision = revision(input.expectedRevision)
    return this.command(input, 'delete', { capabilityId, expectedRevision }, async tx => {
      const record = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${capabilityId}`)
      if (!record) throw new CoreError('NOT_FOUND', 'The capability is unavailable.')
      if (record.revision !== expectedRevision) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed; review it before deleting.')
      }
      const affectedPacks: string[] = []
      for (const candidate of await this.readRecords(tx)) {
        if (candidate.name === capabilityId || candidate.kind !== 'pack' || !candidate.items?.includes(capabilityId)) continue
        const next: StoredCapability = { ...candidate, items: candidate.items.filter(item => item !== capabilityId),
          revision: candidate.revision + 1, updatedAt: this.now() }
        await tx.replace(dataKind, `${recordPrefix}${candidate.name}`, next)
        affectedPacks.push(candidate.name)
      }
      await tx.remove(dataKind, `${recordPrefix}${capabilityId}`)
      await this.writeIndex(tx, (await this.readIndex(tx)).filter(name => name !== capabilityId))
      return { capabilityId, deleted: true as const, revision: record.revision + 1, affectedPacks }
    })
  }

  async approve(input: { instanceId: string; commandId: string; capabilityId: string;
    expectedRevision: number; approved: boolean }) {
    fields(input, ['instanceId', 'commandId', 'capabilityId', 'expectedRevision', 'approved'], 'capability approval')
    this.assertInstance(input.instanceId)
    identifier(input.commandId, 'commandId')
    const capabilityId = validateProductCapabilityName(input.capabilityId)
    const expectedRevision = revision(input.expectedRevision)
    if (typeof input.approved !== 'boolean') {
      throw new CoreError('INVALID_INPUT', 'Choose whether to approve this MCP capability.')
    }
    return this.command(input, 'approve', { capabilityId, expectedRevision, approved: input.approved }, async tx => {
      const record = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${capabilityId}`)
      if (!record) throw new CoreError('NOT_FOUND', 'The capability is unavailable.')
      if (record.revision !== expectedRevision) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed; review it before approving.')
      }
      if (record.kind !== 'mcp' || !record.mcp) {
        throw new CoreError('CAPABILITY_NOT_APPROVABLE', 'Only MCP capabilities need approval.')
      }
      if (input.approved) await this.activeResource(tx, record.mcp.resourceId)
      const next: StoredCapability = { ...record, approved: input.approved,
        revision: record.revision + 1, updatedAt: this.now() }
      await tx.replace(dataKind, `${recordPrefix}${capabilityId}`, next)
      const catalog = await this.catalog(tx)
      return projectCapability(next, catalog)
    })
  }

  async bind(input: { instanceId: string; commandId: string; capabilityId: string;
    expectedRevision: number; scope: ProductCapabilityScope; active: boolean }) {
    fields(input, ['instanceId', 'commandId', 'capabilityId', 'expectedRevision', 'scope', 'active'],
      'capability binding')
    this.assertInstance(input.instanceId)
    identifier(input.commandId, 'commandId')
    const capabilityId = validateProductCapabilityName(input.capabilityId)
    const expectedRevision = revision(input.expectedRevision)
    const scope = capabilityScope(input.scope)
    assertCapabilityExecutionScope(scope)
    if (typeof input.active !== 'boolean') {
      throw new CoreError('INVALID_INPUT', 'Choose whether to bind this capability.')
    }
    return this.command(input, 'bind', { capabilityId, expectedRevision, scope, active: input.active }, async tx => {
      const record = await tx.get<StoredCapability>(dataKind, `${recordPrefix}${capabilityId}`)
      if (!record) throw new CoreError('NOT_FOUND', 'The capability is unavailable.')
      if (record.revision !== expectedRevision) {
        throw new CoreError('CAPABILITY_REVISION_CONFLICT', 'The capability changed; review it before binding.')
      }
      if (input.active && record.kind === 'mcp' && scope.role === 'worker'
        && scope.workItemId === undefined && scope.environmentId === undefined) {
        // Reuse the credential boundary: a Worker tool is never granted for an unbounded work scope.
        throw new CoreError('INVALID_INPUT', 'A Worker MCP capability needs a work item or Environment.')
      }
      const existing = record.bindings.find(binding => sameScope(binding.scope, scope))
      if (existing?.active === input.active) {
        const catalog = await this.catalog(tx)
        return projectCapability(record, catalog)
      }
      if (!existing && record.bindings.length >= maxBindings) {
        throw new CoreError('CAPABILITY_BUDGET', 'This capability has reached its binding limit.')
      }
      const at = this.now()
      const nextBinding: ProductCapabilityBinding = {
        id: existing?.id ?? bindingId(scope),
        scope: { ...scope },
        active: input.active,
        updatedAt: at,
      }
      const next: StoredCapability = {
        ...record,
        bindings: existing
          ? record.bindings.map(binding => sameScope(binding.scope, scope) ? nextBinding : binding)
          : [...record.bindings, nextBinding],
        revision: record.revision + 1,
        updatedAt: at,
      }
      await tx.replace(dataKind, `${recordPrefix}${capabilityId}`, next)
      const catalog = await this.catalog(tx)
      return projectCapability(next, catalog)
    })
  }

  dispatch(endpoint: string, payload: Record<string, unknown> = {}, client?: unknown): Promise<unknown> {
    return dispatchProductCapabilityEndpoint(this, endpoint, payload, client)
  }
}

export function createProductCapabilities(options: ProductCapabilitiesOptions) {
  return new ProductCapabilities(options.storage, options.instanceId, options.authorize,
    options.credentials, options.now)
}

export async function dispatchProductCapabilityEndpoint(service: ProductCapabilities, endpoint: string,
  payload: Record<string, unknown> = {}, client?: unknown): Promise<unknown> {
  if (client !== undefined && client !== null) {
    throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Capability administration requires the local authorized product settings.')
  }
  const allowed = (productCapabilityEndpointFields as Record<string, readonly string[] | undefined>)[endpoint]
  if (!allowed) throw new CoreError('UNAVAILABLE', 'This product capability is not connected yet.')
  plainObject(payload, 'product request')
  if (Object.keys(payload).some(key => !allowed.includes(key))) {
    throw new CoreError('INVALID_INPUT', 'The product request contains unsupported fields.')
  }
  switch (endpoint as ProductCapabilityEndpoint) {
    case 'capability-list': return service.list(payload as unknown as { instanceId: string })
    case 'capability-read': return service.read(payload as unknown as { instanceId: string; capabilityId: string })
    case 'capability-resolve': return service.resolve(payload as unknown as {
      instanceId: string
      scope: ProductCapabilityScope
    })
    case 'capability-save': return service.save(payload as unknown as SaveProductCapabilityInput)
    case 'capability-delete': return service.remove(payload as unknown as {
      instanceId: string
      commandId: string
      capabilityId: string
      expectedRevision: number
    })
    case 'capability-approve': return service.approve(payload as unknown as {
      instanceId: string
      commandId: string
      capabilityId: string
      expectedRevision: number
      approved: boolean
    })
    case 'capability-bind': return service.bind(payload as unknown as {
      instanceId: string
      commandId: string
      capabilityId: string
      expectedRevision: number
      scope: ProductCapabilityScope
      active: boolean
    })
    default: throw new CoreError('UNAVAILABLE', 'This product capability is not connected yet.')
  }
}
