import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Engine } from './engine.js'
import { CoreError, identifier } from './model.js'
import { createClientGateway, type ClientGatewayOptions } from './client-gateway.js'
import type { ClientAccess, ClientCapability, ClientIdentity } from './client-access.js'
import { NativeSessions } from './native-sessions.js'
import { SqliteStorage } from './storage.js'
import { LocalEnvironment } from './local-environment.js'
import { FeishuRuntime, type FeishuRuntimeOptions } from './feishu-runtime.js'
import { GitHubRuntime, type GitHubRuntimeOptions } from './github-runtime.js'
import { ProductAttachments } from './product-attachments.js'
import { productProactivePreparation } from './product-proactive.js'
import type { ProactiveRule } from './proactive.js'
import type { ProductCredentialRecords } from './product-credential-vault.js'
import type { ProductCredentialManager } from './product-credential-manager.js'
import { assertReferenceShape } from './environment-assets.js'
import { localDeliveryChannel, type DeliveryChannel } from './deliveries.js'
import type { RoleConfig, RoleModel } from './config.js'
import type { LegacyPresetCopy, PresetRole } from './role-presets.js'
import { productStatusPublisher, productWatchdogProbe } from './product-watchdog.js'
import { createProductSupervision } from './product-supervision.js'

export interface ProductHostConfig { databasePath: string; workspaceRoot?: string; instanceId?: string; actorId?: string; main?: RoleModel; router?: RoleModel; worker?: RoleModel; timeoutMs?: number;
  /** Trusted process configuration; an external Watchdog reads this atomic status file. */
  watchdogStatusPath?: string;
  clientGateway?: Omit<ClientGatewayOptions, 'product'>;
  /** Supplied by a trusted Host, never by the window or a model turn. */
  feishu?: Omit<FeishuRuntimeOptions, 'storage' | 'instanceId' | 'mainIntake'>;
  feishuConfigurationError?: 'INVALID_CONFIG';
  github?: Omit<GitHubRuntimeOptions, 'storage' | 'instanceId'>;
  githubConfigurationError?: 'INVALID_CONFIG' }
export interface ProductHost {
  dispatch(endpoint: string, payload?: Record<string, unknown>, client?: ClientIdentity): Promise<unknown>
  clients: ClientAccess
  clientGateway?: { url: string; secure: boolean }
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
interface DirectoryPicker {
  kind: 'native' | 'browse'
  pick?(signal: AbortSignal): Promise<string | undefined>
  list?(path: string | undefined, signal: AbortSignal): Promise<{
    path: string; home: string; crumbs: unknown[]; entries: unknown[]; truncated: boolean
  }>
}
type SettingsSection = ReturnType<PublicSettings['describe']>[number]

const resourceFields: Record<string, string[]> = {
  'resource-list': ['instanceId', 'after', 'limit'], 'resource-read': ['instanceId', 'resourceId'],
  'resource-create': ['instanceId', 'commandId', 'label', 'value'],
  'resource-rename': ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'label'],
  'resource-rotate': ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'value'],
  'resource-rotation-read': ['instanceId', 'commandId'],
  'resource-delete': ['instanceId', 'commandId', 'resourceId', 'expectedRevision'],
  'resource-request': ['instanceId', 'commandId', 'resourceId', 'scope', 'purpose'],
  'resource-request-read': ['instanceId', 'requestId'], 'resource-cancel': ['instanceId', 'commandId', 'requestId'],
  'resource-grant': ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'scope', 'purposes', 'requestId'],
  'resource-revoke': ['instanceId', 'commandId', 'resourceId', 'grantId', 'expectedRevision'],
  'resource-cleanup': ['instanceId', 'resourceId'],
  'resource-select-feishu': ['instanceId', 'commandId', 'resourceId'],
}

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
  const environments: LocalEnvironment[] = []
  const nativeAttachments = context.get('attachments') as AttachmentStore | undefined
  const attachments = nativeAttachments ? new ProductAttachments(storage, instanceId, nativeAttachments,
    id => environments.find(environment => environment.config.id === id)) : undefined
  let engine: Engine | undefined
  let gateway: Awaited<ReturnType<typeof createClientGateway>> | undefined
  let feishuRuntime: FeishuRuntime | undefined
  let feishuEngine: Engine | undefined
  let githubRuntime: GitHubRuntime | undefined
  let githubEngine: Engine | undefined
  let feishuLegacyConflict = false
  let feishuSelectionActive = false
  const proactiveRoot = join(dirname(config.databasePath), 'proactive-preparations')
  const proactive = { rootDirectory: proactiveRoot, prepareTimeoutMs: 30_000, pauseSourceInstanceId: 'product-desktop',
    prepare: productProactivePreparation({ instanceId, actorId, sessions,
      engineForSource: sourceId => sourceId === feishuRuntime?.sourceBinding.sourceInstanceId ? feishuEngine
        : sourceId === githubRuntime?.sourceBinding.sourceInstanceId ? githubEngine
        : sourceId === 'product-desktop' ? engine : undefined }),
    guard: async (_tx: import('./storage.js').AsyncTx, candidate: import('./proactive.js').ProactiveCandidate) =>
      (candidate.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        && feishuRuntime.health().state !== 'polling'
        || candidate.sourceInstanceId === githubRuntime?.sourceBinding.sourceInstanceId
        && githubRuntime.health().state !== 'polling') ? 'SOURCE_STOPPED' : undefined }
  let resourceManager: ProductCredentialManager | undefined
  let statusPublisher: ReturnType<typeof productStatusPublisher> | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let supervision: ReturnType<typeof createProductSupervision> | undefined
  let closing: Promise<void> | undefined
  let scheduleTimer: ReturnType<typeof setInterval> | undefined
  let credentialRecovery: Promise<void> | undefined
  const recoverCredentials = () => {
    if (!resourceManager || closing || credentialRecovery) return credentialRecovery
    credentialRecovery = (async () => {
      try { await resourceManager!.resumeCreations() } catch { /* Retain the intent for the next bounded scan. */ }
      try { await resourceManager!.resumeRotations() } catch { /* Retain the rotation intent for the next scan. */ }
      try { await resourceManager!.resumeCleanup() } catch { /* Keep deleted resources visible until cleanup succeeds. */ }
    })().finally(() => { credentialRecovery = undefined })
    return credentialRecovery
  }
  const picker = () => {
    try {
      const service = (context as unknown as { get(name: string): { capability(): DirectoryPicker | undefined } | undefined }).get('directoryPicker')
      return service?.capability()
    } catch { return undefined }
  }
  const directoryId = (root: string) => `product-dir-${createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 32)}`
  const directoryRoot = async (path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path) || Buffer.byteLength(path) > 2048) {
      throw new CoreError('INVALID_INPUT', 'Choose an absolute working directory.')
    }
    let root: string
    try {
      root = await realpath(path)
      if (!(await stat(root)).isDirectory()) throw new Error('Not a directory')
    } catch { throw new CoreError('PATH_DENIED', 'The selected working directory does not exist or cannot be read.') }
    const core = await realpath(dirname(config.databasePath))
    const userHome = await realpath(join(homedir(), '.dsh')).catch(() => undefined)
    const overlap = (left: string, right: string) => {
      const path = relative(left, right)
      return path === '' || path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
    }
    if (overlap(core, root) || overlap(root, core) || userHome && (overlap(userHome, root) || overlap(root, userHome))) {
      throw new CoreError('PATH_DENIED', 'Choose a directory outside the product state and personal DSH data.')
    }
    return root
  }
  const openDirectory = async (root: string) => LocalEnvironment.open({ id: directoryId(root), instanceId, root,
    allowedActorIds: [actorId], permissions: ['read', 'write', 'search', 'command'], commands: {}, allowShell: true,
    assetsPath: join(dirname(config.databasePath), 'assets', directoryId(root)) })
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
    if (scheduleTimer) clearInterval(scheduleTimer)
    if (statusTimer) clearInterval(statusTimer)
    engine?.abortProactiveRuns(); feishuEngine?.abortProactiveRuns(); githubEngine?.abortProactiveRuns()
    const failures: unknown[] = []
    for (const close of [() => supervision?.close(), () => statusPublisher?.close(), () => gateway?.close(), () => feishuRuntime?.stop(), () => githubRuntime?.stop(), () => engine?.effects.stop(),
      () => feishuEngine?.effects.stop(), () => githubEngine?.effects.stop(), () => engine?.shutdown(), () => feishuEngine?.shutdown(), () => githubEngine?.shutdown(),
      () => sessions.close(), ...environments.map(environment => () => environment.close()), () => storage.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'The product Host did not close cleanly.')
  }
  try {
    const saved: { id: string; root: string }[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page++) {
      const slice = await storage.transaction(instanceId, transaction => transaction.scan<{ id: string; root: string }>('product-directory', {
        limit: 100, ...(after ? { after } : {}),
      }))
      saved.push(...slice.items.map(item => item.value))
      if (!slice.cursor) break
      if (page === 9) throw new CoreError('DIRECTORY_BUDGET', 'The product directory registry exceeds 1000 entries.')
      after = slice.cursor
    }
    const roots = [
      ...(config.workspaceRoot ? [await directoryRoot(config.workspaceRoot)] : []),
      ...saved.map(item => item.root),
    ]
    for (const root of new Set(roots)) environments.push(await openDirectory(root))
    if (config.feishu) {
      const { withCredential: _externalCredential, ...api } = config.feishu.api
      feishuRuntime = new FeishuRuntime({ ...config.feishu, api: api.appSecret ? api : {
        ...api, withCredential: async (purpose, consume) => {
          const manager = resourceManager
          const sourceInstanceId = feishuRuntime?.sourceBinding.sourceInstanceId
          if (!manager || !sourceInstanceId) throw new CoreError('RESOURCE_UNAVAILABLE', 'No Feishu credential resource is available.')
          const resourceId = await manager.selectedFeishuCredential(sourceInstanceId)
          if (!resourceId) throw new CoreError('RESOURCE_UNAVAILABLE', 'Select a Feishu credential resource in product settings.')
          return manager.use({ instanceId, resourceId, sourceInstanceId,
            role: purpose === 'source' ? 'main' : 'router', purpose }, consume)
        },
      }, storage, instanceId, mainIntake: true })
      feishuEngine = new Engine(storage, instanceId, feishuRuntime.sourceBinding, {}, sessions, [], {}, {}, {}, {}, {}, proactive)
      feishuRuntime.bind(feishuEngine)
    }
    if (config.github) {
      githubRuntime = new GitHubRuntime({ ...config.github, storage, instanceId })
      githubEngine = new Engine(storage, instanceId, githubRuntime.sourceBinding, {}, sessions, [], {}, {}, {}, {}, {}, proactive)
      githubRuntime.bind(githubEngine)
    }
    const channel: DeliveryChannel | undefined = feishuRuntime || githubRuntime ? {
      deliver: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.deliver(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
      reconcile: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.reconcile(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
    } : undefined
    engine = new Engine(storage, instanceId, { sourceInstanceId: 'product-desktop', actorId, allowedActorIds: [actorId] }, {}, sessions,
      environments, {}, {}, {}, channel ? { channel } : {}, {}, proactive, attachments)
    const records = context.get('credentials') as ProductCredentialRecords | undefined
    if (records && typeof records.readRecord === 'function' && typeof records.modifyRecord === 'function'
      && typeof records.deleteRecord === 'function') resourceManager = engine.createProductCredentialManager(records)
    if (environments[0] && config.workspaceRoot) await engine.addWorkDirectory({ instanceId,
      commandId: `bootstrap:${environments[0].config.id}`, environment: environments[0] })
    await engine.acquireHost()
    if (feishuRuntime && config.feishu?.api.appSecret) {
      const selected = await storage.transaction(instanceId, tx => tx.get<{ resourceId: string | null }>(
        'product-feishu-credential', feishuRuntime!.sourceBinding.sourceInstanceId))
      feishuLegacyConflict = Boolean(selected?.resourceId)
    }
    await engine.recoverProactiveRuns()
    await recoverCredentials()
    await engine.openMain({ instanceId })
    supervision = createProductSupervision(engine, sessions, storage, instanceId,
      { watchdogConfigured: Boolean(config.watchdogStatusPath) })
    if (config.watchdogStatusPath) {
      statusPublisher = productStatusPublisher(config.watchdogStatusPath, async () => {
        const source = feishuRuntime?.health()
        const run = await storage.transaction(instanceId, tx => tx.get<{ history: { status: string; error?: string }[] }>('supervisor-run', 'product-supervisor'))
        const error = run && run.history.length >= 3 && run.history.slice(0, 3).every(item => item.status === 'failed')
          ? run.history[0]?.error : undefined
        return productWatchdogProbe(engine!, instanceId, source ? {
          id: feishuRuntime!.sourceBinding.sourceInstanceId, state: source.state,
          ...(source.lastError ? { error: source.lastError } : {}),
        } : undefined, config.feishuConfigurationError, error)
      }, () => engine!.getHostLease())
      await statusPublisher.publish()
      statusTimer = setInterval(() => { void statusPublisher?.publish().catch(() => {}) }, 10_000)
      statusTimer.unref()
    }
    engine.effects.start()
    supervision.start()
    void engine.tickSchedules().catch(() => { /* Rules and failed occurrences remain available for the next check. */ })
    scheduleTimer = setInterval(() => {
      void engine?.tickSchedules().catch(() => {})
      void engine?.reconcileProactiveCandidates().catch(() => {})
      void feishuEngine?.reconcileProactiveCandidates().catch(() => {})
      if (githubRuntime?.health().state === 'polling') void githubEngine?.reconcileProactiveCandidates().catch(() => {})
      void recoverCredentials()
    }, 30_000)
    scheduleTimer.unref()
    if (feishuRuntime && !feishuLegacyConflict) void feishuRuntime.start().then(() => feishuEngine?.reconcileProactiveCandidates()).catch(() => {
      /* Health and durable candidates retain a failed source pass for the next attempt. */
    })
    if (githubRuntime) void githubRuntime.start().catch(() => {
      /* Source health reports setup failures; the Host and other sources stay available. */
    })
    void engine.resumeMainInputs({ instanceId }).catch(() => { /* The persisted input and failed health remain visible for retry. */ })
    const clients = engine.createClientAccess()
    const product: ProductHost = {
      clients,
      async dispatch(endpoint, payload = {}, client) {
        if (closing) throw new CoreError('RUNTIME_CLOSED', 'The product Host is closed.')
        // The Host supplies identity; a window can only address this authorization scope.
        if (endpoint === 'open') {
          if (Object.keys(payload).length !== 0) throw new CoreError('INVALID_INPUT', 'Opening the product Main accepts no fields.')
          return engine!.openMain({ instanceId })
        }
        if (payload.instanceId !== instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This request is outside the authorized Instance.')
        const fields = resourceFields[endpoint] ?? (endpoint === 'proactive-rules' || endpoint === 'proactive-control' ? ['instanceId']
          : endpoint === 'proactive-list' ? ['instanceId', 'before']
          : endpoint === 'proactive-read' ? ['instanceId', 'runId']
            : endpoint === 'proactive-artifact' ? ['instanceId', 'runId', 'path', 'offset', 'maxBytes']
              : endpoint === 'proactive-save' ? ['instanceId', 'commandId', 'expectedRevision', 'rules']
                : endpoint === 'proactive-pause' ? ['instanceId', 'commandId', 'paused']
                  : endpoint === 'proactive-stop' ? ['instanceId', 'commandId', 'runId', 'reason']
                    : endpoint === 'schedule-list' || endpoint === 'schedule-source-read' ? ['instanceId']
          : endpoint === 'schedule-source-set' ? ['instanceId', 'commandId', 'enabled']
            : endpoint === 'schedule-read' ? ['instanceId', 'ruleId']
              : endpoint === 'schedule-create' ? ['instanceId', 'commandId', 'title', 'text', 'timezone', 'when', 'target']
                : endpoint === 'schedule-cancel' ? ['instanceId', 'commandId', 'ruleId']
                : endpoint === 'send' ? ['instanceId', 'commandId', 'text', 'environmentId', 'attachments']
                  : endpoint === 'attachment-upload' ? ['instanceId', 'commandId', 'environmentId', 'kind', 'name', 'mediaType', 'data']
                    : endpoint === 'attachment-read' ? ['instanceId', 'id', 'offset', 'maxBytes']
                      : endpoint === 'attachment-revoke' ? ['instanceId', 'id']
                        : endpoint === 'artifact-read' ? ['instanceId', 'workItemId', 'path', 'offset', 'maxBytes']
          : endpoint === 'clients-list' ? ['instanceId']
            : endpoint === 'client-enroll' ? ['instanceId', 'commandId', 'label', 'capabilities']
              : endpoint === 'client-revoke' ? ['instanceId', 'commandId', 'clientId', 'reason']
                : endpoint === 'directory-options' || endpoint === 'directory-pick' ? ['instanceId']
                  : endpoint === 'directory-list' ? ['instanceId', 'path']
                    : endpoint === 'directory-register' ? ['instanceId', 'commandId', 'path']
                      : endpoint === 'directory-default-save' ? ['instanceId', 'commandId', 'expectedRevision', 'environmentId']
                        : endpoint === 'feishu-status' || endpoint === 'feishu-start' || endpoint === 'feishu-stop'
                          || endpoint === 'github-status' || endpoint === 'github-start' || endpoint === 'github-stop' ? ['instanceId']
          : endpoint === 'stop-main' ? ['instanceId', 'commandId', 'messageId']
            : endpoint === 'work-stop'
              ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'expectedTicketVersion', 'reason']
            : endpoint === 'work-retry'
              ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'reason']
              : endpoint === 'work-resume' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration']
                : endpoint === 'work-answer' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'attentionId', 'attentionVersion', 'text']
                : endpoint === 'supervision' ? ['instanceId', 'ticketId']
                  : endpoint === 'supervision-inspect' ? ['instanceId']
                    : endpoint === 'supervision-decide' ? ['instanceId', 'commandId', 'proposalId', 'decision', 'fingerprint', 'reason']
                  : endpoint === 'settings' ? ['instanceId', 'limit']
                    : endpoint === 'settings-save' ? ['instanceId', 'commandId', 'expectedRevision', 'roles']
                      : endpoint === 'preset-list' || endpoint === 'preset-imports' || endpoint === 'preset-applications'
                        ? ['instanceId', 'after', 'limit']
                        : endpoint === 'preset-create' ? ['instanceId', 'commandId', 'preset']
                          : endpoint === 'preset-preview' ? ['instanceId', 'commandId', 'copy']
                            : endpoint === 'preset-select' ? ['instanceId', 'commandId', 'previewId', 'decision', 'copy', 'preset', 'expectedDecisionId']
                              : endpoint === 'preset-apply' ? ['instanceId', 'commandId', 'presetId', 'targetRole', 'expectedRevision']
                                : endpoint === 'preset-application-read' ? ['instanceId', 'commandId']
                                  : endpoint === 'preset-preview-read' ? ['instanceId', 'previewId']
                                    : endpoint === 'preset-import-read' ? ['instanceId', 'importId']
                      : endpoint === 'settings-efforts' ? ['instanceId', 'provider', 'model']
                        : endpoint === 'provider-key' ? ['instanceId', 'provider', 'value']
                          : endpoint === 'reconcile-delivery' ? ['instanceId', 'commandId', 'ticketId', 'deliveryId']
                            : endpoint === 'source-deliveries' ? ['instanceId', 'sourceId', 'after', 'limit']
                              : endpoint === 'observe-list' ? ['instanceId', 'after', 'limit', 'query']
                                : endpoint === 'observe-read' ? ['instanceId', 'observationId', 'generation', 'after', 'limit']
                                  : endpoint === 'observe-detail' ? ['instanceId', 'observationId', 'generation', 'detailId', 'offset', 'limit']
                                    : endpoint === 'evidence' ? ['instanceId', 'workItemId', 'ref', 'after', 'maxBytes']
                                      : endpoint === 'history' ? ['instanceId', 'after', 'before', 'limit']
                                        : undefined)
        if (!fields) throw new CoreError('UNAVAILABLE', 'This product capability is not connected yet.')
        if (Object.keys(payload).some(key => !fields.includes(key))) throw new CoreError('INVALID_INPUT', 'The product request contains unsupported fields.')
        if (client && endpoint.startsWith('schedule-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Schedule administration requires the local authorized product settings.')
        }
        if (client && (endpoint === 'github-start' || endpoint === 'github-stop')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'GitHub source administration requires the local authorized product settings.')
        }
        if (client && endpoint.startsWith('supervision')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Supervision decisions and history require the local authorized product window.')
        }
        if (client && (endpoint === 'proactive-save' || endpoint === 'proactive-pause' || endpoint === 'proactive-artifact')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Preparation settings and files require the local authorized product window.')
        }
        if (client && endpoint.startsWith('preset-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Role presets require the local authorized product settings.')
        }
        if (client && endpoint.startsWith('resource-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential resources require the local authorized product settings.')
        }
        if (client && (endpoint.startsWith('attachment-') || endpoint === 'artifact-read')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'File access requires the local authorized product window.')
        }
        if (endpoint === 'clients-list' || endpoint === 'client-enroll' || endpoint === 'client-revoke') {
          if (client) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Client administration requires the local authorized product settings.')
          if (endpoint === 'clients-list') return clients.list()
          if (endpoint === 'client-enroll') return clients.enroll({ commandId: payload.commandId as string,
            label: payload.label as string, grants: [{ instanceId, capabilities: payload.capabilities as ClientCapability[] }] })
          return clients.revoke({ commandId: payload.commandId as string, clientId: payload.clientId as string,
            reason: payload.reason as string })
        }
        const commandId = client && payload.commandId !== undefined
          ? (() => { identifier(payload.commandId, 'commandId'); return `client:${client.id}:${createHash('sha256').update(payload.commandId).digest('hex')}` })()
          : payload.commandId as string
        if (endpoint === 'proactive-rules') {
          const [configured, control] = await Promise.all([engine!.getProactiveRules(), engine!.getProactiveControl()])
          return { ...configured, control, sources: [
            ...(feishuRuntime ? [{ sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId, label: 'Feishu', kind: 'feishu' }] : []),
            ...(githubRuntime ? [{ sourceInstanceId: githubRuntime.sourceBinding.sourceInstanceId,
              label: `GitHub ${config.github!.owner}/${config.github!.repo}`, kind: 'github' }] : []),
          ] }
        }
        if (endpoint === 'proactive-control') return engine!.getProactiveControl()
        if (endpoint === 'proactive-list') {
          const runs = await engine!.listProactiveRuns()
          const before = payload.before
          const end = before === undefined ? runs.length : runs.findIndex(run => run.id === before)
          if (end < 0) throw new CoreError('INVALID_INPUT', 'Use a cursor from this Instance preparation index.')
          const start = Math.max(0, end - 50)
          return { items: runs.slice(start, end).reverse().map(({ text, ...run }) => ({ ...run, text: text.slice(0, 512) })),
            total: runs.length, ...(start ? { before: runs[start]!.id } : {}) }
        }
        if (endpoint === 'proactive-read') return await engine!.getProactiveRun(payload.runId as string) ?? null
        if (endpoint === 'proactive-artifact') return engine!.readProactiveArtifact(payload.runId as string,
          payload.path as string, payload.offset as number | undefined, payload.maxBytes as number | undefined)
        if (endpoint === 'proactive-save') {
          const rules = payload.rules as ProactiveRule[]
          if (!Array.isArray(rules) || rules.some(rule => {
            if (!rule) return true
            if (!rule.enabled) return false
            const source = rule.match?.sourceInstanceIds?.[0]
            const feishu = source === feishuRuntime?.sourceBinding.sourceInstanceId
            const github = source === githubRuntime?.sourceBinding.sourceInstanceId
            return rule.match?.sourceInstanceIds?.length !== 1 || (!feishu && !github)
              || !Array.isArray(rule.match.actorKinds) || !Array.isArray(rule.match.addressing)
              || rule.match.actorKinds.some(kind => feishu ? kind !== 'bot' : kind !== 'bot' && kind !== 'ci')
              || rule.match.addressing.includes('ambient')
              || rule.match.textPattern !== undefined && !/^[\p{L}\p{N} _:-]{1,128}$/u.test(rule.match.textPattern)
          })) {
            throw new CoreError('INVALID_CONFIG', 'Product preparations require an addressed configured source, bot/CI events and a bounded literal text match.')
          }
          const saved = await engine!.updateProactiveRules({ commandId, expectedRevision: payload.expectedRevision as number, rules })
          engine!.abortProactiveRuns(); feishuEngine?.abortProactiveRuns(); githubEngine?.abortProactiveRuns()
          return saved
        }
        if (endpoint === 'proactive-pause') {
          const result = await engine!.setProactivePaused({ commandId, paused: payload.paused as boolean })
          if (result.paused) { engine!.abortProactiveRuns(); feishuEngine?.abortProactiveRuns(); githubEngine?.abortProactiveRuns() }
          return result
        }
        if (endpoint === 'proactive-stop') {
          const run = await engine!.getProactiveRun(payload.runId as string)
          if (!run || ![feishuRuntime?.sourceBinding.sourceInstanceId, githubRuntime?.sourceBinding.sourceInstanceId, 'product-desktop'].includes(run.sourceInstanceId)) {
            throw new CoreError('NOT_FOUND', 'This Host does not own the preparation.')
          }
          const owner = run.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId ? feishuEngine
            : run.sourceInstanceId === githubRuntime?.sourceBinding.sourceInstanceId ? githubEngine : engine
          return owner!.stopProactiveRun({ commandId, runId: run.id, reason: payload.reason as string })
        }
        if (endpoint.startsWith('resource-')) {
          if (!resourceManager) throw new CoreError('UNAVAILABLE', 'This DSH profile has no durable credential record service.')
          const manager = resourceManager
          if (endpoint === 'resource-list') return manager.list({ instanceId,
            ...(payload.after === undefined ? {} : { after: payload.after as string }),
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
          if (endpoint === 'resource-read') {
            const resource = await manager.get({ instanceId, resourceId: payload.resourceId as string })
            if (!resource) throw new CoreError('NOT_FOUND', 'The credential resource is unavailable.')
            return resource
          }
          if (endpoint === 'resource-create') return manager.create({ instanceId, commandId, label: payload.label as string,
            value: payload.value as string })
          if (endpoint === 'resource-rename') return manager.rename({ instanceId, commandId,
            resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number,
            label: payload.label as string })
          if (endpoint === 'resource-rotate') return manager.rotate({ instanceId, commandId,
            resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number,
            value: payload.value as string })
          if (endpoint === 'resource-rotation-read') {
            const result = await manager.rotationStatus({ instanceId, commandId })
            if (!result) throw new CoreError('NOT_FOUND', 'The credential rotation command is unavailable.')
            return result
          }
          if (endpoint === 'resource-delete') return manager.delete({ instanceId, commandId,
            resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number })
          if (endpoint === 'resource-request') return manager.request({ instanceId, commandId,
            resourceId: payload.resourceId as string, scope: payload.scope as import('./resource-credentials.js').CredentialScope,
            purpose: payload.purpose as import('./resource-credentials.js').CredentialPurpose })
          if (endpoint === 'resource-request-read') {
            const request = await manager.getRequest({ instanceId, requestId: payload.requestId as string })
            if (!request) throw new CoreError('NOT_FOUND', 'The credential request is unavailable.')
            return request
          }
          if (endpoint === 'resource-cancel') return manager.cancel({ instanceId, commandId, requestId: payload.requestId as string })
          if (endpoint === 'resource-grant') return manager.grant({ instanceId, commandId,
            resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number,
            scope: payload.scope as import('./resource-credentials.js').CredentialScope,
            purposes: payload.purposes as import('./resource-credentials.js').CredentialPurpose[],
            ...(payload.requestId === undefined ? {} : { requestId: payload.requestId as string }) })
          if (endpoint === 'resource-revoke') return manager.revokeGrant({ instanceId, commandId,
            resourceId: payload.resourceId as string, grantId: payload.grantId as string,
            expectedRevision: payload.expectedRevision as number })
          if (endpoint === 'resource-cleanup') return payload.resourceId === undefined
            ? { creations: await manager.resumeCreations(), rotations: await manager.resumeRotations(),
              deletions: await manager.resumeCleanup() }
            : manager.cleanupDeleted({ instanceId, resourceId: payload.resourceId as string })
          if (endpoint === 'resource-select-feishu') {
            if (!feishuRuntime || config.feishu?.api.appSecret) throw new CoreError('UNAVAILABLE', 'Managed Feishu credentials are not enabled for this source.')
            if (payload.resourceId !== null && typeof payload.resourceId !== 'string') throw new CoreError('INVALID_INPUT', 'Choose a credential resource or clear the selection.')
            if (payload.resourceId !== null && (await manager.get({ instanceId, resourceId: payload.resourceId }))?.status !== 'active') {
              throw new CoreError('RESOURCE_UNAVAILABLE', 'Select an active credential resource.')
            }
            if (feishuSelectionActive) throw new CoreError('RUNTIME_ACTIVE', 'Another Feishu resource selection is in progress.')
            feishuSelectionActive = true
            try {
              await feishuRuntime.stop()
              let selected: { resourceId: string | null }
              try {
                selected = await manager.selectFeishuCredential({ instanceId, sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId,
                  commandId, resourceId: payload.resourceId })
              } catch (error) {
                await feishuRuntime.start().catch(() => { /* Restore the previous selection when the command was rejected. */ })
                throw error
              }
              await feishuRuntime.start().catch(() => { /* Health retains an unavailable or denied grant. */ })
              return { ...selected, sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId, ...feishuRuntime.health() }
            } finally { feishuSelectionActive = false }
          }
        }
        if (endpoint === 'schedule-list') return engine!.listSchedules({ instanceId })
        if (endpoint === 'supervision') return supervision!.state(payload.ticketId as string | undefined)
        if (endpoint === 'supervision-inspect') return supervision!.inspect()
        if (endpoint === 'supervision-decide') return engine!.decideSupervisorProposal({ instanceId,
          commandId: commandId, proposalId: payload.proposalId as string, decision: payload.decision as 'approve' | 'reject',
          fingerprint: payload.fingerprint as string,
          ...(payload.reason === undefined ? {} : { reason: payload.reason as string }) })
        if (endpoint === 'schedule-source-read') return engine!.getScheduleSource({ instanceId })
        if (endpoint === 'schedule-source-set') return engine!.setScheduleSource({ instanceId,
          commandId: payload.commandId as string, enabled: payload.enabled as boolean })
        if (endpoint === 'schedule-read') return engine!.getSchedule({ instanceId, ruleId: payload.ruleId as string })
        if (endpoint === 'schedule-create') return engine!.createSchedule({ instanceId, commandId: payload.commandId as string,
          title: payload.title as string, text: payload.text as string, timezone: payload.timezone as string,
          when: payload.when as import('./product-schedules.js').ScheduleWhen,
          target: payload.target as import('./product-schedules.js').ScheduleTarget })
        if (endpoint === 'schedule-cancel') return engine!.cancelSchedule({ instanceId,
          commandId: payload.commandId as string, ruleId: payload.ruleId as string })
        if (endpoint === 'feishu-status' || endpoint === 'feishu-start' || endpoint === 'feishu-stop') {
          if (feishuSelectionActive && endpoint !== 'feishu-status') throw new CoreError('RUNTIME_ACTIVE', 'The Feishu resource selection is in progress.')
          if (feishuLegacyConflict) {
            if (endpoint === 'feishu-status') return { configured: true, credentialMode: 'legacy',
              sourceInstanceId: feishuRuntime!.sourceBinding.sourceInstanceId, state: 'failed', passes: 0, lastError: 'INVALID_CONFIG' }
            if (endpoint === 'feishu-start') throw new CoreError('INVALID_CONFIG', 'Remove the legacy Feishu secret before using a selected resource.')
          }
          if (!feishuRuntime) {
            if (endpoint === 'feishu-status') return config.feishuConfigurationError
              ? { configured: false, state: 'failed', lastError: config.feishuConfigurationError }
              : { configured: false, state: 'unavailable' }
            if (config.feishuConfigurationError) throw new CoreError('INVALID_CONFIG', 'The Feishu source configuration is incomplete.')
            throw new CoreError('UNAVAILABLE', 'No Feishu source is configured for this product Host.')
          }
          if (endpoint === 'feishu-start' && !['setup', 'polling'].includes(feishuRuntime.health().state)) {
            feishuEngine?.abortProactiveRuns()
            await feishuRuntime.stop()
            await feishuRuntime.start()
          }
          if (endpoint === 'feishu-stop') {
            feishuEngine?.abortProactiveRuns(); await feishuEngine?.discardProactiveCandidates(); await feishuRuntime.stop()
          }
          return { configured: true, sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId,
            credentialMode: config.feishu!.api.appSecret ? 'legacy' : 'managed',
            ...(config.feishu!.api.appSecret ? {} : { resourceId: await resourceManager?.selectedFeishuCredential(feishuRuntime.sourceBinding.sourceInstanceId) ?? null }),
            ...feishuRuntime.health() }
        }
        if (endpoint === 'github-status' || endpoint === 'github-start' || endpoint === 'github-stop') {
          if (!githubRuntime) {
            if (endpoint === 'github-status') return config.githubConfigurationError
              ? { configured: false, state: 'failed', lastError: config.githubConfigurationError }
              : { configured: false, state: 'idle' }
            throw new CoreError('UNAVAILABLE', 'Configure a trusted GitHub repository before starting its source.')
          }
          if (endpoint === 'github-start' && !['setup', 'polling'].includes(githubRuntime.health().state)) {
            await githubRuntime.stop()
            await githubRuntime.start()
          }
          if (endpoint === 'github-stop') {
            githubEngine?.abortProactiveRuns()
            await githubRuntime.stop()
            githubEngine?.abortProactiveRuns()
            await githubEngine?.discardProactiveCandidates()
          }
          return { configured: true, sourceInstanceId: githubRuntime.sourceBinding.sourceInstanceId, ...githubRuntime.health() }
        }
        if (endpoint === 'history') {
          if (payload.after !== undefined && payload.before !== undefined) throw new CoreError('INVALID_INPUT', 'Main history accepts one direction cursor.')
          const page = payload.after !== undefined ? await engine!.getMainConversation({ instanceId, after: payload.after as number,
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
            : await engine!.getRecentMainConversation({ instanceId,
            ...(payload.before === undefined ? {} : { before: payload.before as number }),
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
          const rules = await engine!.getProactiveRules()
          const current = new Map(rules.rules.filter(rule => rule.enabled && rule.communication === 'notify').map(rule => [rule.id, rule]))
          const runs = current.size ? await engine!.getRecentProactiveNotices() : []
          return { ...page, preparations: runs.filter(run => run.state === 'prepared' && run.ruleRevision === rules.revision
            && current.has(run.ruleId)).map(run => ({ id: run.id, ruleId: run.ruleId,
              sourceInstanceId: run.sourceInstanceId, eventId: run.eventId, summary: run.summary, createdAt: run.createdAt })) }
        }
        if (endpoint === 'directory-options') {
          const current = await engine!.getInstanceDirectory({ instanceId }).catch(error => {
            if (error instanceof CoreError && error.code === 'DELEGATION_UNAVAILABLE') return null
            throw error
          })
          return { default: current, picker: picker()?.kind ?? null,
            directories: environments.map(environment => ({ id: environment.config.id, root: environment.config.root,
              title: basename(environment.config.root) || environment.config.root })) }
        }
        if (endpoint === 'directory-pick') {
          const native = picker()
          if (native?.kind !== 'native' || !native.pick) throw new CoreError('UNAVAILABLE', 'This Host has no native folder picker.')
          return await native.pick(AbortSignal.timeout(120_000)) ?? null
        }
        if (endpoint === 'directory-list') {
          const browse = picker()
          if (browse?.kind !== 'browse' || !browse.list) throw new CoreError('UNAVAILABLE', 'This Host cannot browse directories.')
          if (payload.path !== undefined && (typeof payload.path !== 'string' || payload.path.length > 2048)) {
            throw new CoreError('INVALID_INPUT', 'Choose a bounded directory path to browse.')
          }
          return browse.list(payload.path as string | undefined, AbortSignal.timeout(30_000))
        }
        if (endpoint === 'directory-register') {
          identifier(payload.commandId, 'commandId')
          const root = await directoryRoot(payload.path)
          const id = directoryId(root)
          let environment = environments.find(item => item.config.id === id)
          if (environment && environment.config.root !== root) throw new CoreError('ENVIRONMENT_CHANGED', 'Directory identity changed.')
          const opened = environment ? undefined : await openDirectory(root)
          try {
            environment = environment ?? opened!
            await environment.probe({ instanceId, actorId })
            const record = await engine!.addWorkDirectory({ instanceId, commandId: payload.commandId as string, environment })
            if (opened) environments.push(opened)
            return record
          } catch (error) { await opened?.close(); throw error }
        }
        if (endpoint === 'directory-default-save') return engine!.setInstanceDirectory({ instanceId,
          commandId: payload.commandId as string, expectedRevision: payload.expectedRevision as number,
          environmentId: payload.environmentId as string })
        if (endpoint === 'attachment-upload' || endpoint === 'attachment-read' || endpoint === 'attachment-revoke') {
          if (!attachments) throw new CoreError('UNAVAILABLE', 'The public DSH attachment service is not mounted in this profile.')
          if (endpoint === 'attachment-upload') return attachments.upload({ instanceId, actorId,
            commandId: payload.commandId as string, environmentId: payload.environmentId as string,
            kind: payload.kind as 'file' | 'image', name: payload.name as string,
            ...(payload.mediaType === undefined ? {} : { mediaType: payload.mediaType as string }), data: payload.data as string })
          if (endpoint === 'attachment-read') return attachments.read({ instanceId, actorId, id: payload.id as string,
            ...(payload.offset === undefined ? {} : { offset: payload.offset as number }),
            ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
          return attachments.revoke({ instanceId, actorId, id: payload.id as string })
        }
        if (endpoint === 'artifact-read') {
          const work = await engine!.getMainWorkCard({ instanceId, workItemId: payload.workItemId as string })
          const artifact = work.outcome?.artifacts.find(item => item.path === payload.path)
          if (!artifact?.reference) throw new CoreError('NOT_FOUND', 'This work has no authorized artifact at that path.')
          const reference = artifact.reference
          assertReferenceShape(reference)
          if (reference.environmentId !== work.brief.environmentId) {
            throw new CoreError('REFERENCE_STALE', 'The artifact belongs to another work Environment.')
          }
          const owner = environments.find(environment => environment.config.id === reference.environmentId)
          if (!owner) throw new CoreError('ENVIRONMENT_DENIED', 'This artifact belongs to an unavailable work directory.')
          const bound = await owner.prepare({ instanceId, actorId })
          return bound.readProductAsset(reference, {
            ...(payload.offset === undefined ? {} : { offset: payload.offset as number }),
            ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
        }
        if (endpoint === 'send') return engine!.sendMainMessage({ instanceId, commandId, text: payload.text as string,
          ...(payload.environmentId === undefined ? {} : { environmentId: payload.environmentId as string }),
          ...(payload.attachments === undefined ? {} : { attachments: payload.attachments as string[] }),
          ...(client ? { clientId: client.id } : {}) })
        if (endpoint === 'stop-main') return engine!.stopMainTurn({ instanceId, commandId, messageId: payload.messageId as string })
        if (endpoint === 'work-stop') return engine!.stopMainWork({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          ...(payload.expectedGeneration === undefined ? {} : { expectedGeneration: payload.expectedGeneration as string }),
          expectedTicketVersion: payload.expectedTicketVersion as number, reason: payload.reason as string })
        if (endpoint === 'work-resume') return engine!.resumeMainWork({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string })
        if (endpoint === 'work-answer') return engine!.answerMainAttention({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string, attentionId: payload.attentionId as string,
          attentionVersion: payload.attentionVersion as number, text: payload.text as string })
        if (endpoint === 'work-retry') return engine!.retryMainWork({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          expectedGeneration: payload.expectedGeneration as string, reason: payload.reason as string })
        if (endpoint === 'settings') return roleSettings(payload.limit === undefined ? 50 : payload.limit as number)
        if (endpoint === 'preset-list') return engine!.listRolePresets({ instanceId,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'preset-imports') return engine!.listRolePresetImports({ instanceId,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'preset-applications') return engine!.listRolePresetApplications({ instanceId,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'preset-preview-read') return await engine!.getRolePresetPreview({ instanceId, previewId: payload.previewId as string }) ?? null
        if (endpoint === 'preset-import-read') return await engine!.getRolePresetImport({ instanceId, importId: payload.importId as string }) ?? null
        if (endpoint === 'preset-application-read') return await engine!.getRolePresetApplication({ instanceId,
          commandId: payload.commandId as string }) ?? null
        if (endpoint === 'preset-create') return engine!.createRolePreset({ instanceId, commandId: payload.commandId as string, preset: payload.preset })
        if (endpoint === 'preset-preview') return engine!.previewRolePreset({ instanceId, commandId: payload.commandId as string,
          copy: payload.copy as LegacyPresetCopy })
        if (endpoint === 'preset-select') return engine!.selectRolePreset({ instanceId, commandId: payload.commandId as string,
          previewId: payload.previewId as string, decision: payload.decision as 'select' | 'replace' | 'skip',
          ...(payload.copy === undefined ? {} : { copy: payload.copy as LegacyPresetCopy }),
          ...(payload.preset === undefined ? {} : { preset: payload.preset }),
          ...(payload.expectedDecisionId === undefined ? {} : { expectedDecisionId: payload.expectedDecisionId as string }) })
        if (endpoint === 'preset-apply') return engine!.applyRolePreset({ instanceId, commandId: payload.commandId as string,
          presetId: payload.presetId as string, targetRole: payload.targetRole as PresetRole,
          expectedRevision: payload.expectedRevision as number }, { verify: verifyRoles })
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
        if (endpoint === 'reconcile-delivery') return engine!.reconcileDelivery({ commandId,
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
    if (config.clientGateway) {
      gateway = await createClientGateway(engine, clients, { ...config.clientGateway, product })
      product.clientGateway = { url: gateway.url, secure: gateway.secure }
    }
    return product
  } catch (error) {
    await dispose()
    throw error
  }
}
