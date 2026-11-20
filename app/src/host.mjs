// The Host boots the app's single DS-SuperAgent profile on a loopback port and reports the launch URL over IPC.
// Follows DeepSeek Harness apps/desktop-host/src/index.ts (MIT); see NOTICE.
import { loadLayeredEnv, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { INSTALL_ANCHOR, SUPERAGENT_PROFILE, loadAppProfile } from './profile.mjs'
import { reconcileOfficeRuntime } from './office-patch.mjs'
import { reconcileSearchSelector } from './search-patch.mjs'
import { reconcileSuperagentProfile } from './superagent-patch.mjs'
import { sessionInventory } from './product-backups.mjs'
import { createDesktopComputer } from './computer-bridge.mjs'

const send = message => new Promise((resolve, reject) => {
  if (!process.connected || process.send === undefined) { resolve(); return }
  process.send(message, error => { if (error === null) resolve(); else reject(error) })
})
const computerAdapter = Symbol.for('ds-superagent.computer-adapter')

async function main() {
  const pnpm = process.argv[2]
  const profile = loadAppProfile()
  reportSkippedBundles('dsh', profile)
  const office = reconcileOfficeRuntime(profile)
  const superagent = reconcileSuperagentProfile(profile, true)
  if (office.node !== undefined) process.env.DS_SUPERAGENT_OFFICE_NODE = office.node
  const computer = process.env.DS_SUPERAGENT_APP === '1' && process.connected ? createDesktopComputer(send) : undefined
  if (computer) globalThis[computerAdapter] = computer
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: SUPERAGENT_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles: [...reconcileSearchSelector(profile), ...office.patchFiles, ...superagent],
    args: ['--no-open', '--port', process.env.DS_SUPERAGENT_PORT || '0'],
    ...(pnpm === undefined ? {} : {
      packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  })
  let stopping
  const stop = (forBackup = false) => stopping ??= (async () => {
    const running = await application.catch(() => undefined)
    let checkpoint
    await computer?.close().catch(() => {})
    if (globalThis[computerAdapter] === computer) delete globalThis[computerAdapter]
    if (forBackup && running) {
      try {
        const product = running.ctx.get('superagentProduct')
        const persistence = running.ctx.get('sessionPersistence')
        if (process.env.DS_SUPERAGENT_POSTGRES?.trim() || !product || !persistence) throw new Error('Backup unavailable')
        await product.close()
        await persistence.flush()
        checkpoint = await sessionInventory(persistence)
      } catch { /* The parent requires a verified inventory before taking a snapshot. */ }
    }
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete', ...(checkpoint ? { checkpoint } : {}) })
    if (process.connected) process.disconnect()
  })()
  process.on('message', message => { if (message?.type === 'shutdown') void stop(message.forBackup === true) })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  const [webServer, connection] = [ctx.get('webServer'), ctx.get('connection')]
  if (webServer === undefined || connection === undefined) {
    throw new Error(`The profile in ${profile.dir} does not start the engine's web server and connection`)
  }
  const missing = ['superagentProduct', 'workspaceRegistry'].filter(name => ctx.get(name) === undefined)
  if (missing.length > 0) throw new Error(`The profile in ${profile.dir} did not start ${missing.join(', ')}; the engine log has the cause`)
  const product = ctx.get('superagentProduct')
  process.on('message', message => {
    if (message?.type !== 'ds-superagent:workspace-read' || typeof message.id !== 'string' || !/^[\da-f-]{36}$/u.test(message.id)) return
    void (async () => {
      const { instanceId } = await product.dispatch('open')
      const { default: directory } = await product.dispatch('directory-options', { instanceId })
      return directory?.root ?? null
    })().catch(() => null).then(path => send({ type: 'ds-superagent:workspace-read-result', id: message.id, path })).catch(() => {})
  })
  const url = connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
  await send({ type: 'ready', url, injections: webServer.collectIndexInjections(connection.browserPeer) })
}

main().catch(async error => {
  console.error(error)
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  await send({ type: 'fatal', message }).catch(() => undefined)
  if (process.connected) process.disconnect()
})
