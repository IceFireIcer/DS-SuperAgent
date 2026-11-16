import { CoreError, identifier, type DesktopSource, type IntakePolicy } from './model.js'
import type { Storage } from './storage.js'
import type { Engine } from './engine.js'
import { GitHubSource } from './channels.js'
import { GitHubCliTransport, type GitHubCliTransportOptions } from './github-api.js'
import { GitHubPoller, type ChannelHealth, type GitHubTransport } from './pollers.js'

export interface GitHubRuntimeOptions {
  storage: Storage
  instanceId: string
  owner: string
  repo: string
  actorId: string
  allowedActorIds: string[]
  selfActorIds?: string[]
  intake?: IntakePolicy
  transport?: GitHubTransport
  cli?: GitHubCliTransportOptions
  intervalMs?: number
  maxBackoffMs?: number
  pollTimeoutMs?: number
}

/** One trusted repository receiver; CI and bot observations share its native source identity. */
export class GitHubRuntime {
  readonly sourceBinding: DesktopSource
  private readonly options: GitHubRuntimeOptions
  private poller: GitHubPoller | undefined
  private stopped = false

  constructor(options: GitHubRuntimeOptions) {
    identifier(options.instanceId, 'instanceId'); identifier(options.actorId, 'actorId')
    if (!/^[a-zA-Z0-9-]{1,100}$/u.test(options.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/u.test(options.repo)
      || options.repo === '.' || options.repo === '..' || !Array.isArray(options.allowedActorIds)
      || !options.allowedActorIds.includes(options.actorId) || options.selfActorIds?.some(id => typeof id !== 'string' || !id)) {
      throw new CoreError('INVALID_CONFIG', 'A GitHub receiver needs an explicit repository and receiving actor.')
    }
    for (const id of [...options.allowedActorIds, ...(options.selfActorIds ?? [])]) identifier(id, 'nativeActorId')
    if (options.transport && options.cli) throw new CoreError('INVALID_CONFIG', 'Choose one GitHub transport.')
    this.options = options
    const sourceInstanceId = `github:${options.owner}/${options.repo}`
    const intake = options.intake ? { ...options.intake, allowedRequesterIds: [...options.intake.allowedRequesterIds] }
      : { mode: 'auto' as const, maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
        allowedRequesterIds: [], allowedBotActorIds: [], rules: [] }
    this.sourceBinding = { kind: 'github', sourceInstanceId, actorId: options.actorId,
      allowedActorIds: [...options.allowedActorIds], allowedThreadPrefixes: [`${sourceInstanceId}#`],
      versionOrder: 'sequence', intake }
  }

  bind(engine: Engine) {
    if (this.poller) throw new CoreError('RUNTIME_ACTIVE', 'The GitHub runtime is already bound.')
    const { storage, instanceId, owner, repo } = this.options
    const source = new GitHubSource(storage, instanceId, engine, {
      owner, repo, mainIntake: true,
      ...(this.options.selfActorIds ? { selfActorIds: this.options.selfActorIds } : {}),
    })
    this.poller = new GitHubPoller(source, this.options.transport ?? new GitHubCliTransport(this.options.cli), owner, repo, {
      intervalMs: this.options.intervalMs ?? 60_000,
      ...(this.options.maxBackoffMs === undefined ? {} : { maxBackoffMs: this.options.maxBackoffMs }),
      ...(this.options.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: this.options.pollTimeoutMs }),
    })
  }

  start() {
    if (!this.poller) throw new CoreError('INVALID_CONFIG', 'Bind the GitHub runtime before starting it.')
    this.stopped = false
    return this.poller.start()
  }

  stop() { this.stopped = true; return this.poller?.stop() ?? Promise.resolve() }

  health(): ChannelHealth {
    const state = this.poller?.health() ?? { state: 'idle', passes: 0 }
    return this.stopped ? { ...state, state: 'stopped' } : state
  }
}
