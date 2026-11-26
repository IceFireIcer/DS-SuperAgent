import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SkillRegistry, { isSkillName } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve, matchesGlob, sep, parse } from 'node:path'
import { CoreError, identifier, type PathGrant, type PathGrantOperation } from './model.js'
import type { EnvironmentConfig, EnvironmentPrepareOptions, ExecutionEnvironment, PreparedEnvironment } from './environment.js'
import { normalizePathGrants } from './path-grants.js'
import { protectedPath } from './path-safety.js'
import { inspectWorkCopy } from './work-copy.js'
import { sanitizeSecrets } from './sanitize.js'
import type { RemoteJobRecovery } from './remote-protocol.js'
import { defaultAssetPageBytes, environmentAssetGaps, environmentFingerprint, FileAssetStore, fileAssetId,
  assetNamespace, assetPageOptions, assetReferenceFromArgs, attachmentToolInput, matchesEnvironment, maxAssetBytes,
  maxProductAttachmentBytes, maxSpillBytes,
  pageOf, parseSpillAssetId,
  spillAssetId, UnsupportedEnvironmentCombination, unsupportedAssetCapabilities, type EnvironmentAssetCapabilities,
  type EnvironmentAssetPage, type EnvironmentAssetReference, type EnvironmentSkillSummary, type SpillStream } from './environment-assets.js'

export type LocalPermission = PathGrantOperation
export interface LocalCommand { argv: string[]; timeoutMs: number; backgroundTimeoutMs?: number }
export type LocalEnvironmentConfig = EnvironmentConfig
export interface Artifact { path: string; bytes: number; sha256: string; reference?: EnvironmentAssetReference }
export interface LocalToolFact { tool: string; outcome: 'success' | 'failed'; output: Record<string, unknown> }
export interface LocalJobOutput { text: string; lossy: boolean }
export interface LocalJobResult { exitCode: number | null; cancelled: boolean; truncated: boolean; settled: boolean
  outcome?: 'exited' | 'cancelled' | 'unknown'; reason?: string }
export interface RemoteJobObservation {
  deviceId: string
  deviceIncarnation: string
  actorId: string
  ownerId?: string
  deadlineAt?: number
  deviceState: string
  rangeSettled: boolean
  recovery?: RemoteJobRecovery
  recoveredAt?: number
  recoveryQuestionId?: string
  recoveryEvidence?: string
}

/** One background process range: bounded offset reads, a termination verb and exit facts. */
export interface LocalJob {
  /** Stable device job identity, present when the process runs outside this Host. */
  readonly jobId?: string
  /** Device ownership and local-deadline evidence, present for a remote range. */
  readonly remote?: RemoteJobObservation
  readonly done: Promise<LocalJobResult>
  read(): { stdout: LocalJobOutput; stderr: LocalJobOutput }
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

class BoundLocalJob implements LocalJob {
  readonly done: Promise<LocalJobResult>
  constructor(private readonly handle: SubprocessHandle, private readonly deadline: AbortSignal,
    private readonly sanitize: (text: string) => string, readonly jobId: string,
    private readonly retain: (key: string, stream: SpillStream, sourcePath: string) => Promise<void>) {
    this.done = (async () => {
      const outcome = await handle.done
      const settled = await handle.waitForExit(AbortSignal.timeout(2000))
      const stdout = handle.collected.stdout!.readFrom(0)
      const stderr = handle.collected.stderr!.readFrom(0)
      await this.retainSpills(stdout, stderr)
      return { exitCode: outcome.exitCode, cancelled: deadline.aborted, truncated: stdout.lossy || stderr.lossy, settled }
    })()
    // Job state is read through its caller's own await; an unobserved rejection must not crash the Host.
    void this.done.catch(() => {})
  }

  read() {
    const read = (reader: { readFrom(offset: number): { text: string; lossy: boolean } }) => {
      const delta = reader.readFrom(0)
      return { text: delta.lossy ? '' : this.sanitize(delta.text), lossy: delta.lossy }
    }
    return { stdout: read(this.handle.collected.stdout!), stderr: read(this.handle.collected.stderr!) }
  }

  terminate() { this.handle.terminate() }

  waitForExit(signal?: AbortSignal) { return this.handle.waitForExit(signal) }

  private async retainSpills(stdout: { spillPath?: string }, stderr: { spillPath?: string }) {
    if (stdout.spillPath) await this.retain(this.jobId, 'stdout', stdout.spillPath).catch(() => {})
    if (stderr.spillPath) await this.retain(this.jobId, 'stderr', stderr.spillPath).catch(() => {})
  }
}

class BoundLocalTerminalJob implements LocalJob {
  readonly done: Promise<LocalJobResult>
  private text = ''
  private lossy = false
  private spillLost = false
  private cancelled = false
  private termination: Promise<boolean> | undefined

  constructor(private readonly handle: SubprocessTerminalHandle, deadline: AbortSignal,
    private readonly sanitize: (text: string) => string, readonly jobId: string,
    private readonly retain: (id: string, data: Uint8Array) => Promise<void>) {
    const chunks: Buffer[] = []
    let bytes = 0
    const output = (async () => {
      for await (const chunk of handle.output) {
        const buffer = Buffer.from(chunk)
        const piece = buffer.toString('utf8')
        if (Buffer.byteLength(this.text) + Buffer.byteLength(piece) > 8192) this.lossy = true
        else this.text += piece
        bytes += buffer.length
        if (bytes > maxSpillBytes) this.spillLost = true
        else chunks.push(buffer)
      }
    })()
    deadline.addEventListener('abort', () => this.terminate(), { once: true })
    this.done = (async () => {
      let exitCode: number | null = null
      try { exitCode = (await handle.done).exitCode }
      catch { this.lossy = true }
      await output.catch(() => { this.lossy = true; this.spillLost = true })
      const settled = await this.quiet()
      if (!this.spillLost && bytes) await this.retain(jobId, Buffer.concat(chunks)).catch(() => { this.spillLost = true })
      return { exitCode, cancelled: this.cancelled || deadline.aborted, truncated: this.lossy, settled,
        ...(exitCode === null || !settled ? { outcome: 'unknown' as const, reason: 'The terminal exit could not be confirmed.' } : {}) }
    })()
    void this.done.catch(() => {})
  }

  private quiet() {
    return this.termination ??= this.handle.terminate().then(() => {
      this.handle.output.destroy()
      return true
    }, () => false)
  }

  read() { return { stdout: { text: this.lossy ? '' : this.sanitize(this.text), lossy: this.lossy }, stderr: { text: '', lossy: false } } }
  terminate() { this.cancelled = true; void this.quiet() }
  async waitForExit(signal?: AbortSignal) {
    const result = this.termination ?? this.done.then(outcome => outcome.settled, () => false)
    if (!signal) return result
    if (signal.aborted) return false
    return Promise.race([result, new Promise<false>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))])
  }
}

interface BoundPathGrant {
  path: string
  operations: readonly PathGrantOperation[]
  target: FsTarget
  kind: 'file' | 'directory'
}

async function assertNoSymbolicLinks(fs: Context['fs'], path: string, signal?: AbortSignal) {
  const root = parse(path).root
  let prefix = root
  for (const part of path.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    prefix = resolve(prefix, part)
    const observed = await fs.lstat(prefix, {}, signal).catch(() => undefined)
    if (observed?.type === 'symlink') {
      throw new CoreError('PATH_DENIED', 'Task path grants and the paths they contain must not use symbolic links or junctions.')
    }
  }
}

function overlaps(left: string, right: string) {
  const caseFold = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  const relativePath = relative(caseFold(resolve(left)), caseFold(resolve(right)))
  return relativePath === '' || relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function samePath(left: string, right: string) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function protectedGrantRoots(config: LocalEnvironmentConfig): string[] {
  const configured = process.env.DS_SUPERAGENT_PROTECTED_PATHS
  let desktop: string[] = []
  if (configured !== undefined) {
    try {
      const parsed: unknown = JSON.parse(configured)
      if (Array.isArray(parsed) && parsed.length <= 16 && parsed.every(path => typeof path === 'string' && isAbsolute(path))) {
        desktop = parsed
      } else {
        throw new Error('invalid shape')
      }
    } catch {
      throw new CoreError('INVALID_CONFIG', 'The desktop protected directory list is invalid.')
    }
  }
  return [
    config.assetsPath,
    config.skillsPath,
    process.env.DSH_HOME,
    process.env.DS_SUPERAGENT_USER_DSH_HOME,
    resolve(homedir(), '.dsh'),
    resolve(homedir(), '.ds-bot'),
    ...desktop,
  ].filter((path): path is string => Boolean(path))
}

export class LocalEnvironment implements ExecutionEnvironment {
  readonly kind = 'local' as const
  readonly config: Readonly<LocalEnvironmentConfig>
  private closed = false
  private rootIdentity: string | undefined
  private assets: FileAssetStore | undefined
  private constructor(private readonly context: Context, config: LocalEnvironmentConfig) {
    this.config = structuredClone(config)
    Object.freeze(this.config.allowedActorIds)
    Object.freeze(this.config.permissions)
    for (const command of Object.values(this.config.commands)) { Object.freeze(command.argv); Object.freeze(command) }
    Object.freeze(this.config.commands)
    Object.freeze(this.config)
  }

  static async open(config: LocalEnvironmentConfig): Promise<LocalEnvironment> {
    config = structuredClone(config)
    identifier(config.id, 'environmentId')
    identifier(config.instanceId, 'instanceId')
    if (!isAbsolute(config.root) || !Array.isArray(config.allowedActorIds) || !Array.isArray(config.permissions) || config.permissions.some(permission => !['read', 'write', 'search', 'command'].includes(permission))) throw new CoreError('INVALID_CONFIG', 'A local environment needs an absolute directory, explicit actors and supported permissions.')
    for (const actor of config.allowedActorIds) identifier(actor, 'allowedActorId')
    if (!config.commands || typeof config.commands !== 'object' || Object.keys(config.commands).length > 16) throw new CoreError('INVALID_CONFIG', 'Configure at most sixteen named commands.')
    if (config.allowShell !== undefined && (typeof config.allowShell !== 'boolean' || config.allowShell && !config.permissions.includes('command'))) {
      throw new CoreError('INVALID_CONFIG', 'The local shell requires explicit command permission.')
    }
    for (const [name, command] of Object.entries(config.commands)) {
      identifier(name, 'command name')
      if (!Array.isArray(command.argv) || !command.argv[0] || command.argv.length > 64 || command.argv.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16384) || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 50 || command.timeoutMs > 10000) throw new CoreError('INVALID_CONFIG', 'Commands need bounded fixed argv and a 50–10000 ms deadline.')
      if (command.backgroundTimeoutMs !== undefined && (!Number.isInteger(command.backgroundTimeoutMs) || command.backgroundTimeoutMs < command.timeoutMs || command.backgroundTimeoutMs > 3600000)) throw new CoreError('INVALID_CONFIG', 'A background command deadline must be an integer between its foreground deadline and one hour.')
    }
    if (config.setup && (!Object.hasOwn(config.commands, config.setup) || !config.permissions.includes('command'))) throw new CoreError('INVALID_CONFIG', 'The setup command and command permission must be configured explicitly.')
    if (config.assetsPath !== undefined) {
      if (typeof config.assetsPath !== 'string' || !isAbsolute(config.assetsPath)) throw new CoreError('INVALID_CONFIG', 'A local asset store needs an absolute directory.')
      const inside = relative(config.root, config.assetsPath)
      if (!inside.startsWith('..') && !isAbsolute(inside)) throw new CoreError('INVALID_CONFIG', 'The local asset store must live outside the exposed working directory.')
    }
    if (config.skillsPath !== undefined && (typeof config.skillsPath !== 'string' || !isAbsolute(config.skillsPath))) {
      throw new CoreError('INVALID_CONFIG', 'A local skill root needs an absolute directory.')
    }
    const context = new Context()
    try {
      await context.plugin(LocalFileSystem, { cwd: config.root })
      await context.plugin(LocalSubprocessRuntime)
      if (config.skillsPath) {
        await mkdir(config.skillsPath, { recursive: true, mode: 0o700 })
        await context.plugin(SkillRegistry)
        context.skills.registerProvider(control => new FileSystemSkillProvider(context, control,
          { includeDefaultRoots: false, customSkillDirs: [config.skillsPath!], watch: false }))
      }
      const environment = new LocalEnvironment(context, config)
      if (config.assetsPath) environment.assets = await FileAssetStore.open(config.assetsPath, assetNamespace(config.instanceId, config.id))
      return environment
    } catch { await context.fiber.dispose(); throw new CoreError('LOCAL_PROVIDER_UNAVAILABLE', 'The public local DSH providers could not be mounted.') }
  }

  authorize(identity: { instanceId: string; actorId: string }) {
    if (this.closed) throw new CoreError('ENVIRONMENT_CLOSED', 'The local environment is closed.')
    if (identity.instanceId !== this.config.instanceId || !this.config.allowedActorIds.includes(identity.actorId)) throw new CoreError('ENVIRONMENT_DENIED', 'This actor or instance cannot use the local environment.')
  }

  async verifyRoot(signal?: AbortSignal) {
    let prefix = parse(this.config.root).root
    for (const part of this.config.root.slice(prefix.length).split(/[\\/]/u).filter(Boolean)) {
      prefix = resolve(prefix, part)
      if ((await this.context.fs.lstat(prefix, {}, signal))?.type === 'symlink') throw new CoreError('SETUP_FAILED', 'The working directory and its ancestors must not be symbolic links or junctions.')
    }
    // FsVersion is an opaque freshness token; directory writes change it too.
    const observed = await stat(this.config.root, { bigint: true })
    if (!observed.isDirectory() || observed.ino === 0n) throw new CoreError('SETUP_FAILED', 'A stable local working directory identity is required.')
    const identity = `${observed.dev}:${observed.ino}:${observed.birthtimeNs}`
    if (this.rootIdentity !== undefined && this.rootIdentity !== identity) throw new CoreError('ENVIRONMENT_CHANGED', 'The physical working directory changed; configure a new Environment instead of retrying this binding.')
    this.rootIdentity = identity
  }

  async prepare(identity: { instanceId: string; actorId: string }, signal?: AbortSignal,
    options?: EnvironmentPrepareOptions): Promise<BoundLocalEnvironment> {
    signal?.throwIfAborted()
    this.authorize(identity)
    try {
      const fs = this.context.fs
      await this.verifyRoot()
      const root = await fs.resolve(this.config.root)
      if ((await fs.stat(root))?.type !== 'directory' || (await fs.lstat(this.config.root))?.type === 'symlink') throw new CoreError('SETUP_FAILED', 'The configured working directory must exist and be a real directory.')
      const pathGrants = await this.bindPathGrants(options?.pathGrants, signal)
      const bound = new BoundLocalEnvironment(this, this.context, root, { ...identity }, pathGrants)
      for (const command of Object.values(this.config.commands)) await this.context.subprocess.resolveExecutable(command.argv[0]!)
      if (this.config.setup) {
        const result = await bound.command(this.config.setup, signal)
        if (result.exitCode !== 0 || result.cancelled || result.truncated) throw new LocalSetupError(result)
      }
      return bound
    } catch (error) {
      if (error instanceof LocalSetupError || error instanceof CoreError) throw error
      throw new CoreError('SETUP_FAILED', 'The directory or executable checks failed in this local environment.')
    }
  }

  private async bindPathGrants(grants: readonly PathGrant[] | undefined, signal?: AbortSignal): Promise<BoundPathGrant[]> {
    const normalized = normalizePathGrants(grants)
    if (!normalized) return []
    const fs = this.context.fs
    const protectedRoots = await Promise.all(protectedGrantRoots(this.config).map(async root => {
      try { return fs.processPath(await fs.resolve(root)) } catch { return resolve(root) }
    }))
    const bound: BoundPathGrant[] = []
    for (const grant of normalized) {
      signal?.throwIfAborted()
      const path = resolve(grant.path)
      await assertNoSymbolicLinks(fs, path, signal)
      const target = await fs.resolve(path, signal ? { signal } : {})
      const actual = fs.processPath(target)
      if (protectedRoots.some(root => overlaps(actual, root))) {
        throw new CoreError('PATH_DENIED', 'A task path grant cannot include protected personal or product data.')
      }
      const observed = await fs.stat(target, signal)
      if (observed?.type !== 'file' && observed?.type !== 'directory') {
        throw new CoreError('PATH_DENIED', 'A task path grant must name an existing file or directory.')
      }
      bound.push({ path: actual, operations: [...grant.operations], target, kind: observed.type })
    }
    return bound
  }

  async probe(identity: { instanceId: string; actorId: string }, signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.authorize(identity)
    try {
      await this.verifyRoot()
      const observed = await stat(this.config.root, { bigint: true })
      const fingerprint = `${observed.dev}:${observed.ino}:${observed.birthtimeNs}`
      return { online: true, root: this.config.root, version: 'local-v1', fingerprint,
        capabilities: [...this.config.permissions], capacity: 'available' as const,
        productCapabilities: { office: Boolean(this.config.skillsPath) && this.config.permissions.includes('command')
          && Object.hasOwn(this.config.commands, 'office') } }
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('SETUP_FAILED', 'The local Host working directory could not be inspected.')
    }
  }

  async assetCapabilities(identity: { instanceId: string; actorId: string }): Promise<EnvironmentAssetCapabilities> {
    this.authorize(identity)
    if (!this.assets) {
      const capabilities = unsupportedAssetCapabilities([environmentAssetGaps.localStore], [environmentAssetGaps.localSkillStore])
      if (this.context.skills && this.config.skillsPath) capabilities.skills = { supported: true, gaps: [] }
      return capabilities
    }
    return {
      attachments: { supported: true, maxBytes: maxAssetBytes, gaps: [environmentAssetGaps.imageAdmission] },
      spill: { supported: true, maxBytes: maxSpillBytes, gaps: [] },
      skills: this.context.skills && this.config.skillsPath
        ? { supported: true, gaps: [] }
        : { supported: false, gaps: [environmentAssetGaps.localSkillStore] },
    }
  }

  async close() { this.closed = true; await this.context.fiber.dispose() }

  get fingerprint() { return this.rootIdentity ?? 'unknown' }
  get store() { return this.assets }
  get assetSupport() {
    return { attachments: Boolean(this.assets), spill: Boolean(this.assets),
      skills: Boolean(this.context.skills && this.config.skillsPath) }
  }
}

export class LocalSetupError extends CoreError {
  constructor(readonly output: Record<string, unknown>) { super('SETUP_FAILED', 'The configured directory setup command failed; inspect its bounded output and retry explicitly.') }
}

export class BoundLocalEnvironment implements PreparedEnvironment {
  readonly cwd: string
  readonly pathGrants: readonly PathGrant[]
  constructor(private readonly owner: LocalEnvironment, private readonly context: Context, private readonly root: FsTarget,
    private readonly identity: { instanceId: string; actorId: string }, private readonly pathGrantRoots: readonly BoundPathGrant[]) {
    this.cwd = context.fs.processPath(root)
    this.pathGrants = pathGrantRoots.map(grant => ({ path: grant.path, operations: [...grant.operations] }))
    Object.freeze(this.pathGrants)
  }

  private environmentIdentity() {
    return { id: this.owner.config.id, kind: this.owner.kind, fingerprint: environmentFingerprint('local', { local: this.owner.fingerprint }) }
  }

  private assetReference(kind: 'attachment' | 'artifact' | 'spill', input: { id: string; name?: string; path?: string; bytes: number; sha256: string; mediaType?: string }): EnvironmentAssetReference {
    return { kind, environmentId: this.owner.config.id, environmentKind: this.owner.kind,
      environmentFingerprint: this.environmentIdentity().fingerprint, ...input }
  }

  async assetCapabilities(): Promise<EnvironmentAssetCapabilities> {
    return this.owner.assetCapabilities(this.identity)
  }

  private store() {
    const store = this.owner.store
    if (!store) throw new UnsupportedEnvironmentCombination('This local Environment has no deployment-owned asset store.',
      [environmentAssetGaps.localStore])
    return store
  }

  async saveAttachment(input: { name: string; data: Uint8Array; mediaType?: string }): Promise<EnvironmentAssetReference> {
    this.permission('write')
    const saved = await this.store().save(input)
    return this.assetReference('attachment', saved)
  }

  async saveProductAttachment(input: { name: string; data: Uint8Array; mediaType?: string }): Promise<EnvironmentAssetReference> {
    this.permission('write')
    const saved = await this.store().save(input, maxProductAttachmentBytes)
    return this.assetReference('attachment', saved)
  }

  async readAsset(reference: EnvironmentAssetReference, options: { offset?: number; maxBytes?: number } = {}): Promise<EnvironmentAssetPage> {
    return this.readAssetPage(reference, options, true)
  }

  async readProductAsset(reference: EnvironmentAssetReference, options: { offset?: number; maxBytes?: number } = {}): Promise<EnvironmentAssetPage> {
    if (reference.kind !== 'attachment' && reference.kind !== 'artifact') {
      throw new CoreError('INVALID_INPUT', 'A product download needs an attachment or recorded artifact.')
    }
    return this.readAssetPage(reference, options, false)
  }

  private async readAssetPage(reference: EnvironmentAssetReference, options: { offset?: number; maxBytes?: number }, redact: boolean): Promise<EnvironmentAssetPage> {
    this.permission('read')
    if (!matchesEnvironment(reference, this.environmentIdentity())) {
      throw new CoreError('REFERENCE_STALE', 'The reference belongs to a different execution world; read it only through that Environment\'s original identity.')
    }
    const offset = options.offset ?? 0
    const maxBytes = options.maxBytes ?? defaultAssetPageBytes
    if (reference.kind === 'skill') {
      return this.readSkillReference(reference, { offset, maxBytes })
    }
    if (reference.kind === 'attachment') {
      const read = await this.store().read(reference.id, offset, maxBytes)
      const full = await this.store().stat(reference.id)
      if (!full || full.bytes !== reference.bytes || full.sha256 !== reference.sha256) {
        throw new CoreError('REFERENCE_STALE', 'The attachment reference no longer matches the stored object.')
      }
      return pageOf(reference, read.data, offset, maxBytes, redact ? text => this.sanitize(text) : undefined)
    }
    if (reference.kind === 'spill') {
      const { jobId, stream } = parseSpillAssetId(reference.id)
      const read = await this.store().readSpill(jobId, stream, offset, maxBytes, reference)
      return pageOf(reference, read.data, offset, maxBytes, text => this.sanitize(text))
    }
    if (!reference.path) throw new CoreError('INVALID_INPUT', 'An artifact reference needs its working-directory-relative path.')
    const target = await this.target(reference.path, undefined, 'read')
    const prefix = await this.context.fs.readByteRange(target, { offset: 0, length: reference.bytes }, undefined)
    if (prefix.length !== reference.bytes || createHash('sha256').update(prefix).digest('hex') !== reference.sha256) {
      throw new CoreError('REFERENCE_STALE', 'The artifact no longer matches the referenced bytes.')
    }
    if (offset > reference.bytes) throw new CoreError('INVALID_INPUT', 'Asset offsets must address bytes already observed.')
    const window = await this.context.fs.readByteRange(target, { offset, length: Math.min(maxBytes, reference.bytes - offset) }, undefined)
    return pageOf(reference, window, offset, maxBytes, redact ? text => this.sanitize(text) : undefined)
  }

  async listSkills(): Promise<EnvironmentSkillSummary[]> {
    this.permission('read')
    if (!this.context.skills) {
      throw new UnsupportedEnvironmentCombination('This local Environment mounted no public skill provider.',
        [environmentAssetGaps.localSkillStore])
    }
    const summaries = await this.context.skills.list({ cwd: this.cwd })
    return summaries.slice(0, 100).map(summary => ({ name: summary.name, description: summary.description,
      ...(summary.path ? { path: summary.path } : {}), source: summary.source, provider: summary.provider,
      modelInvocable: summary.invocation.modelInvocable }))
  }

  private async readSkillReference(reference: EnvironmentAssetReference, options: { offset: number; maxBytes: number }): Promise<EnvironmentAssetPage> {
    if (!this.context.skills) {
      throw new UnsupportedEnvironmentCombination('This local Environment mounted no public skill provider.',
        [environmentAssetGaps.localSkillStore])
    }
    const name = reference.id.startsWith('skill:') ? reference.id.slice(6) : ''
    if (!isSkillName(name)) throw new CoreError('INVALID_INPUT', 'A skill reference needs its kebab-case name.')
    const skill = await this.context.skills.get(name, { cwd: this.cwd })
    if (!skill) throw new CoreError('NOT_FOUND', 'The skill is no longer available in this execution world.')
    const content = Buffer.from(skill.content, 'utf8')
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (reference.bytes > 0 && (reference.bytes !== content.length || reference.sha256 !== sha256)) {
      throw new CoreError('REFERENCE_STALE', 'The skill body no longer matches its reference.')
    }
    if (options.offset > content.length) throw new CoreError('INVALID_INPUT', 'Asset offsets must address bytes already observed.')
    const enriched: EnvironmentAssetReference = { ...reference, name, bytes: content.length, sha256,
      ...(skill.path ? { path: skill.path } : {}) }
    return pageOf(enriched, content.subarray(options.offset), options.offset, options.maxBytes, text => this.sanitize(text))
  }

  async spillReference(jobId: string, stream: SpillStream): Promise<EnvironmentAssetReference> {
    this.permission('command')
    const info = await this.store().spillInfo(jobId, stream)
    if (!info) throw new UnsupportedEnvironmentCombination('This command retained no complete ' + stream + ' stream within the spill budget.',
      [environmentAssetGaps.spillUnavailable])
    return this.assetReference('spill', { id: spillAssetId(jobId, stream), bytes: info.bytes, sha256: info.sha256 })
  }

  private async target(path: string, signal: AbortSignal | undefined, operation: LocalPermission) {
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 1024 || path.includes('\0')) {
      throw new CoreError('PATH_DENIED', 'Use a non-sensitive path inside the bound working directory or an explicitly granted absolute path.')
    }
    const absolute = isAbsolute(path)
    if (path.split(/[\\/]/u).includes('..') || protectedPath(path) || !absolute && path.includes(':')) {
      throw new CoreError('PATH_DENIED', 'Use a non-sensitive path inside the bound working directory or an explicitly granted absolute path.')
    }
    const fs = this.context.fs
    await this.owner.verifyRoot(signal)
    const currentRoot = await fs.resolve(this.owner.config.root, signal ? { signal } : {})
    if (!fs.contains(this.root, currentRoot) || !fs.contains(currentRoot, this.root)) throw new CoreError('ENVIRONMENT_CHANGED', 'The working directory identity changed; setup must be checked again.')
    await assertNoSymbolicLinks(fs, absolute ? path : resolve(this.cwd, path), signal)
    const target = absolute ? await fs.resolve(path, signal ? { signal } : {})
      : await fs.resolve(path, { cwd: this.cwd, ...(signal ? { signal } : {}) })
    const actual = fs.processPath(target)
    if (fs.contains(this.root, target)) {
      if (protectedPath(relative(this.cwd, actual))) throw new CoreError('PATH_DENIED', 'The path resolves to protected working-directory data.')
      await assertNoSymbolicLinks(fs, actual, signal)
      return target
    }
    if (!absolute) throw new CoreError('PATH_DENIED', 'The path resolves outside the authorized working directory and task path grants.')
    const grant = this.pathGrantRoots.find(candidate => candidate.kind === 'file'
      ? samePath(candidate.path, actual) : fs.contains(candidate.target, target))
    if (!grant) throw new CoreError('PATH_DENIED', 'The absolute path is outside the task path grants for this Ticket.')
    if (!grant.operations.includes(operation)) {
      throw new CoreError('PERMISSION_DENIED', `The task path grant does not include ${operation} access.`)
    }
    await assertNoSymbolicLinks(fs, actual, signal)
    if (protectedPath(relative(grant.path, actual))) throw new CoreError('PATH_DENIED', 'The path resolves to protected granted-directory data.')
    return target
  }

  private permission(name: LocalPermission) {
    this.owner.authorize(this.identity)
    if (!this.owner.config.permissions.includes(name)) throw new CoreError('PERMISSION_DENIED', 'This local capability was not enabled by the deployment.')
  }

  sanitize(text: string) {
    let safe = sanitizeSecrets(text)
    for (const root of new Set([this.cwd, this.owner.config.root, resolve(this.owner.config.root),
      ...this.pathGrantRoots.map(grant => grant.path)].filter(Boolean))) {
      safe = safe.split(root).join('<workdir>')
    }
    return safe
  }

  async inspectWorkCopy(signal?: AbortSignal) {
    this.permission('read')
    signal?.throwIfAborted()
    return inspectWorkCopy(this.cwd)
  }

  async artifact(path: string, signal?: AbortSignal): Promise<Artifact> {
    this.permission('read')
    const target = await this.target(path, signal, 'read')
    const bytes = await this.context.fs.readBytes(target, signal, maxProductAttachmentBytes)
    const processPath = this.context.fs.processPath(target)
    const relativePath = relative(this.cwd, processPath)
    const artifactPath = relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
      ? relativePath.split(sep).join('/') : processPath
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { path: artifactPath, bytes: bytes.length, sha256,
      reference: this.assetReference('artifact', { id: fileAssetId(sha256), path: artifactPath, bytes: bytes.length, sha256 }) }
  }

  async stageAttachment(reference: EnvironmentAssetReference, path: string, signal?: AbortSignal) {
    this.permission('read'); this.permission('write')
    if (reference.kind !== 'attachment' || !matchesEnvironment(reference, this.environmentIdentity())
      || reference.bytes > maxProductAttachmentBytes) throw new CoreError('REFERENCE_STALE', 'The attachment belongs to another execution world.')
    if (!reference.name?.toLowerCase().endsWith('.docx') || !path?.toLowerCase().endsWith('.docx')) {
      throw new CoreError('INVALID_INPUT', 'Stage a Word document at a new .docx path.')
    }
    const target = await this.target(path, signal, 'write')
    const read = await this.store().read(reference.id, 0, reference.bytes)
    if (read.bytes !== reference.bytes || read.sha256 !== reference.sha256 || read.data.length !== reference.bytes) {
      throw new CoreError('REFERENCE_STALE', 'The original attachment bytes changed.')
    }
    signal?.throwIfAborted()
    const handle = await open(this.context.fs.processPath(target), 'wx')
    try { await handle.writeFile(read.data) } finally { await handle.close() }
    return { path, bytes: reference.bytes, sha256: reference.sha256 }
  }

  async runOffice(args: Record<string, string>, signal?: AbortSignal) {
    this.permission('read'); this.permission('command')
    const configured = this.owner.config.commands.office
    if (!configured || !this.owner.config.skillsPath) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Office is unavailable in this Environment.')
    if (Object.keys(args).some(key => !['operation', 'input', 'output', 'ops'].includes(key))) throw new CoreError('INVALID_INPUT', 'Office accepts an operation, input, output and edit operations only.')
    const operation = args.operation
    if (!operation || !['check', 'docx-read', 'docx-edit'].includes(operation) || !args.input?.toLowerCase().endsWith('.docx')) {
      throw new CoreError('INVALID_INPUT', 'Choose check, docx-read or docx-edit with a .docx path.')
    }
    const inputTarget = await this.target(args.input, signal, 'read')
    const input = this.context.fs.processPath(inputTarget)
    if ((await this.context.fs.stat(inputTarget, signal))?.type !== 'file') throw new CoreError('NOT_FOUND', 'The Office input file is unavailable.')
    if (operation !== 'docx-edit' && (args.output !== undefined || args.ops !== undefined)) throw new CoreError('INVALID_INPUT', 'This Office operation is read-only.')
    let argv: string[]
    if (operation === 'docx-edit') {
      if (!args.output?.toLowerCase().endsWith('.docx') || !args.ops || Buffer.byteLength(args.ops) > 16384) throw new CoreError('INVALID_INPUT', 'A Word edit needs a new .docx path and bounded operations.')
      let operations: unknown
      try { operations = JSON.parse(args.ops) } catch { throw new CoreError('INVALID_INPUT', 'Word edit operations must be JSON.') }
      if (!Array.isArray(operations) || !operations.length || operations.length > 20) throw new CoreError('INVALID_INPUT', 'Provide one to twenty Word edit operations.')
      this.permission('write')
      const target = await this.target(args.output!, signal, 'write')
      const output = this.context.fs.processPath(target)
      if (output === input || await this.context.fs.stat(target, signal)) throw new CoreError('PATH_DENIED', 'Write a new Office file inside this work directory.')
      argv = ['docx', 'edit', input, '-o', output, '--ops', args.ops]
    } else argv = operation === 'check' ? ['check', input] : ['docx', 'read', input]
    const result = await this.runArgv([...configured.argv, ...argv, '--json'], configured.timeoutMs, signal)
    if (result.cancelled || result.truncated || result.exitCode === null) throw new CoreError('COMMAND_UNKNOWN', 'Office completion could not be confirmed; inspect the original file before any retry.')
    if (result.exitCode !== 0) throw new CoreError('OFFICE_CHECK_FAILED', 'Office reported an error or package findings; inspect the original command result.')
    return { operation, input: args.input, ...(args.output ? { output: args.output } : {}), ...result }
  }

  private async commandWorkdir(path: string | undefined, signal?: AbortSignal) {
    const target = await this.target(path ?? '.', signal, 'command')
    if ((await this.context.fs.stat(target, signal))?.type !== 'directory') {
      throw new CoreError('PATH_DENIED', 'A command working directory must be an existing authorized directory.')
    }
    return this.context.fs.processPath(target)
  }

  async command(name: string, signal?: AbortSignal, path?: string) {
    this.permission('command')
    const configured = Object.hasOwn(this.owner.config.commands, name) ? this.owner.config.commands[name] : undefined
    if (!configured) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Only configured command names can run; arbitrary argv, Shell, PTY and remote tools are not enabled.')
    return this.runArgv(configured.argv, configured.timeoutMs, signal, path)
  }

  private async shellArgv(command: string, signal?: AbortSignal) {
    this.permission('command')
    if (!this.owner.config.allowShell) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Shell commands are not enabled in this Environment.')
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 4096 || command.includes('\0')) {
      throw new CoreError('INVALID_INPUT', 'Use one nonempty shell command of at most 4096 bytes.')
    }
    const terminal = await this.context.subprocess.terminalEnvironment(signal)
    const shell = terminal.platform === 'windows' ? 'powershell.exe' : 'sh'
    const executable = await this.context.subprocess.resolveExecutable(shell, {}, signal)
    return terminal.platform === 'windows'
      ? [executable, '-NoProfile', '-NonInteractive', '-Command', command]
      : [executable, '-c', command]
  }

  async runShell(command: string, signal?: AbortSignal, path?: string) {
    return this.runArgv(await this.shellArgv(command, signal), 10000, signal, path)
  }

  private async runArgv(argv: readonly string[], timeoutMs: number, signal?: AbortSignal, path?: string) {
    const cwd = await this.commandWorkdir(path, signal)
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    const executable = await this.context.subprocess.resolveExecutable(argv[0]!, {}, combined)
    const collect = this.owner.store ? { maxBytes: 8192, spill: { maxBytes: maxSpillBytes } } : { maxBytes: 8192 }
    const handle = this.context.subprocess.spawn({ argv: [executable, ...argv.slice(1)], cwd, stdio: { stdin: 'ignore', stdout: collect, stderr: collect }, graceMs: 250, signal: combined })
    const operationKey = randomUUID()
    try {
      const outcome = await handle.done
      const settled = await handle.waitForExit(AbortSignal.timeout(2000))
      if (!settled) throw new CoreError('COMMAND_UNKNOWN', 'The local process range did not confirm exit; no retry is authorized.')
      const stdout = handle.collected.stdout!.readFrom(0)
      const stderr = handle.collected.stderr!.readFrom(0)
      const spills = await this.retainSpills(operationKey, stdout, stderr)
      return { exitCode: outcome.exitCode, cancelled: combined.aborted, stdout: stdout.lossy ? '[Truncated output withheld to protect credentials.]' : this.sanitize(stdout.text), stderr: stderr.lossy ? '[Truncated output withheld to protect credentials.]' : this.sanitize(stderr.text), truncated: stdout.lossy || stderr.lossy,
        ...(spills ? { spills } : {}) }
    } catch (error) {
      handle.terminate()
      await handle.waitForExit(AbortSignal.timeout(2000)).catch(() => false)
      if (error instanceof CoreError) throw error
      throw new CoreError('COMMAND_FAILED', 'The local command could not complete; provider diagnostics are withheld to protect credentials.')
    }
  }

  /**
   * Starts one configured command as a background job. The job's own declared deadline bounds it;
   * the caller's own cancellation is deliberately not attached, because background work has to outlive
   * the turn that started it and is stopped through the durable job record instead.
   */
  async startCommand(name: string, jobId = randomUUID(), path?: string): Promise<LocalJob> {
    this.permission('command')
    const configured = Object.hasOwn(this.owner.config.commands, name) ? this.owner.config.commands[name] : undefined
    if (!configured) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Only configured command names can run; arbitrary argv, Shell, PTY and remote tools are not enabled.')
    if (name === this.owner.config.setup) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Setup is controlled by preparation and explicit retry, not model tools.')
    return this.startArgv(configured.argv, configured.backgroundTimeoutMs ?? configured.timeoutMs, jobId, path)
  }

  async startShell(command: string, jobId = randomUUID(), path?: string): Promise<LocalJob> {
    return this.startArgv(await this.shellArgv(command), 3600000, jobId, path)
  }

  async startTerminal(command: string, jobId = randomUUID(), path?: string): Promise<LocalJob> {
    const argv = await this.shellArgv(command)
    const cwd = await this.commandWorkdir(path)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3600000)
    timer.unref()
    try {
      const handle = await this.context.subprocess.spawnTerminal({ argv, cwd, rows: 24, cols: 100,
        terminalType: 'xterm-256color', graceMs: 250, signal: controller.signal })
      const job = new BoundLocalTerminalJob(handle, controller.signal, text => this.sanitize(text), jobId,
        (id, data) => this.owner.store?.storeSpillBytes(id, 'stdout', data).then(() => undefined) ?? Promise.resolve())
      void job.done.finally(() => clearTimeout(timer)).catch(() => {})
      return job
    } catch (error) { clearTimeout(timer); throw error }
  }

  private async startArgv(argv: readonly string[], timeoutMs: number, jobId: string, path?: string): Promise<LocalJob> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref()
    try {
      const cwd = await this.commandWorkdir(path, controller.signal)
      const executable = await this.context.subprocess.resolveExecutable(argv[0]!, {}, controller.signal)
      const collect = this.owner.store ? { maxBytes: 8192, spill: { maxBytes: maxSpillBytes } } : { maxBytes: 8192 }
      const handle = this.context.subprocess.spawn({ argv: [executable, ...argv.slice(1)], cwd,
        stdio: { stdin: 'ignore', stdout: collect, stderr: collect }, graceMs: 250, signal: controller.signal })
      const job = new BoundLocalJob(handle, controller.signal, text => this.sanitize(text), jobId,
        (key, stream, path) => this.retainStream(key, stream, path))
      void job.done.finally(() => clearTimeout(timer)).catch(() => {})
      return job
    } catch (error) { clearTimeout(timer); throw error }
  }

  private async retainSpills(key: string, stdout: { spillPath?: string }, stderr: { spillPath?: string }) {
    const spills: Partial<Record<SpillStream, EnvironmentAssetReference>> = {}
    for (const stream of ['stdout', 'stderr'] as const) {
      const path = (stream === 'stdout' ? stdout : stderr).spillPath
      if (!path) continue
      try {
        await this.retainStream(key, stream, path)
        const info = await this.owner.store?.spillInfo(key, stream)
        if (info) spills[stream] = this.assetReference('spill', { id: spillAssetId(key, stream), bytes: info.bytes, sha256: info.sha256 })
      } catch { /* Spill retention is best effort; the bounded output and its lossy fact stay authoritative. */ }
    }
    return Object.keys(spills).length ? spills : undefined
  }

  private async retainStream(key: string, stream: SpillStream, sourcePath?: string) {
    const store = this.owner.store
    if (!store || !sourcePath) return
    await store.storeSpill(key, stream, sourcePath)
  }

  async invoke(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try { return await this.execute(name, args, signal) }
    catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('LOCAL_TOOL_FAILED', 'The bound local operation failed; provider diagnostics are withheld to protect credentials.')
    }
  }

  private async execute(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted()
    if (name === 'run_office') return this.runOffice(args, signal)
    if (name === 'save_attachment') return this.saveAttachmentTool(args)
    if (name === 'read_asset') return this.readAssetTool(args)
    if (name === 'list_skills') return { skills: await this.listSkills() }
    if (name === 'run_shell') return this.runShell(args.command!, signal, args.path)
    if (name === 'run_command') {
      if (args.name === this.owner.config.setup) throw new CoreError('UNSUPPORTED_CAPABILITY', 'Setup is controlled by preparation and explicit retry, not model tools.')
      return this.command(args.name!, signal, args.path)
    }
    if (name === 'read_file') {
      this.permission('read')
      const target = await this.target(args.path!, signal, 'read')
      const bytes = await this.context.fs.readBytes(target, signal, 65536)
      return { text: this.sanitize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    }
    if (name === 'write_file') {
      this.permission('write')
      if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 65536) throw new CoreError('INVALID_INPUT', 'File writes are limited to 65536 UTF-8 bytes.')
      const target = await this.target(args.path!, signal, 'write')
      const observed = await this.context.fs.stat(target, signal)
      await this.context.fs.writeText(target, args.text, observed ? { kind: 'replaceIfVersion', version: observed.version } : { kind: 'createIfAbsent' }, signal)
      return { path: args.path!, bytes: Buffer.byteLength(args.text) }
    }
    if (name !== 'glob' && name !== 'grep') throw new CoreError('UNSUPPORTED_CAPABILITY', 'This local tool combination is not enabled.')
    this.permission('search')
    const pattern = args.pattern
    if (!pattern || pattern.length > 256) throw new CoreError('INVALID_INPUT', 'Search needs a bounded nonempty pattern.')
    const external = isAbsolute(args.path?.trim() || '.')
    const base = args.path?.trim() || '.'
    const baseTarget = await this.target(base, signal, 'search')
    const baseStat = await this.context.fs.stat(baseTarget, signal)
    if (baseStat?.type !== 'file' && baseStat?.type !== 'directory') throw new CoreError('NOT_FOUND', 'The search path is unavailable.')
    const baseProcess = this.context.fs.processPath(baseTarget)
    const paths: string[] = []
    const matches: { path: string; line: number; text: string }[] = []
    const pending = baseStat.type === 'directory' ? [base] : []
    let visited = 0
    let bytesRead = 0
    const inspect = async (path: string, target: FsTarget, type: 'file' | 'directory' | 'other', requestedName?: string) => {
      if (++visited > 500) throw new CoreError('SEARCH_LIMIT', 'The bounded search exceeded 500 entries.')
      if (type === 'directory') {
        pending.push(path)
        return
      }
      if (type !== 'file') return
      const processPath = this.context.fs.processPath(target)
      const outputPath = external ? processPath : relative(this.cwd, processPath).split(sep).join('/')
      const matchPath = external ? relative(baseProcess, processPath).split(sep).join('/') : outputPath
      const entryName = requestedName ?? basename(processPath)
      if (name === 'glob') {
        if (matchesGlob(matchPath, pattern) || !pattern.includes('/') && matchesGlob(entryName, pattern)) paths.push(outputPath)
      } else {
        this.permission('read')
        const bytes = await this.context.fs.readBytes(target, signal, 65536)
        bytesRead += bytes.length
        if (bytesRead > 1048576) throw new CoreError('SEARCH_LIMIT', 'The bounded search exceeded one MiB.')
        const text = new TextDecoder().decode(bytes)
        if (text.includes('\0')) return
        for (const [index, line] of text.split(/\r?\n/u).entries()) {
          if (line.includes(pattern)) matches.push({ path: outputPath, line: index + 1, text: this.sanitize(line).slice(0, 1000) })
        }
      }
      if (paths.length > 100 || matches.length > 100) throw new CoreError('SEARCH_LIMIT', 'Narrow the search to at most 100 results.')
    }
    if (baseStat.type === 'file') await inspect(base, baseTarget, 'file')
    while (pending.length) {
      const directory = pending.shift()!
      const directoryTarget = await this.target(directory, signal, 'search')
      const entries = await this.context.fs.listDir(directoryTarget, signal)
      for (const entry of entries) {
        const path = directory === '.' ? entry.name
          : isAbsolute(directory) ? resolve(directory, entry.name) : `${directory}/${entry.name}`
        if (protectedPath(path)) continue
        const lexical = isAbsolute(path) ? path : resolve(this.cwd, path)
        if ((await this.context.fs.lstat(lexical, {}, signal).catch(() => undefined))?.type === 'symlink') continue
        const target = await this.target(path, signal, 'search')
        await inspect(path, target, entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other', entry.name)
      }
    }
    return name === 'glob' ? { paths: paths.sort() } : { matches }
  }

  private async saveAttachmentTool(args: Record<string, string>): Promise<Record<string, unknown>> {
    this.permission('write')
    const reference = await this.saveAttachment(attachmentToolInput(args))
    return { ...reference }
  }

  private async readAssetTool(args: Record<string, string>): Promise<Record<string, unknown>> {
    this.permission('read')
    const reference = assetReferenceFromArgs(args, this.environmentIdentity())
    return { ...await this.readAsset(reference, assetPageOptions(args)) }
  }
}
