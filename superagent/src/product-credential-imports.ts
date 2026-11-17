import { createHash } from 'node:crypto'
import { canonicalJson } from './commands.js'
import { CoreError, identifier } from './model.js'
import type { CredentialPurpose, CredentialScope } from './resource-credentials.js'
import type { Storage } from './storage.js'
import type { ProductCredentialManager } from './product-credential-manager.js'
import { credentialLike } from './product-memory-import.js'

export interface CredentialImportPreview {
  owner: { label: string; instanceId?: string }
  sourceLabel: string
  entries: Array<{ id: string; label: string; type: 'api-key' | 'token' | 'password';
    originalScope: { kind: 'main' | 'work' | 'shared' | 'unknown'; role?: string; work?: string;
      environment?: string; sharedWith?: string[] }; sourceRef: string }>
}
export interface CredentialImportValue {
  id: string
  sourceRef: string
  value: string
}
export interface CredentialImportAdapter {
  read(pendingId: string, credentialId: string, sourceRef: string): Promise<CredentialImportValue>
  finish?(pendingId: string, sourceRef: string): Promise<void>
  cancel?(pendingId: string, sourceRef: string): Promise<void>
}
export interface CredentialImportRecord {
  id: string
  instanceId: string
  sourceRef: string
  owner: CredentialImportPreview['owner']
  sourceLabel: string
  credentialId: string
  credentialLabel: string
  credentialType: CredentialImportPreview['entries'][number]['type']
  originalScope: CredentialImportPreview['entries'][number]['originalScope']
  attempt: number
  status: 'pending' | 'importing' | 'unknown' | 'applied' | 'conflict' | 'cancelled'
  target?: { label: string; scope: CredentialScope; purpose: CredentialPurpose }
  resourceId?: string
  grantId?: string
  cleanupPending?: boolean
  code?: string
  createdAt: number
  updatedAt: number
}
interface CredentialImportCommand { operation: 'commit' | 'cancel'; fingerprint: string; sourceRef: string }

const attemptSuffix = (attempt: number) => attempt === 0 ? '' : `:retry:${attempt}`
const createCommandId = (sourceRef: string, attempt = 0) => `credential-import:${sourceRef}:create${attemptSuffix(attempt)}`
const grantCommandId = (sourceRef: string, attempt = 0) => `credential-import:${sourceRef}:grant${attemptSuffix(attempt)}`
const cancelCommandId = (sourceRef: string, attempt = 0) => `credential-import:${sourceRef}:cancel${attemptSuffix(attempt)}`
const importCommandKey = (instanceId: string, commandId: string) => createHash('sha256')
  .update(canonicalJson(['product-credential-import-command-v1', instanceId, commandId])).digest('hex')

function sourceRef(owner: CredentialImportPreview['owner'], credentialId: string) {
  return createHash('sha256').update(canonicalJson([
    'credential-import-source-v1', owner.instanceId ?? '', owner.label, credentialId,
  ])).digest('hex')
}

function text(value: unknown, label: string, max = 256) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || credentialLike(value)) {
    throw new CoreError('INVALID_INPUT', `${label} must be bounded text without credentials.`)
  }
  return value.trim()
}

function previewOf(value: unknown): CredentialImportPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'A credential export preview is required.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['owner', 'sourceLabel', 'entries'].includes(key))) {
    throw new CoreError('INVALID_INPUT', 'Credential preview has unsupported fields.')
  }
  const ownerValue = input.owner
  if (!ownerValue || typeof ownerValue !== 'object' || Array.isArray(ownerValue)) throw new CoreError('INVALID_INPUT', 'Credential preview needs its original owner.')
  const rawOwner = ownerValue as Record<string, unknown>
  if (Object.keys(rawOwner).some(key => !['label', 'instanceId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Credential owner has unsupported fields.')
  const owner = { label: text(rawOwner.label, 'Original owner'),
    ...(rawOwner.instanceId === undefined ? {} : { instanceId: text(rawOwner.instanceId, 'Original Instance') }) }
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 50) {
    throw new CoreError('INVALID_INPUT', 'Credential preview must contain one to 50 entries.')
  }
  const seen = new Set<string>()
  const entries = input.entries.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `Credential entry ${index + 1} is invalid.`)
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !['id', 'label', 'type', 'originalScope', 'sourceRef'].includes(key))) {
      throw new CoreError('INVALID_INPUT', `Credential entry ${index + 1} has unsupported fields.`)
    }
    const id = text(item.id, `Credential entry ${index + 1} ID`, 128)
    if (seen.has(id)) throw new CoreError('INVALID_INPUT', 'Credential preview IDs must be unique.')
    seen.add(id)
    if (!['api-key', 'token', 'password'].includes(item.type as string)) throw new CoreError('INVALID_INPUT', 'Credential type is unsupported.')
    const rawScope = item.originalScope
    if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) throw new CoreError('INVALID_INPUT', 'Original scope is required.')
    const scope = rawScope as Record<string, unknown>
    if (Object.keys(scope).some(key => !['kind', 'role', 'work', 'environment', 'sharedWith'].includes(key))
      || !['main', 'work', 'shared', 'unknown'].includes(scope.kind as string)) {
      throw new CoreError('INVALID_INPUT', 'Original scope has unsupported fields.')
    }
    const sharedWith = scope.sharedWith
    if (sharedWith !== undefined && (!Array.isArray(sharedWith) || sharedWith.length > 20)) {
      throw new CoreError('INVALID_INPUT', 'Original shared scope is invalid.')
    }
    const originalScope = { kind: scope.kind as CredentialImportRecord['originalScope']['kind'],
      ...(scope.role === undefined ? {} : { role: text(scope.role, 'Original role') }),
      ...(scope.work === undefined ? {} : { work: text(scope.work, 'Original work') }),
      ...(scope.environment === undefined ? {} : { environment: text(scope.environment, 'Original Environment') }),
      ...(sharedWith === undefined ? {} : { sharedWith: sharedWith.map((entry, position) => text(entry, `Original reader ${position + 1}`)) }) }
    const expected = sourceRef(owner, id)
    if (item.sourceRef !== expected) throw new CoreError('INVALID_INPUT', 'Credential source reference does not match its exported identity.')
    return { id, label: text(item.label, `Credential entry ${index + 1} label`),
      type: item.type as CredentialImportPreview['entries'][number]['type'], originalScope, sourceRef: expected }
  })
  return { owner, sourceLabel: text(input.sourceLabel, 'Export source label'), entries }
}

function normalizeTarget(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Choose a new credential target.')
  const target = value as Record<string, unknown>
  if (Object.keys(target).some(key => !['label', 'scope', 'purpose'].includes(key))) throw new CoreError('INVALID_INPUT', 'Credential import target has unsupported fields.')
  const label = text(target.label, 'New resource label', 128)
  const scopeValue = target.scope
  if (!scopeValue || typeof scopeValue !== 'object' || Array.isArray(scopeValue)) throw new CoreError('INVALID_INPUT', 'Choose a new authorization scope.')
  const scope = scopeValue as Record<string, unknown>
  if (Object.keys(scope).some(key => !['role', 'workItemId', 'environmentId', 'sourceInstanceId'].includes(key))
    || !['main', 'router', 'worker'].includes(scope.role as string)) throw new CoreError('INVALID_INPUT', 'Choose a supported credential role and scope.')
  const normalizedScope: CredentialScope = { role: scope.role as CredentialScope['role'],
    ...(scope.workItemId === undefined || scope.workItemId === '' ? {} : { workItemId: text(scope.workItemId, 'Target work item', 512) }),
    ...(scope.environmentId === undefined || scope.environmentId === '' ? {} : { environmentId: text(scope.environmentId, 'Target Environment', 512) }),
    ...(scope.sourceInstanceId === undefined || scope.sourceInstanceId === '' ? {} : { sourceInstanceId: text(scope.sourceInstanceId, 'Target source Instance', 512) }) }
  if (!['source', 'tool', 'outbound'].includes(target.purpose as string)) throw new CoreError('INVALID_INPUT', 'Choose a new credential purpose.')
  if (target.purpose !== 'tool' && !normalizedScope.sourceInstanceId) {
    throw new CoreError('INVALID_INPUT', 'Source and outbound grants need an exact source Instance.')
  }
  if (target.purpose === 'tool' && !normalizedScope.workItemId && !normalizedScope.environmentId) {
    throw new CoreError('INVALID_INPUT', 'Choose a work item or Environment for the imported tool grant.')
  }
  return { label, scope: normalizedScope, purpose: target.purpose as CredentialPurpose }
}

export class ProductCredentialImports {
  private readonly flights = new Map<string, Promise<CredentialImportRecord>>()

  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly manager: ProductCredentialManager, private readonly adapter: CredentialImportAdapter) {}

  async preview(input: { instanceId: string; pendingId: string; preview: unknown }) {
    if (input.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential imports belong to another Instance.')
    identifier(input.pendingId, 'credentialImportPendingId')
    const preview = previewOf(input.preview)
    const result = await this.storage.transaction(this.instanceId, async tx => {
      const entries: CredentialImportRecord[] = []
      for (const entry of preview.entries) {
        const existing = await tx.get<CredentialImportRecord>('product-credential-import', entry.sourceRef)
        const metadata = { owner: preview.owner, credentialId: entry.id,
          credentialLabel: entry.label, credentialType: entry.type, originalScope: entry.originalScope }
        if (existing) {
          if (canonicalJson(metadata) !== canonicalJson({ owner: existing.owner,
            credentialId: existing.credentialId, credentialLabel: existing.credentialLabel,
            credentialType: existing.credentialType, originalScope: existing.originalScope })) {
            throw new CoreError('CREDENTIAL_IMPORT_CONFLICT', 'The exported credential identity changed. Choose a different source item ID.')
          }
          entries.push(existing)
          continue
        }
        const now = Date.now()
        const record: CredentialImportRecord = { id: entry.sourceRef, instanceId: this.instanceId,
          sourceRef: entry.sourceRef, ...metadata, sourceLabel: preview.sourceLabel,
          attempt: 0, status: 'pending', createdAt: now, updatedAt: now }
        await tx.insert('product-credential-import', record.id, record)
        entries.push(record)
      }
      return { pendingId: input.pendingId, owner: preview.owner, sourceLabel: preview.sourceLabel, items: entries }
    })
    for (const entry of result.items) {
      if (entry.status === 'applied' || entry.status === 'cancelled') {
        await this.adapter.finish?.(input.pendingId, entry.sourceRef).catch(() => {})
      }
    }
    return result
  }

  async list(input: { instanceId: string; limit?: number }) {
    if (input.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential imports belong to another Instance.')
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Choose between 1 and 100 credential imports.')
    return this.storage.transaction(this.instanceId, async tx => {
      const items = await tx.list<CredentialImportRecord>('product-credential-import', 101)
      return { items: items.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit) }
    })
  }

  async commit(input: { instanceId: string; commandId: string; pendingId: string; sourceRef: string; credentialId: string; target: unknown }) {
    if (input.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential imports belong to another Instance.')
    identifier(input.commandId, 'commandId'); identifier(input.pendingId, 'credentialImportPendingId')
    identifier(input.sourceRef, 'credentialImportSourceRef'); identifier(input.credentialId, 'credentialId')
    const target = normalizeTarget(input.target)
    const current = await this.storage.transaction(this.instanceId, async tx => {
      const commandKey = importCommandKey(this.instanceId, input.commandId)
      const fingerprint = createHash('sha256').update(canonicalJson([
        'credential-import-commit-v1', input.sourceRef, input.credentialId, target,
      ])).digest('hex')
      const priorCommand = await tx.get<CredentialImportCommand>('product-credential-import-command', commandKey)
      if (priorCommand && (priorCommand.operation !== 'commit' || priorCommand.fingerprint !== fingerprint
        || priorCommand.sourceRef !== input.sourceRef)) {
        throw new CoreError('IDENTITY_CONFLICT', 'This credential import command was reused for different input.')
      }
      if (!priorCommand) await tx.insert('product-credential-import-command', commandKey,
        { operation: 'commit', fingerprint, sourceRef: input.sourceRef } satisfies CredentialImportCommand)
      const record = await tx.get<CredentialImportRecord>('product-credential-import', input.sourceRef)
      if (!record || record.credentialId !== input.credentialId) throw new CoreError('NOT_FOUND', 'The previewed credential is unavailable.')
      if (record.status === 'cancelled') throw new CoreError('CREDENTIAL_IMPORT_CANCELLED', 'This credential import was cancelled.')
      if (record.target && canonicalJson(record.target) !== canonicalJson(target)) {
        throw new CoreError('CREDENTIAL_IMPORT_CONFLICT', 'The new resource and authorization target are already fixed for this import.')
      }
      if (record.status === 'applied') return { record, completed: true as const }
      if (record.status === 'importing' && this.flights.has(record.id)) return { record, active: this.flights.get(record.id)! }
      const attempt = record.attempt ?? 0
      const intent = await tx.get<{ status: string }>('resource-vault-intent', createCommandId(record.sourceRef, attempt))
      const nextAttempt = intent?.status === 'abandoned' ? attempt + 1 : attempt
      const { resourceId: _resourceId, grantId: _grantId, cleanupPending: _cleanupPending,
        code: _code, ...retryable } = record
      const next: CredentialImportRecord = { ...retryable, attempt: nextAttempt, target, status: 'importing', updatedAt: Date.now() }
      await tx.replace('product-credential-import', record.id, next)
      return { record: next, completed: false as const }
    })
    if ('active' in current) return current.active
    if (current.completed) return current.record
    const flight = this.apply(current.record, input.pendingId)
    this.flights.set(current.record.id, flight)
    try { return await flight }
    finally { if (this.flights.get(current.record.id) === flight) this.flights.delete(current.record.id) }
  }

  private async apply(record: CredentialImportRecord, pendingId: string) {
    try {
      const attempt = record.attempt ?? 0
      const imported = await this.adapter.read(pendingId, record.credentialId, record.sourceRef)
      if (imported.id !== record.credentialId || imported.sourceRef !== record.sourceRef) {
        throw new CoreError('CREDENTIAL_IMPORT_CONFLICT', 'The selected export item does not match the reviewed source.')
      }
      const state = await this.storage.transaction(this.instanceId, tx => tx.get<CredentialImportRecord>('product-credential-import', record.id))
      if (!state || state.status === 'cancelled') throw new CoreError('CREDENTIAL_IMPORT_CANCELLED', 'This credential import was cancelled.')
      const created = await this.manager.create({ instanceId: this.instanceId, commandId: createCommandId(record.sourceRef, attempt),
        label: record.target!.label, value: imported.value })
      await this.storage.transaction(this.instanceId, async tx => {
        const current = await tx.get<CredentialImportRecord>('product-credential-import', record.id)
        if (current && current.resourceId !== created.id) {
          await tx.replace('product-credential-import', record.id, { ...current, resourceId: created.id, updatedAt: Date.now() })
        }
      })
      const afterCreate = await this.storage.transaction(this.instanceId, tx => tx.get<CredentialImportRecord>('product-credential-import', record.id))
      if (!afterCreate || afterCreate.status === 'cancelled') {
        const active = await this.manager.get({ instanceId: this.instanceId, resourceId: created.id })
        if (active?.status === 'active') await this.manager.delete({ instanceId: this.instanceId,
          commandId: cancelCommandId(record.sourceRef, attempt), resourceId: created.id, expectedRevision: active.revision })
        throw new CoreError('CREDENTIAL_IMPORT_CANCELLED', 'This credential import was cancelled.')
      }
      const granted = await this.manager.grant({ instanceId: this.instanceId,
        commandId: grantCommandId(record.sourceRef, attempt), resourceId: created.id,
        expectedRevision: 1, scope: record.target!.scope, purposes: [record.target!.purpose] })
      const completed = await this.storage.transaction(this.instanceId, async tx => {
        const current = await tx.get<CredentialImportRecord>('product-credential-import', record.id)
        if (!current || current.status === 'cancelled') return current
        const grantId = granted.grants.find(grant => grant.scope.role === record.target!.scope.role
          && grant.purposes.includes(record.target!.purpose))?.id
        const next: CredentialImportRecord = { ...current, status: 'applied', resourceId: created.id,
          ...(grantId ? { grantId } : {}), updatedAt: Date.now() }
        await tx.replace('product-credential-import', current.id, next)
        return next
      })
      if (!completed || completed.status === 'cancelled') {
        const active = await this.manager.get({ instanceId: this.instanceId, resourceId: created.id })
        if (active?.status === 'active') await this.manager.delete({ instanceId: this.instanceId,
          commandId: cancelCommandId(record.sourceRef, attempt), resourceId: created.id, expectedRevision: active.revision })
        throw new CoreError('CREDENTIAL_IMPORT_CANCELLED', 'This credential import was cancelled.')
      }
      await this.adapter.finish?.(pendingId, record.sourceRef).catch(() => {})
      return completed
    } catch (error) {
      const code = error instanceof CoreError && ['CREDENTIAL_IMPORT_CANCELLED', 'CREDENTIAL_IMPORT_CONFLICT',
        'CREDENTIAL_IMPORT_NOT_FOUND'].includes(error.code) ? error.code
        : error instanceof CoreError && error.code === 'IDENTITY_CONFLICT' ? 'CREDENTIAL_IMPORT_CONFLICT'
          : 'CREDENTIAL_IMPORT_UNKNOWN'
      await this.storage.transaction(this.instanceId, async tx => {
        const current = await tx.get<CredentialImportRecord>('product-credential-import', record.id)
        if (!current || current.status === 'cancelled' || current.status === 'applied') return
        const status = code === 'CREDENTIAL_IMPORT_CONFLICT' ? 'conflict'
          : code === 'CREDENTIAL_IMPORT_NOT_FOUND' ? 'unknown'
            : code === 'CREDENTIAL_IMPORT_CANCELLED' ? 'cancelled' : 'unknown'
        await tx.replace('product-credential-import', current.id, { ...current, status, code,
          ...(current.resourceId ? { cleanupPending: true } : {}), updatedAt: Date.now() })
      }).catch(() => {})
      throw new CoreError(code, code === 'CREDENTIAL_IMPORT_CONFLICT' ? 'The source credential changed or conflicts with the earlier import.'
        : code === 'CREDENTIAL_IMPORT_NOT_FOUND' ? 'Reselect the original export to retry this credential.'
          : code === 'CREDENTIAL_IMPORT_CANCELLED' ? 'The credential import was cancelled.'
            : 'The credential import result is unknown; retry the same source after reviewing its target.')
    }
  }

  async cancel(input: { instanceId: string; commandId: string; sourceRef: string; pendingId?: string }) {
    if (input.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential imports belong to another Instance.')
    identifier(input.commandId, 'commandId'); identifier(input.sourceRef, 'credentialImportSourceRef')
    const current = await this.storage.transaction(this.instanceId, async tx => {
      const commandKey = importCommandKey(this.instanceId, input.commandId)
      const fingerprint = createHash('sha256').update(canonicalJson([
        'credential-import-cancel-v1', input.sourceRef,
      ])).digest('hex')
      const priorCommand = await tx.get<CredentialImportCommand>('product-credential-import-command', commandKey)
      if (priorCommand && (priorCommand.operation !== 'cancel' || priorCommand.fingerprint !== fingerprint
        || priorCommand.sourceRef !== input.sourceRef)) {
        throw new CoreError('IDENTITY_CONFLICT', 'This credential import command was reused for different input.')
      }
      const record = await tx.get<CredentialImportRecord>('product-credential-import', input.sourceRef)
      if (!record) throw new CoreError('NOT_FOUND', 'The credential import is unavailable.')
      if (!priorCommand) await tx.insert('product-credential-import-command', commandKey,
        { operation: 'cancel', fingerprint, sourceRef: input.sourceRef } satisfies CredentialImportCommand)
      return record
    })
    if (!current) throw new CoreError('NOT_FOUND', 'The credential import is unavailable.')
    if (current.status === 'applied') throw new CoreError('INVALID_INPUT', 'Delete or revoke the imported resource instead of cancelling it.')
    const active = this.flights.get(current.id)
    const updated = await this.storage.transaction(this.instanceId, async tx => {
      const latest = await tx.get<CredentialImportRecord>('product-credential-import', current.id)
      if (!latest || latest.status === 'applied') throw new CoreError('INVALID_INPUT', 'Delete or revoke the imported resource instead of cancelling it.')
      if (latest.status !== 'cancelled') {
        const next = { ...latest, status: 'cancelled' as const,
          ...(latest.resourceId || latest.target ? { cleanupPending: true } : {}), updatedAt: Date.now() }
        await tx.replace('product-credential-import', latest.id, next)
        return next
      }
      return latest
    })
    if (active) await active.catch(() => {})

    let resourceId = updated.resourceId
    const attempt = updated.attempt ?? 0
    const createIntent = await this.storage.transaction(this.instanceId, tx =>
      tx.get<{ status: string; resourceId?: string }>('resource-vault-intent', createCommandId(updated.sourceRef, attempt)))
    resourceId ??= createIntent?.resourceId
    let cleanupPending = !resourceId && createIntent?.status === 'pending'
    if (!resourceId && updated.target && createIntent?.status === 'pending' && input.pendingId) {
      const imported = await this.adapter.read(input.pendingId, updated.credentialId, updated.sourceRef)
      if (imported.id !== updated.credentialId || imported.sourceRef !== updated.sourceRef) {
        throw new CoreError('CREDENTIAL_IMPORT_CONFLICT', 'The selected export item does not match the reviewed source.')
      }
      try {
        const created = await this.manager.create({ instanceId: this.instanceId, commandId: createCommandId(updated.sourceRef, attempt),
          label: updated.target.label, value: imported.value })
        resourceId = created.id
      } catch {
        const intent = await this.storage.transaction(this.instanceId, tx =>
          tx.get<{ resourceId?: string }>('resource-vault-intent', createCommandId(updated.sourceRef, attempt)))
        resourceId = intent?.resourceId
        cleanupPending = !resourceId
      }
    }
    const cancelled = await this.storage.transaction(this.instanceId, async tx => {
      const latest = await tx.get<CredentialImportRecord>('product-credential-import', updated.id)
      if (!latest || latest.status === 'applied') throw new CoreError('INVALID_INPUT', 'Delete or revoke the imported resource instead of cancelling it.')
      const { cleanupPending: _previousCleanupPending, ...currentRecord } = latest
      const next = { ...currentRecord, status: 'cancelled' as const, ...(resourceId ? { resourceId } : {}),
        ...(cleanupPending ? { cleanupPending: true } : {}), updatedAt: Date.now() }
      await tx.replace('product-credential-import', latest.id, next)
      return next
    })
    if (input.pendingId) await this.adapter.cancel?.(input.pendingId, input.sourceRef).catch(() => {})
    if (!resourceId) return cancelled
    await this.removeResource(resourceId, cancelled.sourceRef, attempt)
    return await this.storage.transaction(this.instanceId, tx => tx.get<CredentialImportRecord>('product-credential-import', cancelled.id)) ?? cancelled
  }

  private async removeResource(resourceId: string, sourceRef: string, attempt: number) {
    let resource = await this.manager.get({ instanceId: this.instanceId, resourceId })
    if (resource?.status === 'active') {
      resource = await this.manager.delete({ instanceId: this.instanceId, commandId: cancelCommandId(sourceRef, attempt),
        resourceId, expectedRevision: resource.revision })
    } else if (resource?.cleanupPending) {
      resource = await this.manager.cleanupDeleted({ instanceId: this.instanceId, resourceId })
    }
    await this.storage.transaction(this.instanceId, async tx => {
      const current = await tx.get<CredentialImportRecord>('product-credential-import', sourceRef)
      if (current?.status === 'cancelled') await tx.replace('product-credential-import', current.id,
        { ...current, cleanupPending: Boolean(resource?.cleanupPending), updatedAt: Date.now() })
    })
  }
}
