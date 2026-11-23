import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionAddress, SessionCancelRequest, SessionControlFrame, SessionFollowRequest, SessionListRequest,
  SessionPageRequest, SessionPromptRequest, SessionProjectionsRequest, SessionRenameRequest, SessionSelectModelRequest,
  SessionUpdateQueueRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ClassicSessionAccess, type ClassicWorkspaces } from './classic-session.js'
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

export function exposeMainSession(context: Context, host: ProductHost, desktop = false) {
  return context.inject(desktop ? ['superagentSessionReader', 'connection', 'workspaceRegistry'] : ['superagentSessionReader'], scope => {
    const controller = scope.get('superagentSessionReader') as SessionController
    const connection = scope.get('connection') as { browserPeer?: object; allowsRemoteAuthorities?: boolean } | undefined
    const workspaces = scope.get('workspaceRegistry') as ClassicWorkspaces | undefined
    const classic = desktop && connection?.browserPeer && connection.allowsRemoteAuthorities === false && workspaces
      ? new ClassicSessionAccess(host, controller, workspaces, sessionId => {
        const agent = scope.get('agents')?.get(sessionId)
        const selection = agent?.model.current()
        if (selection) agent?.model.select(selection)
      }) : undefined
    if (classic) {
      scope.provide('superagentClassicSession', classic)
      scope.effect(() => () => classic.revoke())
    }
    const current = async () => await host.dispatch('open') as MainBinding & { mainSessionMode: 'native' | 'product-history' }
    const classicFor = (context: Context) => classic?.forPeer(context.invocation?.peer)
    const requireClassic = (context: Context, sessionId: SessionId) => {
      const active = classicFor(context)
      if (active?.sessionId !== sessionId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Native commands require the active Classic Agent session.')
      return active
    }
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
        const active = classicFor(this.ctx)
        if (active) {
          const { items } = await controller.list(request, AbortSignal.any([signal, active.signal]))
          return { items: items.filter(item => item.sessionId === active.sessionId) }
        }
        const { mainSessionId, mainSessionMode } = await current()
        if (mainSessionMode !== 'native') return { items: [] }
        const { items } = await controller.list(request, signal)
        return { items: items.filter(item => item.sessionId === mainSessionId) }
      }

      async events(request: SessionPageRequest, signal: AbortSignal) {
        requireOwner(this.ctx)
        const active = classicFor(this.ctx)
        if (active) {
          if (request.address.kind !== 'session' || request.address.sessionId !== active.sessionId) {
            throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the active Classic Agent session is available.')
          }
          return controller.events(request, AbortSignal.any([signal, active.signal]))
        }
        await check(request.address)
        return controller.events(request, signal)
      }

      async *follow({ activate, ...request }: SessionFollowRequest, signal: AbortSignal) {
        requireOwner(this.ctx)
        const active = classicFor(this.ctx)
        if (active) {
          if (request.address.kind !== 'session' || request.address.sessionId !== active.sessionId) {
            throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the active Classic Agent session is available.')
          }
          yield* controller.follow({ ...request, ...(activate === undefined ? {} : { activate }) }, AbortSignal.any([signal, active.signal]))
          return
        }
        const sessionId = await check(request.address)
        for await (const frame of controller.follow(request, signal)) {
          const binding = await current()
          if (classicFor(this.ctx) || binding.mainSessionMode !== 'native' || sessionId !== binding.mainSessionId) return
          yield frame
        }
      }

      async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
        requireOwner(this.ctx)
        for await (const frame of controller.control(signal)) {
          const active = classicFor(this.ctx)
          const binding = active ? undefined : await current()
          const visibleId = active?.sessionId ?? (binding?.mainSessionMode === 'native' ? SessionId(binding.mainSessionId) : undefined)
          if (frame.type === 'baseline') {
            const projection = visibleId === undefined ? undefined : frame.value.projections[visibleId]
            yield { type: 'baseline', value: { projections: visibleId === undefined || projection === undefined ? {} : { [visibleId]: projection } } }
          } else if (frame.sessionId === visibleId) yield frame
        }
      }

      async prompt(request: SessionPromptRequest, signal: AbortSignal) {
        const { signal: lifetime } = requireClassic(this.ctx, request.sessionId)
        return controller.prompt(request, AbortSignal.any([signal, lifetime]))
      }

      cancel(request: SessionCancelRequest) {
        requireClassic(this.ctx, request.sessionId)
        return controller.cancel(request)
      }

      updateQueue(request: SessionUpdateQueueRequest) {
        requireClassic(this.ctx, request.sessionId)
        return controller.updateQueue(request)
      }

      rename(request: SessionRenameRequest) {
        requireClassic(this.ctx, request.sessionId)
        return controller.rename(request)
      }

      async selectModel(request: SessionSelectModelRequest) {
        const { signal } = requireClassic(this.ctx, request.sessionId)
        const selection = { provider: request.provider, model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }) }
        const llm = scope.get('llm')
        const catalog = await controller.modelCatalog()
        const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(entry => entry.id === selection.model)
        if (!llm || !model || (selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort))) {
          throw new CoreError('CLASSIC_UNAVAILABLE', 'Choose a model and reasoning effort that are available to Classic Agent.')
        }
        await llm.resolveCallConfig(selection)
        signal.throwIfAborted()
        const agent = scope.get('agents')?.get(request.sessionId)
        if (!agent) throw new CoreError('CLASSIC_UNAVAILABLE', 'Continue this Classic Agent session before changing its model.')
        agent.model.select(selection)
        return { selected: selection }
      }

      modelCatalog() {
        if (!classicFor(this.ctx)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The native model catalog requires Classic Agent mode.')
        return controller.modelCatalog()
      }

      projections(request: SessionProjectionsRequest, signal: AbortSignal) {
        const { signal: lifetime } = requireClassic(this.ctx, request.sessionId)
        return controller.projections(request, AbortSignal.any([signal, lifetime]))
      }
    }
    new MainSessionReader()
  })
}
