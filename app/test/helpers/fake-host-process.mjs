// The Host of the app, as a test double: it reports a launch URL and counts how often it was
// started, so that a test can see that no second Host was started.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './fake-electron.mjs'

// The port the app gave the Host: the launch URL is on the Host's own address.
const port = () => {
  try {
    return String(JSON.parse(readFileSync(join(paths.userData, 'host-port.json'), 'utf8')).port)
  } catch {
    return '43117'
  }
}

let gate
let open

export const state = {
  starts: 0,
  stops: 0,
  options: undefined,
  stopFails: false,
  fail: false,
  running: false,
  // The Host waits for the test to let it answer.
  held: false,
  release: () => { if (open !== undefined) { open(); open = undefined } },
  die: (error = new Error('the Host stopped')) => { current?.fail(error) },
  emit: message => current?.receive(message),
}

let current

/** Keep the Host waiting until the test lets it answer. */
export const hold = () => {
  state.held = true
  gate = new Promise((done) => { open = done })
}

export class HostProcess {
  #options
  #stopping = false
  #messageListeners = new Set()

  constructor(options) { this.#options = options; state.options = options }

  async start() {
    state.starts += 1
    current = this
    if (state.held) await gate
    if (this.#stopping) throw new Error('The Host start was canceled.')
    if (state.fail) { state.running = false; throw new Error('the Host did not start') }
    state.running = true
    return { url: `http://127.0.0.1:${port()}/?token=test-token`, injections: [] }
  }

  isRunning() { return state.running === true && current === this }

  pid() { return process.pid }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  receive(message) { for (const listener of this.#messageListeners) listener(message) }

  send(message) {
    state.sent ??= []
    state.sent.push(message)
    if (message?.type === 'ds-superagent:workspace-read') this.receive({ type: 'ds-superagent:workspace-read-result',
      id: message.id, path: state.workspace ?? this.#options.env.DS_SUPERAGENT_WORKSPACE })
  }

  stop({ forBackup = false } = {}) {
    this.#stopping = true
    if (current === this) state.release()
    state.stops += 1
    state.running = false
    if (state.stopFails) throw new Error('the Host could not stop')
    return Promise.resolve(forBackup ? { count: 0, events: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } : undefined)
  }

  /** The test kills the Host: the app hears the same failure that a real close reports. */
  fail(error) {
    state.running = false
    this.#options.onFailure(error)
  }
}
