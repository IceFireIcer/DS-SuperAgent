import { LINK_PATH } from './frames.js'

export function parseRelayUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Enter a relay server URL.')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter a relay server URL.') }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a WSS relay or a loopback WS relay.')
  }
  if (url.pathname === '/') url.pathname = LINK_PATH
  return url.href
}
