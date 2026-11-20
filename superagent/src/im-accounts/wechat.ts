import { randomBytes } from 'node:crypto'
import { bearer, clip, digest, hasControls, ImFailure, list, message, object, pause, request, required, str } from './transport.js'
import type { ImAdapter, ImTransport } from './types.js'

const origin = 'https://ilinkai.weixin.qq.com'
const rest = '/ilink/bot'
const version = { channel_version: '2.4.10', bot_agent: 'DS-SuperAgent' }
const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x02040a) }
const loginTtl = 120_000

const botHeaders = (token?: string) => ({ ...appHeaders, AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'), ...(token ? bearer(token) : {}) })

function wechatOrigin(value: unknown) {
  try {
    const url = new URL(str(value))
    if (/^ilinkai(?:-[a-z0-9-]+)?\.weixin\.qq\.com$/u.test(url.hostname) && url.protocol === 'https:'
      && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash) return url.origin
  } catch { }
  throw new ImFailure('IM_UNAVAILABLE')
}

export interface WechatLogin {
  text: string
  expiresAt: number
  state: 'waiting' | 'scanned' | 'verify' | 'expired' | 'failed'
  controller: AbortController
  submitCode(code: string): void
  finish(): Promise<Record<string, string> | undefined>
}

export async function startWechatLogin(transport: ImTransport, parent: AbortSignal): Promise<WechatLogin> {
  const now = transport.now ?? Date.now
  const expiresAt = now() + loginTtl
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(loginTtl)
  const signal = AbortSignal.any([parent, controller.signal, timeout])
  const login = await request(transport, `${origin}${rest}/get_bot_qrcode?bot_type=3`, {
    signal, headers: botHeaders(), body: { local_token_list: [] },
  })
  const qrText = str(login.qrcode_img_content)
  let qrCode = str(login.qrcode)
  if (!qrText || Buffer.byteLength(qrText) > 1800 || !qrCode || qrCode.length > 2048) throw new ImFailure('IM_UNAVAILABLE')
  let code: string | undefined
  let attempts = 0
  const challenge: WechatLogin = {
    text: qrText, expiresAt, state: 'waiting', controller,
    submitCode(value) {
      if (signal.aborted || now() >= expiresAt || code) return
      code = value
    },
    async finish() {
      let statusOrigin = origin
      try {
        while (!signal.aborted && now() < expiresAt) {
          if (challenge.state === 'verify' && !code) {
            await pause(200, signal)
            continue
          }
          const query = new URLSearchParams({ qrcode: qrCode })
          if (code) {
            if (attempts++ >= 3) { challenge.state = 'failed'; return }
            query.set('verify_code', code)
            code = undefined
          }
          let status
          try {
            status = await request(transport, `${statusOrigin}${rest}/get_qrcode_status?${query}`, { signal, headers: appHeaders, timeout: 35_000 })
          } catch (error) {
            if (!(error instanceof ImFailure) || error.code !== 'IM_UNAVAILABLE') throw error
            await pause(error.retryAfterMs ?? 1000, signal)
            continue
          }
          if (signal.aborted || now() >= expiresAt) break
          const state = str(status.status)
          if (state === 'confirmed') {
            const token = required(status.bot_token)
            const botId = required(status.ilink_bot_id)
            const baseUrl = wechatOrigin(status.baseurl || statusOrigin)
            return { token, botId, baseUrl }
          }
          if (state === 'expired') { challenge.state = 'expired'; return }
          if (state === 'verify_code_blocked' || state === 'binded_redirect') { challenge.state = 'failed'; return }
          if (state === 'scaned_but_redirect') {
            statusOrigin = wechatOrigin(`https://${required(status.redirect_host)}`)
            challenge.state = 'scanned'
          } else if (state.includes('need_verifycode')) challenge.state = 'verify'
          else if (state === 'scaned') challenge.state = 'scanned'
          else if (state === 'wait') challenge.state = 'waiting'
          else throw new ImFailure('IM_UNAVAILABLE')
          await pause(750, signal)
        }
        challenge.state = 'expired'
      } catch (error) {
        if (timeout.aborted || now() >= expiresAt) challenge.state = 'expired'
        else if (!signal.aborted) throw error
      } finally {
        code = undefined
        qrCode = ''
        challenge.text = ''
      }
    },
  }
  return challenge
}

export function wechatAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'wechat', fields: [{ name: 'token', label: 'Bot token', secret: true }, { name: 'botId', label: 'Bot ID', secret: false },
      { name: 'baseUrl', label: 'API URL', secret: false }],
    async connect(credentials) {
      const token = required(credentials.token)
      const botId = required(credentials.botId)
      const baseUrl = wechatOrigin(credentials.baseUrl)
      return {
        account: botId,
        async receive(hooks, active) {
          let cursor = await hooks.cursor() ?? ''
          while (!active.aborted) {
            const result = await request(transport, `${baseUrl}${rest}/getupdates`, { signal: active, timeout: 45_000,
              headers: botHeaders(token), body: { get_updates_buf: cursor, base_info: version } })
            const code = result.ret || result.errcode || 0
            if (code === -14) throw new ImFailure('IM_AUTH_FAILED')
            if (code !== 0 || !Array.isArray(result.msgs)) throw new ImFailure('IM_UNAVAILABLE')
            hooks.ready()
            for (const incoming of result.msgs.map(object)) {
              if (incoming.message_type !== 1 || incoming.group_id || incoming.delete_time_ms) continue
              const text = list(incoming.item_list).map(object).filter(item => item.type === 1)
                .map(item => str(object(item.text_item).text)).join('\n')
              const normalized = message(incoming.from_user_id, incoming.from_user_id, incoming.message_id ?? incoming.client_id, text)
              const contextToken = str(incoming.context_token)
              if (normalized && contextToken && contextToken.length <= 4096 && !hasControls(contextToken)) {
                await hooks.message({ ...normalized, contextToken })
              }
            }
            const next = str(result.get_updates_buf)
            if (next && next !== cursor) { await hooks.checkpoint(next); cursor = next }
            else await pause(250, active)
          }
        },
        async send(address, text, key, active) {
          if (!address.contextToken) throw new ImFailure('IM_UNAVAILABLE')
          const clientId = `superagent-${digest(key).slice(0, 32)}`
          const result = await request(transport, `${baseUrl}${rest}/sendmessage`, {
            signal: active, headers: botHeaders(token), sending: true, body: { base_info: version, msg: {
              from_user_id: '', to_user_id: address.senderId, client_id: clientId, message_type: 2, message_state: 2,
              context_token: address.contextToken, item_list: [{ type: 1, text_item: { text: clip(text, 4000) } }],
            } },
          })
          if (result.ret || result.errcode) throw new ImFailure('IM_SEND_REJECTED')
          return clientId
        },
      }
    },
  }
}
