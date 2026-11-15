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
  const host = await createProductHost(context, {
    ...config,
    ...(config.workspaceRoot === undefined && workspaceRoot ? { workspaceRoot } : {}),
    ...(clientGateway ? { clientGateway } : {}),
    databasePath: paths.databasePath,
  })
  context.provide('superagentProduct', host)
  context.effect(() => () => host.close())
}
