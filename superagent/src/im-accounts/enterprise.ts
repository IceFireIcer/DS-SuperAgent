import { randomUUID } from 'node:crypto'
import { clip, digest, ImFailure, ImSocket, list, message, object, request, required, socketUrl, str, type Json } from './transport.js'
import type { ImAdapter, ImTransport } from './types.js'

const dingRobotTopic = '/v1.0/im/bot/messages/get'

export function dingtalkAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'dingtalk', fields: [{ name: 'clientId', label: 'Client ID', secret: false }, { name: 'clientSecret', label: 'Client secret', secret: true }],
    async connect(credentials, signal) {
      const clientId = required(credentials.clientId)
      const clientSecret = required(credentials.clientSecret)
      const now = transport.now ?? Date.now
      const base = 'https://api.dingtalk.com/v1.0'
      let access: { token: string; expiresAt: number } | undefined
      const authorize = async (active: AbortSignal) => {
        if (access && now() < access.expiresAt) return access.token
        const result = await request(transport, `${base}/oauth2/accessToken`, { signal: active, body: { appKey: clientId, appSecret: clientSecret } })
        const token = str(result.accessToken)
        if (!token) throw new ImFailure('IM_AUTH_FAILED')
        const seconds = Math.max(15, Math.min(Number(result.expireIn) || 7200, 7200))
        access = { token, expiresAt: now() + (seconds - 10) * 1000 }
        return token
      }
      await authorize(signal)
      const response = await request(transport, `${base}/gateway/connections/open`, { signal,
        body: { clientId, clientSecret, subscriptions: [{ type: 'CALLBACK', topic: dingRobotTopic }] } })
      const url = socketUrl(response.endpoint, host => host === 'dingtalk.com' || host.endsWith('.dingtalk.com'))
      url.searchParams.set('ticket', required(response.ticket))
      return {
        account: clientId,
        async receive(hooks, active) {
          const socket = new ImSocket(transport, url, active, async (frame, session) => {
            const headers = object(frame.headers)
            const topic = str(headers.topic)
            if (frame.type === 'SYSTEM' && topic === 'disconnect') throw new ImFailure('IM_UNAVAILABLE')
            if (frame.type === 'SYSTEM' && topic === 'ping') {
              session.send({ code: 200, headers: { messageId: required(headers.messageId), contentType: 'application/json' },
                message: 'OK', data: str(frame.data) })
              return
            }
            if (frame.type !== 'CALLBACK' || topic !== dingRobotTopic) return
            const deliveryId = required(headers.messageId)
            const data = object(JSON.parse(str(frame.data)))
            if (String(data.conversationType) === '1' && data.msgtype === 'text' && str(data.senderStaffId)) {
              const incoming = message(data.senderStaffId, data.conversationId, data.msgId, object(data.text).content)
              if (incoming) await hooks.message(incoming)
            }
            session.send({ code: 200, headers: { messageId: deliveryId, contentType: 'application/json' }, message: 'OK', data: '{}' })
          })
          await socket.opened
          socket.ready()
          hooks.ready()
          await socket.done
        },
        async send(address, text, _key, active) {
          const token = await authorize(active)
          const result = await request(transport, `${base}/robot/oToMessages/batchSend`, {
            signal: active, sending: true, headers: { 'x-acs-dingtalk-access-token': token },
            body: { robotCode: clientId, userIds: [address.senderId], msgKey: 'sampleText', msgParam: JSON.stringify({ content: clip(text, 3600) }) },
          })
          if (list(result.flowControlledStaffIdList).includes(address.senderId)) throw new ImFailure('IM_UNAVAILABLE', 5000)
          if (list(result.invalidStaffIdList).includes(address.senderId)) throw new ImFailure('IM_SEND_REJECTED')
          if (!str(result.processQueryKey)) throw new ImFailure('IM_SEND_UNKNOWN')
          return str(result.processQueryKey)
        },
      }
    },
  }
}

export function wecomAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'wecom', fields: [{ name: 'botId', label: 'Bot ID', secret: false }, { name: 'secret', label: 'Bot secret', secret: true }],
    async connect(credentials) {
      const botId = required(credentials.botId)
      const secret = required(credentials.secret)
      let current: ImSocket | undefined
      const pending = new Map<string, (result: Json) => void>()
      const roundTrip = async (socket: ImSocket, command: string, requestId: string, body: Json | undefined, sending: boolean,
        active: AbortSignal) => {
        const signal = AbortSignal.any([active, socket.signal, AbortSignal.timeout(10_000)])
        signal.throwIfAborted()
        if (pending.size >= 50 || pending.has(requestId)) throw new ImFailure('IM_UNAVAILABLE')
        return new Promise<Json>((resolve, reject) => {
          const cleanup = () => { pending.delete(requestId); signal.removeEventListener('abort', abort) }
          const abort = () => { cleanup(); reject(new ImFailure(sending ? 'IM_SEND_UNKNOWN' : 'IM_UNAVAILABLE')) }
          signal.addEventListener('abort', abort, { once: true })
          pending.set(requestId, result => { cleanup(); resolve(result) })
          try { socket.send({ cmd: command, headers: { req_id: requestId }, ...(body ? { body } : {}) }) }
          catch { abort() }
        })
      }
      return {
        account: botId,
        async receive(hooks, active) {
          let heartbeat: NodeJS.Timeout | undefined
          const socket = new ImSocket(transport, new URL('wss://openws.work.weixin.qq.com'), active, async (frame) => {
            const responseId = str(object(frame.headers).req_id)
            if (frame.cmd === 'aibot_msg_callback') {
              const data = object(frame.body)
              if (data.aibotid !== botId || data.chattype !== 'single' || data.msgtype !== 'text') return
              const senderId = object(data.from).userid
              const incoming = message(senderId, senderId, data.msgid, object(data.text).content)
              if (incoming) await hooks.message(incoming)
            } else if (frame.cmd === 'aibot_event_callback') {
              if (object(object(frame.body).event).eventtype === 'disconnected_event') throw new ImFailure('IM_UNAVAILABLE')
            } else if (responseId) pending.get(responseId)?.(frame)
          })
          try {
            await socket.opened
            const reply = await roundTrip(socket, 'aibot_subscribe', randomUUID(), { bot_id: botId, secret }, false, active)
            if (reply.errcode !== 0) throw new ImFailure('IM_AUTH_FAILED')
            current = socket
            socket.ready()
            hooks.ready()
            heartbeat = setInterval(() => {
              void roundTrip(socket, 'ping', randomUUID(), undefined, false, active).then(ack => {
                if (ack.errcode !== 0) socket.end()
              }).catch(() => socket.end())
            }, 30_000)
            heartbeat.unref()
            await socket.done
          } finally {
            clearInterval(heartbeat)
            if (current === socket) current = undefined
            socket.end()
          }
        },
        async send(address, text, key, active) {
          if (!current) throw new ImFailure('IM_UNAVAILABLE')
          const requestId = digest(key).slice(0, 32)
          const result = await roundTrip(current, 'aibot_send_msg', requestId, { chatid: address.senderId, chat_type: 1,
            msgtype: 'markdown', markdown: { content: clip(text, 1200) } }, true, active)
          if (result.errcode !== 0) throw new ImFailure('IM_SEND_REJECTED')
          return requestId
        },
      }
    },
  }
}
