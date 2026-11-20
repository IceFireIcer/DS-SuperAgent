import { platformError } from '../errors.js'
import {
  WECOM_LIMIT,
  asRecord,
  buttonRows,
  chunkText,
  closeSocket,
  configString,
  openSocket,
  requireField,
  safeJson,
  socketData,
  socketOn,
  socketReady,
  stringValue,
} from '../wire.js'
import type { ImAdapter, ImAdapterEnvironment, ImChat, ImSendRequest, ImSocket } from '../types.js'

const WSS = 'wss://openws.work.weixin.qq.com'

function socketUrl(env: ImAdapterEnvironment): string {
  return (configString(env, 'gateway') ?? configString(env, 'api') ?? WSS).replace(/\/+$/u, '')
}

function packetData(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') return safeJson(raw)
  if (raw instanceof Uint8Array) return safeJson(new TextDecoder().decode(raw))
  return safeJson(raw)
}

function nextRequestId(counter: { value: number }): string {
  counter.value += 1
  return `r${counter.value}`
}

export const wecom: ImAdapter = {
  id: 'wecom',

  async check(fields, env) {
    const botId = requireField(fields, 'botId', 'the Bot ID')
    const secret = requireField(fields, 'secret', 'the Secret')
    const socket = await openSocket(env, 'WeCom', socketUrl(env))
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error === undefined) resolve()
          else reject(error)
        }
        const timer = setTimeout(() => finish(platformError('WeCom', 'did not answer the subscription', {
          code: 'IM_TIMEOUT', retryable: true,
        })), Number(env.config?.checkTimeoutMs ?? 10_000))
        timer.unref?.()
        socketOn(socket, 'message', raw => {
          const packet = packetData(socketData(raw))
          if (packet.errcode === undefined) return
          if (Number(packet.errcode) === 0) finish()
          else finish(platformError('WeCom', stringValue(packet.errmsg) || `answered ${packet.errcode}`, {
            code: 'IM_ACCOUNT_INVALID',
            permanent: true,
          }))
        })
        socketOn(socket, 'error', error => finish(platformError('WeCom', error instanceof Error ? error.message : String(error), {
          code: 'IM_NETWORK', retryable: true,
        })))
        socket.send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'check-1' }, body: { secret, bot_id: botId } }))
      })
    } finally {
      closeSocket(socket)
    }
    return { account: { id: botId, name: botId } }
  },

  async connect(fields, env, handlers) {
    const botId = requireField(fields, 'botId', 'the Bot ID')
    const secret = requireField(fields, 'secret', 'the Secret')
    let stopped = false
    let socket: ImSocket | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let generation = 0
    let reconnectCount = 0
    const maxReconnects = Number(env.config?.maxReconnects ?? 5)
    const requestCounter = { value: 0 }
    const lastReqId = new Map<string, string>()
    const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
    const account = { id: botId, name: botId }

    const sendFrame = (packet: Record<string, unknown>) => {
      if (socketReady(socket)) socket!.send(JSON.stringify(packet))
    }

    const request = (cmd: string, body: Record<string, unknown>, reqId?: string): Promise<Record<string, unknown>> => {
      const id = reqId ?? nextRequestId(requestCounter)
      sendFrame({ cmd, headers: { req_id: id }, body })
      if (cmd !== 'aibot_send_msg') return Promise.resolve({})
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(platformError('WeCom', 'did not answer the send', { code: 'IM_TIMEOUT' }))
        }, Number(env.config?.sendTimeoutMs ?? 15_000))
        timer.unref?.()
        pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value) },
          reject: error => { clearTimeout(timer); reject(error) },
        })
      })
    }

    const callback = async (headers: Record<string, unknown>, body: Record<string, unknown>) => {
      const direct = body.chattype === 'single'
      const key = direct ? stringValue(asRecord(body.from).userid) : stringValue(body.chatid)
      lastReqId.set(key, stringValue(headers.req_id))
      const text = stringValue(asRecord(body.text).content) || stringValue(asRecord(body.voice).content)
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group' },
        sender: { id: stringValue(asRecord(body.from).userid), name: stringValue(asRecord(body.from).name) || stringValue(asRecord(body.from).userid) },
        text: text.trim(),
        mentioned: !direct && body.mention_robot === true,
        messageId: stringValue(body.msgid),
      })
    }

    const event = async (body: Record<string, unknown>) => {
      const eventBody = asRecord(body.event)
      if (stringValue(eventBody.event_type) !== 'template_card_event' && stringValue(body.event_type) !== 'template_card_event') return
      const card = asRecord(eventBody.template_card_event ?? body.template_card_event)
      const direct = body.chattype === 'single'
      await handlers.onAction({
        chat: { key: direct ? stringValue(asRecord(body.from).userid) : stringValue(body.chatid), kind: direct ? 'direct' : 'group' },
        sender: { id: stringValue(asRecord(body.from).userid) || stringValue(card.userid), name: '' },
        text: '',
        mentioned: true,
        messageId: stringValue(body.msgid),
        data: stringValue(card.event_key) || stringValue(card.key),
      })
    }

    const open = async () => {
      const gen = ++generation
      const target = await openSocket(env, 'WeCom', socketUrl(env))
      socket = target
      let subscribed = false
      const ready = new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error === undefined) resolve()
          else reject(error)
        }
        const timer = setTimeout(() => finish(platformError('WeCom', 'subscription timed out', { code: 'IM_TIMEOUT' })), 15_000)
        timer.unref?.()
        socketOn(target, 'message', raw => {
          if (stopped || generation !== gen) return
          const packet = packetData(socketData(raw))
          if (packet.errcode !== undefined) {
            if (Number(packet.errcode) !== 0) {
              const error = platformError('WeCom', stringValue(packet.errmsg) || `answered ${packet.errcode}`, {
                code: 'IM_SUBSCRIPTION_FAILED',
                permanent: true,
              })
              const reqId = stringValue(asRecord(packet.headers).req_id)
              const held = pending.get(reqId)
              if (held) {
                pending.delete(reqId)
                held.reject(error)
              }
              handlers.onStatus({ state: 'error', error: error.message })
              finish(error)
              return
            }
            const reqId = stringValue(asRecord(packet.headers).req_id)
            const held = pending.get(reqId)
            if (held) {
              pending.delete(reqId)
              held.resolve(asRecord(packet.body))
            }
            if (!subscribed) {
              subscribed = true
              reconnectCount = 0
              handlers.onStatus({ state: 'ready', account })
              finish()
            }
            return
          }
          if (packet.cmd === 'aibot_msg_callback') {
            void callback(asRecord(packet.headers), asRecord(packet.body))
              .catch(error => env.log?.warn?.('wecom message failed: %s', error instanceof Error ? error.message : error))
          } else if (packet.cmd === 'aibot_event_callback') {
            void event(asRecord(packet.body))
              .catch(error => env.log?.warn?.('wecom event failed: %s', error instanceof Error ? error.message : error))
          }
        })
        socketOn(target, 'error', error => {
          if (stopped || generation !== gen) return
          const failure = platformError('WeCom', error instanceof Error ? error.message : String(error), { code: 'IM_NETWORK' })
          finish(failure)
        })
      })
      sendFrame({ cmd: 'aibot_subscribe', headers: { req_id: nextRequestId(requestCounter) }, body: { secret, bot_id: botId } })
      await ready
      socketOn(target, 'close', () => {
        clearInterval(pingTimer)
        if (stopped || generation !== gen) return
        if (reconnectCount >= maxReconnects) {
          handlers.onStatus({ state: 'error', error: `WeCom stopped after ${maxReconnects} reconnects` })
          return
        }
        reconnectCount += 1
        handlers.onStatus({ state: 'retrying' })
        reconnect = setTimeout(() => {
          if (!stopped) void open().catch(error => handlers.onStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) }))
        }, Math.min(30_000, 500 * (2 ** reconnectCount)))
        reconnect.unref?.()
      })
      socketOn(target, 'error', () => {})
      pingTimer = setInterval(() => {
        if (!stopped && socketReady(target)) sendFrame({ cmd: 'ping', headers: { req_id: nextRequestId(requestCounter) } })
      }, 30_000)
      pingTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    await open()

    return {
      async send(chat: ImChat, message: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(message.text, WECOM_LIMIT)
        const buttons = buttonRows(message.buttons, 10)
        let messageId: string | undefined
        for (const [index, chunk] of chunks.entries()) {
          const body: Record<string, unknown> = { msgtype: 'markdown', markdown: { content: chunk } }
          if (index === chunks.length - 1 && buttons.length) {
            body.msgtype = 'template_card'
            body.template_card = {
              card_type: 'text_notice',
              main_title: { title: chunk.slice(0, 100) },
              card_action: { type: 2, url: 'https://work.weixin.qq.com' },
              button_selection: { question_key: 'choice', option_list: buttons.map(button => ({ id: button.data, text: button.label.slice(0, 30) })) },
            }
          }
          const reqId = lastReqId.get(chat.key)
          if (reqId !== undefined) {
            sendFrame({ cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body })
          } else {
            const answer = await request('aibot_send_msg', {
              ...body,
              ...(chat.kind === 'group' ? { chatid: chat.key } : { userid: chat.key }),
            })
            if (answer.msgid !== undefined) messageId = stringValue(answer.msgid)
          }
        }
        return messageId === undefined ? {} : { messageId }
      },
      stop() {
        stopped = true
        generation += 1
        clearTimeout(reconnect)
        clearInterval(pingTimer)
        for (const held of pending.values()) held.reject(platformError('WeCom', 'stopped', { code: 'IM_STOPPED', permanent: true }))
        pending.clear()
        closeSocket(socket)
      },
    }
  },
}
