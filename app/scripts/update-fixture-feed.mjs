import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

export async function fileUpdateFeed(folder) {
  const served = []
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => { response.writeHead(404).end() })
  })

  async function respond(request, response) {
    const name = decodeURIComponent(new URL(request.url, 'http://fixture/').pathname.slice(1))
    if (!/^[a-z\d][a-z\d._-]*$/iu.test(name) || request.method !== 'GET') {
      response.writeHead(404).end()
      return
    }
    const file = join(folder, name)
    const info = await stat(file)
    if (!info.isFile()) { response.writeHead(404).end(); return }
    served.push(name)
    response.writeHead(200, { 'content-length': info.size })
    const stream = createReadStream(file)
    stream.on('error', error => response.destroy(error))
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }

  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return { url: `http://127.0.0.1:${server.address().port}/`, served,
    close() { server.close(); server.closeAllConnections() } }
}
