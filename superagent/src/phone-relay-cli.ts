#!/usr/bin/env node
import { startRelayServer } from './phone-link/server/server.js'

const env = process.env
const server = await startRelayServer({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8787),
  ...(env.DS_SUPERAGENT_LINK_DATA ? { dataFile: env.DS_SUPERAGENT_LINK_DATA } : {}),
  trustProxy: env.DS_SUPERAGENT_LINK_TRUST_PROXY === '1' })
console.log(`DS SuperAgent relay: ${server.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close() })
