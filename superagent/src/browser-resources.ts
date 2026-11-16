import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import type { ExecutionEnvironment } from './environment.js'
import type { Assignment } from './execution.js'
import { CoreError, identifier, type Work } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import type { MainWorkBrief, MainWorkItem } from './work-delegation.js'

export interface BrowserAdapter {
  execute(request: { profileKey: string; action: 'open' | 'snapshot'; url?: string }, signal: AbortSignal): Promise<string>
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
  state: 'active' | 'revoked'
  operationIds: string[]
  createdAt: number
}

interface BrowserLease extends BrowserWork {
  resourceId: string
  acquiredAt: number
  operationId?: string
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

function profileKey(instanceId: string, resourceId: string) {
  const bytes = createHash('sha256').update(canonicalJson(['ds-superagent-browser', instanceId, resourceId])).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `session-${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`
}

const grantKey = (resourceId: string, workItemId: string) => canonicalJson([resourceId, workItemId])
const browserObservations = ['UNCHANGED', 'CHANGED', 'CLOSED', 'INSPECTED'] as const

/** Product-owned profiles and durable, single-Assignment write control. No Bot identity is imported. */
export class BrowserResources {
  private readonly runtimeId = randomUUID()
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

  private async authorized(tx: AsyncTx, scope: BrowserWork, resource: BrowserResource) {
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
        label: input.label.trim(), profileKey: profileKey(this.instanceId, id), revision: 1, state: 'active',
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
      if (resource.revision !== input.expectedRevision) throw new CoreError('RESOURCE_STALE', 'The browser resource changed.')
      const updated = { ...resource, revision: resource.revision + 1, state: 'revoked' as const }
      await tx.replace('browser-resource', resource.id, updated)
      return this.view(tx, updated)
    })
  }

  private async view(tx: AsyncTx, resource: BrowserResource) {
    const lease = await tx.get<BrowserLease>('browser-lease', resource.id)
    const owner = lease ? await tx.get<Assignment>('assignment', lease.ticketId) : undefined
    const operation = lease?.operationId ? await tx.get<BrowserOperation>('browser-operation', lease.operationId) : undefined
    const grants = await this.resourceGrants(tx, resource.id)
    const occupied = owner && lease && owner.id === lease.assignmentId && owner.generation === lease.generation && owner.state === 'running'
    const state = operation?.state === 'unknown' || operation?.state === 'pending' && !occupied ? 'unknown'
      : resource.state === 'revoked' ? 'revoked'
        : occupied ? 'busy' : 'available'
    return { id: resource.id, environmentId: resource.environmentId, label: resource.label,
      revision: resource.revision, state,
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
        await this.authorized(tx, scope, resource)
        const view = await this.view(tx, resource)
        visible.push({ id: view.id, environmentId: view.environmentId, label: view.label, state: view.state })
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
