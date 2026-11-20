import { clip, digest, id, ImFailure, ImSocket, message, object, request, required, socketUrl, str,
  type Json } from './transport.js'
import type { ImAdapter, ImReceiveHooks, ImTransport } from './types.js'

async function receiveGateway(transport: ImTransport, url: URL, token: string, intents: number, hooks: ImReceiveHooks,
  signal: AbortSignal, onEvent: (event: string, data: Json) => Promise<void>) {
  let interval: NodeJS.Timeout | undefined
  let sequence: number | null = null
  let awaitingHeartbeat = false
  let identified = false
  const socket = new ImSocket(transport, url, signal, async (frame, session) => {
    if (typeof frame.s === 'number') sequence = frame.s
    const data = object(frame.d)
    switch (frame.op) {
      case 10: {
        const heartbeatMs = data.heartbeat_interval
        if (identified || typeof heartbeatMs !== 'number' || !Number.isFinite(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 180_000) {
          throw new ImFailure('IM_UNAVAILABLE')
        }
        identified = true
        interval = setInterval(() => {
          if (awaitingHeartbeat) return session.end()
          try { session.send({ op: 1, d: sequence }); awaitingHeartbeat = true } catch { session.end() }
        }, heartbeatMs)
        interval.unref()
        session.send({ op: 2, d: { token, intents, properties: { os: process.platform, browser: 'DS SuperAgent', device: 'DS SuperAgent' } } })
        break
      }
      case 1:
        session.send({ op: 1, d: sequence })
        awaitingHeartbeat = true
        break
      case 11:
        awaitingHeartbeat = false
        break
      case 7:
      case 9:
        throw new ImFailure('IM_UNAVAILABLE')
      case 0:
        if (!identified) throw new ImFailure('IM_UNAVAILABLE')
        if (frame.t === 'READY') { session.ready(); hooks.ready() }
        else await onEvent(str(frame.t), data)
        break
    }
  })
  try { await socket.done } finally { clearInterval(interval) }
}

export function discordAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'discord', fields: [{ name: 'botToken', label: 'Bot token', secret: true }],
    async connect(credentials, signal) {
      const token = required(credentials.botToken)
      const headers = { Authorization: `Bot ${token}` }
      const base = 'https://discord.com/api/v10'
      const profile = await request(transport, `${base}/users/@me`, { signal, headers })
      if (profile.bot !== true) throw new ImFailure('IM_AUTH_FAILED')
      const account = required(profile.id)
      return {
        account,
        async receive(hooks, active) {
          await receiveGateway(transport, new URL('wss://gateway.discord.gg/?v=10&encoding=json'), token, 1 << 12, hooks, active, async (event, data) => {
            if (event !== 'MESSAGE_CREATE' || data.guild_id || data.webhook_id || data.type !== 0 && data.type !== 19) return
            const author = object(data.author)
            if (author.bot || author.system || author.id === account) return
            const incoming = message(author.id, data.channel_id, data.id, data.content)
            if (incoming) await hooks.message(incoming)
          })
        },
        async send(address, text, key, active) {
          const result = await request(transport, `${base}/channels/${encodeURIComponent(address.conversationId)}/messages`, {
            signal: active, headers, sending: true,
            body: { content: clip(text, 2000), nonce: digest(key).slice(0, 25), enforce_nonce: true, allowed_mentions: { parse: [] },
              message_reference: { message_id: address.messageId, fail_if_not_exists: false } },
          })
          if (!id(result.id)) throw new ImFailure('IM_SEND_UNKNOWN')
          return id(result.id)
        },
      }
    },
  }
}

export function qqAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'qq', fields: [{ name: 'appId', label: 'App ID', secret: false }, { name: 'clientSecret', label: 'Client secret', secret: true }],
    async connect(credentials, signal) {
      const appId = required(credentials.appId)
      const clientSecret = required(credentials.clientSecret)
      const now = transport.now ?? Date.now
      let access: { token: string; expiresAt: number } | undefined
      const base = 'https://api.sgroup.qq.com'
      const authorize = async (active: AbortSignal) => {
        if (access && now() < access.expiresAt) return access.token
        const answer = await request(transport, 'https://bots.qq.com/app/getAppAccessToken', { signal: active, body: { appId, clientSecret } })
        if (!str(answer.access_token)) throw new ImFailure('IM_AUTH_FAILED')
        const expiresIn = Math.max(15, Math.min(Number(answer.expires_in) || 3600, 7200))
        access = { token: str(answer.access_token), expiresAt: now() + (expiresIn - 10) * 1000 }
        return access.token
      }
      const token = `QQBot ${await authorize(signal)}`
      const endpoint = await request(transport, `${base}/gateway`, { signal, headers: { Authorization: token } })
      const gateway = socketUrl(endpoint.url, host => host === 'api.sgroup.qq.com' || host.endsWith('.sgroup.qq.com'))
      return {
        account: appId,
        async receive(hooks, active) {
          await receiveGateway(transport, gateway, token, 1 << 25, hooks, active, async (event, data) => {
            if (event !== 'C2C_MESSAGE_CREATE') return
            const senderId = object(data.author).user_openid
            const incoming = message(senderId, senderId, data.id, data.content)
            if (incoming) await hooks.message(incoming)
          })
        },
        async send(address, text, key, active) {
          const result = await request(transport, `${base}/v2/users/${encodeURIComponent(address.senderId)}/messages`, {
            signal: active, headers: { Authorization: `QQBot ${await authorize(active)}` }, sending: true,
            body: { content: clip(text, 2000), msg_type: 0, msg_id: address.messageId, msg_seq: Number.parseInt(digest(key).slice(0, 7), 16) + 1 },
          })
          if (!id(result.id)) throw new ImFailure('IM_SEND_UNKNOWN')
          return id(result.id)
        },
      }
    },
  }
}

export function slackAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'slack', fields: [{ name: 'botToken', label: 'Bot token', secret: true }, { name: 'appToken', label: 'App token', secret: true }],
    async connect(credentials, signal) {
      const botToken = required(credentials.botToken)
      const appToken = required(credentials.appToken)
      if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-')) throw new ImFailure('IM_AUTH_FAILED')
      const api = async (method: 'auth.test' | 'apps.connections.open' | 'chat.postMessage', token: string, body: Json, active: AbortSignal) => {
        const sending = method === 'chat.postMessage'
        const result = await request(transport, `https://slack.com/api/${method}`, { signal: active, headers: { Authorization: `Bearer ${token}` }, body, sending })
        if (result.ok !== true) throw new ImFailure(sending ? 'IM_SEND_REJECTED' : 'IM_AUTH_FAILED')
        return result
      }
      const profile = await api('auth.test', botToken, {}, signal)
      const team = required(profile.team_id)
      const user = required(profile.user_id)
      const response = await api('apps.connections.open', appToken, {}, signal)
      const url = socketUrl(response.url, host => /^wss(?:-[a-z0-9-]+)?\.slack\.com$/u.test(host))
      return {
        account: `${team}:${user}`,
        async receive(hooks, active) {
          const socket = new ImSocket(transport, url, active, async (value, session) => {
            if (value.type === 'hello') { session.ready(); hooks.ready(); return }
            if (value.type === 'disconnect') throw new ImFailure('IM_UNAVAILABLE')
            if (!str(value.envelope_id)) return
            const envelopeId = required(value.envelope_id)
            const payload = object(value.payload)
            const event = object(payload.event)
            if (value.type === 'events_api' && payload.team_id === team && event.type === 'message' && event.channel_type === 'im'
              && !event.bot_id && !event.subtype && event.user !== user) {
              const incoming = message(event.user, event.channel, event.ts, event.text)
              if (incoming) await hooks.message(incoming)
            }
            session.send({ envelope_id: envelopeId })
          })
          await socket.done
        },
        async send(address, text, _key, active) {
          const result = await api('chat.postMessage', botToken, { channel: address.conversationId, text: clip(text, 4000),
            thread_ts: address.messageId, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false }, active)
          if (!str(result.ts)) throw new ImFailure('IM_SEND_UNKNOWN')
          return str(result.ts)
        },
      }
    },
  }
}
