import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import type { ExecutionEnvironment } from './environment.js'
import type { Assignment } from './execution.js'
import { CoreError, identifier, type Work } from './model.js'
import { credentialLike } from './product-memory-import.js'
import type { AsyncTx, Storage } from './storage.js'
import type { MainWorkBrief, MainWorkItem } from './work-delegation.js'

export interface BrowserAdapter {
  execute(request: { profileKey: string; action: 'open' | 'snapshot'; url?: string }, signal: AbortSignal): Promise<string>
  hold?(profileKey: string, held: boolean, controlId: string): Promise<void>
  importProfile?(request: { profileKey: string; pendingImportId: string; importId: string }): Promise<unknown>
  close?(): Promise<void>
}

export interface BrowserWork {
  instanceId: string
  ticketId: string
  workItemId: string
  assignmentId: string
  generation: string
  environmentId: string
}

interface BrowserResource {
  id: string
  instanceId: string
  environmentId: string
  label: string
  profileKey: string
  revision: number
  state: 'active' | 'importing' | 'revoked'
  operationIds: string[]
  createdAt: number
}

interface BrowserLease extends BrowserWork {
  resourceId: string
  acquiredAt: number
  operationId?: string
}

export interface BrowserControl extends BrowserWork {
  id: string
  resourceId: string
  state: 'taking' | 'held' | 'returning' | 'returned'
  responsibleActorId: string
  createdAt: number
  returnedAt?: number
}

export interface BrowserOperation {
  id: string
  resourceId: string
  ticketId: string
  workItemId: string
  assignmentId: string
  generation: string
  ownerRuntime: string
  action: 'open' | 'snapshot'
  state: 'pending' | 'succeeded' | 'unknown' | 'resolved'
  code?: string
  createdAt: number
  settledAt?: number
  resolution?: string
}

export class BrowserOutcomeUnknown extends CoreError {
  constructor(readonly operationId: string) {
    super('BROWSER_OUTCOME_UNKNOWN', 'The browser outcome is unknown; inspect the original operation before retrying.')
  }
}

interface BrowserGrant { resourceId: string; workItemId: string; active: boolean }
interface BrowserReceipt { fingerprint: string; result: unknown }
export interface BrowserImportPreview {
  source: { kind: 'file' | 'chrome' | 'edge' | 'brave' | 'chromium' | 'firefox'; label: string }
  format: string | null
  flavor: string | null
  sourceDigest: string
  entries: number
  cookies: number
  sites: Array<{ site: string; cookies: number; session: number; httpOnly: number; skipped: number }>
  warnings: Array<{ code: string; message: string; count: number }>
  skipped: Array<{ where: string; name?: string; domain?: string; path?: string; code: string; reason: string }>
  notes: Array<'session-cookies' | 'local-storage-left'>
}
export interface BrowserImportReport {
  stored: number
  droppedCount: number
  failedCount: number
  dropped: Array<{ name: string; domain: string; path: string; code?: string; reason: string }>
  failed: Array<{ name: string; domain: string; path: string; code?: string; reason: string }>
  flushed: boolean
}
export interface BrowserImportView {
  id: string
  sourceRef: string
  resourceId: string
  environmentId: string
  label: string
  status: 'pending' | 'unknown' | 'applied' | 'cancelled'
  preview: BrowserImportPreview
  report?: BrowserImportReport
  code?: string
  createdAt: number
  updatedAt: number
}
interface BrowserImportRecord {
  id: string
  sourceRef: string
  instanceId: string
  sourceKey: string
  previewHash: string
  preview: BrowserImportPreview
  resourceId: string
  environmentId: string
  label: string
  status: 'pending' | 'unknown' | 'applied' | 'cancelled'
  report?: BrowserImportReport
  code?: string
  createdAt: number
  updatedAt: number
}
interface BrowserImportCommand { fingerprint: string; importId: string }
interface BrowserImportSource { importId: string; sourceKey: string }

const grantKey = (resourceId: string, workItemId: string) => canonicalJson([resourceId, workItemId])
const browserObservations = ['UNCHANGED', 'CHANGED', 'CLOSED', 'INSPECTED'] as const
const browserImportId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function importText(value: unknown, label: string, max = 256) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max
    || credentialLike(value)) throw new CoreError('INVALID_INPUT', `${label} must be bounded text without credentials.`)
  return value.trim()
}

function importCount(value: unknown, label: string, max = 100_000) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new CoreError('INVALID_INPUT', `${label} must be a bounded count.`)
  }
  return value as number
}

function importPreview(value: unknown): BrowserImportPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'A browser import needs a value-free preview.')
  const preview = value as Record<string, unknown>
  const source = preview.source && typeof preview.source === 'object' && !Array.isArray(preview.source)
    ? preview.source as Record<string, unknown> : undefined
  const kind = source?.kind
  if (!['file', 'chrome', 'edge', 'brave', 'chromium', 'firefox'].includes(kind as string)) {
    throw new CoreError('INVALID_INPUT', 'A browser import source is not recognized.')
  }
  const sites = Array.isArray(preview.sites) ? preview.sites.slice(0, 20).map((item, index) => {
    const site = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    return {
      site: importText(site.site, `Import site ${index + 1}`, 256),
      cookies: importCount(site.cookies, `Import site ${index + 1} cookies`, 100_000),
      session: importCount(site.session, `Import site ${index + 1} session cookies`, 100_000),
      httpOnly: importCount(site.httpOnly, `Import site ${index + 1} HTTP-only cookies`, 100_000),
      skipped: importCount(site.skipped, `Import site ${index + 1} skipped cookies`, 100_000),
    }
  }) : []
  const warnings = Array.isArray(preview.warnings) ? preview.warnings.slice(0, 20).map((item, index) => {
    const warning = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    return {
      code: importText(warning.code, `Import warning ${index + 1} code`, 64),
      message: importText(warning.message, `Import warning ${index + 1}`, 512),
      count: importCount(warning.count, `Import warning ${index + 1} count`, 100_000),
    }
  }) : []
  const skipped = Array.isArray(preview.skipped) ? preview.skipped.slice(0, 50).map((item, index) => {
    const skippedItem = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    return {
      where: importText(skippedItem.where, `Skipped import entry ${index + 1} location`, 256),
      ...(skippedItem.name === undefined ? {} : { name: importText(skippedItem.name, `Skipped import entry ${index + 1} name`, 256) }),
      ...(skippedItem.domain === undefined ? {} : { domain: importText(skippedItem.domain, `Skipped import entry ${index + 1} domain`, 256) }),
      ...(skippedItem.path === undefined ? {} : { path: importText(skippedItem.path, `Skipped import entry ${index + 1} path`, 512) }),
      code: importText(skippedItem.code, `Skipped import entry ${index + 1} code`, 64),
      reason: importText(skippedItem.reason, `Skipped import entry ${index + 1} reason`, 512),
    }
  }) : []
  const notes = Array.isArray(preview.notes)
    ? preview.notes.filter(note => note === 'session-cookies' || note === 'local-storage-left') as BrowserImportPreview['notes'] : []
  if (typeof preview.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(preview.sourceDigest)) {
    throw new CoreError('INVALID_INPUT', 'A browser import needs its source digest.')
  }
  return {
    source: { kind: kind as BrowserImportPreview['source']['kind'], label: importText(source?.label, 'Import source label', 256) },
    format: preview.format == null ? null : importText(preview.format, 'Import format', 64),
    flavor: preview.flavor == null ? null : importText(preview.flavor, 'Import flavor', 64),
    sourceDigest: preview.sourceDigest,
    entries: importCount(preview.entries, 'Import entries'),
    cookies: importCount(preview.cookies, 'Imported cookie count'),
    sites, warnings, skipped, notes,
  }
}

function importReportItem(value: unknown, index: number): BrowserImportReport['dropped'][number] {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const rawReason = typeof item.reason === 'string' ? item.reason : ''
  const reason = rawReason === 'the browser did not store it' ? rawReason
    : rawReason.includes('different cookie with the same name and domain') ? 'The browser kept a different cookie with the same name and domain.'
      : 'The browser did not confirm this cookie.'
  const code = typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item.code) ? item.code : undefined
  return {
    name: importText(item.name, `Browser import result ${index + 1} name`, 256),
    domain: importText(item.domain, `Browser import result ${index + 1} domain`, 256),
    path: importText(item.path ?? '/', `Browser import result ${index + 1} path`, 512),
    ...(code ? { code } : {}),
    reason,
  }
}

function importReport(value: unknown): BrowserImportReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('BROWSER_IMPORT_UNKNOWN', 'The browser import returned no verifiable report.')
  }
  const report = value as Record<string, unknown>
  if (typeof report.flushed !== 'boolean' || !Array.isArray(report.dropped) || !Array.isArray(report.failed)) {
    throw new CoreError('BROWSER_IMPORT_UNKNOWN', 'The browser import report is malformed.')
  }
  return {
    stored: importCount(report.stored, 'Stored cookie count'),
    droppedCount: report.dropped.length,
    failedCount: report.failed.length,
    dropped: report.dropped.slice(0, 100).map(importReportItem),
    failed: report.failed.slice(0, 100).map(importReportItem),
    flushed: report.flushed,
  }
}

const browserImportErrors = new Set(['BROWSER_IMPORT_NOT_FOUND', 'BROWSER_IMPORT_CONFLICT',
  'BROWSER_IMPORT_UNKNOWN', 'BROWSER_UNAVAILABLE'])
function importErrorCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && browserImportErrors.has(code) ? code : 'BROWSER_IMPORT_UNKNOWN'
}

/** Product-owned profiles and durable, single-Assignment write control. No Bot identity is imported. */
export class BrowserResources {
  private readonly runtimeId = randomUUID()
  private readonly importFlights = new Map<string, Promise<BrowserImportView>>()
  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly actorId: string, private readonly environments: ExecutionEnvironment[], private readonly adapter: BrowserAdapter,
    private readonly authorizeHost: (tx: AsyncTx) => Promise<void>) {}

  private identity(instanceId: string) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The browser belongs to another Instance.')
  }

  private async resource(tx: AsyncTx, resourceId: string) {
    identifier(resourceId, 'resourceId')
    const resource = await tx.get<BrowserResource>('browser-resource', resourceId)
    if (!resource || resource.instanceId !== this.instanceId) throw new CoreError('NOT_FOUND', 'The browser resource is unavailable.')
    return resource
  }

  private async importRecord(tx: AsyncTx, importId: string) {
    identifier(importId, 'browserImportId')
    const record = await tx.get<BrowserImportRecord>('browser-import', importId)
    if (!record || record.instanceId !== this.instanceId) throw new CoreError('NOT_FOUND', 'The browser import is unavailable.')
    return record
  }

  private importView(record: BrowserImportRecord): BrowserImportView {
    return { id: record.id, sourceRef: record.sourceRef, resourceId: record.resourceId, environmentId: record.environmentId,
      label: record.label, status: record.status, preview: structuredClone(record.preview),
      ...(record.report ? { report: structuredClone(record.report) } : {}),
      ...(record.code ? { code: record.code } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  private async resourceGrants(tx: AsyncTx, resourceId: string) {
    const prefix = `${JSON.stringify([resourceId]).slice(0, -1)},`
    const grants: BrowserGrant[] = []
    let after = prefix
    for (let pageCount = 0; pageCount < 2; pageCount++) {
      const page = await tx.scan<BrowserGrant>('browser-grant', { limit: 100, after })
      for (const item of page.items) {
        if (!item.id.startsWith(prefix)) return { items: grants, truncated: false }
        grants.push(item.value)
        if (grants.length === 100) return { items: grants, truncated: true }
      }
      if (!page.cursor?.startsWith(prefix)) return { items: grants, truncated: false }
      after = page.cursor
    }
    return { items: grants, truncated: true }
  }

  private command<T>(commandId: string, input: unknown, apply: (tx: AsyncTx) => Promise<T>): Promise<T> {
    identifier(commandId, 'commandId')
    const key = createHash('sha256').update(canonicalJson([this.instanceId, commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson(input)).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const previous = await tx.get<BrowserReceipt>('browser-command', key)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The browser command ID has different input.')
        return previous.result as T
      }
      const result = await apply(tx)
      await tx.insert('browser-command', key, { fingerprint, result })
      return result
    })
  }

  private async work(tx: AsyncTx, workItemId: string, environmentId: string) {
    const item = await tx.get<MainWorkItem>('work-item', workItemId)
    const brief = item ? await tx.get<MainWorkBrief>('work-brief', item.workBriefId) : undefined
    const index = await tx.get<{ ticketId: string }>('work-item-ticket', workItemId)
    if (!item || !brief || !index || brief.instanceId !== this.instanceId || brief.environmentId !== environmentId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This work has no grant in the browser Environment.')
    }
    return index.ticketId
  }

  private async authorized(tx: AsyncTx, scope: BrowserWork, resource: BrowserResource, allowHuman = false) {
    this.identity(scope.instanceId)
    if (resource.state !== 'active' || resource.environmentId !== scope.environmentId) {
      throw new CoreError('BROWSER_DENIED', 'The browser resource is revoked or belongs to another Environment.')
    }
    const grant = await tx.get<BrowserGrant>('browser-grant', grantKey(resource.id, scope.workItemId))
    const ticketId = await this.work(tx, scope.workItemId, scope.environmentId)
    const assignment = await tx.get<Assignment>('assignment', scope.ticketId)
    const ticket = await tx.get<Work['ticket']>('ticket', scope.ticketId)
    if (!grant?.active || ticketId !== scope.ticketId || !assignment || assignment.id !== scope.assignmentId
      || assignment.generation !== scope.generation || assignment.state !== 'running'
      || assignment.environment?.kind !== 'local' || assignment.environment.id !== scope.environmentId
      || !ticket || ticket.state !== 'open' || ticket.constraint) {
      throw new CoreError('BROWSER_DENIED', 'Only the granted, current local Worker Assignment can use this browser.')
    }
    const control = await tx.get<BrowserControl>('browser-control', resource.id)
    if (!allowHuman && control && control.state !== 'returned') {
      throw new CoreError('BROWSER_HUMAN_CONTROL', 'A person controls this browser; wait for its explicit return.')
    }
  }

  async take(input: { instanceId: string; commandId: string; resourceId: string; workItemId: string; expectedRevision: number }) {
    this.identity(input.instanceId)
    identifier(input.workItemId, 'workItemId')
    if (!Number.isSafeInteger(input.expectedRevision) || !this.adapter.hold) {
      throw new CoreError('BROWSER_UNAVAILABLE', 'The desktop Host cannot transfer this browser to a person.')
    }
    const control = await this.command(input.commandId, ['take', input.resourceId, input.workItemId, input.expectedRevision], async tx => {
      const resource = await this.resource(tx, input.resourceId)
      if (resource.state !== 'active' || resource.revision !== input.expectedRevision) throw new CoreError('RESOURCE_STALE', 'The browser resource changed.')
      const existing = await tx.get<BrowserControl>('browser-control', resource.id)
      if (existing && existing.state !== 'returned') throw new CoreError('BROWSER_HUMAN_CONTROL', 'This browser already awaits a person.')
      const ticketId = await this.work(tx, input.workItemId, resource.environmentId)
      const assignment = await tx.get<Assignment>('assignment', ticketId)
      const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
      if (!assignment || assignment.state !== 'running' || assignment.environment?.kind !== 'local'
        || assignment.environment.id !== resource.environmentId
        || ticket?.state !== 'open' || ticket.constraint
        || !(await tx.get<BrowserGrant>('browser-grant', grantKey(resource.id, input.workItemId)))?.active) {
        throw new CoreError('BROWSER_DENIED', 'A current local Worker grant is required to take over this browser.')
      }
      const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
      if (lease && (lease.assignmentId !== assignment.id || lease.generation !== assignment.generation)) {
        const owner = await tx.get<Assignment>('assignment', lease.ticketId)
        if (owner?.id === lease.assignmentId && owner.generation === lease.generation && owner.state === 'running') {
          throw new CoreError('BROWSER_BUSY', 'Another Worker holds this browser.')
        }
      }
      const control: BrowserControl = { id: randomUUID(), instanceId: this.instanceId, resourceId: resource.id,
        ticketId, workItemId: input.workItemId, assignmentId: assignment.id, generation: assignment.generation,
        environmentId: resource.environmentId, state: 'taking', responsibleActorId: this.actorId, createdAt: Date.now() }
      if (!await tx.replace('browser-control', resource.id, control)) await tx.insert('browser-control', resource.id, control)
      await tx.replace('browser-resource', resource.id, { ...resource, revision: resource.revision + 1 })
      return control
    })
    return this.reconcileTake({ instanceId: input.instanceId, resourceId: input.resourceId, controlId: control.id })
  }

  async reconcileTake(input: { instanceId: string; resourceId: string; controlId: string }) {
    this.identity(input.instanceId)
    identifier(input.controlId, 'controlId')
    if (!this.adapter.hold) throw new CoreError('BROWSER_UNAVAILABLE', 'The desktop Host cannot confirm manual browser control.')
    const control = await this.storage.transaction(this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const resource = await this.resource(tx, input.resourceId)
      const current = await tx.get<BrowserControl>('browser-control', resource.id)
      if (!current || current.id !== input.controlId || current.responsibleActorId !== this.actorId
        || current.state !== 'taking' && current.state !== 'held') {
        throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'Only the original pending takeover can be confirmed.')
      }
      return { control: current, profileKey: resource.profileKey }
    })
    await this.adapter.hold(control.profileKey, true, control.control.id)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const current = await tx.get<BrowserControl>('browser-control', input.resourceId)
      if (!current || current.id !== control.control.id) throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The takeover changed before Host confirmation.')
      if (current.state === 'held') return current
      if (current.state !== 'taking') throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The takeover changed before Host confirmation.')
      const lease = await tx.get<BrowserLease>('browser-lease', input.resourceId)
      if (lease?.operationId) {
        const operation = await tx.get<BrowserOperation>('browser-operation', lease.operationId)
        if (operation?.state === 'pending') await tx.replace('browser-operation', operation.id,
          { ...operation, state: 'unknown', code: 'BROWSER_OUTCOME_UNKNOWN', settledAt: Date.now() })
      }
      const held: BrowserControl = { ...current, state: 'held' }
      await tx.replace('browser-control', input.resourceId, held)
      return held
    })
  }

  async controlView(input: { instanceId: string; resourceId: string; controlId: string }) {
    this.identity(input.instanceId)
    const view = await this.storage.transaction(this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const resource = await this.resource(tx, input.resourceId)
      const control = await tx.get<BrowserControl>('browser-control', resource.id)
      if (!control || control.id !== input.controlId || control.state !== 'held') throw new CoreError('BROWSER_DENIED', 'Take over this browser before opening its manual view.')
      return { profileKey: resource.profileKey, controlId: control.id }
    })
    await this.adapter.hold?.(view.profileKey, true, view.controlId)
    return view
  }

  async giveBack(input: { instanceId: string; commandId: string; resourceId: string; controlId: string }) {
    this.identity(input.instanceId)
    identifier(input.controlId, 'controlId')
    if (!this.adapter.hold) throw new CoreError('BROWSER_UNAVAILABLE', 'The desktop Host cannot return this browser.')
    const control = await this.command(input.commandId, ['return', input.resourceId, input.controlId], async tx => {
      const resource = await this.resource(tx, input.resourceId)
      const current = await tx.get<BrowserControl>('browser-control', resource.id)
      if (!current || current.id !== input.controlId || current.responsibleActorId !== this.actorId) {
        throw new CoreError('BROWSER_DENIED', 'This browser control belongs to another person or generation.')
      }
      if (current.state === 'returned') return current
      if (current.state !== 'held' && current.state !== 'returning') throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser takeover has not been confirmed.')
      const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
      if (lease?.operationId) throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'Inspect the original browser operation before returning control.')
      const returning: BrowserControl = { ...current, state: 'returning' }
      await tx.replace('browser-control', resource.id, returning)
      return returning
    })
    if (control.state === 'returned') return control
    const latest = await this.storage.transaction(this.instanceId, tx => tx.get<BrowserControl>('browser-control', input.resourceId))
    if (latest?.id !== control.id) throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser control changed while returning it.')
    if (latest.state === 'returned') return latest
    if (latest.state !== 'returning') throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser control is still held.')
    const resource = await this.storage.transaction(this.instanceId, tx => this.resource(tx, input.resourceId))
    await this.adapter.hold(resource.profileKey, false, control.id)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const current = await tx.get<BrowserControl>('browser-control', input.resourceId)
      if (!current || current.id !== control.id) throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser control changed while returning it.')
      if (current.state === 'returned') return current
      if (current.state !== 'returning') throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser control is still held.')
      const returned: BrowserControl = { ...current, state: 'returned', returnedAt: Date.now() }
      await tx.replace('browser-control', input.resourceId, returned)
      return returned
    })
  }

  async importData(input: {
    instanceId: string; commandId: string; sourceRef: string; pendingId: string; preview: BrowserImportPreview
    environmentId: string; label: string
  }) {
    this.identity(input.instanceId)
    identifier(input.commandId, 'commandId'); identifier(input.sourceRef, 'browserImportSourceRef')
    identifier(input.pendingId, 'browserImportPendingId')
    if (!browserImportId.test(input.sourceRef)) throw new CoreError('INVALID_INPUT', 'A browser import source reference is invalid.')
    identifier(input.environmentId, 'environmentId')
    const label = importText(input.label, 'Imported browser label', 128)
    const preview = importPreview(input.preview)
    const sourceKey = createHash('sha256').update(canonicalJson(['browser-import-source-v1', this.instanceId, input.pendingId])).digest('hex')
    const previewHash = createHash('sha256').update(canonicalJson(['browser-import-preview-v1', preview])).digest('hex')
    const commandKey = createHash('sha256').update(canonicalJson([this.instanceId, input.commandId, 'browser-import'])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson(['browser-import-v1', input.sourceRef, sourceKey, previewHash,
      input.environmentId, label])).digest('hex')
    const prepared = await commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const previous = await tx.get<BrowserImportCommand>('browser-import-command', commandKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The browser import command has different input.')
        const record = await this.importRecord(tx, previous.importId)
        const resource = await this.resource(tx, record.resourceId)
        return { record, profileKey: resource.profileKey }
      }
      const mapped = await tx.get<BrowserImportSource>('browser-import-source', sourceKey)
      if (mapped && mapped.importId !== input.sourceRef) {
        throw new CoreError('IDENTITY_CONFLICT', 'This browser import source already belongs to another batch.')
      }
      const existing = await tx.get<BrowserImportRecord>('browser-import', input.sourceRef)
      if (existing) {
        if (existing.previewHash !== previewHash) throw new CoreError('IDENTITY_CONFLICT', 'This browser import source changed after preview.')
        if (existing.environmentId !== input.environmentId || existing.label !== label) {
          throw new CoreError('IDENTITY_CONFLICT', 'This browser import already has another target.')
        }
        if (existing.status === 'cancelled') throw new CoreError('BROWSER_IMPORT_CANCELLED', 'This browser import was cancelled.')
        if (!mapped) await tx.insert('browser-import-source', sourceKey, { sourceKey, importId: existing.id })
        if (existing.sourceKey !== sourceKey && existing.status !== 'applied') {
          await tx.replace('browser-import', existing.id, { ...existing, sourceKey, updatedAt: Date.now() })
        }
        await tx.insert('browser-import-command', commandKey, { fingerprint, importId: existing.id })
        const resource = await this.resource(tx, existing.resourceId)
        return { record: existing.sourceKey === sourceKey ? existing : { ...existing, sourceKey }, profileKey: resource.profileKey }
      }
      const environment = this.environments.find(candidate => candidate.config.id === input.environmentId)
      if (!environment || environment.kind !== 'local' || environment.config.instanceId !== this.instanceId
        || !environment.config.allowedActorIds.includes(this.actorId)) {
        throw new CoreError('ENVIRONMENT_DENIED', 'Choose an authorized local Environment for this browser import.')
      }
      if ((await tx.list('browser-resource', 101)).length >= 100) throw new CoreError('RESOURCE_LIMIT', 'The Instance browser resource limit was reached.')
      const now = Date.now()
      const resourceId = randomUUID()
      const importId = input.sourceRef
      const resource: BrowserResource = { id: resourceId, instanceId: this.instanceId, environmentId: input.environmentId,
        label, profileKey: `session-${randomUUID()}`, revision: 1, state: 'importing', operationIds: [], createdAt: now }
      const record: BrowserImportRecord = { id: importId, sourceRef: input.sourceRef, instanceId: this.instanceId, sourceKey, previewHash, preview,
        resourceId, environmentId: input.environmentId, label, status: 'pending', createdAt: now, updatedAt: now }
      await tx.insert('browser-resource', resourceId, resource)
      await tx.insert('browser-import', importId, record)
      await tx.insert('browser-import-source', sourceKey, { sourceKey, importId })
      await tx.insert('browser-import-command', commandKey, { fingerprint, importId })
      return { record, profileKey: resource.profileKey }
    })
    if (prepared.record.status === 'applied') return this.importView(prepared.record)
    if (prepared.record.status === 'cancelled') throw new CoreError('BROWSER_IMPORT_CANCELLED', 'This browser import was cancelled.')
    const active = this.importFlights.get(prepared.record.id)
    if (active) return active
    const flight = this.dispatchImport(prepared.record.id, prepared.profileKey, input.pendingId)
    this.importFlights.set(prepared.record.id, flight)
    try { return await flight }
    finally { if (this.importFlights.get(prepared.record.id) === flight) this.importFlights.delete(prepared.record.id) }
  }

  private async dispatchImport(importId: string, profileKey: string, pendingId: string) {
    if (!this.adapter.importProfile) {
      await this.markImportUnknown(importId, 'BROWSER_UNAVAILABLE')
      throw new CoreError('BROWSER_UNAVAILABLE', 'The desktop Host cannot import browser data.')
    }
    let report: BrowserImportReport
    try {
      report = importReport(await this.adapter.importProfile({ profileKey, pendingImportId: pendingId, importId }))
    } catch (error) {
      const code = importErrorCode(error)
      await this.markImportUnknown(importId, code)
      if (error instanceof CoreError && error.code === code) throw error
      throw new CoreError(code, 'The browser import result is unknown; retry the same preview before using the resource.')
    }
    const applied = await commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const current = await this.importRecord(tx, importId)
      if (current.status === 'cancelled') throw new CoreError('BROWSER_IMPORT_CANCELLED', 'This browser import was cancelled.')
      if (current.status === 'applied') return current
      const resource = await this.resource(tx, current.resourceId)
      if (resource.state !== 'importing') throw new CoreError('BROWSER_IMPORT_CANCELLED',
        'The browser resource changed before its import completed.')
      const active: BrowserResource = { ...resource, state: 'active' }
      await tx.replace('browser-resource', resource.id, active)
      const { code: _code, ...applied } = current
      const next: BrowserImportRecord = { ...applied, status: 'applied', report, updatedAt: Date.now() }
      await tx.replace('browser-import', current.id, next)
      return next
    })
    return this.importView(applied)
  }

  private async markImportUnknown(importId: string, code: string) {
    await this.storage.transaction(this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const current = await this.importRecord(tx, importId)
      if (current.status === 'applied' || current.status === 'cancelled') return
      await tx.replace('browser-import', current.id,
        { ...current, status: 'unknown', code, updatedAt: Date.now() })
    }).catch(() => { /* The pending import remains visible and retryable. */ })
  }

  async listImports(input: { instanceId: string; limit?: number }) {
    this.identity(input.instanceId)
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_INPUT', 'Choose between 1 and 100 browser imports.')
    return this.storage.transaction(this.instanceId, async tx => {
      const records = await tx.list<BrowserImportRecord>('browser-import', 101)
      if (records.length > 100) throw new CoreError('RESOURCE_LIMIT', 'The browser import index exceeds its declared limit.')
      return { items: records.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(record => this.importView(record)) }
    })
  }

  async readImport(input: { instanceId: string; importId: string }) {
    this.identity(input.instanceId)
    return this.storage.transaction(this.instanceId, async tx => this.importView(await this.importRecord(tx, input.importId)))
  }

  async cancelImport(input: { instanceId: string; commandId: string; importId: string }) {
    this.identity(input.instanceId)
    return this.command(input.commandId, ['cancel-import', input.importId], async tx => {
      const current = await this.importRecord(tx, input.importId)
      if (current.status === 'cancelled') return this.importView(current)
      if (current.status === 'applied') throw new CoreError('INVALID_INPUT', 'Revoke an applied browser resource instead of cancelling its import.')
      const resource = await this.resource(tx, current.resourceId)
      if (resource.state !== 'revoked') await tx.replace('browser-resource', resource.id,
        { ...resource, state: 'revoked', revision: resource.revision + 1 })
      const next: BrowserImportRecord = { ...current, status: 'cancelled', updatedAt: Date.now() }
      await tx.replace('browser-import', current.id, next)
      return this.importView(next)
    })
  }

  async create(input: { instanceId: string; commandId: string; environmentId: string; label: string }) {
    this.identity(input.instanceId)
    identifier(input.environmentId, 'environmentId')
    if (typeof input.label !== 'string' || !input.label.trim() || Buffer.byteLength(input.label) > 128) {
      throw new CoreError('INVALID_INPUT', 'Name the browser resource in at most 128 bytes.')
    }
    return this.command(input.commandId, ['create', input.environmentId, input.label.trim()], async tx => {
      const environment = this.environments.find(candidate => candidate.config.id === input.environmentId)
      if (!environment || environment.kind !== 'local' || environment.config.instanceId !== this.instanceId
        || !environment.config.allowedActorIds.includes(this.actorId)) {
        throw new CoreError('ENVIRONMENT_DENIED', 'Choose an authorized local Environment for this browser.')
      }
      if ((await tx.list('browser-resource', 101)).length >= 100) throw new CoreError('RESOURCE_LIMIT', 'The Instance browser resource limit was reached.')
      const id = randomUUID()
      const resource: BrowserResource = { id, instanceId: this.instanceId, environmentId: input.environmentId,
        label: input.label.trim(), profileKey: `session-${randomUUID()}`, revision: 1, state: 'active',
        operationIds: [], createdAt: Date.now() }
      await tx.insert('browser-resource', id, resource)
      return this.view(tx, resource)
    })
  }

  async grant(input: { instanceId: string; commandId: string; resourceId: string; workItemId: string; expectedRevision: number; active: boolean }) {
    this.identity(input.instanceId)
    identifier(input.workItemId, 'workItemId')
    if (typeof input.active !== 'boolean' || !Number.isSafeInteger(input.expectedRevision)) throw new CoreError('INVALID_INPUT', 'A browser grant needs a revision and explicit decision.')
    return this.command(input.commandId, ['grant', input.resourceId, input.workItemId, input.expectedRevision, input.active], async tx => {
      const resource = await this.resource(tx, input.resourceId)
      if (resource.state !== 'active' || resource.revision !== input.expectedRevision) throw new CoreError('RESOURCE_STALE', 'The browser resource changed.')
      await this.work(tx, input.workItemId, resource.environmentId)
      const key = grantKey(resource.id, input.workItemId)
      const existing = await tx.get<BrowserGrant>('browser-grant', key)
      if (!existing && (await this.resourceGrants(tx, resource.id)).truncated) {
        throw new CoreError('RESOURCE_LIMIT', 'The browser grant index for this resource is full.')
      }
      const grant: BrowserGrant = { resourceId: resource.id, workItemId: input.workItemId, active: input.active }
      if (!await tx.replace('browser-grant', key, grant)) await tx.insert('browser-grant', key, grant)
      await tx.replace('browser-resource', resource.id, { ...resource, revision: resource.revision + 1 })
      return { resourceId: resource.id, workItemId: input.workItemId, active: input.active, revision: resource.revision + 1 }
    })
  }

  async revoke(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number }) {
    this.identity(input.instanceId)
    return this.command(input.commandId, ['revoke', input.resourceId, input.expectedRevision], async tx => {
      const resource = await this.resource(tx, input.resourceId)
      if (resource.state === 'importing') throw new CoreError('INVALID_INPUT', 'Cancel the pending browser import instead of revoking its resource.')
      if (resource.revision !== input.expectedRevision) throw new CoreError('RESOURCE_STALE', 'The browser resource changed.')
      const updated = { ...resource, revision: resource.revision + 1, state: 'revoked' as const }
      await tx.replace('browser-resource', resource.id, updated)
      return this.view(tx, updated)
    })
  }

  private async view(tx: AsyncTx, resource: BrowserResource) {
    const control = await tx.get<BrowserControl>('browser-control', resource.id)
    const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
    const owner = lease ? await tx.get<Assignment>('assignment', lease.ticketId) : undefined
    const operation = lease?.operationId ? await tx.get<BrowserOperation>('browser-operation', lease.operationId) : undefined
    const grants = await this.resourceGrants(tx, resource.id)
    const occupied = owner && lease && owner.id === lease.assignmentId && owner.generation === lease.generation && owner.state === 'running'
    const state = operation?.state === 'unknown' || operation?.state === 'pending' && !occupied ? 'unknown'
      : resource.state === 'importing' ? 'importing'
        : resource.state === 'revoked' ? 'revoked'
        : control && control.state !== 'returned' ? 'human'
        : occupied ? 'busy' : 'available'
    return { id: resource.id, environmentId: resource.environmentId, label: resource.label,
      revision: resource.revision, state,
      ...(control && control.state !== 'returned' ? { control: { id: control.id, state: control.state,
        ticketId: control.ticketId, workItemId: control.workItemId, assignmentId: control.assignmentId,
        generation: control.generation, responsibleActorId: control.responsibleActorId } } : {}),
      grants: grants.items.map(grant => ({ workItemId: grant.workItemId, active: grant.active })),
      grantsTruncated: grants.truncated,
      ...(state === 'busy' || state === 'unknown' ? { owner: { ticketId: lease!.ticketId, assignmentId: lease!.assignmentId, generation: lease!.generation } } : {}),
      operations: (await Promise.all(resource.operationIds.map(id => tx.get<BrowserOperation>('browser-operation', id)))).filter(Boolean) }
  }

  async read(input: { instanceId: string; resourceId: string }) {
    this.identity(input.instanceId)
    return this.storage.transaction(this.instanceId, async tx => this.view(tx, await this.resource(tx, input.resourceId)))
  }

  async list(input: { instanceId: string }) {
    this.identity(input.instanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      const resources = await tx.list<BrowserResource>('browser-resource', 101)
      if (resources.length > 100) throw new CoreError('RESOURCE_LIMIT', 'The browser resource index exceeds its declared limit.')
      return Promise.all(resources.map(resource => this.view(tx, resource)))
    })
  }

  async forWorker(scope: BrowserWork) {
    this.identity(scope.instanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const resources = await tx.list<BrowserResource>('browser-resource', 101)
      const visible = []
      for (const resource of resources) {
        if (resource.state !== 'active' || resource.environmentId !== scope.environmentId) continue
        if (!(await tx.get<BrowserGrant>('browser-grant', grantKey(resource.id, scope.workItemId)))?.active) continue
        await this.authorized(tx, scope, resource, true)
        const view = await this.view(tx, resource)
        visible.push({ id: view.id, environmentId: view.environmentId, label: view.label, state: view.control ? 'human' : view.state })
      }
      return visible
    })
  }

  /** The lease index is authoritative even when its operation has fallen out of the bounded display history. */
  async unconfirmed(tx: AsyncTx, ticketId: string) {
    const resources = await tx.list<BrowserResource>('browser-resource', 101)
    if (resources.length > 100) throw new CoreError('RESOURCE_LIMIT', 'The browser resource index exceeds its declared limit.')
    const pending: BrowserOperation[] = []
    for (const resource of resources) {
      const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
      if (lease?.ticketId !== ticketId || !lease.operationId) continue
      const operation = await tx.get<BrowserOperation>('browser-operation', lease.operationId)
      if (operation?.state === 'pending' || operation?.state === 'unknown') pending.push(operation)
    }
    return pending
  }

  async use(scope: BrowserWork, input: { resourceId: string; action: 'open' | 'snapshot'; url?: string }, signal: AbortSignal) {
    this.identity(scope.instanceId)
    if (input.action !== 'open' && input.action !== 'snapshot') throw new CoreError('INVALID_INPUT', 'Choose browser open or snapshot.')
    if (input.action === 'open') {
      let url: URL
      try { url = new URL(input.url ?? '') } catch { throw new CoreError('INVALID_INPUT', 'Open an HTTP or HTTPS page.') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || Buffer.byteLength(input.url ?? '') > 2048) {
        throw new CoreError('INVALID_INPUT', 'Open an HTTP or HTTPS page without embedded credentials.')
      }
    } else if (input.url !== undefined) throw new CoreError('INVALID_INPUT', 'A snapshot does not accept a URL.')
    signal.throwIfAborted()
    const operationId = randomUUID()
    const started = await commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorizeHost(tx)
      const resource = await this.resource(tx, input.resourceId)
      await this.authorized(tx, scope, resource)
      const existing = await tx.get<BrowserLease>('browser-lease', resource.id)
      const resumed = await tx.get<BrowserOperation>('browser-operation', operationId)
      if (resumed && existing?.operationId === resumed.id && resumed.state === 'pending') {
        return { operation: resumed, profileKey: resource.profileKey }
      }
      if (existing?.operationId) {
        const operation = await tx.get<BrowserOperation>('browser-operation', existing.operationId)
        const owner = await tx.get<Assignment>('assignment', existing.ticketId)
        if (operation?.state === 'pending' && owner?.id === existing.assignmentId
          && owner.generation === existing.generation && owner.state === 'running') {
          throw new CoreError('BROWSER_BUSY', 'A Worker is using this browser resource.')
        }
        throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'A prior browser operation has no confirmed outcome.')
      }
      if (existing && (existing.assignmentId !== scope.assignmentId || existing.generation !== scope.generation)) {
        const owner = await tx.get<Assignment>('assignment', existing.ticketId)
        if (owner?.id === existing.assignmentId && owner.generation === existing.generation && owner.state === 'running') {
          throw new CoreError('BROWSER_BUSY', 'Another Worker Assignment holds this browser resource.')
        }
      }
      const operation: BrowserOperation = { id: operationId, resourceId: resource.id, ticketId: scope.ticketId,
        workItemId: scope.workItemId, assignmentId: scope.assignmentId, generation: scope.generation,
        ownerRuntime: this.runtimeId, action: input.action, state: 'pending', createdAt: Date.now() }
      await tx.insert('browser-operation', operation.id, operation)
      const lease: BrowserLease = { ...scope, resourceId: resource.id, acquiredAt: existing?.assignmentId === scope.assignmentId
        ? existing.acquiredAt : Date.now(), operationId: operation.id }
      if (!await tx.replace('browser-lease', resource.id, lease)) await tx.insert('browser-lease', resource.id, lease)
      await tx.replace('browser-resource', resource.id, { ...resource, operationIds: [...resource.operationIds, operation.id].slice(-20) })
      return { operation, profileKey: resource.profileKey }
    })
    let text: string | undefined
    try {
      await this.storage.transaction(this.instanceId, async tx => {
        await this.authorizeHost(tx)
        await this.authorized(tx, scope, await this.resource(tx, input.resourceId))
      })
      text = await this.adapter.execute({ profileKey: started.profileKey, action: input.action,
        ...(input.action === 'open' ? { url: input.url } : {}) }, signal)
      if (typeof text !== 'string' || Buffer.byteLength(text) > 8192 || signal.aborted) throw new Error('Browser result unconfirmed')
      await commandTransaction(this.storage, this.instanceId, async tx => {
        await this.authorizeHost(tx)
        const operation = await tx.get<BrowserOperation>('browser-operation', started.operation.id)
        if (operation?.state === 'succeeded') return
        const resource = await this.resource(tx, input.resourceId)
        await this.authorized(tx, scope, resource)
        const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
        if (lease?.operationId !== started.operation.id) throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'The browser lease changed.')
        await tx.replace('browser-operation', started.operation.id, { ...started.operation, state: 'succeeded', settledAt: Date.now() })
        const { operationId: _operationId, ...released } = lease
        await tx.replace('browser-lease', resource.id, released)
      })
      return { operationId: started.operation.id, text }
    } catch {
      // If a committed success lost its database acknowledgement, read the original operation before reporting unknown.
      const committed = await this.storage.transaction(this.instanceId, tx =>
        tx.get<BrowserOperation>('browser-operation', started.operation.id)).catch(() => undefined)
      if (committed?.state === 'succeeded' && text !== undefined) return { operationId: started.operation.id, text }
      // A dispatched navigation or read may have happened even when the response was lost or a stop arrived.
      await commandTransaction(this.storage, this.instanceId, async tx => {
        const current = await tx.get<BrowserOperation>('browser-operation', started.operation.id)
        if (current?.state === 'pending') await tx.replace('browser-operation', current.id,
          { ...current, state: 'unknown', code: 'BROWSER_OUTCOME_UNKNOWN', settledAt: Date.now() })
      }).catch(() => { /* The pending intent remains a visible, blocking unknown. */ })
      throw new BrowserOutcomeUnknown(started.operation.id)
    }
  }

  async resolve(input: { instanceId: string; commandId: string; resourceId: string; operationId: string; reason: string }) {
    this.identity(input.instanceId)
    identifier(input.operationId, 'operationId')
    if (!browserObservations.includes(input.reason as typeof browserObservations[number])) {
      throw new CoreError('INVALID_INPUT', 'Choose the observed browser state used to reconcile this operation.')
    }
    return this.command(input.commandId, ['resolve', input.resourceId, input.operationId, input.reason], async tx => {
      const resource = await this.resource(tx, input.resourceId)
      const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
      const operation = await tx.get<BrowserOperation>('browser-operation', input.operationId)
      const assignment = lease ? await tx.get<Assignment>('assignment', lease.ticketId) : undefined
      if (!operation || operation.resourceId !== resource.id || lease?.operationId !== operation.id
        || operation.state !== 'unknown' && !(operation.state === 'pending'
          && operation.ownerRuntime !== this.runtimeId
          && (assignment?.id !== lease.assignmentId || assignment.generation !== lease.generation || assignment.state !== 'running'))) {
        throw new CoreError('BROWSER_RECONCILE_REQUIRED', 'Only an unknown or abandoned browser operation can be reconciled.')
      }
      const updated: BrowserOperation = { ...operation, state: 'resolved', resolution: input.reason, settledAt: Date.now() }
      await tx.replace('browser-operation', operation.id, updated)
      const { operationId: _operationId, ...released } = lease
      await tx.replace('browser-lease', resource.id, released)
      return updated
    })
  }

  close() { return this.adapter.close?.() ?? Promise.resolve() }
}
