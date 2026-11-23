// Derived from DS Bot 0.3.8 (Apache-2.0), 5e9b7da8882da3b68d8a0624342708c2150a9156:link/server/server.ts.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Gateway, type GatewayOptions } from './gateway.js'
import { DeviceStore } from './store.js'
import { LINK_PATH } from '../src/frames.js'

export { LINK_PATH }

export interface RelayServerOptions extends Omit<GatewayOptions, 'store' | 'serverVersion'> {
  port?: number
  host?: string
  dataFile?: string
}

export interface RelayServer {
  /** The WebSocket address phones and computers connect to. */
  url: string
  close(): Promise<void>
}

const VERSION = 'ds-superagent-link/0.1.0'

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const { port: listenPort, host, dataFile, ...limits } = options
  const store = new DeviceStore(dataFile)
  const gateway = new Gateway({ ...limits, store, serverVersion: VERSION })
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n')
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== LINK_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    gateway.handleUpgrade(req, socket, head)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort ?? 0, host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const { address, port } = server.address() as AddressInfo
  const shown = address.includes(':') ? `[${address}]` : address
  return {
    url: `ws://${shown}:${port}${LINK_PATH}`,
    async close() {
      gateway.close()
      store.flush()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
