import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CoreError, identifier } from './model.js'
import type { CredentialUse } from './resource-credentials.js'
import type { NativeTool } from './native-sessions.js'
import type { WorkerMcpCall } from './worker-mcp-calls.js'

/** Deployment-owned, fixed tool selection. Neither the model nor a work message supplies these fields. */
export interface WorkerMcpConfig {
  serverName: string
  toolName: string
  url: string
  resourceId: string
}

export interface WorkerMcpBinding {
  config: WorkerMcpConfig
  credentials: { use<T>(request: CredentialUse, consume: (secret: string) => Promise<T>): Promise<T> }
}

export interface WorkerMcpDispatch {
  begin(use: CredentialUse, input: Record<string, unknown>): Promise<WorkerMcpCall>
  confirm(call: WorkerMcpCall, outcome: 'success' | 'failed', code?: string): Promise<void>
}

export function workerMcpName(config: WorkerMcpConfig) {
  identifier(config.resourceId, 'resourceId')
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(config.serverName)
    || !/^[A-Za-z0-9_-]{1,24}$/u.test(config.toolName)) {
    throw new CoreError('INVALID_CONFIG', 'The approved MCP tool needs a bounded server and tool name.')
  }
  let url: URL
  try { url = new URL(config.url) }
  catch { throw new CoreError('INVALID_CONFIG', 'The approved MCP endpoint is invalid.') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.hash || Buffer.byteLength(config.url) > 2048) {
    throw new CoreError('INVALID_CONFIG', 'The approved MCP endpoint must use HTTPS or local loopback HTTP.')
  }
  return `mcp__${config.serverName}__${config.toolName}`
}

/** One connection and one tools/call per use; no credential survives in a global MCP registration. */
export function workerMcpTool(binding: WorkerMcpBinding, scope: () => Promise<CredentialUse>,
  record: (outcome: 'success' | 'failed', output: Record<string, unknown>) => void, dispatch: WorkerMcpDispatch): NativeTool {
  const name = workerMcpName(binding.config)
  return {
    name,
    description: `Call the approved ${binding.config.serverName} MCP tool ${binding.config.toolName} for this work. Supply a JSON object as input.`,
    parameters: { input: { type: 'string', required: true } },
    execute: async (args, signal) => {
      let dispatched = false
      let settled = false
      let reportedCode: string | undefined
      let call: WorkerMcpCall | undefined
      try {
        signal.throwIfAborted()
        if (typeof args.input !== 'string' || Buffer.byteLength(args.input) > 8192)
          throw new CoreError('INVALID_INPUT', 'MCP input must be a bounded JSON object.')
        let input: unknown
        try { input = JSON.parse(args.input) }
        catch { throw new CoreError('INVALID_INPUT', 'MCP input must be a JSON object.') }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new CoreError('INVALID_INPUT', 'MCP input must be a JSON object.')
        const use = await scope()
        const output = await binding.credentials.use(use, async secret => {
          signal.throwIfAborted()
          const client = new Client({ name: 'ds-superagent-worker', version: '0.0.0' },
            { versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false } })
          const transport = new StreamableHTTPClientTransport(new URL(binding.config.url), {
            requestInit: { headers: { Authorization: `Bearer ${secret}` } },
            fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
          })
          try {
            await client.connect(transport, { signal, timeout: 10000 })
            const tools = await client.listTools(undefined, { signal, timeout: 10000 })
            const approved = tools.tools.find(tool => tool.name === binding.config.toolName)
            if (!approved) {
              reportedCode = 'MCP_TOOL_UNAVAILABLE'
              throw new CoreError('MCP_TOOL_UNAVAILABLE', 'The approved MCP tool is unavailable.')
            }
            // Recheck the live Assignment and stop state after the handshake, immediately before dispatch.
            const current = await scope()
            if (current.workItemId !== use.workItemId || current.environmentId !== use.environmentId)
              throw new CoreError('STALE_ASSIGNMENT', 'The work scope changed before MCP dispatch.')
            let result
            try {
              result = await binding.credentials.use(current, async currentSecret => {
                if (currentSecret !== secret) {
                  reportedCode = 'RESOURCE_STALE'
                  throw new CoreError('RESOURCE_STALE', 'The MCP credential changed during discovery.')
                }
                signal.throwIfAborted()
                try { call = await dispatch.begin(current, input as Record<string, unknown>) }
                catch (error) {
                  if (error instanceof CoreError && ['MCP_OUTCOME_UNKNOWN', 'COMMIT_UNKNOWN'].includes(error.code)) {
                    reportedCode = 'MCP_OUTCOME_UNKNOWN'
                  }
                  throw error
                }
                dispatched = true
                return client.callTool({ name: binding.config.toolName,
                  arguments: input as Record<string, unknown>,
                  _meta: { 'com.ds-superagent/requestId': call.requestId } }, { signal, timeout: 15000, toolDefinition: approved })
              })
            } catch (error) {
              if (error instanceof CoreError && ['GRANT_DENIED', 'RESOURCE_UNAVAILABLE'].includes(error.code)) reportedCode = error.code
              throw error
            }
            if (result.isError) {
              reportedCode = 'MCP_TOOL_FAILED'
              await dispatch.confirm(call!, 'failed', reportedCode)
              settled = true
              throw new CoreError('MCP_TOOL_FAILED', 'The approved MCP tool reported failure.')
            }
            if (!Array.isArray(result.content) || result.content.some(block => block.type !== 'text' || typeof block.text !== 'string')) {
              reportedCode = 'MCP_RESULT_UNSUPPORTED'
              await dispatch.confirm(call!, 'failed', reportedCode)
              settled = true
              throw new CoreError('MCP_RESULT_UNSUPPORTED', 'Only MCP text results are supported for this tool.')
            }
            const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
            if (Buffer.byteLength(text) > 8192 || text.includes(secret)) {
              reportedCode = 'MCP_RESULT_UNSUPPORTED'
              await dispatch.confirm(call!, 'failed', reportedCode)
              settled = true
              throw new CoreError('MCP_RESULT_UNSUPPORTED', 'The MCP result could not be presented safely.')
            }
            await dispatch.confirm(call!, 'success')
            settled = true
            signal.throwIfAborted()
            return text
          } finally { await client.close().catch(() => {}) }
        })
        record('success', { text: output, requestId: call!.requestId })
        return output
      } catch (error) {
        const code = dispatched && !settled ? 'MCP_OUTCOME_UNKNOWN'
          : reportedCode ?? (signal.aborted ? 'TICKET_BLOCKED' : error instanceof CoreError ? error.code : 'MCP_TOOL_FAILED')
        record('failed', { code, ...(call ? { requestId: call.requestId } : {}) })
        throw new CoreError(code, 'The approved MCP tool was not confirmed; check its tool fact before retrying.')
      }
    },
  }
}
