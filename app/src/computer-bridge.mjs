import { randomUUID } from 'node:crypto'
import { createComputerDriver } from './computer-driver.mjs'

const replyType = 'ds-superagent:computer-shell-response'

export function createDesktopComputer(send) {
  const pending = new Map()
  let stopControl
  let controlId
  let closed = false
  const lifetime = new AbortController()
  const activeSignal = signal => AbortSignal.any([signal, lifetime.signal])
  const ask = (kind, body, signal = AbortSignal.timeout(5000)) => new Promise((resolve, reject) => {
    if (closed || signal.aborted) { reject(new Error('The desktop computer bridge is unavailable.')); return }
    const id = randomUUID()
    const finish = (value, error) => {
      if (!pending.delete(id)) return
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      finish(undefined, signal.reason)
      void send({ type: 'ds-superagent:computer-shell-cancel', id }).catch(() => {})
    }
    pending.set(id, finish)
    signal.addEventListener('abort', abort, { once: true })
    const request = kind === 'indicator'
      ? { type: 'ds-superagent:computer-indicator', id, active: true, ...body }
      : { type: 'ds-superagent:computer-shell', id, kind, ...body }
    void send(request).catch(error => finish(undefined, error))
  })
  const driver = createComputerDriver({
    canUseForeground: signal => ask('foreground', { controlId }, signal).then(value => value === true),
    onCursor: (point, signal) => ask('cursor', { controlId, point }, signal),
  })
  const onMessage = message => {
    if (message?.type === replyType) pending.get(message.id)?.(message.ok === true)
    if (message?.type === 'ds-superagent:computer-stop' && controlId !== undefined && message.controlId === controlId) {
      const revoke = stopControl
      controlId = undefined
      stopControl = undefined
      driver.reset()
      revoke?.()
    }
  }
  process.on('message', onMessage)
  return {
    status: signal => driver.status(activeSignal(signal)),
    apps: signal => driver.apps(activeSignal(signal)),
    approve: (request, signal) => ask('approve', { request }, activeSignal(signal)).then(value => value === true),
    reconcile: (request, signal) => ask('reconcile', { request }, activeSignal(signal)).then(value => value === true),
    async indicator(active, stop) {
      if (!active) {
        const id = controlId
        controlId = undefined
        stopControl = undefined
        driver.reset()
        if (id !== undefined) await send({ type: 'ds-superagent:computer-indicator', active: false, controlId: id })
        return true
      }
      const id = controlId = randomUUID()
      stopControl = stop
      let shown = false
      try { shown = await ask('indicator', { controlId: id }) === true && controlId === id }
      finally {
        if (!shown && controlId === id) await this.indicator(false).catch(() => {})
      }
      return shown
    },
    async execute(action, signal, authorize, launchInput) {
      signal = activeSignal(signal)
      const id = controlId
      if (!id || !await ask('active', { controlId: id }, signal)) throw new Error('Desktop control is no longer active.')
      const check = async () => {
        if (controlId !== id || !await ask('active', { controlId: id }, signal)) throw new Error('Desktop control is no longer active.')
        await authorize()
      }
      return driver.execute(action, signal, check, async sendInput => {
        await check()
        return launchInput(sendInput)
      })
    },
    async close() {
      closed = true
      lifetime.abort()
      process.off('message', onMessage)
      for (const finish of pending.values()) finish(undefined, new Error('Desktop control stopped.'))
      await this.indicator(false).catch(() => {})
      await driver.close()
    },
  }
}
