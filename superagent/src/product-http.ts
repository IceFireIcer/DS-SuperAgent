import type { Context } from '@deepseek-ai/cordis'
import { classicEndpoints, classicProofHeader, type ClassicSessionAccess } from './classic-session.js'
import { CoreError } from './model.js'
import type { ProductHost } from './product-host.js'

interface NativeRequest { url?: string }

interface NativeResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

interface ProductScope {
  superagentProduct: ProductHost
  connection: {
    admit?(request: { headers: Headers }): { peer?: object }
    fetch: {
      register(route: {
        path: string
        methods: string[]
        requestBody: 'buffered'
        fetch(request: Request): Promise<Response>
      }): () => unknown
    }
  }
  inject(dependencies: string[], callback: (scope: Context) => unknown): unknown
  effect(execute: () => () => unknown, label?: string): unknown
  on(name: 'connection/request', listener: (request: NativeRequest, response: NativeResponse,
    next: () => unknown) => Promise<unknown>): () => unknown
}

const errorResponses: Record<string, { status: number; message?: string; detail?: boolean }> = {
  CLASSIC_DENIED: { status: 403, detail: true },
  CLASSIC_UNAVAILABLE: { status: 400, detail: true },
  SOURCE_NOT_AUTHORIZED: { status: 403, message: 'This conversation is outside the authorized workspace.' },
  MEMORY_DENIED: { status: 403, detail: true },
  NOT_FOUND: { status: 404, message: 'The requested work activity is unavailable.' },
  RUNTIME_CLOSED: { status: 503, message: 'The product Host is closed.' },
  COMMIT_UNKNOWN: { status: 503, detail: true },
  IDENTITY_CONFLICT: { status: 409, message: 'This message identity was already used for different text.' },
  CONFIG_REVISION_CONFLICT: { status: 409, message: 'The configuration changed elsewhere. Your draft is still here.' },
  CAPABILITY_REVISION_CONFLICT: { status: 409, message: 'The capability changed. Reload it before saving.' },
  CAPABILITY_BUDGET: { status: 400, message: 'The capability library or execution scope has reached its limit.' },
  RESOURCE_UNAVAILABLE: { status: 400, message: 'The credential resource is unavailable.' },
  TICKET_VERSION_CONFLICT: { status: 409, message: 'The work changed. Review its current state and try again.' },
  DELEGATION_UNAVAILABLE: { status: 400, message: 'Work follow-up is unavailable in this Host.' },
  INVALID_CONFIG: { status: 400, message: 'Check the role configuration.', detail: true },
  INVALID_INPUT: { status: 400, message: 'Check the request fields.', detail: true },
  UNAVAILABLE: { status: 400, message: 'This product capability is not connected yet.' },
}

const classicNativePaths = new Set(['create', 'prompt', 'cancel', 'updateQueue', 'rename', 'selectModel', 'modelCatalog', 'projections']
  .map(method => `/api/session/${method}`))
const workspaceSessionWrites = new Set(['insertSessionBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']
  .map(method => `/api/workspace/${method}`))

function productError(endpoint: unknown, error: unknown) {
  const value = error as { code?: unknown; message?: unknown }
  const code = typeof value?.code === 'string' ? value.code : 'PRODUCT_UNAVAILABLE'
  const endpointName = typeof endpoint === 'string' ? endpoint : ''
  const preset = endpointName.startsWith('preset-') && (code.startsWith('PRESET_') || code.startsWith('INVALID_PRESET')
    || code === 'IDENTITY_CONFLICT' || code === 'COMMIT_UNKNOWN')
  const memory = endpointName.startsWith('memory-') && code.startsWith('MEMORY_')
  const response = errorResponses[code]
  const message = preset ? String(value?.message ?? 'Check the preset request.')
    : memory ? String(value?.message ?? 'Review the current memory scope.')
      : response?.detail ? String(value?.message ?? response.message)
        : response?.message ?? 'Main is unavailable. Your accepted messages remain in the conversation.'
  const status = response?.status ?? (code.startsWith('PRESET_') || code === 'MEMORY_STALE'
    || code === 'MEMORY_CURSOR_STALE' ? 409 : 400)
  return { code, message, status }
}

export const inject = ['connection', 'superagentProduct']

/** Register the existing client's product protocol beside the production Engine host. */
export function apply(context: Context) {
  const ctx = context as unknown as ProductScope
  return ctx.inject(['connection', 'superagentProduct'], scope => {
    const productScope = scope as unknown as ProductScope
    const classic = () => scope.get('superagentClassicSession') as ClassicSessionAccess | undefined
    productScope.effect(() => productScope.on('connection/request', async (request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const desktopWorkspaceWrite = workspaceSessionWrites.has(path) && classic()
      if (!path.startsWith('/api/session/') && path !== '/api/session.export' && !desktopWorkspaceWrite) return next()
      if (path === '/api/session/list' || path === '/api/session/events') return next()
      if (classicNativePaths.has(path) && classic()) return next()
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'server-response', result: { ok: false, error: {
        code: 'product/session-forbidden',
        message: 'Use the authorized Main conversation. Native Session access is unavailable.',
        details: {},
      } } }))
    }), 'superagent: close native Session access')
    productScope.effect(() => productScope.connection.fetch.register({
      path: '/api/product',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request) {
        let body: { endpoint?: unknown; payload?: Record<string, unknown> } | undefined
        try { body = await request.json() as typeof body }
        catch {
          return Response.json({ ok: false, error: {
            code: 'INVALID_INPUT',
            message: 'Send a JSON product request.',
          } }, { status: 400 })
        }
        try {
          const endpoint = String(body?.endpoint ?? '')
          const payload = body?.payload ?? {}
          let value
          if (classicEndpoints.has(endpoint)) {
            const access = classic()
            if (!access) throw new CoreError('CLASSIC_DENIED', 'Classic Agent mode is available from the local desktop window only.')
            const peer = productScope.connection.admit?.({ headers: request.headers }).peer
            value = await access.dispatch(endpoint, payload, request.headers.get(classicProofHeader), peer)
          } else value = await productScope.superagentProduct.dispatch(endpoint, payload)
          return Response.json({ ok: true, value })
        } catch (error) {
          const { code, message, status } = productError(body?.endpoint, error)
          return Response.json({ ok: false, error: { code, message } }, { status })
        }
      },
    }), 'superagent: product commands and queries')
  })
}

export const productHttpPlugin = { name: 'ds-superagent-product-http', inject, apply }
