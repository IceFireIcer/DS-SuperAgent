import { createHash } from 'node:crypto'
import { CoreError, identifier } from './model.js'
import { canonicalJson, commandTransaction } from './commands.js'
import { ProductCredentialVault, assertCredentialValue, type ProductCredentialRecords } from './product-credential-vault.js'
import { ResourceCredentials, type CredentialPurpose, type CredentialResourceView, type CredentialScope, type CredentialUse } from './resource-credentials.js'
import type { Storage } from './storage.js'

interface CreationIntent {
  commandId: string
  instanceId: string
  label: string
  reference: string
  status: 'pending' | 'created' | 'abandoned'
  resourceId?: string
  createdAt: number
}
interface RotationIntent {
  commandId: string
  resourceId: string
  expectedRevision: number
  previousReference: string
  nextReference: string
  status: 'pending' | 'committed' | 'abandoned'
  cleanupPending: boolean
  createdAt: number
}

/** Host-only commands; the supplied Storage must enforce the current Host lease. */
export class ProductCredentialManager {
  private readonly vault: ProductCredentialVault
  private readonly resources: ResourceCredentials
  private readonly creating = new Map<string, { label: string; value: string; promise: Promise<CredentialResourceView> }>()
  private recoveryCursor: string | undefined
  private readonly rotating = new Map<string, { resourceId: string; expectedRevision: number; value: string;
    promise: Promise<{ status: 'committed'; resource: CredentialResourceView; cleanupPending: boolean }> }>()
  private rotationCursor: string | undefined

  constructor(private readonly storage: Storage, private readonly instanceId: string, records: ProductCredentialRecords) {
    identifier(instanceId, 'instanceId')
    this.vault = new ProductCredentialVault(records)
    this.resources = new ResourceCredentials(storage, instanceId, this.vault)
  }

  async create(request: { instanceId: string; commandId: string; label: string; value: string }) {
    this.assertInstance(request.instanceId)
    identifier(request.commandId, 'commandId')
    if (typeof request.label !== 'string' || !request.label.trim() || Buffer.byteLength(request.label.trim()) > 128) {
      throw new CoreError('INVALID_INPUT', 'Choose a resource label of at most 128 bytes.')
    }
    const existing = this.creating.get(request.commandId)
    if (existing) {
      if (existing.label !== request.label.trim() || existing.value !== request.value) {
        throw new CoreError('IDENTITY_CONFLICT', 'The resource creation command changed.')
      }
      return existing.promise
    }
    const promise = this.createOne(request)
    this.creating.set(request.commandId, { label: request.label.trim(), value: request.value, promise })
    try { return await promise } finally { this.creating.delete(request.commandId) }
  }

  private async createOne(request: { instanceId: string; commandId: string; label: string; value: string }): Promise<CredentialResourceView> {
    const name = request.label.trim()
    const reference = this.vault.referenceFor(this.instanceId, request.commandId)
    const command = { instanceId: this.instanceId, commandId: request.commandId, label: name, vaultReference: reference }
    const committed = await this.resources.creationReceipt(command)
    if (committed) return this.createdView(committed, request.value, reference)
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<CreationIntent>('resource-vault-intent', request.commandId)
      if (prior) {
        if (prior.label !== name || prior.reference !== reference) throw new CoreError('IDENTITY_CONFLICT', 'The resource creation command changed.')
        if (prior.status === 'abandoned') throw new CoreError('RESOURCE_UNAVAILABLE', 'This credential creation was abandoned after Host recovery.')
        return
      }
      await tx.insert('resource-vault-intent', request.commandId, { commandId: request.commandId,
        instanceId: this.instanceId, label: name, reference, status: 'pending', createdAt: Date.now() } satisfies CreationIntent)
    })
    const prior = await this.resources.creationReceipt(command)
    if (prior) {
      await this.markCreated(request.commandId, prior.id)
      return this.createdView(prior, request.value, reference)
    }
    await this.vault.create(this.instanceId, request.value, request.commandId)
    try {
      const created = await this.resources.create({ ...command, intentCommandId: request.commandId })
      await this.markCreated(request.commandId, created.id)
      return await this.resources.get({ instanceId: this.instanceId, resourceId: created.id }) ?? created
    } catch (error) {
      if (error instanceof CoreError && (error.code === 'HOST_LEASED' || error.code === 'RESOURCE_UNAVAILABLE')) {
        await this.vault.ensureRevoked(this.instanceId, reference).catch(() => {})
      }
      throw error
    }
  }

  private async createdView(receipt: CredentialResourceView, value: string, reference: string) {
    const current = await this.resources.get({ instanceId: this.instanceId, resourceId: receipt.id })
    if (!current) throw new CoreError('INCOMPLETE_STATE', 'The accepted resource record is unavailable.')
    if (current.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'This creation command belongs to a deleted resource.')
    const same = await this.vault.withSecret(this.instanceId, reference, async original => original === value)
    if (!same) throw new CoreError('IDENTITY_CONFLICT', 'The resource creation command changed.')
    return current
  }

  private async markCreated(commandId: string, resourceId: string) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const intent = await tx.get<CreationIntent>('resource-vault-intent', commandId)
      if (!intent || intent.status === 'created' && intent.resourceId !== resourceId) {
        throw new CoreError('INCOMPLETE_STATE', 'The resource creation intent changed.')
      }
      if (intent.status !== 'created') await tx.replace('resource-vault-intent', commandId,
        { ...intent, status: 'created', resourceId })
    })
  }

  async resumeCreations() {
    let after = this.recoveryCursor
    let reconciled = 0
    let pending = 0
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.storage.transaction(this.instanceId, tx => tx.scan<CreationIntent>('resource-vault-intent',
        { limit: 100, ...(after === undefined ? {} : { after }) }))
      for (const item of page.items.filter(entry => entry.value.status !== 'created')) {
        const intent = item.value
        if (this.creating.has(intent.commandId)) { pending++; continue }
        try {
          const receipt = await this.resources.creationReceipt({ instanceId: this.instanceId, commandId: intent.commandId,
            label: intent.label, vaultReference: intent.reference })
          if (receipt) await this.markCreated(intent.commandId, receipt.id)
          else {
            await this.vault.ensureRevoked(this.instanceId, intent.reference)
            // A delayed old Host write can arrive after this scan. Keep a durable tombstone for later cleanup.
            await commandTransaction(this.storage, this.instanceId, async tx => {
              const current = await tx.get<CreationIntent>('resource-vault-intent', intent.commandId)
              if (current?.status === 'pending') await tx.replace('resource-vault-intent', intent.commandId,
                { ...current, status: 'abandoned' })
            })
          }
          reconciled++
        } catch { pending++ }
      }
      if (!page.cursor) {
        this.recoveryCursor = undefined
        return { reconciled, pending }
      }
      after = page.cursor
    }
    this.recoveryCursor = after
    return { reconciled, pending, more: true }
  }

  list(request: { instanceId: string; after?: string; limit?: number }) { return this.resources.list(request) }
  get(request: { instanceId: string; resourceId: string }) { return this.resources.get(request) }
  getRequest(request: { instanceId: string; requestId: string }) { return this.resources.getRequest(request) }
  listRequests(request: { instanceId: string; after?: string; limit?: number }) { return this.resources.listRequests(request) }
  request(request: { instanceId: string; commandId: string; resourceId: string; scope: CredentialScope; purpose: CredentialPurpose }) {
    return this.resources.request(request)
  }
  cancel(request: { instanceId: string; commandId: string; requestId: string }) { return this.resources.cancel(request) }
  grant(request: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    scope: CredentialScope; purposes: CredentialPurpose[]; requestId?: string }) { return this.resources.grant(request) }
  revokeGrant(request: { instanceId: string; commandId: string; resourceId: string; grantId: string; expectedRevision: number }) {
    return this.resources.revoke(request)
  }
  rename(request: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number; label: string }) {
    return this.resources.update(request)
  }

  async rotate(request: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number; value: string }) {
    this.assertInstance(request.instanceId)
    identifier(request.commandId, 'commandId'); identifier(request.resourceId, 'resourceId')
    assertCredentialValue(request.value)
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new CoreError('INVALID_INPUT', 'An expected resource revision is required.')
    }
    const existing = this.rotating.get(request.commandId)
    if (existing) {
      if (existing.resourceId !== request.resourceId || existing.expectedRevision !== request.expectedRevision
        || existing.value !== request.value) throw new CoreError('IDENTITY_CONFLICT', 'The credential rotation command changed.')
      return existing.promise
    }
    const promise = this.rotateOne(request)
    this.rotating.set(request.commandId, { resourceId: request.resourceId, expectedRevision: request.expectedRevision,
      value: request.value, promise })
    try { return await promise } finally { this.rotating.delete(request.commandId) }
  }

  private async rotateOne(request: { instanceId: string; commandId: string; resourceId: string;
    expectedRevision: number; value: string }) {
    const nextReference = this.vault.referenceFor(this.instanceId, `rotation:${request.resourceId}:${request.commandId}`)
    const receipt = { instanceId: this.instanceId, commandId: request.commandId, resourceId: request.resourceId,
      expectedRevision: request.expectedRevision, nextReference }
    const accepted = await this.resources.rotationReceipt(receipt)
    if (accepted) {
      const current = await this.rotationStatus({ instanceId: this.instanceId, commandId: request.commandId })
      if (current?.status !== 'committed' || current.resource?.status !== 'active'
        || current.resource.revision < accepted.revision) throw new CoreError('RESOURCE_UNAVAILABLE', 'The rotated resource is unavailable.')
      const stillCurrent = await this.storage.transaction(this.instanceId, async tx =>
        (await tx.get<{ vaultReference?: string }>('resource-credential', request.resourceId))?.vaultReference === nextReference)
      if (!stillCurrent || !await this.vault.withSecret(this.instanceId, nextReference, async value => value === request.value)) {
        throw new CoreError('IDENTITY_CONFLICT', 'The credential rotation command changed or was superseded.')
      }
      await this.cleanupRotation(request.commandId).catch(() => {})
      return this.committedRotation(request.commandId)
    }
    const intent = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<RotationIntent>('resource-rotation-intent', request.commandId)
      if (prior) {
        if (prior.resourceId !== request.resourceId || prior.expectedRevision !== request.expectedRevision
          || prior.nextReference !== nextReference) throw new CoreError('IDENTITY_CONFLICT', 'The credential rotation command changed.')
        if (prior.status === 'abandoned') throw new CoreError('RESOURCE_UNAVAILABLE', 'This credential rotation was abandoned after recovery.')
        return prior
      }
      const resource = await tx.get<{ status: string; revision: number; vaultReference?: string }>('resource-credential', request.resourceId)
      if (resource?.status !== 'active' || !resource.vaultReference) throw new CoreError('RESOURCE_UNAVAILABLE', 'The resource is unavailable.')
      if (resource.revision !== request.expectedRevision) throw new CoreError('RESOURCE_REVISION_CONFLICT', 'The resource changed since this command was prepared.')
      const prepared: RotationIntent = { commandId: request.commandId, resourceId: request.resourceId,
        expectedRevision: request.expectedRevision, previousReference: resource.vaultReference, nextReference,
        status: 'pending', cleanupPending: true, createdAt: Date.now() }
      await tx.insert('resource-rotation-intent', request.commandId, prepared)
      return prepared
    })
    if (intent.status === 'committed') {
      throw new CoreError('COMMIT_UNKNOWN', 'Check this rotation with its original command ID.')
    }
    await this.vault.create(this.instanceId, request.value, `rotation:${request.resourceId}:${request.commandId}`)
    try {
      await this.resources.rotate({ ...receipt, previousReference: intent.previousReference })
    } catch (error) {
      if (error instanceof CoreError && ['RESOURCE_REVISION_CONFLICT', 'RESOURCE_UNAVAILABLE', 'IDENTITY_CONFLICT'].includes(error.code)) {
        await this.abandonRotation(request.commandId).catch(() => {})
        await this.cleanupRotation(request.commandId).catch(() => {})
      }
      throw error
    }
    await this.cleanupRotation(request.commandId).catch(() => {})
    return this.committedRotation(request.commandId)
  }

  rotationStatus(request: { instanceId: string; commandId: string }) {
    this.assertInstance(request.instanceId); identifier(request.commandId, 'commandId')
    return this.storage.transaction(this.instanceId, async tx => {
      const intent = await tx.get<RotationIntent>('resource-rotation-intent', request.commandId)
      if (!intent) return undefined
      const resource = await tx.get<{ id: string; instanceId: string; label: string; status: 'active' | 'deleted';
        revision: number; grants: CredentialResourceView['grants']; createdAt: number; updatedAt: number;
        vaultReference?: string }>('resource-credential', intent.resourceId)
      return { status: intent.status, resourceId: intent.resourceId, cleanupPending: intent.cleanupPending,
        ...(resource ? { resource: { id: resource.id, instanceId: resource.instanceId, label: resource.label,
          status: resource.status, revision: resource.revision, grants: structuredClone(resource.grants),
          createdAt: resource.createdAt, updatedAt: resource.updatedAt } satisfies CredentialResourceView } : {}) }
    })
  }

  private async committedRotation(commandId: string) {
    const status = await this.rotationStatus({ instanceId: this.instanceId, commandId })
    if (status?.status !== 'committed' || !status.resource) throw new CoreError('COMMIT_UNKNOWN', 'Check this rotation with its original command ID.')
    return { status: 'committed' as const, resource: status.resource, cleanupPending: status.cleanupPending }
  }

  private async abandonRotation(commandId: string) {
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const intent = await tx.get<RotationIntent>('resource-rotation-intent', commandId)
      if (intent?.status !== 'pending' || await tx.get('resource-command', commandId)) return
      await tx.replace('resource-rotation-intent', commandId, { ...intent, status: 'abandoned' })
    })
  }

  private async cleanupRotation(commandId: string) {
    const intent = await this.storage.transaction(this.instanceId, tx => tx.get<RotationIntent>('resource-rotation-intent', commandId))
    if (!intent || intent.status === 'pending') return false
    const reference = intent.status === 'committed' ? intent.previousReference : intent.nextReference
    const activeReference = await this.storage.transaction(this.instanceId, async tx =>
      (await tx.get<{ status: string; vaultReference?: string }>('resource-credential', intent.resourceId)))
    if (activeReference?.status === 'active' && activeReference.vaultReference === reference) {
      throw new CoreError('INCOMPLETE_STATE', 'An active vault record cannot be cleaned.')
    }
    try { await this.vault.ensureRevoked(this.instanceId, reference) }
    catch {
      await commandTransaction(this.storage, this.instanceId, async tx => {
        const current = await tx.get<RotationIntent>('resource-rotation-intent', commandId)
        if (current?.status === intent.status && !current.cleanupPending) {
          await tx.replace('resource-rotation-intent', commandId, { ...current, cleanupPending: true })
        }
      }).catch(() => {})
      throw new CoreError('CREDENTIAL_WRITE_FAILED', 'The credential record could not be cleaned.')
    }
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await tx.get<RotationIntent>('resource-rotation-intent', commandId)
      if (current?.status === intent.status && current.cleanupPending) {
        await tx.replace('resource-rotation-intent', commandId, { ...current, cleanupPending: false })
      }
    })
    return true
  }

  async resumeRotations() {
    let after = this.rotationCursor
    let reconciled = 0
    let pending = 0
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.storage.transaction(this.instanceId, tx => tx.scan<RotationIntent>('resource-rotation-intent',
        { limit: 100, ...(after === undefined ? {} : { after }) }))
      for (const { value: intent } of page.items) {
        if (this.rotating.has(intent.commandId)) { pending++; continue }
        try {
          if (intent.status === 'pending') await this.abandonRotation(intent.commandId)
          if (await this.cleanupRotation(intent.commandId)) reconciled++
          else pending++
        } catch { pending++ }
      }
      if (!page.cursor) { this.rotationCursor = undefined; return { reconciled, pending } }
      after = page.cursor
    }
    this.rotationCursor = after
    return { reconciled, pending, more: true }
  }

  async delete(request: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number }) {
    const deleted = await this.resources.delete(request)
    await this.cleanupOne(request.resourceId)
    return await this.resources.get({ instanceId: this.instanceId, resourceId: request.resourceId }) ?? deleted
  }

  async cleanupDeleted(request: { instanceId: string; resourceId: string }) {
    this.assertInstance(request.instanceId); identifier(request.resourceId, 'resourceId')
    await this.cleanupOne(request.resourceId)
    return this.resources.get({ instanceId: this.instanceId, resourceId: request.resourceId })
  }

  async resumeCleanup() {
    let after: string | undefined
    let cleaned = 0
    let pending = 0
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.resources.pendingVaultDeletes({ instanceId: this.instanceId, limit: 100,
        ...(after === undefined ? {} : { after }) })
      for (const item of page.items) {
        if (await this.cleanupOne(item.resourceId)) cleaned++
        else pending++
      }
      if (!page.cursor) return { cleaned, pending }
      after = page.cursor
    }
    throw new CoreError('RESOURCE_BUDGET', 'Credential cleanup exceeded its bounded scan.')
  }

  /** Invoked only by a trusted source/tool/outbound adapter at its exact use site. */
  use<T>(request: CredentialUse, consume: (value: string) => Promise<T>) { return this.resources.use(request, consume) }

  /** The Host, not the caller, supplies the exact Feishu source identity. */
  selectedFeishuCredential(sourceInstanceId: string) {
    identifier(sourceInstanceId, 'sourceInstanceId')
    return this.storage.transaction(this.instanceId, async tx =>
      (await tx.get<{ resourceId: string | null }>('product-feishu-credential', sourceInstanceId))?.resourceId ?? null)
  }

  selectFeishuCredential(request: { instanceId: string; sourceInstanceId: string; commandId: string; resourceId: string | null }) {
    this.assertInstance(request.instanceId)
    identifier(request.sourceInstanceId, 'sourceInstanceId'); identifier(request.commandId, 'commandId')
    if (request.resourceId !== null) identifier(request.resourceId, 'resourceId')
    const fingerprint = createHash('sha256').update(canonicalJson([request.sourceInstanceId, request.resourceId])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const previous = await tx.get<{ fingerprint: string; resourceId: string | null }>('product-feishu-credential-command', request.commandId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Feishu credential selection command changed.')
        return { resourceId: previous.resourceId }
      }
      if (request.resourceId !== null) {
        const resource = await tx.get<{ status: string }>('resource-credential', request.resourceId)
        if (resource?.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'Select an active credential resource.')
      }
      const selection = { resourceId: request.resourceId, updatedAt: Date.now() }
      if (!await tx.replace('product-feishu-credential', request.sourceInstanceId, selection)) {
        await tx.insert('product-feishu-credential', request.sourceInstanceId, selection)
      }
      await tx.insert('product-feishu-credential-command', request.commandId, { fingerprint, resourceId: request.resourceId })
      return { resourceId: request.resourceId }
    })
  }

  selectedGitHubCredential(sourceInstanceId: string) {
    identifier(sourceInstanceId, 'sourceInstanceId')
    return this.storage.transaction(this.instanceId, async tx =>
      (await tx.get<{ resourceId: string | null }>('product-github-credential', sourceInstanceId))?.resourceId ?? null)
  }

  selectGitHubCredential(request: { instanceId: string; sourceInstanceId: string; commandId: string; resourceId: string | null }) {
    this.assertInstance(request.instanceId)
    identifier(request.sourceInstanceId, 'sourceInstanceId'); identifier(request.commandId, 'commandId')
    if (request.resourceId !== null) identifier(request.resourceId, 'resourceId')
    const fingerprint = createHash('sha256').update(canonicalJson([request.sourceInstanceId, request.resourceId])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const previous = await tx.get<{ fingerprint: string; resourceId: string | null }>('product-github-credential-command', request.commandId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The GitHub credential selection command changed.')
        return { resourceId: previous.resourceId }
      }
      if (request.resourceId !== null) {
        const resource = await tx.get<{ status: string }>('resource-credential', request.resourceId)
        if (resource?.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'Select an active credential resource.')
      }
      const selection = { resourceId: request.resourceId, updatedAt: Date.now() }
      if (!await tx.replace('product-github-credential', request.sourceInstanceId, selection)) {
        await tx.insert('product-github-credential', request.sourceInstanceId, selection)
      }
      await tx.insert('product-github-credential-command', request.commandId, { fingerprint, resourceId: request.resourceId })
      return { resourceId: request.resourceId }
    })
  }

  private async cleanupOne(resourceId: string): Promise<boolean> {
    const reference = await this.resources.deletedVaultReference({ instanceId: this.instanceId, resourceId })
    if (!reference) return true
    try {
      await this.vault.ensureRevoked(this.instanceId, reference)
      await this.resources.confirmVaultDeletion({ instanceId: this.instanceId, resourceId, reference })
      return true
    } catch { return false }
  }

  private assertInstance(instanceId: string) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The resource belongs to another Instance.')
  }
}
