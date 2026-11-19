import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, type Work } from './model.js'
import type { Assignment } from './execution.js'
import type { CredentialUse } from './resource-credentials.js'
import type { AsyncTx, Storage } from './storage.js'
import type { WorkerMcpConfig } from './worker-mcp-tool.js'

/** The ID is sent with the original tools/call. No request arguments, credential or response text is retained. */
export interface WorkerMcpCall {
  id: string
  requestId: string
  ticketId: string
  assignmentId: string
  generation: string
  workItemId: string
  environmentId: string
  serverName: string
  toolName: string
  resourceId: string
  inputSha256: string
  state: 'unknown' | 'confirmed'
  outcome?: 'success' | 'failed'
  code?: string
  startedAt: number
  settledAt?: number
}

export interface WorkerMcpDenial {
  id: string
  ticketId: string
  assignmentId: string
  generation: string
  workItemId: string
  environmentId: string
  serverName: string
  toolName: string
  code: string
  deniedAt: number
}

const callPrefix = (ticketId: string) => `${JSON.stringify(['worker-mcp-call', ticketId])}:`
const denialPrefix = (ticketId: string) => `${JSON.stringify(['worker-mcp-denial', ticketId])}:`
const blockKey = (ticketId: string) => JSON.stringify(['worker-mcp-block', ticketId])

export async function mcpBlockIn(tx: AsyncTx, ticketId: string) {
  const block = await tx.get<{ callId: string }>('worker-mcp-block', blockKey(ticketId))
  if (!block) return undefined
  const call = await tx.get<WorkerMcpCall>('worker-mcp-call', block.callId)
  if (!call || call.ticketId !== ticketId || call.state !== 'unknown') {
    throw new CoreError('MCP_OUTCOME_UNKNOWN', 'The original MCP request cannot be verified from its dispatch intent.')
  }
  return call
}

export async function mcpCallPageIn(tx: AsyncTx, ticketId: string, after?: string) {
  const prefix = callPrefix(ticketId)
  if (after && !after.startsWith(prefix)) throw new CoreError('INVALID_INPUT', 'The MCP call cursor belongs to another Ticket.')
  const page = await tx.scan<WorkerMcpCall>('worker-mcp-call', { limit: 100, after: after ?? prefix })
  return { items: page.items.filter(entry => entry.id.startsWith(prefix)).map(entry => entry.value),
    ...(page.cursor?.startsWith(prefix) ? { cursor: page.cursor } : {}) }
}

export async function mcpDenialPageIn(tx: AsyncTx, ticketId: string, after?: string) {
  const prefix = denialPrefix(ticketId)
  if (after && !after.startsWith(prefix)) throw new CoreError('INVALID_INPUT', 'The MCP denial cursor belongs to another Ticket.')
  const page = await tx.scan<WorkerMcpDenial>('worker-mcp-denial', { limit: 100, after: after ?? prefix })
  return { items: page.items.filter(entry => entry.id.startsWith(prefix)).map(entry => entry.value),
    ...(page.cursor?.startsWith(prefix) ? { cursor: page.cursor } : {}) }
}

/** A dispatch intent is already unknown until its original request receives a durable confirmation. */
export class WorkerMcpCalls {
  constructor(private readonly storage: Storage, private readonly instanceId: string) {}

  async recordNotDispatched(ticketId: string, assignment: { id: string; generation: string },
    config: WorkerMcpConfig, code: string) {
    const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'MCP_TOOL_FAILED'
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await tx.get<Assignment>('assignment', ticketId)
      const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
      const link = await tx.get<{ workItemId: string }>('work-ticket', ticketId)
      if (!ticket || !link || !current || current.id !== assignment.id || current.generation !== assignment.generation) {
        throw new CoreError('STALE_ASSIGNMENT', 'Only the bound Worker Assignment may record this MCP denial.')
      }
      const denied: WorkerMcpDenial = { id: `${denialPrefix(ticketId)}${randomUUID()}`, ticketId,
        assignmentId: current.id, generation: current.generation, workItemId: link.workItemId,
        environmentId: current.environment?.id ?? 'unknown', serverName: config.serverName, toolName: config.toolName,
        code: safeCode, deniedAt: Date.now() }
      await tx.insert('worker-mcp-denial', denied.id, denied)
    })
  }

  async begin(ticketId: string, assignment: Pick<Assignment, 'id' | 'generation'>,
    use: CredentialUse, config: WorkerMcpConfig, input: Record<string, unknown>) {
    const inputSha256 = createHash('sha256').update(canonicalJson(input)).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const current = await tx.get<Assignment>('assignment', ticketId)
      const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
      const link = await tx.get<{ workItemId: string }>('work-ticket', ticketId)
      if (!current || current.id !== assignment.id || current.generation !== assignment.generation
        || current.state !== 'running' || !ticket || ticket.state !== 'open' || ticket.constraint
        || !link || link.workItemId !== use.workItemId || current.environment?.id !== use.environmentId
        || use.instanceId !== this.instanceId || use.role !== 'worker' || use.purpose !== 'tool'
        || use.resourceId !== config.resourceId) {
        throw new CoreError('STALE_ASSIGNMENT', 'The original Worker scope changed before MCP dispatch.')
      }
      if (await tx.get('worker-mcp-block', blockKey(ticketId))) {
        throw new CoreError('MCP_OUTCOME_UNKNOWN', 'Reconcile the original MCP request before another call on this Ticket.')
      }
      const requestId = randomUUID()
      const call: WorkerMcpCall = { id: `${callPrefix(ticketId)}${requestId}`, requestId, ticketId,
        assignmentId: current.id, generation: current.generation, workItemId: use.workItemId!,
        environmentId: use.environmentId!, serverName: config.serverName, toolName: config.toolName,
        resourceId: config.resourceId, inputSha256, state: 'unknown', startedAt: Date.now() }
      await tx.insert('worker-mcp-call', call.id, call)
      await tx.insert('worker-mcp-block', blockKey(ticketId), { callId: call.id })
      return call
    })
  }

  async confirm(call: WorkerMcpCall, outcome: 'success' | 'failed', code?: string) {
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const stored = await tx.get<WorkerMcpCall>('worker-mcp-call', call.id)
      const block = await tx.get<{ callId: string }>('worker-mcp-block', blockKey(call.ticketId))
      if (!stored || stored.requestId !== call.requestId || block?.callId !== call.id || stored.state !== 'unknown') {
        throw new CoreError('MCP_OUTCOME_UNKNOWN', 'The original MCP request has no confirmable intent.')
      }
      await tx.replace('worker-mcp-call', call.id, { ...stored, state: 'confirmed', outcome,
        ...(code ? { code } : {}), settledAt: Date.now() } satisfies WorkerMcpCall)
      await tx.remove('worker-mcp-block', blockKey(call.ticketId))
    })
  }
}
