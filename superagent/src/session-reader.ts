import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionAddress, SessionControlFrame, SessionFollowRequest, SessionListRequest, SessionPageRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { MainBinding } from './main-conversation.js'
import { CoreError } from './model.js'
import type { ProductHost } from './product-host.js'

type SessionReads = Pick<SessionController, 'list' | 'events' | 'follow' | 'control'>

export const name = 'superagent-session-reader'
export const inject = ['sessionController']

export function apply(context: Context) {
  context.provide('superagentSessionReader', context.get('sessionController'))
}

function requireOwner(context: Context) {
  const invocation = context.invocation
  if (invocation && invocation.peer.principal.kind !== 'owner') {
    throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the Host owner can read the native Main Session.')
  }
}

export function exposeMainSession(context: Context, host: ProductHost) {
  return context.inject(['superagentSessionReader'], scope => {
    const controller = scope.get('superagentSessionReader') as SessionReads
    const current = async () => await host.dispatch('open') as MainBinding & { mainSessionMode: 'native' | 'product-history' }
    const check = async (address: SessionAddress) => {
      const { mainSessionId, mainSessionMode } = await current()
      if (address.kind !== 'session' || address.sessionId !== mainSessionId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the current Main Session is available.')
      }
      if (mainSessionMode !== 'native') {
        throw new CoreError('MAIN_SESSION_REQUIRES_PRODUCT_HISTORY', 'Read this Main conversation through product history.')
      }
      return address.sessionId
    }
    class MainSessionReader extends TypertRemoteService implements SessionReads {
      constructor() {
        super(scope, 'sessionController', { namespace: 'session' })
      }

      async list(request: SessionListRequest, signal: AbortSignal) {
        requireOwner(this.ctx)
        const { mainSessionId, mainSessionMode } = await current()
        if (mainSessionMode !== 'native') return { items: [] }
        const { items } = await controller.list(request, signal)
        return { items: items.filter(item => item.sessionId === mainSessionId) }
      }

      async events(request: SessionPageRequest, signal: AbortSignal) {
        requireOwner(this.ctx)
        await check(request.address)
        return controller.events(request, signal)
      }

      async *follow({ activate: _activate, ...request }: SessionFollowRequest, signal: AbortSignal) {
        requireOwner(this.ctx)
        const sessionId = await check(request.address)
        for await (const frame of controller.follow(request, signal)) {
          const binding = await current()
          if (binding.mainSessionMode !== 'native' || sessionId !== binding.mainSessionId) return
          yield frame
        }
      }

      async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
        requireOwner(this.ctx)
        for await (const frame of controller.control(signal)) {
          const { mainSessionId, mainSessionMode } = await current()
          if (frame.type === 'baseline') {
            const projection = mainSessionMode === 'native' ? frame.value.projections[SessionId(mainSessionId)] : undefined
            yield { type: 'baseline', value: { projections: projection === undefined ? {} : { [mainSessionId]: projection } } }
          } else if (mainSessionMode === 'native' && frame.sessionId === mainSessionId) yield frame
        }
      }
    }
    new MainSessionReader()
  })
}
