import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier } from './model.js'
import { createRolePreset, previewLegacyRolePreset, prepareLegacyPresetDecision,
  type LegacyPresetCopy, type LegacyPresetPreview, type LegacyPresetSource, type PresetRole, type RolePreset } from './role-presets.js'
import type { AsyncTx, Storage } from './storage.js'

export interface RolePresetEntry {
  id: string
  instanceId: string
  preset: RolePreset
  status: 'active' | 'deleted'
  revision: number
  origin?: { key: string; source: LegacyPresetSource; targetRole: PresetRole }
  createdAt: number
  updatedAt: number
}

export interface RolePresetPreviewRecord {
  id: string
  instanceId: string
  preview: LegacyPresetPreview
  createdAt: number
}

export interface RolePresetImportRecord {
  id: string
  instanceId: string
  previewId: string
  key: string
  source: LegacyPresetSource
  targetRole: PresetRole
  status: 'selected' | 'replaced' | 'skipped' | 'duplicate' | 'conflict'
  presetId?: string
  duplicateOf?: string
  conflictWith?: string
  reason?: 'PRESET_SOURCE_CONFLICT' | 'PRESET_CONTENT_CONFLICT' | 'PRESET_REVIEW_CONFLICT' | 'PRESET_ID_CONFLICT'
  observedDigest?: string
  createdAt: number
}

export interface RolePresetApplication {
  instanceId: string
  commandId: string
  sourceInstanceId: string
  actorId: string
  presetId: string
  presetRevision: number
  targetRole: PresetRole
  revision: number
  appliedAt: number
}

interface StoredPreset extends RolePresetEntry { imageChunks: number }
interface StoredPreview extends RolePresetPreviewRecord { imageChunks: number }
type CommandTarget = { kind: 'preset'; id: string; revision: number } | { kind: 'preview' | 'import'; id: string }
interface CommandReceipt { fingerprint: string; result: CommandTarget }
interface ReviewIndex { decisionId: string; fingerprint: string }
interface SourceIndex { key: string; decisionId: string; presetId: string; fingerprint: string }

const imageChunkChars = 60_000
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const versionKey = (id: string, revision: number) => JSON.stringify([id, revision])
const imageKey = (kind: 'preset' | 'preview', id: string, revision: number, index: number) => JSON.stringify([kind, id, revision, index])

function fields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) throw new CoreError('INVALID_INPUT', `Invalid ${label} fields.`)
}

function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CoreError('INVALID_INPUT', 'A positive expected preset revision is required.')
}

function page(input: { after?: string; limit?: number }) {
  if (input.after !== undefined) identifier(input.after, 'after')
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'A page limit from 1 to 100 is required.')
  return { limit, ...(input.after === undefined ? {} : { after: input.after }) }
}

/** Instance-scoped facts. A trusted Host must authorize callers before invoking commands or queries. */
export class RolePresetStore {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly now: () => number = Date.now) {
    identifier(instanceId, 'instanceId')
  }

  private assertInstance(instanceId: unknown) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The preset belongs to another Instance.')
  }

  private async writeImage(tx: AsyncTx, kind: 'preset' | 'preview', id: string, revision: number, image?: string): Promise<number> {
    if (image === undefined) return 0
    const chunks = Math.ceil(image.length / imageChunkChars)
    for (let index = 0; index < chunks; index++) {
      await tx.insert('role-preset-image', imageKey(kind, id, revision, index), { data: image.slice(index * imageChunkChars, (index + 1) * imageChunkChars) })
    }
    return chunks
  }

  private async readImage(tx: AsyncTx, kind: 'preset' | 'preview', id: string, revision: number, chunks: number) {
    let image = ''
    for (let index = 0; index < chunks; index++) {
      const part = await tx.get<{ data: string }>('role-preset-image', imageKey(kind, id, revision, index))
      if (!part) throw new CoreError('PRESET_UNAVAILABLE', 'A stored preset image is incomplete.')
      image += part.data
    }
    return image
  }

  private withoutImage<T extends { appearance?: { image?: string } }>(value: T): T {
    const clean = structuredClone(value)
    if (clean.appearance) delete clean.appearance.image
    return clean
  }

  private async presetView(tx: AsyncTx, stored: StoredPreset): Promise<RolePresetEntry> {
    const { imageChunks, ...entry } = structuredClone(stored)
    if (imageChunks) entry.preset.appearance = { ...entry.preset.appearance,
      image: await this.readImage(tx, 'preset', entry.id, entry.revision, imageChunks) }
    return entry
  }

  private async previewView(tx: AsyncTx, stored: StoredPreview): Promise<RolePresetPreviewRecord> {
    const { imageChunks, ...entry } = structuredClone(stored)
    if (imageChunks) entry.preview.draft.appearance = { ...entry.preview.draft.appearance,
      image: await this.readImage(tx, 'preview', entry.id, 0, imageChunks) }
    return entry
  }

  private async result(tx: AsyncTx, target: CommandTarget): Promise<RolePresetEntry | RolePresetPreviewRecord | RolePresetImportRecord> {
    if (target.kind === 'preset') {
      const record = await tx.get<StoredPreset>('role-preset-version', versionKey(target.id, target.revision))
      if (!record) throw new CoreError('PRESET_UNAVAILABLE', 'The preset revision is unavailable.')
      return this.presetView(tx, record)
    }
    if (target.kind === 'preview') {
      const record = await tx.get<StoredPreview>('role-preset-preview', target.id)
      if (!record) throw new CoreError('PRESET_UNAVAILABLE', 'The import preview is unavailable.')
      return this.previewView(tx, record)
    }
    const record = await tx.get<RolePresetImportRecord>('role-preset-import', target.id)
    if (!record) throw new CoreError('PRESET_UNAVAILABLE', 'The import decision is unavailable.')
    return record
  }

  private async command<T extends RolePresetEntry | RolePresetPreviewRecord | RolePresetImportRecord>(commandId: unknown, input: unknown,
    apply: (tx: AsyncTx) => Promise<CommandTarget>): Promise<T> {
    identifier(commandId, 'commandId')
    const fingerprint = hash(input)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<CommandReceipt>('role-preset-command', commandId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The preset command ID has different input.')
        return await this.result(tx, prior.result) as T
      }
      const result = await apply(tx)
      await tx.insert<CommandReceipt>('role-preset-command', commandId, { fingerprint, result })
      return await this.result(tx, result) as T
    })
  }

  private async savePreset(tx: AsyncTx, preset: RolePreset, origin?: RolePresetEntry['origin']): Promise<CommandTarget> {
    if (await tx.get<StoredPreset>('role-preset', preset.id)) throw new CoreError('PRESET_EXISTS', 'The preset ID already exists.')
    const at = this.now()
    const record: StoredPreset = { id: preset.id, instanceId: this.instanceId, preset: this.withoutImage(preset),
      status: 'active', revision: 1, ...(origin ? { origin } : {}), createdAt: at, updatedAt: at,
      imageChunks: await this.writeImage(tx, 'preset', preset.id, 1, preset.appearance?.image) }
    await tx.insert('role-preset', preset.id, record)
    await tx.insert('role-preset-version', versionKey(preset.id, 1), record)
    return { kind: 'preset', id: preset.id, revision: 1 }
  }

  async create(input: { instanceId: string; commandId: string; preset: unknown }): Promise<RolePresetEntry> {
    fields(input, ['instanceId', 'commandId', 'preset'], 'preset creation')
    this.assertInstance(input.instanceId)
    const preset = createRolePreset(input.preset)
    return this.command(input.commandId, ['create', preset], tx => this.savePreset(tx, preset))
  }

  async update(input: { instanceId: string; commandId: string; expectedRevision: number; preset: unknown }): Promise<RolePresetEntry> {
    fields(input, ['instanceId', 'commandId', 'expectedRevision', 'preset'], 'preset update')
    this.assertInstance(input.instanceId); revision(input.expectedRevision)
    const preset = createRolePreset(input.preset)
    return this.command(input.commandId, ['update', input.expectedRevision, preset], async tx => {
      const current = await tx.get<StoredPreset>('role-preset', preset.id)
      if (!current || current.status !== 'active') throw new CoreError('PRESET_UNAVAILABLE', 'The preset is unavailable.')
      if (current.revision !== input.expectedRevision) throw new CoreError('PRESET_REVISION_CONFLICT', 'The preset changed after this edit was prepared.')
      const nextRevision = current.revision + 1
      const next: StoredPreset = { ...current, preset: this.withoutImage(preset), revision: nextRevision, updatedAt: this.now(),
        imageChunks: await this.writeImage(tx, 'preset', preset.id, nextRevision, preset.appearance?.image) }
      await tx.replace('role-preset', preset.id, next)
      await tx.insert('role-preset-version', versionKey(preset.id, nextRevision), next)
      return { kind: 'preset', id: preset.id, revision: nextRevision }
    })
  }

  async delete(input: { instanceId: string; commandId: string; presetId: string; expectedRevision: number }): Promise<RolePresetEntry> {
    fields(input, ['instanceId', 'commandId', 'presetId', 'expectedRevision'], 'preset deletion')
    this.assertInstance(input.instanceId); identifier(input.presetId, 'presetId'); revision(input.expectedRevision)
    return this.command(input.commandId, ['delete', input.presetId, input.expectedRevision], async tx => {
      const current = await tx.get<StoredPreset>('role-preset', input.presetId)
      if (!current || current.status !== 'active') throw new CoreError('PRESET_UNAVAILABLE', 'The preset is unavailable.')
      if (current.revision !== input.expectedRevision) throw new CoreError('PRESET_REVISION_CONFLICT', 'The preset changed after this deletion was prepared.')
      const nextRevision = current.revision + 1
      const original = await this.presetView(tx, current)
      const next: StoredPreset = { ...current, revision: nextRevision, status: 'deleted', updatedAt: this.now(),
        imageChunks: await this.writeImage(tx, 'preset', current.id, nextRevision, original.preset.appearance?.image) }
      await tx.replace('role-preset', current.id, next)
      await tx.insert('role-preset-version', versionKey(current.id, nextRevision), next)
      return { kind: 'preset', id: current.id, revision: nextRevision }
    })
  }

  async get(input: { instanceId: string; presetId: string }): Promise<RolePresetEntry | undefined> {
    fields(input, ['instanceId', 'presetId'], 'preset query')
    this.assertInstance(input.instanceId); identifier(input.presetId, 'presetId')
    return this.storage.transaction(this.instanceId, async tx => {
      const record = await tx.get<StoredPreset>('role-preset', input.presetId)
      return record && this.presetView(tx, record)
    })
  }

  async assertCurrent(tx: AsyncTx, presetId: string, expectedRevision: number): Promise<void> {
    const current = await tx.get<StoredPreset>('role-preset', presetId)
    if (!current || current.status !== 'active') throw new CoreError('PRESET_UNAVAILABLE', 'The preset is unavailable.')
    if (current.revision !== expectedRevision) throw new CoreError('PRESET_REVISION_CONFLICT', 'The preset changed while its application was prepared.')
  }

  async list(input: { instanceId: string; after?: string; limit?: number }): Promise<{ items: RolePresetEntry[]; cursor?: string }> {
    fields(input, ['instanceId', 'after', 'limit'], 'preset list')
    this.assertInstance(input.instanceId)
    const options = page(input)
    return this.storage.transaction(this.instanceId, async tx => {
      const found = await tx.scan<StoredPreset>('role-preset', options)
      return { items: await Promise.all(found.items.map(item => this.presetView(tx, item.value))),
        ...(found.cursor ? { cursor: found.cursor } : {}) }
    })
  }

  /** The explicit copy is projected in memory; only reviewed fields, never the legacy state, are stored. */
  async recordPreview(input: { instanceId: string; commandId: string; copy: LegacyPresetCopy }): Promise<RolePresetPreviewRecord> {
    fields(input, ['instanceId', 'commandId', 'copy'], 'import preview')
    this.assertInstance(input.instanceId)
    const preview = previewLegacyRolePreset(input.copy)
    return this.command(input.commandId, ['preview', preview], async tx => {
      const id = randomUUID()
      const compact = structuredClone(preview)
      if (compact.draft.appearance) delete compact.draft.appearance.image
      const record: StoredPreview = { id, instanceId: this.instanceId, preview: compact, createdAt: this.now(),
        imageChunks: await this.writeImage(tx, 'preview', id, 0, preview.draft.appearance?.image) }
      await tx.insert('role-preset-preview', id, record)
      return { kind: 'preview', id }
    })
  }

  async getPreview(input: { instanceId: string; previewId: string }): Promise<RolePresetPreviewRecord | undefined> {
    fields(input, ['instanceId', 'previewId'], 'import preview query')
    this.assertInstance(input.instanceId); identifier(input.previewId, 'previewId')
    return this.storage.transaction(this.instanceId, async tx => {
      const record = await tx.get<StoredPreview>('role-preset-preview', input.previewId)
      return record && this.previewView(tx, record)
    })
  }

  async listPreviews(input: { instanceId: string; after?: string; limit?: number }): Promise<{ items: RolePresetPreviewRecord[]; cursor?: string }> {
    fields(input, ['instanceId', 'after', 'limit'], 'import preview list')
    this.assertInstance(input.instanceId)
    const options = page(input)
    return this.storage.transaction(this.instanceId, async tx => {
      const found = await tx.scan<StoredPreview>('role-preset-preview', options)
      return { items: await Promise.all(found.items.map(item => this.previewView(tx, item.value))),
        ...(found.cursor ? { cursor: found.cursor } : {}) }
    })
  }

  /** Skipping cancels this preview; a later explicit preview may still select the same source. */
  async decideImport(input: { instanceId: string; commandId: string; previewId: string; decision: 'select' | 'replace' | 'skip';
    copy?: LegacyPresetCopy; preset?: unknown; expectedDecisionId?: string }): Promise<RolePresetImportRecord> {
    fields(input, ['instanceId', 'commandId', 'previewId', 'decision', 'copy', 'preset', 'expectedDecisionId'], 'import decision')
    this.assertInstance(input.instanceId); identifier(input.previewId, 'previewId')
    if (!['select', 'replace', 'skip'].includes(input.decision)) throw new CoreError('INVALID_INPUT', 'Select, replace or skip the import explicitly.')
    if (input.decision === 'skip' && (input.copy !== undefined || input.preset !== undefined || input.expectedDecisionId !== undefined)) {
      throw new CoreError('INVALID_INPUT', 'A skipped import carries no source copy or preset.')
    }
    if (input.decision !== 'skip' && input.copy === undefined) throw new CoreError('INVALID_INPUT', 'Selection requires a fresh explicit source copy.')
    if (input.decision === 'replace') identifier(input.expectedDecisionId, 'expectedDecisionId')
    else if (input.expectedDecisionId !== undefined) throw new CoreError('INVALID_INPUT', 'Only replacement may identify an earlier decision.')
    const preset = input.decision !== 'skip' ? createRolePreset(input.preset) : undefined
    const observed = input.copy === undefined ? undefined : previewLegacyRolePreset(input.copy)
    const selectedFingerprint = preset && observed ? prepareLegacyPresetDecision({ ...input.copy!, expectedDigest: observed.source.digest,
      decision: 'select', preset }).fingerprint : undefined
    return this.command(input.commandId, ['decide', input.previewId, input.decision, observed?.key ?? null,
      observed?.source.digest ?? null, preset ?? null, input.expectedDecisionId ?? null], async tx => {
      const saved = await tx.get<StoredPreview>('role-preset-preview', input.previewId)
      if (!saved) throw new CoreError('PRESET_UNAVAILABLE', 'The import preview is unavailable.')
      const { preview } = saved
      const fingerprint = input.decision === 'skip' ? hash([preview.key, preview.source.digest, 'skipped'])
        : observed?.key === preview.key && observed.source.digest === preview.source.digest
          ? selectedFingerprint!
          : hash([preview.key, observed?.source.digest, 'source-conflict', preset])
      const priorReview = await tx.get<ReviewIndex>('role-preset-review', input.previewId)
      const origin = input.decision !== 'skip' ? await tx.get<SourceIndex>('role-preset-source', hash(preview.key)) : undefined
      const currentOrigin = origin ? await tx.get<StoredPreset>('role-preset', origin.presetId) : undefined
      const sourceUnchanged = !origin || currentOrigin?.status === 'active' && currentOrigin.revision === 1
      let status: RolePresetImportRecord['status'] = input.decision === 'skip' ? 'skipped' : 'selected'
      let reason: RolePresetImportRecord['reason']
      let duplicateOf: string | undefined
      let conflictWith: string | undefined
      if (input.decision !== 'skip' && (observed?.key !== preview.key || observed.source.digest !== preview.source.digest)) {
        status = 'conflict'; reason = 'PRESET_SOURCE_CONFLICT'
      } else if (priorReview) {
        status = priorReview.fingerprint === fingerprint && (input.decision === 'skip' || sourceUnchanged) ? 'duplicate' : 'conflict'
        if (status === 'duplicate') duplicateOf = priorReview.decisionId
        else { reason = sourceUnchanged ? 'PRESET_REVIEW_CONFLICT' : 'PRESET_CONTENT_CONFLICT'; conflictWith = priorReview.decisionId }
      } else if (input.decision === 'replace') {
        if (!origin || origin.decisionId !== input.expectedDecisionId) {
          status = 'conflict'; reason = 'PRESET_CONTENT_CONFLICT'; conflictWith = origin?.decisionId
        } else if (preset && await tx.get<StoredPreset>('role-preset', preset.id)) {
          status = 'conflict'; reason = 'PRESET_ID_CONFLICT'
        } else { status = 'replaced'; conflictWith = origin.decisionId }
      } else if (origin) {
        status = origin.key === preview.key && origin.fingerprint === fingerprint && sourceUnchanged ? 'duplicate' : 'conflict'
        if (status === 'duplicate') duplicateOf = origin.decisionId
        else { reason = 'PRESET_CONTENT_CONFLICT'; conflictWith = origin.decisionId }
      } else if (preset && await tx.get<StoredPreset>('role-preset', preset.id)) {
        status = 'conflict'; reason = 'PRESET_ID_CONFLICT'
      }
      const id = randomUUID()
      const earlier = duplicateOf ? await tx.get<RolePresetImportRecord>('role-preset-import', duplicateOf) : undefined
      const result: RolePresetImportRecord = { id, instanceId: this.instanceId, previewId: saved.id, key: preview.key,
        source: preview.source, targetRole: preview.targetRole, status,
        ...(['selected', 'replaced'].includes(status) ? { presetId: preset!.id } : earlier?.presetId ? { presetId: earlier.presetId } : {}),
        ...(duplicateOf ? { duplicateOf } : {}), ...(conflictWith ? { conflictWith } : {}), ...(reason ? { reason } : {}),
        ...(reason === 'PRESET_SOURCE_CONFLICT' && observed ? { observedDigest: observed.source.digest } : {}), createdAt: this.now() }
      if (status === 'selected' || status === 'replaced') {
        await this.savePreset(tx, preset!, { key: preview.key, source: preview.source, targetRole: preview.targetRole })
        const index: SourceIndex = { key: preview.key, decisionId: id, presetId: preset!.id, fingerprint }
        if (status === 'replaced') await tx.replace('role-preset-source', hash(preview.key), index)
        else await tx.insert('role-preset-source', hash(preview.key), index)
      }
      if (!priorReview && status !== 'conflict') await tx.insert('role-preset-review', input.previewId, { decisionId: id, fingerprint })
      await tx.insert('role-preset-import', id, result)
      return { kind: 'import', id }
    })
  }

  async getImport(input: { instanceId: string; importId: string }): Promise<RolePresetImportRecord | undefined> {
    fields(input, ['instanceId', 'importId'], 'import decision query')
    this.assertInstance(input.instanceId); identifier(input.importId, 'importId')
    return this.storage.transaction(this.instanceId, tx => tx.get<RolePresetImportRecord>('role-preset-import', input.importId))
  }

  async listImports(input: { instanceId: string; after?: string; limit?: number }): Promise<{ items: RolePresetImportRecord[]; cursor?: string }> {
    fields(input, ['instanceId', 'after', 'limit'], 'import decision list')
    this.assertInstance(input.instanceId)
    const options = page(input)
    return this.storage.transaction(this.instanceId, async tx => {
      const found = await tx.scan<RolePresetImportRecord>('role-preset-import', options)
      return { items: found.items.map(item => item.value), ...(found.cursor ? { cursor: found.cursor } : {}) }
    })
  }
}
