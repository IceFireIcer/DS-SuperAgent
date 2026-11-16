import { createHash } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier } from './model.js'
import type { CredentialResourceView, CredentialUse } from './resource-credentials.js'
import type { AsyncTx, Storage } from './storage.js'
import { workerMcpName, type WorkerMcpConfig } from './worker-mcp-tool.js'

interface McpSelection {
  declaration: string
  revision: number
  resourceId: string
  approved: boolean
  connected: boolean
  updatedAt: number
}

interface McpReceipt { fingerprint: string; selection: McpSelection }

export interface ProductMcpView {
  configured: true
  serverName: string
  toolName: string
  location: 'host'
  remote: 'unsupported'
  revision: number
  resourceId: string
  approved: boolean
  connected: boolean
  state: 'off' | 'needs-approval' | 'needs-grant' | 'ready' | 'error'
  error?: 'CONFIG_CHANGED' | 'RESOURCE_UNAVAILABLE'
}

/** A deployment declares the endpoint; product commands only select and enable a managed credential. */
export class ProductMcpConfiguration {
  private readonly declaration: string

  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly configured: WorkerMcpConfig, private readonly authorize: (tx: AsyncTx) => Promise<void>) {
    identifier(instanceId, 'instanceId')
    workerMcpName(configured)
    this.declaration = createHash('sha256').update(canonicalJson([
      configured.serverName, configured.toolName, configured.url,
    ])).digest('hex')
  }

  private initial(): McpSelection {
    // Deployment selects the tool, but a product actor must approve and connect it explicitly.
    return { declaration: this.declaration, revision: 0, resourceId: this.configured.resourceId,
      approved: false, connected: false, updatedAt: 0 }
  }

  private assertInstance(instanceId: unknown) {
    if (instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The MCP setting belongs to another Instance.')
  }

  private async projection(selection: McpSelection, tx: AsyncTx): Promise<ProductMcpView> {
    const resource = await tx.get<CredentialResourceView>('resource-credential', selection.resourceId)
    const error = selection.declaration !== this.declaration ? 'CONFIG_CHANGED'
      : resource?.status !== 'active' ? 'RESOURCE_UNAVAILABLE' : undefined
    const grant = resource?.grants.some(item => item.scope.role === 'worker' && item.purposes.includes('tool')) ?? false
    const state = error ? 'error' : !selection.approved ? 'needs-approval'
      : !selection.connected ? 'off' : !grant ? 'needs-grant' : 'ready'
    return { configured: true, serverName: this.configured.serverName, toolName: this.configured.toolName,
      location: 'host', remote: 'unsupported', revision: selection.revision, resourceId: selection.resourceId,
      approved: selection.approved, connected: selection.connected, state, ...(error ? { error } : {}) }
  }

  async get(input: { instanceId: string }): Promise<ProductMcpView> {
    this.assertInstance(input?.instanceId)
    return this.storage.transaction(this.instanceId, async tx =>
      this.projection(await tx.get<McpSelection>('product-mcp-selection', 'worker') ?? this.initial(), tx))
  }

  private async command(input: { instanceId: string; commandId: string; expectedRevision: number }, action: string,
    value: unknown, change: (current: McpSelection, tx: AsyncTx) => Promise<McpSelection>): Promise<ProductMcpView> {
    this.assertInstance(input?.instanceId)
    identifier(input.commandId, 'commandId')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new CoreError('INVALID_INPUT', 'An expected MCP configuration revision is required.')
    }
    const fingerprint = createHash('sha256').update(canonicalJson([action, value, input.expectedRevision])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.authorize(tx)
      const receipt = await tx.get<McpReceipt>('product-mcp-command', input.commandId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The MCP command ID has different input.')
        return this.projection(await tx.get<McpSelection>('product-mcp-selection', 'worker') ?? this.initial(), tx)
      }
      const current = await tx.get<McpSelection>('product-mcp-selection', 'worker') ?? this.initial()
      if (current.revision !== input.expectedRevision) throw new CoreError('MCP_REVISION_CONFLICT', 'The MCP configuration changed; review it before saving.')
      const next = await change(current, tx)
      const updated = { ...next, revision: current.revision + 1, updatedAt: Date.now() }
      if (!await tx.replace('product-mcp-selection', 'worker', updated)) await tx.insert('product-mcp-selection', 'worker', updated)
      await tx.insert('product-mcp-command', input.commandId, { fingerprint, selection: updated } satisfies McpReceipt)
      return this.projection(updated, tx)
    })
  }

  save(input: { instanceId: string; commandId: string; expectedRevision: number; resourceId: string }) {
    identifier(input?.resourceId, 'resourceId')
    return this.command(input, 'save', input.resourceId, async (current, tx) => {
      const resource = await tx.get<CredentialResourceView>('resource-credential', input.resourceId)
      if (resource?.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'Choose an active MCP credential resource.')
      return { ...current, declaration: this.declaration, resourceId: input.resourceId, approved: false, connected: false }
    })
  }

  approve(input: { instanceId: string; commandId: string; expectedRevision: number; approved: boolean }) {
    if (typeof input?.approved !== 'boolean') throw new CoreError('INVALID_INPUT', 'Choose whether to approve this MCP tool.')
    return this.command(input, 'approve', input.approved, async (current, tx) => {
      if (current.declaration !== this.declaration) throw new CoreError('INVALID_CONFIG', 'Save the changed Host tool before approving it.')
      const resource = await tx.get<CredentialResourceView>('resource-credential', current.resourceId)
      if (resource?.status !== 'active') throw new CoreError('RESOURCE_UNAVAILABLE', 'Choose an active MCP credential resource.')
      return { ...current, approved: input.approved, connected: input.approved && current.connected }
    })
  }

  connect(input: { instanceId: string; commandId: string; expectedRevision: number }, retry = false) {
    return this.command(input, retry ? 'retry' : 'connect', null, async (current, tx) => {
      const view = await this.projection(current, tx)
      if (view.error) throw new CoreError(view.error, 'Save an active credential for this Host MCP tool.')
      if (!current.approved) throw new CoreError('MCP_NOT_APPROVED', 'Approve this tool before connecting it.')
      const resource = await tx.get<CredentialResourceView>('resource-credential', current.resourceId)
      if (!resource!.grants.some(item => item.scope.role === 'worker' && item.purposes.includes('tool'))) {
        throw new CoreError('GRANT_DENIED', 'Grant Worker/tool for the intended work or Environment first.')
      }
      return { ...current, connected: true }
    })
  }

  disconnect(input: { instanceId: string; commandId: string; expectedRevision: number }) {
    return this.command(input, 'disconnect', null, async current => ({ ...current, connected: false }))
  }

  /** Recheck the switch before the credential is opened and again at its actual use site. */
  async assertUse(input: CredentialUse) {
    this.assertInstance(input.instanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      const selection = await tx.get<McpSelection>('product-mcp-selection', 'worker') ?? this.initial()
      const view = await this.projection(selection, tx)
      if (view.resourceId !== input.resourceId || !selection.connected) {
        throw new CoreError('MCP_NOT_CONNECTED', 'This Host MCP tool is not enabled for the selected resource.')
      }
      if (view.error) throw new CoreError(view.error, 'The selected MCP resource is unavailable.')
      if (!selection.approved) throw new CoreError('MCP_NOT_APPROVED', 'This Host MCP tool is no longer approved.')
      const resource = await tx.get<CredentialResourceView>('resource-credential', input.resourceId)
      if (!resource?.grants.some(grant => grant.scope.role === 'worker' && grant.purposes.includes('tool')
        && (grant.scope.workItemId === undefined || grant.scope.workItemId === input.workItemId)
        && (grant.scope.environmentId === undefined || grant.scope.environmentId === input.environmentId)
        && (grant.scope.sourceInstanceId === undefined || grant.scope.sourceInstanceId === input.sourceInstanceId))) {
        throw new CoreError('GRANT_DENIED', 'This MCP tool has no grant for the current work and Environment.')
      }
    })
  }
}
