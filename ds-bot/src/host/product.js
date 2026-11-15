// The existing UI bundle uses this product projection without loading the old team runtime.
export function installProduct(ctx) {
  return ctx.inject(['superagentProduct'], scope => {
    scope.effect(() => scope.on('connection/request', async (request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (!path.startsWith('/api/session/') && path !== '/api/session.export') return next()
      if (path === '/api/session/list') {
        let text = ''
        for await (const chunk of request) {
          text += chunk.toString()
          if (Buffer.byteLength(text) > 4096) { response.statusCode = 413; response.end(); return }
        }
        let rpcId
        try { rpcId = JSON.parse(text)?.rpcId } catch { /* Invalid envelopes receive the same bounded refusal. */ }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items: [] } } }))
        return
      }
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'server-response', result: { ok: false, error: { code: 'product/session-forbidden', message: 'Use the authorized Main conversation. Native Session access is unavailable.', details: {} } } }))
    }), 'superagent: close native Session access')
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/product', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let body
        try { body = await request.json() } catch { return Response.json({ ok: false, error: { code: 'INVALID_INPUT', message: 'Send a JSON product request.' } }, { status: 400 }) }
        try {
          const value = await scope.superagentProduct.dispatch(body?.endpoint, body?.payload ?? {})
          return Response.json({ ok: true, value })
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'PRODUCT_UNAVAILABLE'
          const message = code === 'SOURCE_NOT_AUTHORIZED' ? 'This conversation is outside the authorized workspace.'
            : code === 'IDENTITY_CONFLICT' ? 'This message identity was already used for different text.'
              : code === 'CONFIG_REVISION_CONFLICT' ? 'The configuration changed elsewhere. Your draft is still here.'
                : code === 'INVALID_CONFIG' ? String(error?.message ?? 'Check the role configuration.')
              : code === 'INVALID_INPUT' ? String(error?.message ?? 'Check the request fields.')
                : code === 'NOT_FOUND' ? 'The requested work activity is unavailable.'
                  : code === 'UNAVAILABLE' ? 'This product capability is not connected yet.'
                    : code === 'RUNTIME_CLOSED' ? 'The product Host is closed.'
                      : 'Main is unavailable. Your accepted messages remain in the conversation.'
          const status = code === 'SOURCE_NOT_AUTHORIZED' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'RUNTIME_CLOSED' ? 503 : 400
          return Response.json({ ok: false, error: { code, message } }, { status })
        }
      },
    }), 'superagent: product commands and queries')
  })
}
