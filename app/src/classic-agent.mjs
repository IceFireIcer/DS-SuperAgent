import { randomUUID } from 'node:crypto'

const endpoints = new Set(['classic-open', 'classic-renew', 'classic-close'])
const muxPath = '/api/remote.mux'
const failed = (code, message) => ({ ok: false, error: { code, message } })

export function createDesktopClassicAgent({ window, remote, request = fetch }) {
  const proof = randomUUID()
  let host
  let launchUrl
  let cookie
  let revision = 0

  function replaceHost(instance, url) {
    host = instance
    const address = new URL(url)
    launchUrl = address.protocol === 'http:' && address.hostname === '127.0.0.1' ? address : undefined
    cookie = undefined
    revision += 1
  }

  function revoke({ navigation = false } = {}) {
    if (navigation) { cookie = undefined; revision += 1 }
    try { host?.send({ type: 'ds-superagent:classic-revoke', detach: navigation }) } catch {}
  }

  async function connect(instance, url, scope) {
    const connectUrl = new URL(url)
    connectUrl.pathname = '/connect'
    connectUrl.searchParams.set('interactions', 'answer')
    const response = await request(connectUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const grant = response.status === 302 && response.headers.get('set-cookie')?.split(';', 1)[0]
    if (!grant || scope !== revision || instance !== host) return undefined
    const id = randomUUID()
    const bound = await new Promise(resolve => {
      const finish = ok => { clearTimeout(timer); dispose(); resolve(ok) }
      const dispose = instance.onMessage(message => {
        if (message?.type === 'ds-superagent:classic-bound' && message.id === id) finish(message.bound === true)
      })
      const timer = setTimeout(() => finish(false), 3000)
      try { instance.send({ type: 'ds-superagent:classic-bind', id, cookie: grant, proof }) }
      catch { finish(false) }
    })
    return bound && scope === revision && instance === host ? grant : undefined
  }

  function install(session) {
    session.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] }, (details, callback) => {
      const url = new URL(details.url)
      const origin = url.origin.replace(/^ws:/u, 'http:')
      const contents = window()?.webContents
      const frame = details.frame
      const eligible = () => launchUrl?.origin === origin && contents && window()?.webContents === contents
        && contents.id === details.webContentsId && frame && frame === contents.mainFrame && details.initiatorOrigin === origin
      const attach = current => {
        if (!current || !eligible()) { callback({}); return }
        const requestHeaders = { ...details.requestHeaders }
        for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === 'cookie') delete requestHeaders[name]
        callback({ requestHeaders: { ...requestHeaders, Cookie: current } })
      }
      if (!eligible() || !url.pathname.startsWith('/api/')) { callback({}); return }
      if (details.resourceType === 'webSocket' && url.pathname === muxPath) {
        const scope = ++revision
        cookie = undefined
        void connect(host, launchUrl, scope).then(current => {
          if (scope === revision) cookie = current
          attach(current)
        }).catch(() => attach(undefined))
      } else attach(cookie)
    })
  }

  async function call(sender, endpoint, payload) {
    if (!endpoints.has(endpoint) || typeof payload?.instanceId !== 'string' || Object.keys(payload).length !== 1) {
      return failed('INVALID_INPUT', 'Classic Agent mode requires the current Instance.')
    }
    if (remote() || sender !== window()?.webContents || !launchUrl || !cookie) {
      return failed('CLASSIC_DENIED', 'Classic Agent mode is available from the local desktop window only.')
    }
    try {
      const response = await request(new URL('/api/product', launchUrl), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', Cookie: cookie, 'x-ds-superagent-desktop-proof': proof },
        body: JSON.stringify({ endpoint, payload }),
      })
      return await response.json()
    } catch { return failed('CLASSIC_UNAVAILABLE', 'The Classic Agent request could not reach the local Host.') }
  }

  return { replaceHost, revoke, install, call }
}
