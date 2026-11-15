// DSH updates: a released DS Bot may name the DSH release it was verified
// against (`dsBot.verifiedDsh` in package.json); a release that names none
// offers nothing. The newest released bot wins: offering that version and
// nothing newer keeps the update path away from DSH releases we have not
// checked. A DSH installed from npm swaps with `npm i -g`; a packaged app's
// runtime lives inside its bundle and only its own updater moves it, to the
// newest release it finds, so the client offers it only when that release is
// the verified one.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  CHECK_TTL_MS, cleanVersion, encodeName, fetchJson, installSpecOf,
  newer, registryPlan, repoSlug, sourceOf,
} from './update.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const APP_BOOT = '@deepseek-ai/dsh-app-boot'
const DSH_PACKAGE = '@deepseek-ai/dsh'

export function install(rt) {
  const { ctx, config } = rt
  const enabled = config.updateCheck !== false

  const status = {
    current: null, verified: null, kind: 'npm', blockedBy: null,
    checkedAt: 0, phase: 'idle', installed: null, error: null,
  }
  let target = null
  let checking = null
  let running = null

  // A newer `minBot` than the running bot gates the offer: the bot goes first.
  const blocked = () => status.blockedBy !== null && newer(status.blockedBy, PKG.version)

  const view = () => ({
    current: status.current, verified: status.verified, kind: status.kind, blockedBy: status.blockedBy,
    checkedAt: status.checkedAt, phase: status.phase, installed: status.installed, error: status.error,
    // Nothing is offered without a current version to compare against.
    available: status.phase !== 'installed' && target !== null && status.current !== null
      && status.verified !== null && status.verified !== status.current && !blocked(),
  })

  // The version of the DSH that is running us, from the public app-boot export.
  // Without it the version is unknown, and no version-based update is offered.
  async function currentDsh() {
    try {
      const loader = ctx.get?.('loader')
      const loaded = await loader?.import?.(APP_BOOT)
      const appBoot = loader?.unwrapExports?.(loaded) ?? loaded?.default ?? loaded
      const reported = appBoot?.getDshRuntimeVersion?.()
      return cleanVersion(reported?.release?.version ?? reported?.version ?? reported)
    } catch {
      return null
    }
  }

  // A bundled package manager means the runtime came with the app and only the
  // app's own updater can move it.
  const installKind = () =>
    typeof ctx.get?.('profileContext')?.packageManager?.command === 'string' ? 'app' : 'npm'

  // The newest released DS Bot's `dsBot` block, through the same channel the bot
  // itself updates from: its registry, or the public repo's latest release.
  async function releasedDeclaration(source) {
    if (source.kind === 'registry') {
      for (const registry of await registryPlan(config, ctx.get?.('pluginManager'))) {
        try {
          const manifest = await fetchJson(`${registry}${encodeName(PKG.name)}/latest`)
          if (manifest?.dsBot?.verifiedDsh) return manifest.dsBot
        } catch { /* unreachable or not published there: ask the next one */ }
      }
      return null
    }
    const repo = repoSlug()
    if (!repo) return null
    try {
      const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, { 'user-agent': `${PKG.name}/${PKG.version}` })
      const tag = cleanVersion(release?.tag_name)
      if (!tag) return null
      const manifest = await fetchJson(`https://raw.githubusercontent.com/${repo}/${release.tag_name}/ds-bot/package.json`, { 'user-agent': `${PKG.name}/${PKG.version}` })
      return manifest?.dsBot?.verifiedDsh ? manifest.dsBot : null
    } catch { return null }
  }

  async function runCheck() {
    try {
      status.current = await currentDsh()
      status.kind = installKind()
      // The desktop app pins its DSH and updates it as a whole, so it has nothing to offer.
      const inApp = process.env.DS_BOT_APP === '1'
      // The release the running package itself verified stays the floor: a bot
      // older than its own declaration has nothing newer to offer.
      const declared = inApp ? [] : [{ verifiedDsh: PKG.dsBot?.verifiedDsh }]
      const released = inApp ? null : await releasedDeclaration(sourceOf(await installSpecOf(ctx)))
      if (released) declared.push(released)
      const newestDeclared = declared
        .filter(entry => cleanVersion(entry.verifiedDsh))
        .sort((a, b) => (newer(cleanVersion(a.verifiedDsh), cleanVersion(b.verifiedDsh)) ? -1 : 1))[0]
      status.verified = cleanVersion(newestDeclared?.verifiedDsh)
      // A release may gate the DSH update on a newer bot: offer nothing until
      // the bot itself is at least `minBot`.
      status.blockedBy = cleanVersion(newestDeclared?.minBot)
      target = status.current !== null && status.verified !== null && status.verified !== status.current
        ? { version: status.verified }
        : null
      status.error = null
    } catch (error) {
      rt.warn('ds-bot: dsh update check failed: %s', error?.message ?? error)
      status.verified = null
      status.blockedBy = null
      target = null
    }
    status.checkedAt = Date.now()
  }

  /** Read current and verified DSH versions; a fresh check ignores the last answer. */
  async function check({ fresh = false } = {}) {
    if (!enabled) return view()
    if (!checking && (fresh || Date.now() - status.checkedAt >= CHECK_TTL_MS)) {
      checking = runCheck().finally(() => { checking = null })
    }
    if (checking) await checking
    return view()
  }

  // npm is a .cmd batch file on Windows, which spawn cannot start directly.
  // The only variable argument is a cleaned release version.
  function npmInvocation(args) {
    if (process.platform !== 'win32') return ['npm', args]
    return [process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]]
  }

  /** Swap an npm-installed DSH for the verified version; the answer comes back through `check`. */
  function start() {
    if (status.phase === 'installing') return view()
    if (target === null || status.current === null || blocked()) throw new Error('No DSH update is available')
    if (status.kind !== 'npm') throw new Error('This DSH updates with its app')
    const chosen = target
    Object.assign(status, { phase: 'installing', error: null })
    const args = ['install', '-g', `${DSH_PACKAGE}@${chosen.version}`]
    const runner = rt.dshSpawn ?? ((command, argv, options) => spawn(command, argv, options))
    const [command, argv] = npmInvocation(args)
    try {
      running = runner(command, argv, { windowsHide: true })
    } catch (error) {
      rt.warn('ds-bot: dsh update to %s could not start: %s', chosen.version, error?.message ?? error)
      Object.assign(status, { phase: 'failed', error: String(error?.message ?? error).slice(0, 600) })
      return view()
    }
    let output = ''
    running.stdout?.on?.('data', chunk => { output = `${output}${chunk}`.slice(-4000) })
    running.stderr?.on?.('data', chunk => { output = `${output}${chunk}`.slice(-4000) })
    const done = new Promise((resolve, reject) => {
      running.once?.('error', reject)
      running.once?.('close', code => (code === 0 ? resolve() : reject(new Error(`npm exited ${code}`))))
    })
    void done
      .then(() => Object.assign(status, { phase: 'installed', installed: chosen.version }))
      .catch((error) => {
        rt.warn('ds-bot: dsh update to %s failed: %s', chosen.version, error?.message ?? error)
        Object.assign(status, { phase: 'failed', error: `${error?.message ?? error}${output ? ` — ${output.trim().slice(-400)}` : ''}`.slice(0, 600) })
      })
    return view()
  }

  // Whatever npm is still running when the plugin unloads dies with it.
  ctx.effect(() => () => running?.kill?.(), 'ds-bot: dsh update install')

  Object.assign(rt, { dshUpdateCheck: check, dshUpdateStart: start, dshUpdateView: view })
}
