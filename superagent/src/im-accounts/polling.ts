import { FeishuApiError, FeishuOpenApi } from '../feishu-api.js'
import { clip, digest, id, ImFailure, list, message, object, pause, request, required } from './transport.js'
import type { ImAdapter, ImTransport } from './types.js'

export function feishuAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'feishu', fields: [
      { name: 'appId', label: 'App ID', secret: false }, { name: 'appSecret', label: 'App secret', secret: true },
      { name: 'chatId', label: 'Direct chat ID', secret: false },
    ],
    async connect(credentials, signal) {
      const appId = required(credentials.appId)
      const appSecret = required(credentials.appSecret)
      const chatId = required(credentials.chatId)
      if (!/^cli_[A-Za-z0-9]+$/u.test(appId) || !/^oc_[A-Za-z0-9]+$/u.test(chatId)) throw new ImFailure('IM_AUTH_FAILED')
      const api = new FeishuOpenApi({ appId, appSecret, lookbackSeconds: 0, acknowledgePages: true, requestTimeoutMs: 15_000,
        ...(transport.fetch ? { fetch: transport.fetch } : {}), ...(transport.now ? { now: transport.now } : {}) })
      try {
        const chats = await api.check([chatId], signal)
        if (chats[0]?.chatType !== 'p2p') throw new ImFailure('IM_AUTH_FAILED')
      } catch (error) {
        if (error instanceof FeishuApiError && (error.httpStatus === 401 || error.httpStatus === 403 || error.code === 'SOURCE_AUTH_REQUIRED')) {
          throw new ImFailure('IM_AUTH_FAILED')
        }
        throw error
      }
      return {
        account: appId,
        async receive(hooks, active) {
          let cursor = await hooks.cursor()
          if (!cursor) {
            cursor = `${String((transport.now ?? Date.now)()).padStart(16, '0')}:`
            await hooks.checkpoint(cursor)
          }
          while (!active.aborted) {
            const page = await api.listEvents({ tenantKey: '', chatIds: [chatId], cursor, signal: active })
            hooks.ready()
            for (const event of page.events) {
              if (event.cursor <= cursor) continue
              if (!event.deleted && !event.edited && event.senderKind === 'human' && event.chatType === 'p2p' && !event.resource) {
                const incoming = message(event.senderId, event.chatId, event.messageId, event.text)
                if (incoming) await hooks.message(incoming)
              }
              cursor = event.cursor
            }
            if (page.events.length) await hooks.checkpoint(cursor)
            api.acknowledgePage()
            await pause(2000, active)
          }
        },
        async send(address, text, key, active) {
          try {
            return (await api.replyMessage({ messageId: address.messageId, text: clip(text, 4000),
              uuid: digest(key).slice(0, 32), signal: active })).messageId
          } catch (error) {
            if (error instanceof FeishuApiError) {
              if (error.httpStatus === 429) throw new ImFailure('IM_UNAVAILABLE', 5000)
              if (error.feishuCode && (!error.httpStatus || error.httpStatus < 500)) throw new ImFailure('IM_SEND_REJECTED')
            }
            throw new ImFailure('IM_SEND_UNKNOWN')
          }
        },
        stop: () => api.clear(),
      }
    },
  }
}

export function telegramAdapter(transport: ImTransport): ImAdapter {
  return {
    platform: 'telegram', fields: [{ name: 'botToken', label: 'Bot token', secret: true }],
    async connect(credentials, signal) {
      const token = credentials.botToken
      if (!token || !/^\d{4,20}:[A-Za-z0-9_-]{20,128}$/u.test(token)) throw new ImFailure('IM_AUTH_FAILED')
      const call = async (operation: 'getMe' | 'getUpdates' | 'sendMessage', body: Record<string, unknown>, active: AbortSignal) => {
        const sending = operation === 'sendMessage'
        const result = await request(transport, `https://api.telegram.org/bot${token}/${operation}`, {
          signal: active, body, sending, timeout: operation === 'getUpdates' ? 40_000 : 15_000,
        })
        if (result.ok !== true) {
          if (result.error_code === 429) {
            const seconds = Number(object(result.parameters).retry_after)
            throw new ImFailure('IM_UNAVAILABLE', Math.min(300_000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000))
          }
          if (sending) throw new ImFailure('IM_SEND_REJECTED')
          if (result.error_code === 401 || result.error_code === 403) throw new ImFailure('IM_AUTH_FAILED')
          throw new ImFailure('IM_UNAVAILABLE')
        }
        return result.result
      }
      const identity = object(await call('getMe', {}, signal))
      if (identity.is_bot !== true || !id(identity.id)) throw new ImFailure('IM_AUTH_FAILED')
      return {
        account: required(identity.id),
        async receive(hooks, active) {
          let offset = Number(await hooks.cursor())
          if (!Number.isSafeInteger(offset) || offset < 0) offset = 0
          while (!active.aborted) {
            const entries = list(await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, active))
            hooks.ready()
            for (const update of entries.map(object)) {
              const next = typeof update.update_id === 'number' ? update.update_id + 1 : 0
              if (!Number.isSafeInteger(next) || next < 1 || next <= offset) continue
              const item = object(update.message)
              const chat = object(item.chat)
              const sender = object(item.from)
              if (chat.type === 'private' && sender.is_bot === false && id(sender.id) === id(chat.id)) {
                const incoming = message(sender.id, chat.id, item.message_id, item.text)
                if (incoming) await hooks.message(incoming)
              }
              await hooks.checkpoint(String(next))
              offset = next
            }
            if (!entries.length) await pause(250, active)
          }
        },
        async send(address, text, _key, active) {
          const result = object(await call('sendMessage', {
            chat_id: address.conversationId, text: clip(text, 4096), link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: Number(address.messageId), allow_sending_without_reply: true },
          }, active))
          if (!id(result.message_id)) throw new ImFailure('IM_SEND_UNKNOWN')
          return id(result.message_id)
        },
      }
    },
  }
}
