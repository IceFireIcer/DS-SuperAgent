import { createServer, request as httpRequest } from 'node:http'

export async function breakableProxy(endpoint) {
  const state = { blocked: false }
  const server = createServer((request, response) => {
    if (state.blocked) { request.destroy(); response.destroy(); return }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const upstream = httpRequest(new URL(request.url, endpoint), { method: request.method, headers: request.headers }, result => {
        const answer = []
        result.on('data', chunk => answer.push(chunk))
        result.on('end', () => {
          const body = Buffer.concat(answer)
          const headers = { ...result.headers }
          delete headers['transfer-encoding']
          response.writeHead(result.statusCode ?? 500, { ...headers, 'content-length': String(body.length) }).end(body)
        })
      })
      upstream.on('error', error => response.writeHead(502).end(error.message))
      upstream.end(Buffer.concat(chunks))
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { endpoint: `http://127.0.0.1:${address.port}`, state,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
