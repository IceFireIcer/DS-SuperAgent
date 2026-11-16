import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createProductHost, type ProductHostConfig } from './product-host.js'
import { CoreError } from './model.js'

export interface SuperagentProfilePaths {
  root: string
  databasePath: string
}

export type SuperagentProfileConfig = Omit<ProductHostConfig, 'databasePath'>

/**
 * The profile home is the app's isolated DSH home for this profile. Keeping the
 * business store below it leaves the old ds-bot team and DSH session data apart.
 */
export function profilePaths(env: NodeJS.ProcessEnv = process.env): SuperagentProfilePaths {
  const home = env.DSH_HOME
  if (typeof home !== 'string' || home.trim() === '') {
    throw new CoreError('INVALID_CONFIG', 'The ds-superagent profile needs DSH_HOME.')
  }
  const root = join(home, 'core')
  return { root, databasePath: join(root, 'state.sqlite') }
}

/** Opt-in source settings come from the trusted Host process, never a model or browser request. */
export function feishuProfileConfig(env: NodeJS.ProcessEnv = process.env): ProductHostConfig['feishu'] | undefined {
  const keys = ['APP_ID', 'TENANT_KEY', 'CHAT_IDS', 'SELF_ACTOR_IDS', 'ALLOWED_REQUESTER_IDS'] as const
  const values = keys.map(key => env[`DS_SUPERAGENT_FEISHU_${key}`])
  const appSecret = env.DS_SUPERAGENT_FEISHU_APP_SECRET
  if (values.every(value => value === undefined || value === '') && appSecret === undefined) return undefined
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new CoreError('INVALID_CONFIG', 'A Feishu source needs its app, tenant, chats, bot identities and requester allowlist.')
  }
  const [appId, tenantKey, chats, bots, requesters] = values as string[]
  const ids = (value: string) => value.split(',').map(id => id.trim())
  const chatIds = ids(chats!), selfActorIds = ids(bots!), allowedRequesterIds = ids(requesters!)
  if (![appId, tenantKey].every(id => /^[\w-]{1,256}$/u.test(id!.trim()))
    || appSecret !== undefined && (!appSecret.trim() || Buffer.byteLength(appSecret) > 16384 || /[\r\n]/u.test(appSecret))
    || chatIds.length > 20 || selfActorIds.length > 100 || allowedRequesterIds.length > 100
    || [chatIds, selfActorIds, allowedRequesterIds].some(list => list.some(id => !/^[\w-]{1,256}$/u.test(id)) || new Set(list).size !== list.length)) {
    throw new CoreError('INVALID_CONFIG', 'A Feishu source needs valid bounded app, tenant, chat, bot and requester settings.')
  }
  return {
    tenantKey: tenantKey!.trim(), chatIds, actorId: 'feishu-receiver', selfActorIds,
    allowedActorIds: ['feishu-receiver'],
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds, allowedBotActorIds: [], rules: [] },
    api: { appId: appId!.trim(), ...(appSecret === undefined ? {} : { appSecret: appSecret.trim() }) },
  }
}

/** The configured allowlist authorizes Main intake, never GitHub posting. */
export function githubProfileConfig(env: NodeJS.ProcessEnv = process.env): ProductHostConfig['github'] | undefined {
  const owner = env.DS_SUPERAGENT_GITHUB_OWNER
  const repo = env.DS_SUPERAGENT_GITHUB_REPO
  const requesters = env.DS_SUPERAGENT_GITHUB_ALLOWED_REQUESTER_IDS
  const self = env.DS_SUPERAGENT_GITHUB_SELF_ACTOR_IDS
  if ([owner, repo, requesters, self].every(value => value === undefined || value === '')) return undefined
  if (!owner || !repo || requesters === undefined || !/^[a-zA-Z0-9-]{1,100}$/u.test(owner)
    || !/^[a-zA-Z0-9_.-]{1,100}$/u.test(repo) || repo === '.' || repo === '..') {
    throw new CoreError('INVALID_CONFIG', 'A GitHub source needs an owner, repository and explicit requester allowlist.')
  }
  const ids = (value: string) => value ? value.split(',').map(id => id.trim()) : []
  const allowedRequesterIds = ids(requesters), selfActorIds = ids(self ?? '')
  if (allowedRequesterIds.length > 100 || selfActorIds.length > 100
    || [...allowedRequesterIds, ...selfActorIds].some(id => !/^[\w-]{1,256}$/u.test(id))
    || new Set(allowedRequesterIds).size !== allowedRequesterIds.length || new Set(selfActorIds).size !== selfActorIds.length) {
    throw new CoreError('INVALID_CONFIG', 'GitHub actor allowlists must contain distinct bounded identities.')
  }
  return { owner, repo, actorId: 'github-receiver', allowedActorIds: ['github-receiver'], selfActorIds,
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds, allowedBotActorIds: [], rules: [] } }
}

export const name = 'ds-superagent-profile'
export const inject = ['sessionPersistence', 'agents', 'sessions']

export async function apply(context: Context, config: SuperagentProfileConfig = {}) {
  const paths = profilePaths()
  mkdirSync(paths.root, { recursive: true })
  const workspaceRoot = config.workspaceRoot ?? process.env.DS_BOT_WORKSPACE
  if (workspaceRoot) mkdirSync(workspaceRoot, { recursive: true })
  const gatewayPort = process.env.DS_SUPERAGENT_CLIENT_PORT
  const keyPath = process.env.DS_SUPERAGENT_CLIENT_TLS_KEY_PATH
  const certPath = process.env.DS_SUPERAGENT_CLIENT_TLS_CERT_PATH
  if (!config.clientGateway && (keyPath || certPath) && !gatewayPort) {
    throw new CoreError('INVALID_CONFIG', 'A client TLS configuration needs a gateway port.')
  }
  if (!config.clientGateway && Boolean(keyPath) !== Boolean(certPath)) {
    throw new CoreError('INVALID_CONFIG', 'A client gateway needs both TLS key and certificate files.')
  }
  if (gatewayPort && (!Number.isInteger(Number(gatewayPort)) || Number(gatewayPort) < 1 || Number(gatewayPort) > 65535)) {
    throw new CoreError('INVALID_CONFIG', 'The client gateway port must be between 1 and 65535.')
  }
  const clientGateway = config.clientGateway ?? (gatewayPort ? {
    host: process.env.DS_SUPERAGENT_CLIENT_HOST ?? '127.0.0.1', port: Number(gatewayPort),
    ...(keyPath && certPath ? { tls: { key: readFileSync(keyPath), cert: readFileSync(certPath) } } : {}),
  } : undefined)
  let feishu = config.feishu
  let feishuConfigurationError: 'INVALID_CONFIG' | undefined
  if (!feishu) {
    try { feishu = feishuProfileConfig() }
    catch (error) {
      if (!(error instanceof CoreError) || error.code !== 'INVALID_CONFIG') throw error
      feishuConfigurationError = 'INVALID_CONFIG'
    }
  }
  let github = config.github
  let githubConfigurationError: 'INVALID_CONFIG' | undefined
  if (!github) {
    try { github = githubProfileConfig() }
    catch (error) {
      if (!(error instanceof CoreError) || error.code !== 'INVALID_CONFIG') throw error
      githubConfigurationError = 'INVALID_CONFIG'
    }
  }
  const host = await createProductHost(context, {
    ...config,
    ...(config.watchdogStatusPath === undefined && process.env.DS_SUPERAGENT_WATCHDOG_STATUS_PATH
      ? { watchdogStatusPath: process.env.DS_SUPERAGENT_WATCHDOG_STATUS_PATH } : {}),
    ...(config.workspaceRoot === undefined && workspaceRoot ? { workspaceRoot } : {}),
    ...(clientGateway ? { clientGateway } : {}),
    ...(feishu ? { feishu } : {}),
    ...(feishuConfigurationError ? { feishuConfigurationError } : {}),
    ...(github ? { github } : {}),
    ...(githubConfigurationError ? { githubConfigurationError } : {}),
    databasePath: paths.databasePath,
  })
  context.provide('superagentProduct', host)
  context.effect(() => () => host.close())
}
