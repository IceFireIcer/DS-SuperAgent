// Windows and a Linux AppImage download and install updates; macOS and a Linux deb ask before
// opening the release page.
import { ARTIFACT_PREFIX, PRODUCT_NAME, PRODUCT_SLUG, REPOSITORY } from './product.mjs'

export const UPDATE_TEXT = {
  en: {
    ready: version => `${PRODUCT_NAME} ${version} is ready to install.`,
    readyDetail: 'Restart now to install it. If you choose Later, the current version stays installed; installing remains your choice.',
    restart: 'Restart now', later: 'Later',
    installFailed: 'The update could not be installed. Check Diagnostics in Status and usage.',
    onFailure: version => `${PRODUCT_NAME} ${version} is available. It can finish downloading in the background, but it is not installed unless you confirm.`,
    available: version => `${PRODUCT_NAME} ${version} is available.`,
    availableDetail: `This version cannot update itself. Download the new version from its release page, then replace ${PRODUCT_NAME} in Applications.`,
    download: 'Download',
    rollbackRestore: 'Undo unfinished restore',
    onFailurePage: version => `${PRODUCT_NAME} ${version} is available. After this box, its download page opens.`,
  },
  zh: {
    ready: version => `${PRODUCT_NAME} ${version} 已经下载好。`,
    readyDetail: '现在重启即可安装；选择「稍后」会继续使用当前版本，是否安装由你决定。',
    restart: '立即重启', later: '稍后',
    installFailed: '更新未能安装。请在「状态与用量」中查看诊断。',
    onFailure: version => `${PRODUCT_NAME} ${version} 已可用。下载可在后台继续，但未经你确认不会安装。`,
    available: version => `${PRODUCT_NAME} ${version} 已经发布。`,
    availableDetail: `这个版本不能自己更新。请到发布页下载新版，再用它替换「应用程序」里的 ${PRODUCT_NAME}。`,
    download: '下载',
    rollbackRestore: '撤销未完成的恢复',
    onFailurePage: version => `${PRODUCT_NAME} ${version} 已经发布。关掉这个对话框后，会打开它的下载页面。`,
  },
}

const CHECK_EVERY_MS = 4 * 60 * 60_000
const CHECK_TIMEOUT_MS = 60_000
export const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`

function parseVersion(version) {
  if (typeof version !== 'string') return null
  const value = version.replace(/^v/u, '')
  const separator = value.indexOf('-')
  const core = separator < 0 ? value : value.slice(0, separator)
  const pre = separator < 0 ? null : value.slice(separator + 1).split('.')
  const parts = core.split('.')
  if (parts.length > 3 || parts.some(part => !/^\d+$/u.test(part)) || pre?.some(part => part === '')) return null
  return {
    core: [0, 1, 2].map(index => (index < parts.length ? BigInt(parts[index]) : 0n)),
    pre,
  }
}

export function isNewer(candidate, current) {
  const newer = parseVersion(candidate)
  const older = parseVersion(current)
  if (newer === null || older === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (newer.core[index] !== older.core[index]) return newer.core[index] > older.core[index]
  }
  if (newer.pre === null) return older.pre !== null
  if (older.pre === null) return false
  for (let index = 0; index < Math.max(newer.pre.length, older.pre.length); index += 1) {
    const left = newer.pre[index]
    const right = older.pre[index]
    if (left === undefined) return false
    if (right === undefined) return true
    if (left === right) continue
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right)
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return false
}

function isHttpsPage(page) {
  if (typeof page !== 'string') return false
  try {
    return new URL(page).protocol === 'https:'
  } catch {
    return false
  }
}

// The About row shows the checker's phase: checking → current | downloading → downloaded |
// available | failed. While a check, a download or a ready install is on, a new check must
// not start, so `check()` is a no-op in those phases.
const UPDATE_BUSY = new Set(['checking', 'downloading', 'downloaded', 'installing'])

function stateHolder(log) {
  let state = { phase: 'checking' }
  const listeners = new Set()
  return {
    state: () => state,
    set: (next) => {
      state = next
      for (const listener of [...listeners]) {
        try { listener(next) } catch (error) { log.error(`${PRODUCT_NAME}: an update state listener failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// `asset` names the release asset of this install (default: the macOS zip); a release without
// it does not count.
export function watchReleases({ current, arch, fetch = globalThis.fetch, ask, open, feed = RELEASES_URL, log = console, asset, timeout = CHECK_TIMEOUT_MS }) {
  const assetName = asset ?? (version => `${ARTIFACT_PREFIX}-${version}-mac-${arch}.zip`)
  let asked
  let latest = Promise.resolve(null)
  let stopped = false
  let controller
  const runs = new Set()
  let sequence = 0
  const holder = stateHolder(log)
  const run = () => {
    if (stopped) return
    const runId = ++sequence
    const signal = new AbortController()
    controller = signal
    holder.set({ phase: 'checking' })
    let finish
    const stoppedRun = new Promise((resolve) => { finish = () => resolve(null) })
    const active = { finish }
    runs.add(active)
    const live = () => !stopped && !signal.signal.aborted && sequence === runId
    const deadline = setTimeout(() => {
      if (!live()) return
      sequence += 1
      log.error(`${PRODUCT_NAME}: update check failed: timed out`)
      holder.set({ phase: 'failed' })
      signal.abort(new Error('the update check timed out'))
    }, timeout)
    const check = (async () => {
      try {
        const response = await fetch(feed, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': `${PRODUCT_SLUG}/${current}` },
          signal: signal.signal,
        })
        if (!live()) return null
        if (!response.ok) {
          log.error(`${PRODUCT_NAME}: update check failed: HTTP ${String(response.status)}`)
          holder.set({ phase: 'failed' })
          return null
        }
        const releases = await response.json()
        if (!live()) return null
        if (!Array.isArray(releases)) {
          log.error(`${PRODUCT_NAME}: update check failed: releases response is not an array`)
          holder.set({ phase: 'failed' })
          return null
        }
        const currentVersion = parseVersion(current)
        const allowPrerelease = currentVersion !== null && currentVersion.pre !== null
        let found
        for (const release of releases) {
          if (release === null || typeof release !== 'object' || release.draft === true
            || (release.prerelease === true && !allowPrerelease)) continue
          const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : ''
          if (!isNewer(version, current)) continue
          if (!Array.isArray(release.assets) || !release.assets.some(entry => entry?.name === assetName(version))) continue
          if (!isHttpsPage(release.html_url)) {
            log.error(`${PRODUCT_NAME}: update check failed: release page URL is not HTTPS`)
            continue
          }
          if (found === undefined || isNewer(version, found.version)) found = { version, page: release.html_url }
        }
        if (found === undefined) {
          holder.set({ phase: 'current' })
          return null
        }
        log.info(`${PRODUCT_NAME}: update ${found.version} available`)
        if (ask !== undefined && asked !== found.version) {
          asked = found.version
          void Promise.resolve().then(() => ask(found.version))
            .then(yes => (!stopped && yes ? open(found.page) : undefined))
            .catch((error) => { log.error(`${PRODUCT_NAME}: update ${found.version} not opened: ${error instanceof Error ? error.message : String(error)}`) })
        }
        holder.set({ phase: 'available', version: found.version, page: found.page })
        return found
      } catch (error) {
        if (!live()) return null
        log.error(`${PRODUCT_NAME}: update check failed: ${error instanceof Error ? error.message : String(error)}`)
        holder.set({ phase: 'failed' })
        return null
      }
    })()
    latest = Promise.race([check, stoppedRun]).finally(() => {
      clearTimeout(deadline)
      runs.delete(active)
      if (controller === signal) controller = undefined
    })
  }
  // A check runs at once and then on the timer; a manual one only starts when none is on.
  const check = () => { if (!stopped && !UPDATE_BUSY.has(holder.state().phase)) run() }
  run()
  const timer = setInterval(check, CHECK_EVERY_MS)
  const stop = () => {
    if (stopped) return
    stopped = true
    sequence += 1
    clearInterval(timer)
    controller?.abort(new Error('the update check stopped'))
    for (const run of runs) run.finish()
  }
  return { stop, latest: () => latest, state: holder.state, subscribe: holder.subscribe, check }
}

/**
 * @param {{
 *   updater: import('electron-updater').AppUpdater,
 *   beforeInstall: () => Promise<unknown>,
 *   onInstallFailure?: (failure: { asynchronous: boolean }) => Promise<void>,
 *   beforeLaunch?: (version: string) => Promise<void>,
 *   ask?: (version: string) => Promise<boolean>,
 *   feed?: string,
 *   timeout?: number,
 *   log?: Pick<Console, 'info' | 'error'>,
 * }} options `ask` answers whether to install now; without it a downloaded update waits for
 *   an explicit `install()` call. The desktop main process owns the backup through
 *   `beforeInstall`.
 *   `feed` is a folder URL with a latest.yml, in place of the GitHub releases. A check that
 *   takes longer than `timeout` fails, so that a later check can run.
 * @returns {{
 *   stop: () => void,
 *   latest: () => Promise<{ version: string, downloaded: Promise<boolean> } | null>,
 *   install: () => Promise<void>,
 *   state: () => { phase: string, version?: string, page?: string },
 *   subscribe: (listener: (state: { phase: string }) => void) => () => void,
 *   check: () => void,
 * }} `latest` is what the newest check found: the version and whether its download finished.
 *   `install` stops the Host and runs the installer. By default the installer opens the app again. `state` is
 *   the phase the About row shows; `check` runs the same check the timer does and does
 *   nothing while a check, a download or a ready install is on.
 */
export function watchUpdates({ updater, beforeInstall, beforeLaunch, onInstallFailure, ask, feed, log = console, timeout = CHECK_TIMEOUT_MS }) {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  if (feed) updater.setFeedURL({ provider: 'generic', url: feed })
  const holder = stateHolder(log)
  let stopped = false
  let accepting = true
  const runs = new Set()
  let sequence = 0
  let installing
  let launching = false
  let launchFailure
  const failedInstall = (version, error, asynchronous = false) => {
    launching = false
    holder.set({ phase: 'downloaded', version, failure: 'install_failed' })
    return Promise.resolve().then(() => onInstallFailure?.({ asynchronous })).catch(() => {
      log.error(`${PRODUCT_NAME}: could not restart the Host after an update error`)
    }).then(() => { throw error })
  }
  const install = () => {
    if (installing) return installing
    if (launchFailure) return launchFailure
    const { phase, version } = holder.state()
    if (phase !== 'downloaded') return Promise.resolve()
    installing = (async () => {
      holder.set({ phase: 'installing', version })
      try {
        await beforeInstall()
        await beforeLaunch?.(version)
        launching = true
        updater.quitAndInstall(true, true)
        if (launchFailure) await launchFailure
      } catch (error) {
        if (holder.state().phase === 'installing') await failedInstall(version, error)
        throw error
      }
    })().finally(() => { installing = undefined })
    return installing
  }
  let asked
  const report = (next) => { if (!stopped && accepting && holder.state().phase !== 'installing') holder.set(next) }
  updater.on('checking-for-update', () => { report({ phase: 'checking' }) })
  updater.on('update-not-available', () => { report({ phase: 'current' }) })
  updater.on('update-available', (info) => { report({ phase: 'downloading', version: info?.version }) })
  updater.on('update-downloaded', ({ version }) => {
    if (stopped || !accepting || holder.state().phase === 'installing') return
    log.info(`${PRODUCT_NAME}: update ${version} downloaded`)
    holder.set({ phase: 'downloaded', version })
    if (ask === undefined || asked === version) return
    asked = version
    void ask(version).then(now => (!stopped && now ? install() : undefined))
      .catch((error) => { log.error(`${PRODUCT_NAME}: update ${version} not installed: ${error instanceof Error ? error.message : String(error)}`) })
  })
  // A downloaded update stays ready: a later failed check does not hide it.
  updater.on('error', (error) => {
    if (stopped && !launching) return
    log.error(`${PRODUCT_NAME}: update failed: ${error instanceof Error ? error.message : String(error)}`)
    const { phase, version } = holder.state()
    if (phase === 'installing' && launching) {
      launchFailure = failedInstall(version, error, installing === undefined)
      void launchFailure.catch(() => {}).finally(() => { launchFailure = undefined })
    } else if (phase === 'installing') {
      return
    } else if (accepting && phase !== 'downloaded') {
      holder.set(phase === 'downloading' ? { phase: 'failed', failure: 'download_failed' } : { phase: 'failed' })
    }
  })
  let latest = Promise.resolve(null)
  // A failed check or download also comes as an 'error' event.
  // The events normally move the phase; a check that settles without one must not leave it
  // on `checking`, or the busy guard would also stop the timer's checks.
  const settled = (next) => { if (accepting && holder.state().phase === 'checking') holder.set(next) }
  const run = () => {
    if (stopped) return
    accepting = true
    const runId = ++sequence
    let finish
    const stoppedRun = new Promise((resolve) => { finish = () => resolve(null) })
    const active = { finish }
    runs.add(active)
    const live = () => !stopped && accepting && sequence === runId
    const deadline = setTimeout(() => {
      if (!live()) return
      sequence += 1
      accepting = false
      log.error(`${PRODUCT_NAME}: update check failed: timed out`)
      holder.set({ phase: 'failed' })
      finish?.()
    }, timeout)
    const check = updater.checkForUpdates().then((result) => {
      if (!live()) return null
      if (result?.isUpdateAvailable && result.downloadPromise) {
        settled({ phase: 'downloading', version: result.updateInfo.version })
        return { version: result.updateInfo.version, downloaded: result.downloadPromise.then(() => true, () => {
          if (live() && holder.state().phase === 'downloading') holder.set({ phase: 'failed', failure: 'download_failed' })
          return false
        }) }
      }
      settled({ phase: 'current' })
      return null
    }, () => {
      if (live()) settled({ phase: 'failed' })
      return null
    })
    latest = Promise.race([check, stoppedRun]).finally(() => {
      clearTimeout(deadline)
      runs.delete(active)
    })
  }
  const check = () => { if (!stopped && !UPDATE_BUSY.has(holder.state().phase)) run() }
  run()
  const timer = setInterval(check, CHECK_EVERY_MS)
  const stop = () => {
    if (stopped) return
    stopped = true
    sequence += 1
    accepting = false
    clearInterval(timer)
    for (const run of runs) run.finish()
  }
  return { stop, latest: () => latest, install, state: holder.state, subscribe: holder.subscribe, check }
}
