import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
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
import type { ExecutionEnvironment } from './environment.js'
import { RemoteEnvironment, type PersistedRemoteEnvironmentState } from './remote-environment.js'
import { RemoteEnvironmentSecrets, type RemoteCredentialRecords } from './remote-environment-secrets.js'
import { FeishuRuntime, type FeishuRuntimeOptions } from './feishu-runtime.js'
import type { FeishuSourceReply } from './feishu-delivery.js'
import { GitHubRuntime, type GitHubRuntimeOptions } from './github-runtime.js'
import { GitHubCliTransport } from './github-api.js'
import { ProductAttachments } from './product-attachments.js'
import { productProactivePreparation } from './product-proactive.js'
import { ProactiveWork } from './proactive-work.js'
import type { ProactiveRule } from './proactive.js'
import type { ProductCredentialRecords } from './product-credential-vault.js'
import type { ProductCredentialManager } from './product-credential-manager.js'
import { workerMcpName, type WorkerMcpConfig } from './worker-mcp-tool.js'
import type { ProductMcpConfiguration } from './product-mcp-configuration.js'
import { HostBrowserAdapter } from './browser-host.js'
import type { BrowserAdapter } from './browser-resources.js'
import { assertReferenceShape } from './environment-assets.js'
import { canonicalJson } from './commands.js'
import { localDeliveryChannel, type DeliveryChannel } from './deliveries.js'
import type { RoleConfig, RoleModel } from './config.js'
import type { LegacyPresetCopy, PresetRole } from './role-presets.js'
import { productStatusPublisher, productWatchdogProbe } from './product-watchdog.js'
import { createProductSupervision } from './product-supervision.js'

export interface ProductHostConfig { databasePath: string; workspaceRoot?: string; instanceId?: string; actorId?: string; main?: RoleModel; router?: RoleModel; worker?: RoleModel; timeoutMs?: number;
  /** Trusted local Office runtime supplied by the product Host, never a window request. */
  office?: { node: string; cli: string; skillsPath: string };
  /** Trusted process configuration; an external Watchdog reads this atomic status file. */
  watchdogStatusPath?: string;
  clientGateway?: Omit<ClientGatewayOptions, 'product'>;
  /** Supplied by a trusted Host, never by the window or a model turn. */
  feishu?: Omit<FeishuRuntimeOptions, 'storage' | 'instanceId' | 'mainIntake' | 'attachmentIntake'>;
  /** Trusted deployment selection; one exact Host-local MCP tool, with no model-supplied endpoint or credential. */
  workerMcpTool?: WorkerMcpConfig;
  /** Trusted Host seam; tests may supply a fake bridge without touching a user browser. */
  browserAdapter?: BrowserAdapter;
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
  'resource-request-list': ['instanceId', 'after', 'limit'],
  'resource-request-read': ['instanceId', 'requestId'], 'resource-cancel': ['instanceId', 'commandId', 'requestId'],
  'resource-grant': ['instanceId', 'commandId', 'resourceId', 'expectedRevision', 'scope', 'purposes', 'requestId'],
  'resource-revoke': ['instanceId', 'commandId', 'resourceId', 'grantId', 'expectedRevision'],
  'resource-cleanup': ['instanceId', 'resourceId'],
  'resource-select-feishu': ['instanceId', 'commandId', 'resourceId'],
  'resource-select-github': ['instanceId', 'commandId', 'resourceId'],
  'mcp-status': ['instanceId'],
  'mcp-save': ['instanceId', 'commandId', 'expectedRevision', 'resourceId'],
  'mcp-approve': ['instanceId', 'commandId', 'expectedRevision', 'approved'],
  'mcp-connect': ['instanceId', 'commandId', 'expectedRevision'],
  'mcp-disconnect': ['instanceId', 'commandId', 'expectedRevision'],
  'mcp-retry': ['instanceId', 'commandId', 'expectedRevision'],
}

const browserFields: Record<string, string[]> = {
  'browser-list': ['instanceId'], 'browser-read': ['instanceId', 'resourceId'],
  'browser-create': ['instanceId', 'commandId', 'environmentId', 'label'],
  'browser-grant': ['instanceId', 'commandId', 'resourceId', 'workItemId', 'expectedRevision', 'active'],
  'browser-revoke': ['instanceId', 'commandId', 'resourceId', 'expectedRevision'],
  'browser-resolve': ['instanceId', 'commandId', 'resourceId', 'operationId', 'reason'],
}
const memoryFields: Record<string, string[]> = {
  'memory-list': ['instanceId', 'after', 'limit', 'query'],
  'memory-read': ['instanceId', 'id', 'after', 'maxBytes'],
  'memory-side-query': ['instanceId', 'target', 'query', 'limit'],
  'memory-side-read': ['instanceId', 'target', 'id', 'after', 'maxBytes'],
  'memory-save': ['instanceId', 'commandId', 'scope', 'text'],
  'memory-share': ['instanceId', 'commandId', 'id', 'expectedRevision', 'main', 'workItemIds'],
  'memory-forget': ['instanceId', 'commandId', 'id', 'expectedRevision'],
  'memory-access-read': ['instanceId', 'workItemId'],
  'memory-grant': ['instanceId', 'commandId', 'workItemId', 'expectedRevision', 'enabled'],
  'memory-proposals': ['instanceId'],
  'memory-decide': ['instanceId', 'commandId', 'proposalId', 'approve'],
}

export async function createProductHost(context: Context, config: ProductHostConfig): Promise<ProductHost> {
  const instanceId = config.instanceId ?? 'personal'
  const actorId = config.actorId ?? 'local-user'
  identifier(instanceId, 'instanceId'); identifier(actorId, 'actorId')
  const credentialRecords = context.get('credentials') as RemoteCredentialRecords | undefined
  const remoteSecrets = credentialRecords && typeof credentialRecords.readRecord === 'function'
    && typeof credentialRecords.modifyRecord === 'function' && typeof credentialRecords.deleteRecord === 'function'
    ? new RemoteEnvironmentSecrets(credentialRecords) : undefined
  const browserAdapter = config.browserAdapter ?? (process.env.DS_BOT_APP === '1' && typeof process.send === 'function'
    ? new HostBrowserAdapter() : undefined)
  if (config.office && (![config.office.node, config.office.cli, config.office.skillsPath].every(isAbsolute)
    || ![config.office.node, config.office.cli, join(config.office.skillsPath, 'office', 'SKILL.md'),
      join(config.office.skillsPath, 'office-docx', 'SKILL.md')].every(path => existsSync(path)))) {
    throw new CoreError('INVALID_CONFIG', 'The trusted Office runtime needs its Node, CLI and Word skill files.')
  }
  if (config.workerMcpTool) workerMcpName(config.workerMcpTool)
  const route = (configured?: RoleModel): RoleModel => {
    const value = configured ?? context.get('agentDefaultModel')?.currentSelection?.()
    if (!value?.provider || !value.model) return { provider: 'unconfigured', model: 'unconfigured' }
    return { provider: value.provider, model: value.model }
  }
  const sessions = new NativeSessions(context, { main: route(config.main), router: route(config.router), worker: route(config.worker), ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
  const storage = await SqliteStorage.open(config.databasePath)
  const environments: ExecutionEnvironment[] = []
  const remoteEnvironments = new Map<string, { environment: RemoteEnvironment; label: string; pairedAt: number;
    credentialReference: string }>()
  const remoteLoadErrors = new Map<string, string>()
  const activePairCommands = new Set<string>()
  const activeRevokeCommands = new Set<string>()
  const nativeAttachments = context.get('attachments') as AttachmentStore | undefined
  const attachments = nativeAttachments ? new ProductAttachments(storage, instanceId, nativeAttachments,
    id => environments.find(environment => environment.config.id === id), actorId) : undefined
  let engine: Engine | undefined
  let gateway: Awaited<ReturnType<typeof createClientGateway>> | undefined
  let feishuRuntime: FeishuRuntime | undefined
  let feishuEngine: Engine | undefined
  let githubRuntime: GitHubRuntime | undefined
  let githubEngine: Engine | undefined
  let workRouter: ProactiveWork | undefined
  let feishuLegacyConflict = false
  let feishuSelectionActive = false
  let githubSelectionActive = false
  const proactiveRoot = join(dirname(config.databasePath), 'proactive-preparations')
  const proactive = { rootDirectory: proactiveRoot, prepareTimeoutMs: 30_000, pauseSourceInstanceId: 'product-desktop',
    onPrepared: (tx: import('./storage.js').AsyncTx, run: import('./proactive.js').ProactiveRun) => workRouter!.enqueue(tx, run),
    route: (runId: string, signal: AbortSignal) => workRouter!.route(runId, signal),
    sourceAvailable: (sourceId: string, sourceActorId: string) => sourceId === feishuRuntime?.sourceBinding.sourceInstanceId
      && sourceActorId === feishuRuntime.sourceBinding.actorId && feishuRuntime.health().state === 'polling'
      || sourceId === githubRuntime?.sourceBinding.sourceInstanceId
      && sourceActorId === githubRuntime.sourceBinding.actorId && githubRuntime.health().state === 'polling',
    authorizeWork: async (tx: import('./storage.js').AsyncTx, run: import('./proactive.js').ProactiveRun) => {
      if (run.sourceInstanceId !== feishuRuntime?.sourceBinding.sourceInstanceId || config.feishu?.api.appSecret) return
      const selected = await tx.get<{ resourceId: string | null }>('product-feishu-credential', run.sourceInstanceId)
      const resource = selected?.resourceId ? await tx.get<{ status: string; grants: { scope: { role: string; workItemId?: string;
        environmentId?: string; sourceInstanceId?: string }; purposes: string[] }[] }>('resource-credential', selected.resourceId) : undefined
      if (resource?.status !== 'active' || !resource.grants.some(grant => grant.scope.role === 'main'
        && grant.scope.workItemId === undefined && grant.scope.environmentId === undefined
        && (grant.scope.sourceInstanceId === undefined || grant.scope.sourceInstanceId === run.sourceInstanceId)
        && grant.purposes.includes('source'))) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The selected Feishu source grant was revoked.')
    },
    onSourceChanged: (sourceId: string) => { void workRouter?.stopInvalid('The original source event changed.', sourceId).catch(() => {}) },
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
  let mcpConfiguration: ProductMcpConfiguration | undefined
  let selectedMcpTool: WorkerMcpConfig | undefined
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
    allowedActorIds: [actorId], permissions: ['read', 'write', 'search', 'command'], allowShell: true,
    commands: config.office ? { office: { argv: [config.office.node, config.office.cli], timeoutMs: 10000 } } : {},
    ...(config.office ? { skillsPath: config.office.skillsPath } : {}),
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
  const executionOptions = async () => {
    const policy = await engine!.getExecutionPolicy()
    const preview = await engine!.getExecutionPreview()
    const candidates = new Map(preview.candidates.map(candidate => [candidate.id, candidate]))
    const items = await Promise.all(engine!.listEnvironments().map(async environment => {
      const remote = environment.kind === 'remote' ? remoteEnvironments.get(environment.id) : undefined
      const candidate = candidates.get(environment.id)
      const capabilities = await engine!.getEnvironmentCapabilities(environment.id).catch(error =>
        error instanceof CoreError ? { unavailable: true, reason: error.code } : { unavailable: true, reason: 'CAPABILITY_READ_FAILED' })
      return { ...environment, target: environment.kind === 'remote' ? 'remote-only' : 'local-only',
        ...(remote ? { label: remote.label, pairedAt: remote.pairedAt } : {}),
        ...(candidate ? { online: candidate.online, eligible: candidate.eligible, reasons: candidate.reasons,
          version: candidate.version, fingerprint: candidate.fingerprint, capacity: candidate.capacity,
          ...(candidate.productCapabilities ? { productCapabilities: candidate.productCapabilities } : {}) } : {}),
        capabilities }
    }))
    return { policy, preview: { status: preview.status, source: preview.source, target: preview.target,
      ...(preview.reason ? { reason: preview.reason } : {}), capabilities: preview.capabilities ?? [] }, environments: items,
      remoteLoadErrors: [...remoteLoadErrors].map(([id, reason]) => ({ id, reason })) }
  }
  async function dispose() {
    if (scheduleTimer) clearInterval(scheduleTimer)
    if (statusTimer) clearInterval(statusTimer)
    engine?.abortProactiveRuns(); feishuEngine?.abortProactiveRuns(); githubEngine?.abortProactiveRuns()
    const failures: unknown[] = []
    for (const close of [() => supervision?.close(), () => statusPublisher?.close(), () => gateway?.close(), () => feishuRuntime?.stop(), () => githubRuntime?.stop(), () => engine?.effects.stop(),
      () => feishuEngine?.effects.stop(), () => githubEngine?.effects.stop(), () => engine?.shutdown(), () => feishuEngine?.shutdown(), () => githubEngine?.shutdown(),
      () => engine?.closeBrowserResources(), () => workRouter?.close(), () => sessions.close(),
      ...environments.map(environment => () => environment.close()), () => storage.close()]) {
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
    let remoteAfter: string | undefined
    for (let page = 0; page < 10; page++) {
      const slice = await storage.transaction(instanceId, transaction => transaction.scan<{
        label: string; pairedAt: number; state: PersistedRemoteEnvironmentState }>('product-remote-environment', {
        limit: 100, ...(remoteAfter ? { after: remoteAfter } : {}),
      }))
      for (const item of slice.items) {
        let environment: RemoteEnvironment | undefined
        try {
          if (typeof item.value.label !== 'string' || !item.value.label.trim() || Buffer.byteLength(item.value.label) > 128
            || !Number.isSafeInteger(item.value.pairedAt) || item.value.pairedAt < 0) {
            throw new CoreError('INVALID_CONFIG', 'A saved remote Environment has invalid display metadata.')
          }
          if (!remoteSecrets) throw new CoreError('INVALID_CONFIG', 'Saved remote Environments require the DSH credential record service.')
          environment = await remoteSecrets.withSecret(item.value.state.hostExchangePrivateReference,
            async privateKey => RemoteEnvironment.restorePersisted(item.value.state, privateKey))
          if (!environment) throw new CoreError('INVALID_CONFIG', 'A saved remote Environment could not be restored.')
          const restoredEnvironment = environment
          if (restoredEnvironment.config.instanceId !== instanceId || !restoredEnvironment.config.allowedActorIds.includes(actorId)
            || remoteEnvironments.has(restoredEnvironment.config.id)
            || environments.some(candidate => candidate.config.id === restoredEnvironment.config.id)) {
            throw new CoreError('INVALID_CONFIG', 'A saved remote Environment has a conflicting identity.')
          }
          remoteEnvironments.set(restoredEnvironment.config.id, { environment: restoredEnvironment, label: item.value.label,
            pairedAt: item.value.pairedAt,
            credentialReference: item.value.state.hostExchangePrivateReference })
          environments.push(restoredEnvironment)
        } catch (error) {
          await environment?.close().catch(() => {})
          remoteLoadErrors.set(item.id, error instanceof CoreError ? error.code : 'REMOTE_ENVIRONMENT_RESTORE_FAILED')
        }
      }
      if (!slice.cursor) break
      if (page === 9) throw new CoreError('DIRECTORY_BUDGET', 'The product remote Environment registry exceeds 1000 entries.')
      remoteAfter = slice.cursor
    }
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
      }, storage, instanceId, mainIntake: true,
      ...(attachments ? { attachmentIntake: { upload: (request: import('./product-attachments.js').ProductAttachmentUpload) => attachments.upload(request),
        environmentId: async () => (await engine!.getInstanceDirectory({ instanceId })).environmentId } } : {}) })
      feishuEngine = new Engine(storage, instanceId, feishuRuntime.sourceBinding,
        { claimUnowned: false, streamOwners: { notice: 'product-desktop', relay: 'product-desktop' } }, sessions, [], {}, {}, {},
        { channel: feishuRuntime.channel }, {}, proactive)
      feishuRuntime.bind(feishuEngine)
    }
    if (config.github) {
      const sourceInstanceId = `github:${config.github.owner}/${config.github.repo}`
      const githubCli = new GitHubCliTransport({ ...config.github.cli,
        withCredential: async (purpose, consume) => {
          const manager = resourceManager
          if (!manager) throw new CoreError('RESOURCE_UNAVAILABLE', 'No GitHub credential resource is available.')
          const resourceId = await manager.selectedGitHubCredential(sourceInstanceId)
          if (!resourceId) throw new CoreError('RESOURCE_UNAVAILABLE', 'Select a GitHub credential resource in product settings.')
          return manager.use({ instanceId, resourceId, sourceInstanceId, role: 'main', purpose }, consume)
        } })
      const { cli: _cli, transport: trustedTransport, ...github } = config.github
      githubRuntime = new GitHubRuntime({ ...github, transport: trustedTransport ?? githubCli, storage, instanceId })
      githubEngine = new Engine(storage, instanceId, githubRuntime.sourceBinding,
        { claimUnowned: false, streamOwners: { notice: 'product-desktop', relay: 'product-desktop' } }, sessions, [], {}, {}, {}, {}, {}, proactive)
      githubRuntime.bind(githubEngine)
    }
    type ProductDeliveryChannel = DeliveryChannel & {
      deliverSourceReply?: (reply: FeishuSourceReply, context: Parameters<DeliveryChannel['deliver']>[1]) => ReturnType<DeliveryChannel['deliver']>
      reconcileSourceReply?: (reply: FeishuSourceReply, context: Parameters<DeliveryChannel['deliver']>[1]) => ReturnType<DeliveryChannel['deliver']>
    }
    const channel: ProductDeliveryChannel | undefined = feishuRuntime || githubRuntime ? {
      deliver: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.deliver(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
      reconcile: (delivery, context) => delivery.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.reconcile(delivery, context)
        : delivery.destination.sourceInstanceId === 'product-desktop' ? localDeliveryChannel.deliver(delivery, context)
          : Promise.resolve({ type: 'permanent', reason: 'DESTINATION_SOURCE_DISABLED' }),
      deliverSourceReply: (reply, context) => reply.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.deliverSourceReply(reply, context)
        : Promise.resolve({ type: 'unknown', reason: 'DESTINATION_SOURCE_DISABLED' }),
      reconcileSourceReply: (reply, context) => reply.destination.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId
        ? feishuRuntime!.channel.reconcileSourceReply(reply, context)
        : Promise.resolve({ type: 'unknown', reason: 'DESTINATION_SOURCE_DISABLED' }),
    } : undefined
    engine = new Engine(storage, instanceId, { sourceInstanceId: 'product-desktop', actorId, allowedActorIds: [actorId],
      ...(config.workerMcpTool || browserAdapter ? { hostCapabilities: {
        ...(config.workerMcpTool ? { mcp: true } : {}), ...(browserAdapter ? { browser: true } : {}),
      } } : {}) }, {}, sessions,
      environments, {}, {}, {}, channel ? { channel } : {}, {}, proactive, attachments)
    workRouter = new ProactiveWork(storage, instanceId, engine, sessions, actorId)
    const records = credentialRecords as ProductCredentialRecords | undefined
    if (records && typeof records.readRecord === 'function' && typeof records.modifyRecord === 'function'
      && typeof records.deleteRecord === 'function') resourceManager = engine.createProductCredentialManager(records)
    if (config.workerMcpTool) {
      if (!resourceManager) throw new CoreError('UNAVAILABLE', 'The approved MCP tool requires a durable DSH record service.')
      mcpConfiguration = engine.createProductMcpConfiguration(config.workerMcpTool)
      const selected = await mcpConfiguration.get({ instanceId })
      selectedMcpTool = { ...config.workerMcpTool, resourceId: selected.resourceId }
      engine.configureWorkerMcp({ config: selectedMcpTool, credentials: {
        use: async (request, consume) => {
          await mcpConfiguration!.assertUse(request)
          return resourceManager!.use(request, async secret => {
            await mcpConfiguration!.assertUse(request)
            return consume(secret)
          })
        },
      } })
    }
    if (browserAdapter) engine.configureWorkerBrowser(browserAdapter)
    if (environments[0] && config.workspaceRoot) await engine.addWorkDirectory({ instanceId,
      commandId: `bootstrap:${environments[0].config.id}`, environment: environments[0] })
    await engine.acquireHost()
    if (feishuRuntime && config.feishu?.api.appSecret) {
      const selected = await storage.transaction(instanceId, tx => tx.get<{ resourceId: string | null }>(
        'product-feishu-credential', feishuRuntime!.sourceBinding.sourceInstanceId))
      feishuLegacyConflict = Boolean(selected?.resourceId)
    }
    await engine.recoverProactiveRuns()
    await workRouter.recover()
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
    feishuEngine?.effects.start()
    engine.effects.start()
    supervision.start()
    void engine.tickSchedules().catch(() => { /* Rules and failed occurrences remain available for the next check. */ })
    scheduleTimer = setInterval(() => {
      void engine?.tickSchedules().catch(() => {})
      void engine?.reconcileProactiveCandidates().catch(() => {})
      void feishuEngine?.reconcileProactiveCandidates().catch(() => {})
      if (githubRuntime?.health().state === 'polling') void githubEngine?.reconcileProactiveCandidates().catch(() => {})
      void workRouter?.stopInvalid('The proactive authorization changed.').catch(() => {})
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
        const fields = memoryFields[endpoint] ?? resourceFields[endpoint] ?? browserFields[endpoint]
          ?? (endpoint === 'proactive-rules' || endpoint === 'proactive-control' ? ['instanceId']
          : endpoint === 'proactive-list' ? ['instanceId', 'before']
          : endpoint === 'proactive-read' ? ['instanceId', 'runId']
            : endpoint === 'proactive-artifact' ? ['instanceId', 'runId', 'path', 'offset', 'maxBytes']
              : endpoint === 'proactive-work-artifact' ? ['instanceId', 'runId', 'path', 'offset', 'maxBytes']
              : endpoint === 'proactive-save' ? ['instanceId', 'commandId', 'expectedRevision', 'rules']
                : endpoint === 'proactive-pause' ? ['instanceId', 'commandId', 'paused']
                  : endpoint === 'proactive-stop' ? ['instanceId', 'commandId', 'runId', 'reason']
                    : endpoint === 'schedule-list' || endpoint === 'schedule-source-read' ? ['instanceId']
          : endpoint === 'schedule-source-set' ? ['instanceId', 'commandId', 'enabled']
            : endpoint === 'schedule-read' ? ['instanceId', 'ruleId']
              : endpoint === 'schedule-create' ? ['instanceId', 'commandId', 'title', 'text', 'timezone', 'when', 'target']
                : endpoint === 'schedule-cancel' ? ['instanceId', 'commandId', 'ruleId']
                : endpoint === 'send' ? ['instanceId', 'commandId', 'text', 'environmentId', 'target', 'attachments']
                  : endpoint === 'execution-options' ? ['instanceId']
                    : endpoint === 'execution-policy-save' ? ['instanceId', 'commandId', 'expectedRevision', 'policy']
                      : endpoint === 'remote-environment-pair' ? ['instanceId', 'commandId', 'environmentId', 'label', 'endpoint',
                        'pairingCode', 'expectedDeviceId', 'expectedDeviceKey', 'permissions']
                        : endpoint === 'remote-environment-pair-read' || endpoint === 'remote-environment-pair-abandon'
                          ? ['instanceId', 'commandId']
                          : endpoint === 'remote-environment-revoke' ? ['instanceId', 'commandId', 'environmentId']
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
            : endpoint === 'work-reconcile-stop' ? ['instanceId', 'commandId', 'workItemId', 'ticketId']
            : endpoint === 'work-retry'
              ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'reason']
              : endpoint === 'work-resume' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration']
                : endpoint === 'work-answer' ? ['instanceId', 'commandId', 'workItemId', 'ticketId', 'expectedGeneration', 'attentionId', 'attentionVersion', 'text']
                : endpoint === 'supervision' ? ['instanceId', 'ticketId']
                  : endpoint === 'supervision-inspect' ? ['instanceId', 'restart']
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
        if (client && (endpoint === 'execution-policy-save' || endpoint.startsWith('remote-environment-'))) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Execution and device administration requires the local authorized product settings.')
        }
        if (client && (endpoint === 'github-start' || endpoint === 'github-stop')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'GitHub source administration requires the local authorized product settings.')
        }
        if (client && endpoint.startsWith('supervision')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Supervision decisions and history require the local authorized product window.')
        }
        if (client && (endpoint === 'proactive-save' || endpoint === 'proactive-pause' || endpoint === 'proactive-artifact' || endpoint === 'proactive-work-artifact')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Preparation settings and files require the local authorized product window.')
        }
        if (client && endpoint.startsWith('preset-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Role presets require the local authorized product settings.')
        }
        if (client && (endpoint.startsWith('resource-') || endpoint.startsWith('mcp-'))) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Credential and MCP settings require the local authorized product settings.')
        }
        if (client && endpoint.startsWith('browser-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Browser resources require the local authorized product window.')
        }
        if (client && endpoint.startsWith('memory-')) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Memory management requires the local authorized product window.')
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
        if (endpoint.startsWith('browser-')) {
          if (endpoint === 'browser-list') return engine!.listBrowserResources({ instanceId })
          if (endpoint === 'browser-read') return engine!.readBrowserResource({ instanceId, resourceId: payload.resourceId as string })
          if (endpoint === 'browser-create') return engine!.createBrowserResource({ instanceId, commandId,
            environmentId: payload.environmentId as string, label: payload.label as string })
          if (endpoint === 'browser-grant') return engine!.grantBrowserResource({ instanceId, commandId,
            resourceId: payload.resourceId as string, workItemId: payload.workItemId as string,
            expectedRevision: payload.expectedRevision as number, active: payload.active as boolean })
          if (endpoint === 'browser-revoke') return engine!.revokeBrowserResource({ instanceId, commandId,
            resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number })
          if (endpoint === 'browser-resolve') return engine!.resolveBrowserOperation({ instanceId, commandId,
            resourceId: payload.resourceId as string, operationId: payload.operationId as string, reason: payload.reason as string })
        }
        if (endpoint === 'memory-list') return engine!.listProductMemory({ instanceId,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }),
          ...(payload.query === undefined ? {} : { query: payload.query as string }) })
        if (endpoint === 'memory-read') return engine!.getProductMemory({ instanceId, id: payload.id as string,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
        if (endpoint === 'memory-side-query') return engine!.queryProductMemorySide({ instanceId,
          target: payload.target as import('./product-memory.js').MemorySideTarget, query: payload.query as string,
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
        if (endpoint === 'memory-side-read') return engine!.readProductMemorySide({ instanceId,
          target: payload.target as import('./product-memory.js').MemorySideTarget, id: payload.id as string,
          ...(payload.after === undefined ? {} : { after: payload.after as string }),
          ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
        if (endpoint === 'memory-save') return engine!.saveProductMemory({ instanceId, commandId,
          scope: payload.scope as import('./product-memory.js').MemoryScope, text: payload.text as string })
        if (endpoint === 'memory-share') return engine!.shareProductMemory({ instanceId, commandId,
          id: payload.id as string, expectedRevision: payload.expectedRevision as number,
          main: payload.main as boolean, workItemIds: payload.workItemIds as string[] })
        if (endpoint === 'memory-forget') return engine!.forgetProductMemory({ instanceId, commandId,
          id: payload.id as string, expectedRevision: payload.expectedRevision as number })
        if (endpoint === 'memory-access-read') return engine!.getProductWorkMemoryAccess({ instanceId,
          workItemId: payload.workItemId as string })
        if (endpoint === 'memory-grant') return engine!.grantProductWorkMemory({ instanceId, commandId,
          workItemId: payload.workItemId as string, expectedRevision: payload.expectedRevision as number,
          enabled: payload.enabled as boolean })
        if (endpoint === 'memory-proposals') return engine!.listProductMemoryProposals({ instanceId })
        if (endpoint === 'memory-decide') return engine!.decideProductMemoryProposal({ instanceId, commandId,
          proposalId: payload.proposalId as string, approve: payload.approve as boolean })
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
          return { items: await Promise.all(runs.slice(start, end).reverse().map(async run => {
            const work = await workRouter!.view(run)
            return { ...run, text: run.text.slice(0, 512), ...(work ? { work } : {}) }
          })),
            total: runs.length, ...(start ? { before: runs[start]!.id } : {}) }
        }
        if (endpoint === 'proactive-read') {
          const run = await engine!.getProactiveRun(payload.runId as string)
          if (!run) return null
          const work = await workRouter!.view(run, { detail: true })
          return { ...run, ...(work ? { work } : {}) }
        }
        if (endpoint === 'proactive-artifact') return engine!.readProactiveArtifact(payload.runId as string,
          payload.path as string, payload.offset as number | undefined, payload.maxBytes as number | undefined)
        if (endpoint === 'proactive-work-artifact') return workRouter!.readArtifact(payload.runId as string,
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
          await workRouter!.stopInvalid('The standing proactive rule changed.')
          return saved
        }
        if (endpoint === 'proactive-pause') {
          const result = await engine!.setProactivePaused({ commandId, paused: payload.paused as boolean })
          if (result.paused) { engine!.abortProactiveRuns(); feishuEngine?.abortProactiveRuns(); githubEngine?.abortProactiveRuns() }
          if (result.paused) await workRouter!.stopInvalid('Proactive work was paused.')
          return result
        }
        if (endpoint === 'proactive-stop') {
          const run = await engine!.getProactiveRun(payload.runId as string)
          if (!run || ![feishuRuntime?.sourceBinding.sourceInstanceId, githubRuntime?.sourceBinding.sourceInstanceId, 'product-desktop'].includes(run.sourceInstanceId)) {
            throw new CoreError('NOT_FOUND', 'This Host does not own the preparation.')
          }
          const owner = run.sourceInstanceId === feishuRuntime?.sourceBinding.sourceInstanceId ? feishuEngine
            : run.sourceInstanceId === githubRuntime?.sourceBinding.sourceInstanceId ? githubEngine : engine
          const stopped = await owner!.stopProactiveRun({ commandId, runId: run.id, reason: payload.reason as string })
          await workRouter!.stopInvalid('The preparation was stopped.')
          return stopped
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
          if (endpoint === 'resource-delete') {
            const result = await manager.delete({ instanceId, commandId,
              resourceId: payload.resourceId as string, expectedRevision: payload.expectedRevision as number })
            await workRouter!.stopInvalid('A source credential was deleted.')
            return result
          }
          if (endpoint === 'resource-request') return manager.request({ instanceId, commandId,
            resourceId: payload.resourceId as string, scope: payload.scope as import('./resource-credentials.js').CredentialScope,
            purpose: payload.purpose as import('./resource-credentials.js').CredentialPurpose })
          if (endpoint === 'resource-request-list') return manager.listRequests({ instanceId,
            ...(payload.after === undefined ? {} : { after: payload.after as string }),
            ...(payload.limit === undefined ? {} : { limit: payload.limit as number }) })
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
          if (endpoint === 'resource-revoke') {
            const result = await manager.revokeGrant({ instanceId, commandId,
              resourceId: payload.resourceId as string, grantId: payload.grantId as string,
              expectedRevision: payload.expectedRevision as number })
            await workRouter!.stopInvalid('A source credential grant was revoked.')
            return result
          }
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
                await workRouter!.stopInvalid('The Feishu source credential selection changed.', feishuRuntime.sourceBinding.sourceInstanceId)
              } catch (error) {
                await feishuRuntime.start().catch(() => { /* Restore the previous selection when the command was rejected. */ })
                throw error
              }
              await feishuRuntime.start().catch(() => { /* Health retains an unavailable or denied grant. */ })
              return { ...selected, sourceInstanceId: feishuRuntime.sourceBinding.sourceInstanceId, ...feishuRuntime.health() }
            } finally { feishuSelectionActive = false }
          }
          if (endpoint === 'resource-select-github') {
            if (!githubRuntime || config.github?.transport) throw new CoreError('UNAVAILABLE', 'Managed GitHub credentials are not enabled for this source.')
            if (payload.resourceId !== null && typeof payload.resourceId !== 'string') throw new CoreError('INVALID_INPUT', 'Choose a credential resource or clear the selection.')
            if (payload.resourceId !== null && (await manager.get({ instanceId, resourceId: payload.resourceId }))?.status !== 'active') {
              throw new CoreError('RESOURCE_UNAVAILABLE', 'Select an active credential resource.')
            }
            if (githubSelectionActive) throw new CoreError('RUNTIME_ACTIVE', 'Another GitHub resource selection is in progress.')
            githubSelectionActive = true
            try {
              await githubRuntime.stop()
              let selected: { resourceId: string | null }
              try {
                selected = await manager.selectGitHubCredential({ instanceId, sourceInstanceId: githubRuntime.sourceBinding.sourceInstanceId,
                  commandId, resourceId: payload.resourceId })
                await workRouter!.stopInvalid('The GitHub source credential selection changed.', githubRuntime.sourceBinding.sourceInstanceId)
              } catch (error) {
                await githubRuntime.start().catch(() => {})
                throw error
              }
              await githubRuntime.start().catch(() => {})
              return { ...selected, sourceInstanceId: githubRuntime.sourceBinding.sourceInstanceId, ...githubRuntime.health() }
            } finally { githubSelectionActive = false }
          }
        }
        if (endpoint.startsWith('mcp-')) {
          if (!mcpConfiguration) {
            if (endpoint === 'mcp-status') return { configured: false, state: 'unavailable', location: 'host', remote: 'unsupported' }
            throw new CoreError('UNAVAILABLE', 'No trusted Host MCP tool is configured.')
          }
          if (endpoint === 'mcp-status') {
            const current = await mcpConfiguration.get({ instanceId })
            selectedMcpTool!.resourceId = current.resourceId
            return current
          }
          const request = { instanceId, commandId, expectedRevision: payload.expectedRevision as number }
          if (endpoint === 'mcp-save') {
            const saved = await mcpConfiguration.save({ ...request, resourceId: payload.resourceId as string })
            selectedMcpTool!.resourceId = saved.resourceId
            return saved
          }
          if (endpoint === 'mcp-approve') return mcpConfiguration.approve({ ...request, approved: payload.approved as boolean })
          if (endpoint === 'mcp-connect') return mcpConfiguration.connect(request)
          if (endpoint === 'mcp-disconnect') return mcpConfiguration.disconnect(request)
          if (endpoint === 'mcp-retry') return mcpConfiguration.connect(request, true)
        }
        if (endpoint === 'schedule-list') return engine!.listSchedules({ instanceId })
        if (endpoint === 'supervision') return supervision!.state(payload.ticketId as string | undefined)
        if (endpoint === 'supervision-inspect') {
          if (payload.restart !== undefined && payload.restart !== true) throw new CoreError('INVALID_INPUT', 'Restarting an inspection requires an explicit true value.')
          return supervision!.inspect(payload.restart === true)
        }
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
            await workRouter!.stopInvalid('The Feishu source was stopped.', feishuRuntime.sourceBinding.sourceInstanceId)
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
          if (githubSelectionActive && endpoint !== 'github-status') throw new CoreError('RUNTIME_ACTIVE', 'The GitHub resource selection is in progress.')
          if (endpoint === 'github-start' && !['setup', 'polling'].includes(githubRuntime.health().state)) {
            await githubRuntime.stop()
            await githubRuntime.start()
          }
          if (endpoint === 'github-stop') {
            githubEngine?.abortProactiveRuns()
            await githubRuntime.stop()
            githubEngine?.abortProactiveRuns()
            await githubEngine?.discardProactiveCandidates()
            await workRouter!.stopInvalid('The GitHub source was stopped.', githubRuntime.sourceBinding.sourceInstanceId)
          }
          return { configured: true, sourceInstanceId: githubRuntime.sourceBinding.sourceInstanceId,
            credentialMode: config.github?.transport ? 'trusted' : 'managed',
            ...(config.github?.transport ? {} : { resourceId: await resourceManager?.selectedGitHubCredential(githubRuntime.sourceBinding.sourceInstanceId) ?? null }),
            ...githubRuntime.health() }
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
        if (endpoint === 'execution-options') return executionOptions()
        if (endpoint === 'execution-policy-save') return engine!.updateExecutionPolicy({
          commandId: payload.commandId as string, expectedRevision: payload.expectedRevision as number,
          policy: payload.policy as import('./execution-target.js').ExecutionPolicyConfig })
        if (endpoint === 'remote-environment-pair') {
          if (!remoteSecrets) throw new CoreError('UNAVAILABLE', 'Remote device pairing requires the DSH credential record service.')
          identifier(payload.commandId, 'commandId')
          const commandKey = `product-remote-environment-command:${payload.commandId as string}`
          if (activePairCommands.has(commandKey)) {
            throw new CoreError('PAIRING_PENDING', 'The device pairing command is still running.')
          }
          activePairCommands.add(commandKey)
          try {
          const environmentId = payload.environmentId as string
          identifier(environmentId, 'environmentId')
          const label = typeof payload.label === 'string' ? payload.label.trim() : ''
          if (!label || Buffer.byteLength(label) > 128) throw new CoreError('INVALID_INPUT', 'A remote Environment needs a bounded label.')
          const permissions = payload.permissions as import('./remote-environment.js').RemoteEnvironmentPermission[]
          const fingerprint = createHash('sha256').update(canonicalJson(['product-remote-pair-v1', instanceId, actorId,
            environmentId, label, payload.endpoint, payload.expectedDeviceId, payload.expectedDeviceKey, permissions])).digest('hex')
          const credentialReference = remoteSecrets.referenceFor(instanceId, payload.commandId as string)
          const prior = await storage.transaction(instanceId, tx => tx.get<{ fingerprint: string; status: string;
            environmentId?: string; label?: string; pairedAt?: number; credentialReference?: string }>(
            'product-remote-environment-command', commandKey))
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The device pairing command changed its input.')
            if (prior.status === 'pending') {
              await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
                { ...prior, status: 'unknown', credentialReference: prior.credentialReference ?? credentialReference }))
              throw new CoreError('PAIRING_UNKNOWN', 'The device pairing result is unknown. Inspect the device before issuing a new pairing.')
            }
            const current = prior.environmentId ? remoteEnvironments.get(prior.environmentId) : undefined
            if (current && prior.label && prior.pairedAt) return { id: current.environment.config.id, label: prior.label,
              pairedAt: prior.pairedAt, kind: 'remote', deviceId: current.environment.deviceId, root: current.environment.config.root,
              permissions: [...current.environment.config.permissions] }
            if (prior.status === 'unknown') throw new CoreError('PAIRING_UNKNOWN', 'The device pairing result is unknown. Inspect the device before issuing a new pairing.')
            if (prior.status === 'abandoned') throw new CoreError('PAIRING_STALE', 'This pairing command was abandoned.')
            if (prior.status === 'completed') throw new CoreError('PAIRING_STALE', 'This pairing command was already applied and the device was removed.')
          }
          if (remoteEnvironments.has(environmentId) || environments.some(environment => environment.config.id === environmentId)) {
            throw new CoreError('IDENTITY_CONFLICT', 'This Environment ID is already in use.')
          }
          await storage.transaction(instanceId, async tx => {
            if (await tx.get('product-remote-environment-command', commandKey)) {
              throw new CoreError('PAIRING_UNKNOWN', 'The device pairing result is unknown.')
            }
            await tx.insert('product-remote-environment-command', commandKey,
              { fingerprint, status: 'pending', operation: 'pair', credentialReference })
          })
          let environment: RemoteEnvironment
          try {
            environment = await RemoteEnvironment.pair({ id: environmentId, instanceId, allowedActorIds: [actorId], permissions,
              endpoint: payload.endpoint as string, pairingCode: payload.pairingCode as string,
              expectedDeviceId: payload.expectedDeviceId as string, expectedDeviceKey: payload.expectedDeviceKey as string })
          } catch (error) {
            const known = error instanceof CoreError && ['PAIRING_DENIED', 'GRANT_DENIED', 'DEVICE_IDENTITY_MISMATCH', 'INVALID_CONFIG'].includes(error.code)
            await storage.transaction(instanceId, tx => known ? tx.remove('product-remote-environment-command', commandKey)
              : tx.replace('product-remote-environment-command', commandKey,
                { fingerprint, status: 'unknown', operation: 'pair', credentialReference })).catch(() => {})
            if (known) await remoteSecrets.ensureRemoved(credentialReference).catch(() => {})
            throw error
          }
          const pairedAt = Date.now()
          try {
            await remoteSecrets.create(credentialReference, environment.snapshot().hostExchangePrivate)
            await storage.transaction(instanceId, async tx => {
              const pending = await tx.get<{ fingerprint: string; status: string }>('product-remote-environment-command', commandKey)
              if (pending?.fingerprint !== fingerprint || pending.status !== 'pending') {
                throw new CoreError('PAIRING_STALE', 'This pairing command is no longer pending.')
              }
              if (await tx.get('product-remote-environment', environmentId)) throw new CoreError('IDENTITY_CONFLICT', 'This Environment ID is already in use.')
              await tx.insert('product-remote-environment', environmentId,
                { label, pairedAt, state: environment.persistedSnapshot(credentialReference) })
              await tx.replace('product-remote-environment-command', commandKey,
                { fingerprint, status: 'completed', operation: 'pair', environmentId, label, pairedAt, credentialReference })
            })
          } catch (error) {
            await environment.close()
            const abandoned = await storage.transaction(instanceId, async tx => {
              const current = await tx.get<{ status: string }>('product-remote-environment-command', commandKey)
              if (current?.status === 'pending') await tx.replace('product-remote-environment-command', commandKey,
                { fingerprint, status: 'unknown', operation: 'pair', credentialReference, environmentId, label, pairedAt })
              return current?.status === 'abandoned'
            }).catch(() => false)
            if (abandoned) {
              try { await remoteSecrets.ensureRemoved(credentialReference) }
              catch {
                await storage.transaction(instanceId, async tx => {
                  const current = await tx.get<{ status: string }>('product-remote-environment-command', commandKey)
                  if (current?.status === 'abandoned') await tx.replace('product-remote-environment-command', commandKey,
                    { fingerprint, status: 'abandoned', operation: 'pair', credentialReference, cleanupPending: true })
                }).catch(() => {})
              }
            }
            throw error
          }
          remoteEnvironments.set(environmentId, { environment, label, pairedAt, credentialReference })
          environments.push(environment)
          engine!.registerExecutionEnvironment(environment)
          return { id: environmentId, label, pairedAt, kind: 'remote', deviceId: environment.deviceId,
            root: environment.config.root, permissions: [...environment.config.permissions] }
          } finally {
            activePairCommands.delete(commandKey)
          }
        }
        if (endpoint === 'remote-environment-pair-read') {
          identifier(payload.commandId, 'commandId')
          const commandKey = `product-remote-environment-command:${payload.commandId as string}`
          const record = await storage.transaction(instanceId, tx => tx.get<{ status: string; operation?: string;
            environmentId?: string; cleanupPending?: boolean }>('product-remote-environment-command', commandKey))
          if (!record || record.operation !== undefined && record.operation !== 'pair') {
            throw new CoreError('NOT_FOUND', 'This pairing command is unavailable.')
          }
          const saved = record.environmentId
            ? await storage.transaction(instanceId, tx => tx.get('product-remote-environment', record.environmentId!))
            : undefined
          return { commandId: payload.commandId, status: record.status, active: activePairCommands.has(commandKey),
            canAbandon: !activePairCommands.has(commandKey) && !saved && ['pending', 'unknown'].includes(record.status),
            ...(saved ? { recoverable: true } : {}),
            ...(record.environmentId ? { environmentId: record.environmentId } : {}),
            ...(record.cleanupPending ? { cleanupPending: true } : {}) }
        }
        if (endpoint === 'remote-environment-pair-abandon') {
          if (!remoteSecrets) throw new CoreError('UNAVAILABLE', 'Remote device pairing requires the DSH credential record service.')
          identifier(payload.commandId, 'commandId')
          const commandKey = `product-remote-environment-command:${payload.commandId as string}`
          if (activePairCommands.has(commandKey)) {
            throw new CoreError('PAIRING_PENDING', 'The device pairing command is still running.')
          }
          const record = await storage.transaction(instanceId, tx => tx.get<{ fingerprint: string; status: string;
            operation?: string; environmentId?: string; credentialReference?: string; cleanupPending?: boolean }>(
            'product-remote-environment-command', commandKey))
          if (!record || record.operation !== undefined && record.operation !== 'pair') {
            throw new CoreError('NOT_FOUND', 'This pairing command is unavailable.')
          }
          if (record.status === 'completed') throw new CoreError('PAIRING_STALE', 'A completed pairing cannot be abandoned here.')
          if (record.environmentId && await storage.transaction(instanceId, tx =>
            tx.get('product-remote-environment', record.environmentId!))) {
            throw new CoreError('PAIRING_STALE', 'A saved device exists for this pairing command. Restart the Host before changing it.')
          }
          if (record.status === 'abandoned' && !record.cleanupPending) return { commandId: payload.commandId, abandoned: true }
          const credentialReference = record.credentialReference
            ?? remoteSecrets.referenceFor(instanceId, payload.commandId as string)
          await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
            { ...record, status: 'abandoned', operation: 'pair', credentialReference, cleanupPending: true }))
          let cleaned = true
          try { await remoteSecrets.ensureRemoved(credentialReference) }
          catch {
            cleaned = false
            await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
              { ...record, status: 'abandoned', operation: 'pair', credentialReference, cleanupPending: true }))
          }
          if (cleaned) {
            await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
              { ...record, status: 'abandoned', operation: 'pair', credentialReference, cleanupPending: false }))
          }
          return { commandId: payload.commandId, abandoned: true, ...(cleaned ? {} : { secretCleanupPending: true }) }
        }
        if (endpoint === 'remote-environment-revoke') {
          if (!remoteSecrets) throw new CoreError('UNAVAILABLE', 'Remote device revocation requires the DSH credential record service.')
          identifier(payload.commandId, 'commandId')
          const environmentId = payload.environmentId as string
          identifier(environmentId, 'environmentId')
          const commandKey = `product-remote-environment-command:${payload.commandId as string}`
          if (activeRevokeCommands.has(commandKey)) {
            throw new CoreError('REVOKE_PENDING', 'The device revocation command is still running.')
          }
          activeRevokeCommands.add(commandKey)
          try {
          const fingerprint = createHash('sha256').update(canonicalJson(['product-remote-revoke-v1', instanceId, environmentId])).digest('hex')
          const prior = await storage.transaction(instanceId, tx => tx.get<{ fingerprint: string; status: string;
            operation?: string; deviceConfirmed?: boolean; reason?: string; credentialReference?: string; cleanupPending?: boolean }>(
            'product-remote-environment-command', commandKey))
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The device revoke command changed its target.')
            if (prior.operation !== undefined && prior.operation !== 'revoke') {
              throw new CoreError('IDENTITY_CONFLICT', 'This command belongs to another device operation.')
            }
            if (prior.status === 'completed') {
              let cleanupPending = prior.cleanupPending === true
              if (prior.credentialReference) {
                try {
                  await remoteSecrets.ensureRemoved(prior.credentialReference)
                  cleanupPending = false
                  await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
                    { ...prior, cleanupPending: false }))
                } catch { cleanupPending = true }
              }
              return { environmentId, revoked: true, deviceConfirmed: prior.deviceConfirmed === true,
                ...(prior.reason ? { reason: prior.reason } : {}), ...(cleanupPending ? { secretCleanupPending: true } : {}) }
            }
          }
          const current = remoteEnvironments.get(environmentId)
          if (!current) throw new CoreError('NOT_FOUND', 'The remote Environment is not paired in this Host.')
          await storage.transaction(instanceId, async tx => {
            const value = { fingerprint, status: 'pending', operation: 'revoke', environmentId,
              credentialReference: current.credentialReference }
            if (!await tx.replace('product-remote-environment-command', commandKey, value)) {
              await tx.insert('product-remote-environment-command', commandKey, value)
            }
          })
          let deviceConfirmed = true
          let reason: string | undefined
          if (prior?.status === 'pending') {
            deviceConfirmed = false
            reason = 'DEVICE_REVOKE_UNKNOWN'
          } else {
            try { await current.environment.revoke() }
            catch (error) {
              deviceConfirmed = false
              reason = error instanceof CoreError ? error.code : 'DEVICE_REVOKE_UNKNOWN'
            }
          }
          await storage.transaction(instanceId, async tx => {
            await tx.remove('product-remote-environment', environmentId)
            const value = { fingerprint, status: 'completed', operation: 'revoke', deviceConfirmed,
              ...(reason ? { reason } : {}), environmentId,
              credentialReference: current.credentialReference }
            if (!await tx.replace('product-remote-environment-command', commandKey, value)) {
              await tx.insert('product-remote-environment-command', commandKey, value)
            }
          })
          await current.environment.close()
          remoteEnvironments.delete(environmentId)
          const index = environments.indexOf(current.environment)
          if (index >= 0) environments.splice(index, 1)
          engine!.unregisterExecutionEnvironment(environmentId)
          let secretCleanupPending = false
          try { await remoteSecrets.ensureRemoved(current.credentialReference) }
          catch { secretCleanupPending = true }
          if (secretCleanupPending) {
            await storage.transaction(instanceId, tx => tx.replace('product-remote-environment-command', commandKey,
              { fingerprint, status: 'completed', operation: 'revoke', deviceConfirmed, ...(reason ? { reason } : {}), environmentId,
                credentialReference: current.credentialReference, cleanupPending: true }))
          }
          return { environmentId, revoked: true, deviceConfirmed, ...(reason ? { reason } : {}),
            ...(secretCleanupPending ? { secretCleanupPending: true } : {}) }
          } finally {
            activeRevokeCommands.delete(commandKey)
          }
        }
        if (endpoint === 'directory-options') {
          const current = await engine!.getInstanceDirectory({ instanceId }).catch(error => {
            if (error instanceof CoreError && error.code === 'DELEGATION_UNAVAILABLE') return null
            throw error
          })
          return { default: current, picker: picker()?.kind ?? null,
            directories: environments.filter(environment => environment.kind === 'local').map(environment => ({ id: environment.config.id, root: environment.config.root,
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
          if (environment && environment.kind !== 'local') throw new CoreError('IDENTITY_CONFLICT', 'A remote Environment already owns this identity.')
          if (environment && environment.config.root !== root) throw new CoreError('ENVIRONMENT_CHANGED', 'Directory identity changed.')
          const opened = environment ? undefined : await openDirectory(root)
          try {
            environment = environment ?? opened!
            if (!environment.probe) throw new CoreError('INVALID_CONFIG', 'The local Environment cannot verify its directory.')
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
          if (reference.environmentId !== (work.executionLocation?.id ?? work.brief.environmentId)) {
            throw new CoreError('REFERENCE_STALE', 'The artifact belongs to another work Environment.')
          }
          const owner = environments.find(environment => environment.config.id === reference.environmentId)
          if (!owner) throw new CoreError('ENVIRONMENT_DENIED', 'This artifact belongs to an unavailable work directory.')
          const bound = await owner.prepare({ instanceId, actorId })
          if (!bound.readProductAsset) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment cannot download the reported artifact.')
          return bound.readProductAsset(reference, {
            ...(payload.offset === undefined ? {} : { offset: payload.offset as number }),
            ...(payload.maxBytes === undefined ? {} : { maxBytes: payload.maxBytes as number }) })
        }
        if (endpoint === 'send') return engine!.sendMainMessage({ instanceId, commandId, text: payload.text as string,
          ...(payload.environmentId === undefined ? {} : { environmentId: payload.environmentId as string }),
          ...(payload.target === undefined ? {} : { target: payload.target as import('./execution-target.js').ExecutionTarget }),
          ...(payload.attachments === undefined ? {} : { attachments: payload.attachments as string[] }),
          ...(client ? { clientId: client.id } : {}) })
        if (endpoint === 'stop-main') return engine!.stopMainTurn({ instanceId, commandId, messageId: payload.messageId as string })
        if (endpoint === 'work-stop') return engine!.stopMainWork({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string,
          ...(payload.expectedGeneration === undefined ? {} : { expectedGeneration: payload.expectedGeneration as string }),
          expectedTicketVersion: payload.expectedTicketVersion as number, reason: payload.reason as string })
        if (endpoint === 'work-reconcile-stop') return engine!.reconcileMainStop({ instanceId, commandId,
          workItemId: payload.workItemId as string, ticketId: payload.ticketId as string })
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
