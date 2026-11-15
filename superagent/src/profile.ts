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
  const keys = ['APP_ID', 'APP_SECRET', 'TENANT_KEY', 'CHAT_IDS', 'SELF_ACTOR_IDS', 'ALLOWED_REQUESTER_IDS'] as const
  const values = keys.map(key => env[`DS_SUPERAGENT_FEISHU_${key}`])
  if (values.every(value => value === undefined || value === '')) return undefined
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new CoreError('INVALID_CONFIG', 'A Feishu source needs its app, tenant, chats, bot identities and requester allowlist.')
  }
  const [appId, appSecret, tenantKey, chats, bots, requesters] = values as string[]
  const ids = (value: string) => value.split(',').map(id => id.trim())
  const chatIds = ids(chats!), selfActorIds = ids(bots!), allowedRequesterIds = ids(requesters!)
  if (![appId, tenantKey].every(id => /^[\w-]{1,256}$/u.test(id!.trim()))
    || !appSecret || Buffer.byteLength(appSecret) > 16384 || /[\r\n]/u.test(appSecret)
    || chatIds.length > 20 || selfActorIds.length > 100 || allowedRequesterIds.length > 100
    || [chatIds, selfActorIds, allowedRequesterIds].some(list => list.some(id => !/^[\w-]{1,256}$/u.test(id)) || new Set(list).size !== list.length)) {
    throw new CoreError('INVALID_CONFIG', 'A Feishu source needs valid bounded app, tenant, chat, bot and requester settings.')
  }
  return {
    tenantKey: tenantKey!.trim(), chatIds, actorId: 'feishu-receiver', selfActorIds,
    allowedActorIds: ['feishu-receiver'],
    intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
      allowedRequesterIds, allowedBotActorIds: [], rules: [] },
    api: { appId: appId!.trim(), appSecret: appSecret!.trim() },
  }
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
  const host = await createProductHost(context, {
    ...config,
    ...(config.watchdogStatusPath === undefined && process.env.DS_SUPERAGENT_WATCHDOG_STATUS_PATH
      ? { watchdogStatusPath: process.env.DS_SUPERAGENT_WATCHDOG_STATUS_PATH } : {}),
    ...(config.workspaceRoot === undefined && workspaceRoot ? { workspaceRoot } : {}),
    ...(clientGateway ? { clientGateway } : {}),
    ...(feishu ? { feishu } : {}),
    ...(feishuConfigurationError ? { feishuConfigurationError } : {}),
    databasePath: paths.databasePath,
  })
  context.provide('superagentProduct', host)
  context.effect(() => () => host.close())
}
