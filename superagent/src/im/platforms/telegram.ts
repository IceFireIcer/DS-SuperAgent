import { platformError, networkError } from '../errors.js'
import {
  TELEGRAM_LIMIT,
  asArray,
  asRecord,
  buttonRows,
  chunkText,
  configString,
  jsonRequest,
  requireField,
  stringValue,
} from '../wire.js'
import type {
  ImAdapter,
  ImAdapterEnvironment,
  ImChat,
  ImSendRequest,
  ImSendResult,
} from '../types.js'

const CLOUD_API = 'https://api.telegram.org'
const POLL_TIMEOUT_SECONDS = 50

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nameOf(from: Record<string, unknown>): string {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
  return stringValue(from.username) !== '' ? `@${stringValue(from.username)}` : name || stringValue(from.id)
}

async function callApi(
  env: ImAdapterEnvironment,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const base = configString(env, 'api') ?? CLOUD_API
  const { response, body } = await jsonRequest(env, 'Telegram', `${base.replace(/\/+$/u, '')}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  }, signal)
  if (!response.ok || body.ok !== true) {
    const status = Number(body.error_code ?? response.status)
    const retryAfter = asRecord(body.parameters).retry_after
    throw platformError('Telegram', String(body.description ?? `answered ${response.status}`), {
      status,
      ...(retryAfter === undefined ? {} : { retryAfterMs: Number(retryAfter) * 1000 }),
    })
  }
  return body.result
}

function chatOf(chat: Record<string, unknown>, from: Record<string, unknown>): ImChat {
  const direct = chat.type === 'private'
  const title = stringValue(chat.title) || nameOf(from)
  return { key: stringValue(chat.id), kind: direct ? 'direct' : 'group', ...(title === '' ? {} : { title }) }
}

export const telegram: ImAdapter = {
  id: 'telegram',

  async check(fields, env) {
    const token = requireField(fields, 'token', 'the Bot token')
    const me = asRecord(await callApi(env, token, 'getMe'))
    if (typeof me.id !== 'number' || typeof me.username !== 'string') {
      throw platformError('Telegram', 'the token does not belong to a bot', { code: 'IM_ACCOUNT_INVALID', permanent: true })
    }
    return { account: { id: String(me.id), name: `@${me.username}` } }
  },

  async connect(fields, env, handlers) {
    const token = requireField(fields, 'token', 'the Bot token')
    const me = asRecord(await callApi(env, token, 'getMe'))
    const selfName = stringValue(me.username) === '' ? '' : `@${stringValue(me.username)}`
    const account = { id: stringValue(me.id), name: selfName || stringValue(me.id) }
    if (account.id === '') {
      throw platformError('Telegram', 'the token does not identify a bot', { code: 'IM_ACCOUNT_INVALID', permanent: true })
    }
    handlers.onStatus({ state: 'ready', account })

    let stopped = false
    const controller = new AbortController()
    const maxFailures = Number(env.config?.maxPollFailures ?? 5)
    let failures = 0

    const deliver = async (update: Record<string, unknown>) => {
      if (update.message !== undefined) {
        const message = asRecord(update.message)
        const chat = asRecord(message.chat)
        const from = asRecord(message.from)
        const raw = stringValue(message.text) || stringValue(message.caption)
        const entities = asArray(message.entities).map(asRecord)
        const repliedToBot = asRecord(asRecord(message.reply_to_message).from)
        const mentioned = chat.type !== 'private' && entities.some(entity => {
          const start = Number(entity.offset)
          const length = Number(entity.length)
          const token = Number.isInteger(start) && Number.isInteger(length) ? raw.slice(start, start + length) : ''
          if (entity.type === 'text_mention' && stringValue(asRecord(entity.user).id) === account.id) return true
          if (entity.type === 'mention' && selfName !== '' && token.toLowerCase() === selfName.toLowerCase()) return true
          return entity.type === 'bot_command' && selfName !== ''
            && new RegExp(`^/[^@\\s]+@${selfName.slice(1)}$`, 'iu').test(token)
        }) || chat.type !== 'private' && selfName !== '' && repliedToBot.is_bot === true
          && stringValue(repliedToBot.username).toLowerCase() === selfName.slice(1).toLowerCase()
        const text = mentioned && selfName !== ''
          ? raw.replaceAll(selfName, ' ').replace(/\s+/gu, ' ').trim()
          : raw
        await handlers.onMessage({
          chat: chatOf(chat, from),
          sender: { id: stringValue(from.id), name: nameOf(from) },
          text,
          mentioned,
          messageId: stringValue(message.message_id),
        })
        return
      }
      if (update.callback_query !== undefined) {
        const query = asRecord(update.callback_query)
        const message = asRecord(query.message)
        const chat = asRecord(message.chat)
        const from = asRecord(query.from)
        await callApi(env, token, 'answerCallbackQuery', { callback_query_id: query.id }, controller.signal).catch(() => {})
        await handlers.onAction({
          chat: chatOf(chat, from),
          sender: { id: stringValue(from.id), name: nameOf(from) },
          text: '',
          mentioned: true,
          messageId: stringValue(message.message_id),
          data: stringValue(query.data),
        })
      }
    }

    const poll = async () => {
      while (!stopped && failures < maxFailures) {
        try {
          const updates = await callApi(env, token, 'getUpdates', {
            offset: Number(env.runtime.get().offset ?? 0),
            timeout: Number(env.config?.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS),
            allowed_updates: ['message', 'callback_query'],
          }, controller.signal)
          failures = 0
          for (const raw of asArray(updates)) {
            const update = asRecord(raw)
            if (typeof update.update_id === 'number') env.runtime.set({ offset: update.update_id + 1 })
            await deliver(update).catch(error => env.log?.warn?.('telegram update failed: %s', reason(error)))
          }
        } catch (error) {
          if (stopped) return
          failures += 1
          handlers.onStatus({ state: 'retrying', error: reason(error) })
          if (failures >= maxFailures) {
            handlers.onStatus({ state: 'error', error: `Telegram stopped after ${maxFailures} failed polls` })
            return
          }
          const wait = Math.min(30_000, 250 * (2 ** (failures - 1)))
          await new Promise(resolve => {
            const timer = setTimeout(resolve, wait)
            timer.unref?.()
          })
        }
      }
    }
    void poll()

    return {
      async send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>): Promise<ImSendResult> {
        const chunks = chunkText(request.text, TELEGRAM_LIMIT)
        const buttons = buttonRows(request.buttons)
        let messageId: string | undefined
        for (const [index, text] of chunks.entries()) {
          const markup = index === chunks.length - 1 && buttons.length
            ? { reply_markup: { inline_keyboard: buttons.map(button => [{ text: button.label, callback_data: button.data }]) } }
            : {}
          const sent = asRecord(await callApi(env, token, 'sendMessage', {
            chat_id: chat.key,
            text,
            ...markup,
          }, controller.signal))
          if (sent.message_id !== undefined) messageId = stringValue(sent.message_id)
        }
        return messageId === undefined ? {} : { messageId }
      },
      async edit(chat, messageId, request) {
        const buttons = buttonRows(request.buttons)
        await callApi(env, token, 'editMessageText', {
          chat_id: chat.key,
          message_id: messageId,
          text: chunkText(request.text, TELEGRAM_LIMIT)[0] ?? '',
          ...(buttons.length ? { reply_markup: { inline_keyboard: buttons.map(button => [{ text: button.label, callback_data: button.data }]) } } : {}),
        }, controller.signal)
      },
      async typing(chat) {
        await callApi(env, token, 'sendChatAction', { chat_id: chat.key, action: 'typing' }, controller.signal).catch(() => {})
      },
      stop() {
        stopped = true
        controller.abort(new Error('stopped'))
      },
    }
  },
}

export function telegramError(error: unknown): never {
  if (error instanceof Error) throw networkError('Telegram', error)
  throw error
}
