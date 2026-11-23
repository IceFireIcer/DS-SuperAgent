import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ClassicSessionAccess } from './classic-session.js'
import type { ProductHost } from './product-host.js'

type UpgradeRoute = { path: string; handler(request: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void> }
type WebServer = { registerUpgrade(route: UpgradeRoute): () => void }
type Connection = { browserPeer: PeerScope; admit(request: IncomingMessage): { peer: PeerScope } | { rejection: number } }
type Notification = { event: string; args: readonly unknown[] }
type Invocation = {
  event: string
  request: { signal?: AbortSignal }
  context: { agentId: string }
  resolve(outcome: { kind: 'next' }): void
}
type EventSource = (signal: AbortSignal) => AsyncIterable<Notification | Invocation>
type Gateway = { registerRemoteEvents(source: EventSource, host: { home: string }): () => Promise<void> }

export const name = 'superagent-desktop-session-gate'
export const inject = ['superagentDesktopWebServer', 'superagentDesktopGateway', 'connection', 'superagentProduct']

export function apply(context: Context) {
  const webServer = context.get('superagentDesktopWebServer') as WebServer
  const gateway = context.get('superagentDesktopGateway') as Gateway
  const connection = context.get('connection') as Connection
  const product = context.get('superagentProduct') as ProductHost
  const classic = () => context.get('superagentClassicSession') as ClassicSessionAccess | undefined
  const sockets = new Set<Duplex>()
  let desktopPeer: PeerScope | undefined

  function revoke(detach = false) {
    classic()?.revoke()
    if (!detach || !desktopPeer) return
    const previous = desktopPeer
    desktopPeer = undefined
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    void previous.dispose().catch(() => {})
  }

  context.provide('superagentDesktopSessionGate', {
    bindDesktop(peer: PeerScope | undefined, proof: string) {
      if (!peer || peer === connection.browserPeer || peer.principal.kind !== 'owner'
        || peer.interactions !== 'answer' || peer.signal.aborted) return false
      if (peer !== desktopPeer) revoke(true)
      desktopPeer = peer
      classic()?.bindDesktop(peer, proof)
      return true
    },
    revoke,
  })
  context.effect(() => () => revoke(true))

  async function currentMainSessionId() {
    const binding = await product.dispatch('open').catch(() => undefined) as
      { mainSessionId: string; mainSessionMode: string } | undefined
    return binding?.mainSessionMode === 'native' ? binding.mainSessionId : undefined
  }

  context.provide('webServer', {
    registerUpgrade(route: UpgradeRoute) {
      return webServer.registerUpgrade({ ...route, handler(request, socket, head) {
        const admission = connection.admit(request)
        if (!desktopPeer || desktopPeer.signal.aborted || !('peer' in admission) || admission.peer !== desktopPeer) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        sockets.add(socket)
        socket.once('close', () => { sockets.delete(socket) })
        return route.handler(request, socket, head)
      } })
    },
  })
  context.provide('typertGateway', {
    registerRemoteEvents(source: EventSource, host: { home: string }) {
      return gateway.registerRemoteEvents(signal => {
        const events = source(signal)
        return (async function* () {
          for await (const event of events) {
            if ('context' in event) {
              const peer = desktopPeer
              const grant = classic()?.forPeer(peer)
              const sessionId = event.context.agentId
              if (peer && grant?.sessionId === sessionId) {
                const lifetime = AbortSignal.any([peer.signal, grant.signal, ...(event.request.signal ? [event.request.signal] : [])])
                if (!lifetime.aborted) {
                  yield { ...event, request: { ...event.request, signal: lifetime } }
                  continue
                }
              } else if (sessionId === await currentMainSessionId()) {
                yield event
                continue
              }
              event.resolve({ kind: 'next' })
              continue
            }
            if (event.event.startsWith('api-session/')) {
              const value = event.args[0]
              const sessionId = value && typeof value === 'object' && 'sessionId' in value ? value.sessionId : value
              const current = classic()?.forPeer(desktopPeer)?.sessionId ?? await currentMainSessionId()
              const visible = classic()?.forPeer(desktopPeer)?.sessionId ?? current
              if (typeof sessionId !== 'string' || sessionId !== visible) continue
            }
            yield event
          }
        })()
      }, host)
    },
  })
}
