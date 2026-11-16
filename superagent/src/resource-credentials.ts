import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'

export type CredentialRole = 'main' | 'router' | 'worker'
export type CredentialPurpose = 'source' | 'tool' | 'outbound'
export interface CredentialScope {
  role: CredentialRole
  workItemId?: string
  environmentId?: string
  sourceInstanceId?: string
}
export interface CredentialGrant {
  id: string
  scope: CredentialScope
  purposes: CredentialPurpose[]
  grantedAt: number
}
export interface CredentialResourceView {
  id: string
  instanceId: string
  label: string
  status: 'active' | 'deleted'
  revision: number
  grants: CredentialGrant[]
  cleanupPending?: boolean
  createdAt: number
  updatedAt: number
}
export interface CredentialRequest {
  id: string
  resourceId: string
  scope: CredentialScope
  purpose: CredentialPurpose
  status: 'pending' | 'cancelled' | 'granted'
  createdAt: number
  updatedAt: number
}
export interface CredentialUse extends CredentialScope {
  instanceId: string
  resourceId: string
  purpose: CredentialPurpose
}

/** A Host-owned vault port. The business database only stores its opaque reference. */
export interface CredentialVault {
  assertReference(instanceId: string, reference: string): Promise<void>
  withSecret<T>(instanceId: string, reference: string, consume: (secret: string) => Promise<T>): Promise<T>
}

interface StoredResource extends CredentialResourceView { vaultReference?: string }
interface CommandReceipt { fingerprint: string; result: CredentialResourceView | CredentialRequest }
interface RotationIntentRecord { resourceId: string; expectedRevision: number; previousReference: string;
  nextReference: string; status: 'pending' | 'committed' | 'abandoned' }

const purposes: CredentialPurpose[] = ['source', 'tool', 'outbound']
const roles: CredentialRole[] = ['main', 'router', 'worker']

function fields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new CoreError('INVALID_INPUT', `Invalid ${label} fields.`)
  }
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim()) > 128) {
    throw new CoreError('INVALID_INPUT', 'A resource needs a label of 1 to 128 bytes.')
  }
  return value.trim()
}

function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CoreError('INVALID_INPUT', 'An expected resource revision is required.')
}

function scope(value: unknown): CredentialScope {
  fields(value, ['role', 'workItemId', 'environmentId', 'sourceInstanceId'], 'resource scope')
  if (!roles.includes(value.role as CredentialRole)) throw new CoreError('INVALID_INPUT', 'A resource scope needs an explicit role.')
  const result: CredentialScope = { role: value.role as CredentialRole }
  for (const key of ['workItemId', 'environmentId', 'sourceInstanceId'] as const) {
    if (value[key] !== undefined) {
      identifier(value[key], key)
      result[key] = value[key]
    }
  }
  return result
}

function purpose(value: unknown): CredentialPurpose {
  if (!purposes.includes(value as CredentialPurpose)) throw new CoreError('INVALID_INPUT', 'Unknown credential purpose.')
  return value as CredentialPurpose
}

function grantPurposes(value: unknown, target: CredentialScope): CredentialPurpose[] {
  if (!Array.isArray(value) || !value.length || value.length > purposes.length
    || value.some(item => !purposes.includes(item)) || new Set(value).size !== value.length) {
    throw new CoreError('INVALID_INPUT', 'Choose distinct resource purposes.')
  }
  const normalized = purposes.filter(item => value.includes(item))
  if (normalized.some(item => item !== 'tool') && target.sourceInstanceId === undefined) {
    throw new CoreError('INVALID_INPUT', 'Source and outbound grants need an exact source Instance.')
  }
  return normalized
}

function view(record: StoredResource): CredentialResourceView {
  const { id, instanceId, label: name, status, revision: version, grants, createdAt, updatedAt } = record
  return { id, instanceId, label: name, status, revision: version, grants: structuredClone(grants), createdAt, updatedAt,
    ...(status === 'deleted' && record.vaultReference ? { cleanupPending: true } : {}) }
}

function fingerprint(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

/** Only a trusted Host can construct this store or supply its vault and use callback. */
export class ResourceCredentials {
  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly vault: CredentialVault, private readonly now: () => number = Date.now) {
    identifier(instanceId, 'instanceId')
  }

  private assertInstance(instanceId: unknown) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The resource belongs to another Instance.')
  }

  private async command<T extends CredentialResourceView | CredentialRequest>(commandId: unknown, input: unknown,
    apply: (tx: AsyncTx) => Promise<T>): Promise<T> {
    identifier(commandId, 'commandId')
    const hash = fingerprint(input)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<CommandReceipt>('resource-command', commandId)
      if (prior) {
        if (prior.fingerprint !== hash) throw new CoreError('IDENTITY_CONFLICT', 'This resource command ID has different input.')
        return prior.result as T
      }
      const result = await apply(tx)
      await tx.insert<CommandReceipt>('resource-command', commandId, { fingerprint: hash, result })
      return result
    })
  }

  private async active(tx: AsyncTx, id: string) {
    const record = await tx.get<StoredResource>('resource-credential', id)
    if (!record || record.status !== 'active' || !record.vaultReference) {
      throw new CoreError('RESOURCE_UNAVAILABLE', 'The resource is unavailable.')
    }
    return record
  }

  async creationReceipt(input: { instanceId: string; commandId: string; label: string; vaultReference: string }) {
    this.assertInstance(input.instanceId); identifier(input.commandId, 'commandId')
    const name = label(input.label)
    identifier(input.vaultReference, 'vaultReference')
    const expected = fingerprint(['create', this.instanceId, name, input.vaultReference])
    return this.storage.transaction(this.instanceId, async tx => {
      const receipt = await tx.get<CommandReceipt>('resource-command', input.commandId)
      if (!receipt) return undefined
      if (receipt.fingerprint !== expected || !('id' in receipt.result)) {
        throw new CoreError('IDENTITY_CONFLICT', 'The resource creation command changed.')
      }
      return receipt.result as CredentialResourceView
    })
  }

  async create(input: { instanceId: string; commandId: string; label: string; vaultReference: string;
    intentCommandId?: string }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'label', 'vaultReference', 'intentCommandId'], 'resource creation')
    this.assertInstance(input.instanceId)
    const name = label(input.label)
    identifier(input.vaultReference, 'vaultReference')
    if (input.intentCommandId !== undefined) identifier(input.intentCommandId, 'intentCommandId')
    return this.command(input.commandId, ['create', this.instanceId, name, input.vaultReference], async tx => {
      if (input.intentCommandId !== undefined) {
        const intent = await tx.get<{ status: string; reference: string }>('resource-vault-intent', input.intentCommandId)
        if (intent?.status !== 'pending' || intent.reference !== input.vaultReference) {
          throw new CoreError('RESOURCE_UNAVAILABLE', 'This credential creation is no longer authorized.')
        }
      }
      await this.assertVault(input.vaultReference)
      const at = this.now()
      const record: StoredResource = { id: randomUUID(), instanceId: this.instanceId, label: name,
        vaultReference: input.vaultReference, status: 'active', revision: 1, grants: [], createdAt: at, updatedAt: at }
      await tx.insert('resource-credential', record.id, record)
      return view(record)
    })
  }

  async update(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    label?: string; vaultReference?: string }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'label', 'vaultReference'], 'resource update')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); revision(input.expectedRevision)
    if (input.label === undefined && input.vaultReference === undefined) throw new CoreError('INVALID_INPUT', 'Choose a label or a vault reference to update.')
    const name = input.label === undefined ? undefined : label(input.label)
    if (input.vaultReference !== undefined) identifier(input.vaultReference, 'vaultReference')
    return this.command(input.commandId, ['update', input.resourceId, input.expectedRevision, name ?? null, input.vaultReference ?? null], async tx => {
      const current = await this.active(tx, input.resourceId)
      this.assertRevision(current, input.expectedRevision)
      if (input.vaultReference !== undefined) await this.assertVault(input.vaultReference)
      const next: StoredResource = { ...current, label: name ?? current.label,
        ...(input.vaultReference === undefined ? {} : { vaultReference: input.vaultReference }),
        revision: current.revision + 1, updatedAt: this.now() }
      await tx.replace('resource-credential', current.id, next)
      return view(next)
    })
  }

  /** Switch the reference and settle its cleanup intent in the same business transaction. */
  async rotate(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    previousReference: string; nextReference: string }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'previousReference', 'nextReference'], 'resource rotation')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); revision(input.expectedRevision)
    identifier(input.previousReference, 'previousReference'); identifier(input.nextReference, 'nextReference')
    if (input.previousReference === input.nextReference) throw new CoreError('INVALID_INPUT', 'Rotation needs a new vault record.')
    return this.command(input.commandId, ['rotate', input.resourceId, input.expectedRevision, input.nextReference], async tx => {
      const intent = await tx.get<RotationIntentRecord>('resource-rotation-intent', input.commandId)
      if (intent?.status !== 'pending' || intent.resourceId !== input.resourceId
        || intent.expectedRevision !== input.expectedRevision || intent.previousReference !== input.previousReference
        || intent.nextReference !== input.nextReference) {
        throw new CoreError('RESOURCE_UNAVAILABLE', 'This credential rotation is no longer authorized.')
      }
      const current = await this.active(tx, input.resourceId)
      this.assertRevision(current, input.expectedRevision)
      if (current.vaultReference !== input.previousReference) throw new CoreError('RESOURCE_REVISION_CONFLICT', 'The resource changed since this command was prepared.')
      await this.assertVault(input.nextReference)
      const next = { ...current, vaultReference: input.nextReference, revision: current.revision + 1, updatedAt: this.now() }
      await tx.replace('resource-credential', current.id, next)
      await tx.replace('resource-rotation-intent', input.commandId, { ...intent, status: 'committed' })
      return view(next)
    })
  }

  async rotationReceipt(input: { instanceId: string; commandId: string; resourceId: string;
    expectedRevision: number; nextReference: string }) {
    this.assertInstance(input.instanceId); identifier(input.commandId, 'commandId'); identifier(input.resourceId, 'resourceId')
    revision(input.expectedRevision); identifier(input.nextReference, 'nextReference')
    const expected = fingerprint(['rotate', input.resourceId, input.expectedRevision, input.nextReference])
    return this.storage.transaction(this.instanceId, async tx => {
      const receipt = await tx.get<CommandReceipt>('resource-command', input.commandId)
      if (!receipt) return undefined
      if (receipt.fingerprint !== expected) throw new CoreError('IDENTITY_CONFLICT', 'The resource rotation command changed.')
      return receipt.result as CredentialResourceView
    })
  }

  async request(input: { instanceId: string; commandId: string; resourceId: string; scope: CredentialScope;
    purpose: CredentialPurpose }): Promise<CredentialRequest> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'scope', 'purpose'], 'resource request')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId')
    const target = scope(input.scope)
    const requestedPurpose = purpose(input.purpose)
    grantPurposes([requestedPurpose], target)
    return this.command(input.commandId, ['request', input.resourceId, target, requestedPurpose], async tx => {
      await this.active(tx, input.resourceId)
      const at = this.now()
      const request: CredentialRequest = { id: randomUUID(), resourceId: input.resourceId, scope: target,
        purpose: requestedPurpose, status: 'pending', createdAt: at, updatedAt: at }
      await tx.insert('resource-request', request.id, request)
      return request
    })
  }

  async cancel(input: { instanceId: string; commandId: string; requestId: string }): Promise<CredentialRequest> {
    fields(input, ['instanceId', 'commandId', 'requestId'], 'request cancellation')
    this.assertInstance(input.instanceId); identifier(input.requestId, 'requestId')
    return this.command(input.commandId, ['cancel', input.requestId], async tx => {
      const current = await tx.get<CredentialRequest>('resource-request', input.requestId)
      if (!current || current.status !== 'pending') throw new CoreError('REQUEST_UNAVAILABLE', 'The pending request is unavailable.')
      const next: CredentialRequest = { ...current, status: 'cancelled', updatedAt: this.now() }
      await tx.replace('resource-request', input.requestId, next)
      return next
    })
  }

  async grant(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    scope: CredentialScope; purposes: CredentialPurpose[]; requestId?: string }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'scope', 'purposes', 'requestId'], 'resource grant')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); revision(input.expectedRevision)
    if (input.requestId !== undefined) identifier(input.requestId, 'requestId')
    const target = scope(input.scope)
    const allowed = grantPurposes(input.purposes, target)
    return this.command(input.commandId, ['grant', input.resourceId, input.expectedRevision, target, allowed, input.requestId ?? null], async tx => {
      const current = await this.active(tx, input.resourceId)
      this.assertRevision(current, input.expectedRevision)
      if (current.grants.some(grant => canonicalJson(grant.scope) === canonicalJson(target)
        && grant.purposes.some(item => allowed.includes(item)))) throw new CoreError('GRANT_CONFLICT', 'The resource is already granted for this scope and purpose.')
      if (input.requestId !== undefined) {
        const request = await tx.get<CredentialRequest>('resource-request', input.requestId)
        if (!request || request.status !== 'pending' || request.resourceId !== current.id
          || canonicalJson(request.scope) !== canonicalJson(target) || allowed.length !== 1 || request.purpose !== allowed[0]) {
          throw new CoreError('REQUEST_UNAVAILABLE', 'The pending request is unavailable.')
        }
        await tx.replace('resource-request', request.id, { ...request, status: 'granted', updatedAt: this.now() })
      }
      const next: StoredResource = { ...current, grants: [...current.grants, { id: randomUUID(), scope: target, purposes: allowed,
        grantedAt: this.now() }], revision: current.revision + 1, updatedAt: this.now() }
      await tx.replace('resource-credential', current.id, next)
      return view(next)
    })
  }

  async revoke(input: { instanceId: string; commandId: string; resourceId: string; grantId: string;
    expectedRevision: number }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'grantId', 'expectedRevision'], 'resource revocation')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); identifier(input.grantId, 'grantId')
    revision(input.expectedRevision)
    return this.command(input.commandId, ['revoke', input.resourceId, input.grantId, input.expectedRevision], async tx => {
      const current = await this.active(tx, input.resourceId)
      this.assertRevision(current, input.expectedRevision)
      if (!current.grants.some(grant => grant.id === input.grantId)) throw new CoreError('GRANT_DENIED', 'The grant is unavailable.')
      const next: StoredResource = { ...current, grants: current.grants.filter(grant => grant.id !== input.grantId),
        revision: current.revision + 1, updatedAt: this.now() }
      await tx.replace('resource-credential', current.id, next)
      return view(next)
    })
  }

  async delete(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number }): Promise<CredentialResourceView> {
    fields(input, ['instanceId', 'commandId', 'resourceId', 'expectedRevision'], 'resource deletion')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); revision(input.expectedRevision)
    return this.command(input.commandId, ['delete', input.resourceId, input.expectedRevision], async tx => {
      const current = await this.active(tx, input.resourceId)
      this.assertRevision(current, input.expectedRevision)
      const next: StoredResource = { ...current, status: 'deleted', grants: [], revision: current.revision + 1, updatedAt: this.now() }
      await tx.replace('resource-credential', current.id, next)
      return view(next)
    })
  }

  /** Only a trusted Host may drain deleted vault references; no user projection includes them. */
  async pendingVaultDeletes(input: { instanceId: string; after?: string; limit?: number }) {
    this.assertInstance(input.instanceId)
    if (input.after !== undefined) identifier(input.after, 'after')
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Use a bounded cleanup page.')
    return this.storage.transaction(this.instanceId, async tx => {
      const page = await tx.scan<StoredResource>('resource-credential', { limit,
        ...(input.after === undefined ? {} : { after: input.after }) })
      return { items: page.items.filter(item => item.value.status === 'deleted' && item.value.vaultReference)
        .map(item => ({ resourceId: item.value.id, reference: item.value.vaultReference! })),
        ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
  }

  async deletedVaultReference(input: { instanceId: string; resourceId: string }) {
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId')
    return this.storage.transaction(this.instanceId, async tx => {
      const record = await tx.get<StoredResource>('resource-credential', input.resourceId)
      if (!record || record.status !== 'deleted') throw new CoreError('RESOURCE_UNAVAILABLE', 'The deleted resource is unavailable.')
      return record.vaultReference
    })
  }

  async confirmVaultDeletion(input: { instanceId: string; resourceId: string; reference: string }) {
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId'); identifier(input.reference, 'reference')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await tx.get<StoredResource>('resource-credential', input.resourceId)
      if (!current || current.status !== 'deleted') throw new CoreError('RESOURCE_UNAVAILABLE', 'The deleted resource is unavailable.')
      if (current.vaultReference === undefined) return
      if (current.vaultReference !== input.reference) throw new CoreError('RESOURCE_UNAVAILABLE', 'The vault reference changed.')
      const { vaultReference: _reference, ...cleaned } = current
      await tx.replace('resource-credential', current.id, cleaned)
    })
  }

  async get(input: { instanceId: string; resourceId: string }): Promise<CredentialResourceView | undefined> {
    fields(input, ['instanceId', 'resourceId'], 'resource query')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId')
    const record = await this.storage.transaction(this.instanceId, tx => tx.get<StoredResource>('resource-credential', input.resourceId))
    return record && view(record)
  }

  async list(input: { instanceId: string; after?: string; limit?: number }): Promise<{ items: CredentialResourceView[]; cursor?: string }> {
    fields(input, ['instanceId', 'after', 'limit'], 'resource list')
    this.assertInstance(input.instanceId)
    if (input.after !== undefined) identifier(input.after, 'after')
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Resource page limit must be between 1 and 100.')
    return this.storage.transaction(this.instanceId, async tx => {
      const page = await tx.scan<StoredResource>('resource-credential', { limit, ...(input.after ? { after: input.after } : {}) })
      return { items: page.items.map(item => view(item.value)), ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
  }

  async getRequest(input: { instanceId: string; requestId: string }): Promise<CredentialRequest | undefined> {
    fields(input, ['instanceId', 'requestId'], 'request query')
    this.assertInstance(input.instanceId); identifier(input.requestId, 'requestId')
    return this.storage.transaction(this.instanceId, tx => tx.get<CredentialRequest>('resource-request', input.requestId))
  }

  /** Trusted adapters call this at the use site; model tools receive no vault reference. */
  async use<T>(input: CredentialUse, consume: (secret: string) => Promise<T>): Promise<T> {
    fields(input, ['instanceId', 'resourceId', 'role', 'workItemId', 'environmentId', 'sourceInstanceId', 'purpose'], 'resource use')
    this.assertInstance(input.instanceId); identifier(input.resourceId, 'resourceId')
    if (typeof consume !== 'function') throw new CoreError('INVALID_INPUT', 'A trusted resource consumer is required.')
    const requested = scope({ role: input.role, ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      ...(input.sourceInstanceId === undefined ? {} : { sourceInstanceId: input.sourceInstanceId }) })
    const requestedPurpose = purpose(input.purpose)
    grantPurposes([requestedPurpose], requested)
    const reference = await this.storage.transaction(this.instanceId, async tx => {
      const current = await this.active(tx, input.resourceId)
      if (!current.grants.some(grant => grant.purposes.includes(requestedPurpose)
        && grant.scope.role === requested.role && (grant.scope.workItemId === undefined || grant.scope.workItemId === requested.workItemId)
        && (grant.scope.environmentId === undefined || grant.scope.environmentId === requested.environmentId)
        && (grant.scope.sourceInstanceId === undefined || grant.scope.sourceInstanceId === requested.sourceInstanceId))) {
        throw new CoreError('GRANT_DENIED', 'This resource is not granted for the requested use.')
      }
      return current.vaultReference!
    })
    // Vault and consumer errors may contain a secret; never forward their text to callers or logs.
    try { return await this.vault.withSecret(this.instanceId, reference, consume) }
    catch { throw new CoreError('CREDENTIAL_USE_FAILED', 'The credential could not be used.') }
  }

  private async assertVault(reference: string) {
    try { await this.vault.assertReference(this.instanceId, reference) }
    catch { throw new CoreError('RESOURCE_UNAVAILABLE', 'The vault reference is unavailable for this Instance.') }
  }

  private assertRevision(record: StoredResource, expected: number) {
    if (record.revision !== expected) throw new CoreError('RESOURCE_REVISION_CONFLICT', 'The resource changed since this command was prepared.')
  }
}
