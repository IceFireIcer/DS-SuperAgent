const READS = new Set(['open', 'history', 'observe-list', 'observe-read', 'observe-detail', 'evidence', 'source-deliveries'])
const COMMANDS = new Set(['send', 'stop-main', 'work-stop', 'work-answer', 'work-resume', 'work-retry', 'reconcile-delivery'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function targetOf(address, instanceId) {
  let url
  try { url = new URL(address) } catch { throw new Error('Enter a valid Host address.') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.protocol === 'http:' && !url.port) {
    throw new Error('Use an HTTPS Host address or a loopback SSH tunnel address with an explicit port.')
  }
  if (typeof instanceId !== 'string' || !instanceId.trim() || instanceId.length > 128
    || [...instanceId].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
    throw new Error('Enter the authorized Instance name.')
  }
  return `${url.origin}/instances/${encodeURIComponent(instanceId)}/product/`
}

async function request(base, credential, route, { body, timeout = 20000 } = {}) {
  let response
  try {
    response = await fetch(new URL(route, base), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Error('Could not reach the authorized Host. Check its address and transport.')
  }
  let result
  try { result = await response.json() } catch { throw new Error('The Host returned an invalid response.') }
  if (!response.ok) {
    const error = new Error(typeof result?.message === 'string' ? result.message : 'The Host denied the request.')
    error.code = result?.code
    throw error
  }
  return result
}

export class RemoteProductClient {
  #connection
  #revision = 0

  status() {
    const current = this.#connection
    return current ? { connected: true, address: current.address, instanceId: current.instanceId,
      client: current.client, capabilities: [...current.capabilities] } : { connected: false }
  }

  async connect({ address, instanceId, credential } = {}) {
    const revision = ++this.#revision
    const base = targetOf(address, instanceId)
    if (typeof credential !== 'string' || !/^sc1\.[A-Za-z0-9-]{8,64}\.[A-Za-z0-9_-]{32,128}$/u.test(credential)) {
      throw new Error('Enter the client credential issued by the Host.')
    }
    const snapshot = await request(base, credential, 'snapshot')
    const grant = snapshot?.client?.grants?.find(item => item.instanceId === instanceId)
    if (snapshot.instanceId !== instanceId || snapshot.binding?.instanceId !== instanceId
      || !grant?.capabilities?.includes('read') || !snapshot.history || !snapshot.observations
      || !/^\d+$/u.test(snapshot.cursor)) throw new Error('The Host returned an invalid authorized snapshot.')
    if (revision !== this.#revision) throw new Error('The connection was replaced while opening.')
    this.#connection = { base, address: new URL(address).origin, instanceId, credential,
      client: { id: snapshot.client.id, label: snapshot.client.label },
      capabilities: grant.capabilities, cursor: snapshot.cursor }
    return { ...this.status(), binding: snapshot.binding, history: snapshot.history, observations: snapshot.observations }
  }

  disconnect() {
    ++this.#revision
    this.#connection = undefined
    return this.status()
  }

  async call(endpoint, payload = {}) {
    const current = this.#connection
    if (!current) throw new Error('Connect to a Host first.')
    const capability = READS.has(endpoint) ? 'read' : COMMANDS.has(endpoint) ? 'command' : undefined
    if (!capability || !current.capabilities.includes(capability)) throw new Error('This client is not authorized for that product operation.')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || endpoint !== 'open' && payload.instanceId !== current.instanceId
      || endpoint === 'open' && Object.keys(payload).length !== 0) throw new Error('The product request is outside the connected Instance.')
    return request(current.base, current.credential, endpoint, { body: payload, timeout: capability === 'command' ? 120000 : 20000 })
  }

  async events() {
    const current = this.#connection
    if (!current) throw new Error('Connect to a Host first.')
    const events = []
    for (let page = 0; page < 10; page++) {
      const result = await request(current.base, current.credential, `events?after=${current.cursor}&limit=100`)
      if (current !== this.#connection) return []
      if (!Array.isArray(result.items) || !/^\d+$/u.test(result.cursor)) throw new Error('The Host returned an invalid event cursor.')
      events.push(...result.items)
      if (Number(result.cursor) < Number(current.cursor)) throw new Error('The Host event cursor moved backward.')
      current.cursor = result.cursor
      if (!result.hasMore) break
    }
    return events
  }
}
