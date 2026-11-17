// The Host boots the app's single DS-SuperAgent profile on a loopback port and reports the launch URL over IPC.
// Follows DeepSeek Harness apps/desktop-host/src/index.ts (MIT); see NOTICE.
import { inspect } from 'node:util'
import { loadLayeredEnv, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { INSTALL_ANCHOR, SUPERAGENT_PROFILE, loadAppProfile } from './profile.mjs'
import { reconcileOfficeRuntime } from './office-patch.mjs'
import { reconcileSearchSelector } from './search-patch.mjs'
import { reconcileSuperagentProfile } from './superagent-patch.mjs'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

const send = message => new Promise((resolve, reject) => {
  if (!process.connected || process.send === undefined) { resolve(); return }
  process.send(message, error => { if (error === null) resolve(); else reject(error) })
})

async function main() {
  const pnpm = process.argv[2]
  const profile = loadAppProfile()
  reportSkippedBundles('dsh', profile)
  const office = reconcileOfficeRuntime(profile)
  const superagent = reconcileSuperagentProfile(profile, true)
  if (office.node !== undefined) process.env.DS_BOT_OFFICE_NODE = office.node
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: SUPERAGENT_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles: [...reconcileSearchSelector(profile), ...office.patchFiles, ...superagent],
    args: ['--no-open', '--port', process.env.DS_BOT_PORT || '0'],
    ...(pnpm === undefined ? {} : {
      packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  })
  let stopping
  const stop = () => stopping ??= (async () => {
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', message => { if (message?.type === 'shutdown') void stop() })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  const [webServer, connection] = [ctx.get('webServer'), ctx.get('connection')]
  if (webServer === undefined || connection === undefined) {
    throw new Error(`The profile in ${profile.dir} does not start the engine's web server and connection`)
  }
  const missing = ['superagentProduct', 'workspaceRegistry'].filter(name => ctx.get(name) === undefined)
  if (missing.length > 0) throw new Error(`The profile in ${profile.dir} did not start ${missing.join(', ')}; the engine log has the cause`)
  const url = connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
  await send({ type: 'ready', url, injections: webServer.collectIndexInjections() })
}

main().catch(async error => {
  console.error(error)
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  await send({ type: 'fatal', message, diagnostic }).catch(() => undefined)
  if (process.connected) process.disconnect()
})
