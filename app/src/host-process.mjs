// Runs the Host in plain Node on Linux, Electron's Node mode elsewhere, and owns its lifetime.
// Follows DeepSeek Harness apps/desktop/src/host-process.ts (MIT); see NOTICE.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const STDERR_TAIL_CHARS = 8 * 1024

// Electron on Linux leaks system glib symbols into sharp's bundled libvips.
export function hostExecutable(runtimeDir, platform = process.platform) {
  return platform === 'linux'
    ? join(runtimeDir, 'primary-runtime', 'dependencies', 'node', 'bin', 'node')
    : process.execPath
}

// The web server prints its launch URL, and the launch token in it opens the Host.
const redact = (text) => text.replace(/([?&]token=)[^&\s]+/gu, '$1<hidden>')

// The engine's own report of a failure is on the Host's stderr; the error box
// gets its tail with the message so the real cause reaches the user.
export const withLogTail = (message, stderr) => {
  const tail = redact(stderr.trim())
  return tail === '' ? message : `${message}:\n${tail}`
}

const settlesWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(false) }, ms)
  void promise.then(() => { clearTimeout(timer); resolve(true) })
})
const validCheckpoint = value => value && Number.isSafeInteger(value.count) && value.count >= 0
  && Number.isSafeInteger(value.events) && value.events >= 0 && /^[a-f0-9]{64}$/u.test(value.digest)

export class HostProcess {
  #options
  #platform
  #child
  #ready
  #exit
  #stderr = ''
  #stopping = false
  #failed = false
  #exited = false
  #shutdownCheckpoint
  #exitCode
  #messageListeners = new Set()

  /**
   * @param {{ entry: string, cwd: string, env: NodeJS.ProcessEnv, pnpm: string, onFailure: (error: Error) => void }} options
   *   `onFailure` receives the first unexpected failure, also after the Host was ready.
   */
  constructor(options, platform = process.platform) { this.#options = options; this.#platform = platform }

  /**
   * @returns {Promise<{ url: string, injections: unknown[] } | { unreadable: string[] }>} the Host's launch URL
   *   and index injections; for the first-run check, the Sessions it cannot read
   */
  start() {
    this.#exited = false
    this.#ready ??= new Promise((resolve, reject) => {
      const { entry, cwd, env, pnpm } = this.#options
      const child = spawn(hostExecutable(env.DS_SUPERAGENT_RUNTIME_DIR, this.#platform), ['--expose-internals', entry, pnpm], {
        cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.#child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { process.stdout.write(redact(chunk)) })
      child.stderr.on('data', (chunk) => {
        process.stderr.write(redact(chunk))
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS)
      })
      child.on('message', (message) => {
        for (const listener of this.#messageListeners) listener(message)
        if (message?.type === 'ready') resolve({ url: message.url, injections: message.injections })
        else if (message?.type === 'checked') resolve({ unreadable: message.unreadable })
        else if (message?.type === 'fatal') this.#fail(new Error(withLogTail(message.message, this.#stderr)), reject)
        else if (message?.type === 'shutdown-complete' && this.#stopping) this.#shutdownCheckpoint = message.checkpoint
      })
      child.once('error', (error) => { this.#fail(error, reject) })
      this.#exit = new Promise((done) => {
        child.once('close', (code) => {
          this.#exited = true
          this.#exitCode = code
          this.#fail(new Error(withLogTail(`The DSH Host stopped (exit ${String(code)})`, this.#stderr)), reject)
          done()
        })
      })
    })
    return this.#ready
  }

  /** Whether the Host process is still there: a shell that wakes from sleep checks this. */
  isRunning() { return this.#child !== undefined && !this.#exited }

  /** The Host process, for the lock that keeps a second Router off the same data. */
  pid() { return this.#child?.pid }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  send(message) {
    if (!this.#child?.connected) throw new Error('The DSH Host IPC channel is closed')
    this.#child.send(message)
  }

  /** Ask the Host to shut down, then end it if it does not exit in time. */
  async stop({ forBackup = false } = {}) {
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    if (child.connected) child.send({ type: 'shutdown', forBackup }, (error) => { if (error) console.error(error) })
    if (!await settlesWithin(this.#exit, forBackup ? 45_000 : 10_000)) child.kill()
    if (!await settlesWithin(this.#exit, 5_000)) child.kill('SIGKILL')
    // SIGKILL is not an exit: wait for close, so that the lock is not released while the
    // old Host may still be writing.
    if (!await settlesWithin(this.#exit, 5_000)) {
      const error = new Error('The DSH Host did not confirm that it stopped; its data stays locked.')
      error.code = 'STOP_UNKNOWN'
      throw error
    }
    this.#exited = true
    this.#child = undefined
    if (forBackup) {
      if (this.#exitCode !== 0 || !validCheckpoint(this.#shutdownCheckpoint)) {
        const error = new Error('The Host did not verify that its Sessions were saved. Try the backup again after checking the Host.')
        error.code = 'BACKUP_SHUTDOWN_UNVERIFIED'
        throw error
      }
      return this.#shutdownCheckpoint
    }
  }

  #fail(error, reject) {
    reject(error)
    if (this.#failed || this.#stopping) return
    this.#failed = true
    this.#options.onFailure(error)
  }
}
