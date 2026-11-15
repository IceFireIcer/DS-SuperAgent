import type { Context } from '@deepseek-ai/cordis'
import { Engine } from './engine.js'
import { CoreError, identifier } from './model.js'
import { NativeSessions } from './native-sessions.js'
import { SqliteStorage } from './storage.js'
import { LocalEnvironment } from './local-environment.js'
import { FeishuRuntime, type FeishuRuntimeOptions } from './feishu-runtime.js'
import { localDeliveryChannel, type DeliveryChannel } from './deliveries.js'
import type { RoleConfig, RoleModel } from './config.js'

export interface ProductHostConfig { databasePath: string; workspaceRoot?: string; instanceId?: string; actorId?: string; main?: RoleModel; router?: RoleModel; worker?: RoleModel; timeoutMs?: number;
  /** Supplied by a trusted Host, never by the window or a model turn. */
  feishu?: Omit<FeishuRuntimeOptions, 'storage' | 'instanceId' | 'mainIntake'> }
export interface ProductHost {
  dispatch(endpoint: string, payload?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}
declare module '@deepseek-ai/cordis' { interface Context { superagentProduct: ProductHost } }

interface PublicLlm {
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name?: string }>>
  resolveModelInfo?(provider: string, model: string): Promise<{ reasoning?: { efforts?: Array<{ id: string; name?: string; description?: string }>; defaultEffort?: string } }>
  listConfigurableProviders?(): Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }>
}
interface PublicSettings {
  describe(options: { redactSecrets: boolean }): Array<{ ns: string; value?: Record<string, unknown>; user?: Record<string, unknown>; base?: Record<string, unknown>; revision?: number }>
  mutate(ns: string, operations: Array<{ op: 'set'; path: string[]; value: unknown }>, revision?: number): Promise<unknown>
}
interface PublicCredentials {
  describe(reference: string): Promise<{ configured?: boolean; writable?: boolean }>
  set(reference: string, value: string): Promise<unknown>
  unset(reference: string): Promise<unknown>
}
type SettingsSection = ReturnType<PublicSettings['describe']>[number]

export async function createProductHost(context: Context, config: ProductHostConfig): Promise<ProductHost> {
  const instanceId = config.instanceId ?? 'personal'
  const actorId = config.actorId ?? 'local-user'
  identifier(instanceId, 'instanceId'); identifier(actorId, 'actorId')
  const route = (configured?: RoleModel): RoleModel => {
    const value = configured ?? context.get('agentDefaultModel')?.currentSelection?.()
    if (!value?.provider || !value.model) return { provider: 'unconfigured', model: 'unconfigured' }
    return { provider: value.provider, model: value.model }
  }
  const sessions = new NativeSessions(context, { main: route(config.main), router: route(config.router), worker: route(config.worker), ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
  const storage = await SqliteStorage.open(config.databasePath)
  let environment: LocalEnvironment | undefined
  let engine: Engine | undefined
  let feishuRuntime: FeishuRuntime | undefined
  let feishuEngine: Engine | undefined
  let closing: Promise<void> | undefined
  const publicLlm = () => context.get('llm') as unknown as PublicLlm
  const settingsSections = (settings: PublicSettings) => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const derivedKeyRef = (provider: string) => `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
  const keyRefFor = (provider: string, sections: Map<string, SettingsSection>) => {
    const entry = publicLlm().listConfigurableProviders?.().find(item => item.provider === provider)
    const section = entry ? sections.get(entry.settingsNs) : undefined
    if (!entry) return undefined
    const value = entry.settingsPath.reduce<unknown>((current, key) =>
      current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, section?.value)
    const reference = value && typeof value === 'object' ? (value as Record<string, unknown>).apiKeyEnv : undefined
    return { reference: typeof reference === 'string' && reference ? reference : derivedKeyRef(provider),
      explicit: typeof reference === 'string' && reference !== '', ns: entry.settingsNs, path: entry.settingsPath,
      ...(section?.revision === undefined ? {} : { revision: section.revision }) }
  }
  const providerCatalog = async () => {
    const llm = publicLlm()
    const settings = context.get('settings') as unknown as PublicSettings | undefined
    const credentials = context.get('credentials') as unknown as PublicCredentials | undefined
    const sections = settings ? settingsSections(settings) : new Map<string, SettingsSection>()
    const providers = []
    for (const provider of llm.listProviders()) {
      let models: Array<{ id: string; name?: string }> = []
      try { models = await llm.listModels(provider.id) }
      catch { /* A provider that cannot enumerate models now exposes none. */ }
      const keyRef = keyRefFor(provider.id, sections)
      const keyInfo = keyRef && credentials ? await credentials.describe(keyRef.reference).catch(() => undefined) : undefined
      providers.push({ id: provider.id, name: provider.name ?? provider.id,
        models: models.map(model => ({ provider: provider.id, model: model.id, ref: `${provider.id}/${model.id}`, name: model.name ?? model.id })),
        ...(keyRef || keyInfo ? { key: { configured: keyInfo?.configured === true, writable: keyInfo?.writable !== false } } : {}) })
    }
    return providers
  }
  const verifyRoles = async (roles: RoleConfig, signal: AbortSignal) => {
    signal.throwIfAborted()
    const providers = await providerCatalog()
    for (const profile of [roles.main, roles.router, roles.worker]) {
      if (!profile) continue
      const provider = providers.find(candidate => candidate.id === profile.model.provider)
      if (!provider || !provider.models.some(model => model.model === profile.model.model)) {
        throw new CoreError('INVALID_CONFIG', `${profile.name} needs a model served by a configured provider.`)
      }
      if (profile.model.effort !== undefined) {
        signal.throwIfAborted()
        const info = await publicLlm().resolveModelInfo?.(profile.model.provider, profile.model.model)
        if (!info?.reasoning?.efforts?.some(effort => effort.id === profile.model.effort)) {
          throw new CoreError('INVALID_CONFIG', `${profile.name} selected a thinking level this model does not serve.`)
        }
      }
    }
    signal.throwIfAborted()
  }
  const roleSettings = async (limit: number) => {
    const current = await engine!.getRoleConfig()
    const [providers, uses, history] = await Promise.all([
      providerCatalog(), engine!.getRecentRoleConfigUses(limit), engine!.getRoleConfigHistory(20),
    ])
    return { ...current, providers, uses,
      history: history.length ? history : [{ revision: current.revision, roles: current.roles, updatedAt: current.updatedAt }] }
  }
  const setProviderKey = async (provider: string, value: unknown) => {
    const settings = context.get('settings') as unknown as PublicSettings | undefined
    const credentials = context.get('credentials') as unknown as PublicCredentials | undefined
    if (!settings || !credentials) throw new CoreError('INVALID_CONFIG', 'This DSH cannot store provider credentials.')
    const keyRef = keyRefFor(provider, settingsSections(settings))
    if (!keyRef) throw new CoreError('INVALID_CONFIG', `${provider} does not use a writable API key here.`)
    const info = await credentials.describe(keyRef.reference)
    if (info.writable === false) throw new CoreError('INVALID_CONFIG', `The API key for ${provider} is set outside this product.`)
    try {
      if (value === null) await credentials.unset(keyRef.reference)
      else {
        if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\r\n]/u.test(value)) {
          throw new CoreError('INVALID_INPUT', 'Enter one nonempty API key without line breaks.')
        }
        if (!keyRef.explicit) await settings.mutate(keyRef.ns,
          [{ op: 'set', path: [...keyRef.path, 'apiKeyEnv'], value: keyRef.reference }], keyRef.revision)
        await credentials.set(keyRef.reference, value.trim())
      }
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('INVALID_CONFIG', 'The provider key could not be changed.')
    }
    return { provider, configured: value !== null }
  }
  async function dispose() {
    try {
      await feishuRuntime?.stop()
      await engine?.effects.stop()
      await feishuEngine?.effects.stop()
      await engine?.shutdown()
      await feishuEngine?.shutdown()
    }
    finally { try { await sessions.close() } finally { try { await environment?.close() } finally { await storage.close() } } }
  }
  try {
    if (config.workspaceRoot) {
      environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId, root: config.workspaceRoot,
        allowedActorIds: [actorId], permissions: ['read', 'write'], commands: {} })
    }
    if (config.feishu) {
      feishuRuntime = new FeishuRuntime({ ...config.feishu, storage, instanceId, mainIntake: true })
      feishuEngine = new Engine(storage, instanceId, feishuRuntime.sourceBinding, {}, sessions)
      feishuRuntime.bind(feishuEngine)
    }
    const channel: DeliveryChannel | undefined = feishuRuntime ? {
      deliver: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime!.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.deliver(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
      reconcile: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime!.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.reconcile(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
    } : undefined
    engine = new Engine(storage, instanceId, { sourceInstanceId: 'product-desktop', actorId, allowedActorIds: [actorId] }, {}, sessions,
      environment ? [environment] : [], {}, {}, {}, channel ? { channel } : {})
    await engine.acquireHost()
    await engine.openMain({ instanceId })
    engine.effects.start()
    if (feishuRuntime) void feishuRuntime.start().catch(() => { /* Health retains the setup failure; Main stays available. */ })
    void engine.resumeMainInputs({ instanceId }).catch(() => { /* The persisted input and failed health remain visible for retry. */ })
    return {
      async dispatch(endpoint, payload = {}) {
        if (closing) throw new CoreError('RUNTIME_CLOSED', 'The product Host is closed.')
        // The Host supplies identity; a window can only address this authorization scope.
        if (endpoint === 'open') {
          if (Object.keys(payload).length !== 0) throw new CoreError('INVALID_INPUT', 'Opening the product Main accepts no fields.')
          return engine!.openMain({ instanceId })
        }
        if (payload.instanceId !== instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This request is outside the authorized Instance.')
        const fields = endpoint === 'send' ? ['instanceId', 'commandId', 'text']
          : endpoint === 'feishu-status' || endpoint === 'feishu-start' || endpoint === 'feishu-stop' ? ['instanceId']
          : endpoint === 'stop-main' ? ['instanceId', 'commandId', 'messageId']
            : endpoint === 'work-stop'
              ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'expectedTicketVersion', 'reason']
            : endpoint === 'work-retry'
              ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'reason']
              : endpoint === 'work-resume' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration']
                : endpoint === 'work-answer' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'attentionId', 'attentionVersion', 'text']
                  : endpoint === 'settings' ? ['instanceId', 'limit']
                    : endpoint === 'settings-save' ? ['instanceId', 'commandId', 'expectedRevision', 'roles']
                      : endpoint === 'settings-efforts' ? ['instanceId', 'provider', 'model']
                        : endpoint === 'provider-key' ? ['instanceId', 'provider', 'value']
                          : endpoint === 'reconcile-delivery' ? ['instanceId', 'commandId', 'ticketId', 'deliveryId']
                            : endpoint === 'source-deliveries' ? ['instanceId', 'sourceId', 'after', 'limit']
                              : endpoint === 'observe-list' ? ['instanceId', 'after', 'limit', 'query']
                                : endpoint === 'observe-read' ? ['instanceId', 'observationId', 'generation', 'after', 'limit']
                                  : endpoint === 'observe-detail' ? ['instanceId', 'observationId', 'generation', 'detailId', 'offset', 'limit']
                                    : endpoint === 'evidence' ? ['instanceId', 'workItemId', 'ref', 'after', 'maxBytes']
                                      : endpoint === 'history' ? ['instanceId', 'after', 'before', 'limit']
                                        : undefined
        if (!fields) throw new CoreError('UNAVAILABLE', 'This product capability is not connected yet.')
        if (Object.keys(payload).some(key => !fields.includes(key))) throw new CoreError('INVALID_INPUT', 'The product request contains unsupported fields.')
        if (endpoint === 'feishu-status' || endpoint === 'feishu-start' || endpoint === 'feishu-stop') {
          if (!feishuRuntime) {
            if (endpoint === 'feishu-status') return { configured: false, state: 'unavailable' }
            throw new CoreError('UNAVAILABLE', 'No Feishu source is configured for this product Host.')
          }
          if (endpoint === 'feishu-start' && !['setup', 'polling'].includes(feishuRuntime.health().state)) {
            await feishuRuntime.stop()
            await feishuRuntime.start()
          }
          if (endpoint === 'feishu-stop') await feishuRuntime.stop()
          return { configured: true, sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId, ...feishuRuntime.health() }
        }
        if (endpoint === 'history') {
          if (payload.after !== undefined && payload.before !== undefined) throw new CoreError('INVALID_INPUT', 'Main history accepts one direction cursor.')
          if (payload.after !== undefined) return engine!.getMainConversation({ instanceId, after: payload.after as number,
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
          return engine!.getRecentMainConversation({ instanceId,
            ...(payload.before === undefined ? {} : { before: payload.before as number }),
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        }
        if (endpoint === 'send') return engine!.sendMainMessage({ instanceId, commandId: payload.commandId as string, text: payload.text as string })
        if (endpoint === 'stop-main') return engine!.stopMainTurn({ instanceId, commandId: payload.commandId as string, messageId: payload.messageId as string })
        if (endpoint === 'work-stop') return engine!.stopMainWork({ instanceId, commandId: payload.commandId as string,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          ...(payload.expectedGeneration === undefined ? {} : { expectedGeneration: payload.expectedGeneration as string }),
          expectedTicketVersion: payload.expectedTicketVersion as number, reason: payload.reason as string })
        if (endpoint === 'work-resume') return engine!.resumeMainWork({ instanceId, commandId: payload.commandId as string,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string })
        if (endpoint === 'work-answer') return engine!.answerMainAttention({ instanceId, commandId: payload.commandId as string,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string, attentionId: payload.attentionId as string,
          attentionVersion: payload.attentionVersion as number, text: payload.text as string })
        if (endpoint === 'work-retry') return engine!.retryMainWork({ instanceId, commandId: payload.commandId as string,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string, reason: payload.reason as string })
        if (endpoint === 'settings') return roleSettings(payload.limit === undefined ? 50 : payload.limit as number)
        if (endpoint === 'settings-save') {
          const roles = payload.roles as RoleConfig
          if (!roles || typeof roles !== 'object' || !roles.main || !roles.router || !roles.worker) {
            throw new CoreError('INVALID_CONFIG', 'Product settings require Main, Router and Worker profiles.')
          }
          const view = await engine!.updateRoleConfig({ commandId: payload.commandId as string,
            expectedRevision: payload.expectedRevision as number, roles },
          { verify: (roles, signal) => verifyRoles(roles, signal) })
          return { ...view, uses: await engine!.getRecentRoleConfigUses(50) }
        }
        if (endpoint === 'settings-efforts') {
          if (typeof payload.provider !== 'string' || typeof payload.model !== 'string') throw new CoreError('INVALID_INPUT', 'A settings model needs provider and model.')
          const info = await publicLlm().resolveModelInfo?.(payload.provider, payload.model)
          return { efforts: (info?.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id,
            ...(effort.description ? { description: effort.description } : {}) })), ...(info?.reasoning?.defaultEffort ? { defaultEffort: info.reasoning.defaultEffort } : {}) }
        }
        if (endpoint === 'provider-key') return setProviderKey(payload.provider as string, payload.value)
        if (endpoint === 'evidence') return engine!.readMainEvidence({ instanceId, workItemId: payload.workItemId as string,
          ref: payload.ref as { kind: 'ticket' | 'trigger' | 'decision' | 'mandate' | 'report' | 'attention' | 'delivery' | 'source-event' | 'source-thread';
            id?: string; threadId?: string; objectId?: string },
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
        if (endpoint === 'reconcile-delivery') return engine!.reconcileDelivery({ commandId: payload.commandId as string,
          ticketId: payload.ticketId as string, deliveryId: payload.deliveryId as string })
        if (endpoint === 'source-deliveries') return engine!.getMainSourceDeliveries({ instanceId,
          sourceId: payload.sourceId as string, ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'observe-list') return engine!.getWorkObservations({ instanceId,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }),
          ...(payload.query === undefined ? {} : { query: payload.query as string }) })
        if (endpoint === 'observe-read') return engine!.readWorkObservation({ instanceId, observationId: payload.observationId as string,
          ...(payload.generation === undefined ? {} : { generation: payload.generation as string }),
          ...(payload.after === undefined ? {} : { after: payload.after as number }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'observe-detail') return engine!.readWorkObservationDetail({ instanceId,
          observationId: payload.observationId as string, detailId: payload.detailId as string,
          ...(payload.generation === undefined ? {} : { generation: payload.generation as string }),
          ...(payload.offset === undefined ? {} : { offset: payload.offset as number }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        throw new CoreError('UNAVAILABLE', 'This product capability is not connected yet.')
      },
      close() {
        return closing ??= dispose()
      },
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
