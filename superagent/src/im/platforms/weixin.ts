import { randomBytes } from 'node:crypto'
import { platformError, networkError } from '../errors.js'
import {
  WEIXIN_LIMIT,
  asArray,
  asRecord,
  chunkText,
  configString,
  field,
  jsonRequest,
  requireField,
  stringValue,
} from '../wire.js'
import type { ImAdapter, ImAdapterEnvironment, ImChat, ImSendRequest } from '../types.js'

const QR_BASE = 'https://ilinkai.weixin.qq.com/'
const SESSION_EXPIRED = -14
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6

function withSlash(value: string): string {
  return `${value.replace(/\/+$/u, '')}/`
}

function qrBase(env: ImAdapterEnvironment): string {
  return withSlash(configString(env, 'qr') ?? configString(env, 'api') ?? QR_BASE)
}

function base(env: ImAdapterEnvironment, fields: Readonly<Record<string, string>>): string {
  return withSlash(field(fields, 'baseUrl') || configString(env, 'api') || QR_BASE)
}

function headers(token?: string): Record<string, string> {
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
    'content-type': 'application/json',
    'X-WECHAT-UIN': uin,
    ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}`, AuthorizationType: 'ilink_bot_token' }),
  }
}

async function request(
  env: ImAdapterEnvironment,
  baseUrl: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { response, body: answer } = await jsonRequest(env, 'WeChat', `${baseUrl}ilink/bot/${endpoint}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ ...body, base_info: { channel_version: 'ds-superagent' } }),
  }, signal)
  if (response.status === 429) {
    throw platformError('WeChat', 'rate limited the request', {
      status: 429,
      retryAfterMs: Number(response.headers.get('retry-after') || 1) * 1000,
    })
  }
  if (response.status === 401 || response.status === 403) {
    throw platformError('WeChat', 'refused the token', { status: response.status, code: 'IM_ACCOUNT_INVALID', permanent: true })
  }
  if (!response.ok) throw platformError('WeChat', `answered ${response.status}`, { status: response.status })
  return answer
}

function updatesAnswer(answer: Record<string, unknown>): boolean {
  return Array.isArray(answer.msgs) || typeof answer.get_updates_buf === 'string' || typeof answer.sync_buf === 'string'
}

async function checkToken(env: ImAdapterEnvironment, fields: Readonly<Record<string, string>>) {
  const answer = await request(env, base(env, fields), requireField(fields, 'token', 'the WeChat token'), 'getupdates', {
    get_updates_buf: '',
    timeout_ms: 0,
  })
  if (answer.ret !== undefined && Number(answer.ret) !== 0) {
    throw platformError('WeChat', `answered ${answer.ret}`, { code: 'IM_ACCOUNT_INVALID', permanent: true })
  }
  if (answer.ret === undefined && !updatesAnswer(answer)) {
    throw platformError('WeChat', 'answered an unreadable response', { code: 'IM_ACCOUNT_INVALID', permanent: true })
  }
}

export const weixin: ImAdapter = {
  id: 'weixin',

  async check(fields, env) {
    await checkToken(env, fields)
    return { account: { id: field(fields, 'ilinkBotId') || 'wechat', name: 'WeChat' } }
  },

  login: {
    async start(env) {
      const { response, body } = await jsonRequest(env, 'WeChat', `${qrBase(env)}ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ local_token_list: [] }),
      })
      if (!response.ok || body.qrcode === undefined) {
        throw platformError('WeChat', stringValue(body.errmsg) || 'did not return a login code', {
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        })
      }
      return {
        qr: stringValue(body.qrcode_img_content) || stringValue(body.qrcode),
        state: { qrcode: stringValue(body.qrcode) },
      }
    },
    async wait(state, env) {
      const qrcode = stringValue(asRecord(state).qrcode)
      if (qrcode === '') return { status: 'expired' }
      const { response, body } = await jsonRequest(env, 'WeChat', `${qrBase(env)}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
        method: 'GET',
        headers: headers(),
      })
      if (!response.ok) throw platformError('WeChat', `login status answered ${response.status}`, { status: response.status })
      const status = stringValue(body.status)
      if (status === 'expired' || status === 'invalid') return { status: 'expired' }
      if (status === 'scaned' || status === 'scaned_but_redirect' || status === 'binded_redirect') return { status: 'scanned' }
      if (status !== 'confirmed') return { status: 'waiting' }
      const botId = stringValue(body.ilink_bot_id)
      const ownerId = stringValue(body.ilink_user_id)
      return {
        status: 'done',
        connection: {
          fields: {
            token: stringValue(body.bot_token),
            baseUrl: stringValue(body.baseurl),
            ilinkBotId: botId,
          },
          account: { id: botId || 'wechat', name: 'WeChat' },
        },
        ...(ownerId === '' ? {} : { owner: { id: ownerId, name: ownerId } }),
      }
    },
  },

  async connect(fields, env, handlers) {
    const token = requireField(fields, 'token', 'the WeChat token')
    const baseUrl = base(env, fields)
    const controller = new AbortController()
    let stopped = false
    let failures = 0
    const maxFailures = Number(env.config?.maxPollFailures ?? 5)
    const contextTokens = () => asRecord(env.runtime.get().contextTokens)

    const start = await request(env, baseUrl, token, 'msg/notifystart', {}, controller.signal)
    const startCode = start.errcode ?? start.ret
    if (startCode !== undefined && Number(startCode) !== 0) {
      throw platformError('WeChat', Number(startCode) === SESSION_EXPIRED
        ? 'session expired; scan the login code again'
        : `did not start the session (${startCode})`,
      { code: 'IM_ACCOUNT_INVALID', permanent: true })
    }
    handlers.onStatus({ state: 'ready', account: { id: field(fields, 'ilinkBotId') || 'wechat', name: 'WeChat' } })

    const poll = async () => {
      while (!stopped && failures < maxFailures) {
        let answer: Record<string, unknown>
        try {
          answer = await request(env, baseUrl, token, 'getupdates', {
            get_updates_buf: stringValue(env.runtime.get().cursor),
          }, controller.signal)
        } catch (error) {
          if (stopped) return
          failures += 1
          handlers.onStatus({ state: 'retrying', error: error instanceof Error ? error.message : String(error) })
          if (failures >= maxFailures) {
            handlers.onStatus({ state: 'error', error: `WeChat stopped after ${maxFailures} failed polls` })
            return
          }
          await new Promise(resolve => {
            const timer = setTimeout(resolve, Math.min(30_000, 250 * (2 ** (failures - 1))))
            timer.unref?.()
          })
          continue
        }
        const code = answer.ret ?? answer.errcode
        if (Number(code) === SESSION_EXPIRED) {
          handlers.onStatus({ state: 'error', error: 'WeChat session expired; scan the login code again' })
          return
        }
        if (code !== undefined && Number(code) !== 0) {
          failures += 1
          if (Number(code) === 401 || Number(code) === 403) {
            handlers.onStatus({ state: 'error', error: `WeChat answered ${code}` })
            return
          }
          continue
        }
        failures = 0
        handlers.onStatus({ state: 'ready' })
        for (const raw of asArray(answer.msgs)) {
          const message = asRecord(raw)
          const sender = stringValue(message.from_user_id)
          const contextToken = stringValue(message.context_token)
          if (contextToken !== '') env.runtime.set({ contextTokens: { ...contextTokens(), [sender]: contextToken } })
          const text = asArray(message.item_list).map(asRecord).flatMap(item => {
            if (item.type === 1) return [stringValue(asRecord(item.text_item).text)]
            if (item.type === 3) return [stringValue(asRecord(item.voice_item).text)]
            return []
          }).join('\n').trim()
          await handlers.onMessage({
            chat: { key: sender, kind: 'direct' },
            sender: { id: sender, name: sender },
            text,
            mentioned: false,
            messageId: stringValue(message.client_id) || stringValue(message.message_id),
          })
        }
        if (answer.get_updates_buf !== undefined && answer.get_updates_buf !== env.runtime.get().cursor) {
          env.runtime.set({ cursor: stringValue(answer.get_updates_buf) })
        }
      }
    }
    void poll()

    return {
      async send(chat: ImChat, message: Omit<ImSendRequest, 'chat'>) {
        const chunks = chunkText(message.text, WEIXIN_LIMIT)
        let messageId: string | undefined
        for (const text of chunks) {
          const clientId = `ds-superagent-${randomBytes(8).toString('hex')}`
          const contextToken = stringValue(contextTokens()[chat.key])
          const answer = await request(env, baseUrl, token, 'sendmessage', {
            msg: {
              from_user_id: '',
              to_user_id: chat.key,
              client_id: clientId,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text } }],
              ...(contextToken === '' ? {} : { context_token: contextToken }),
            },
          }, controller.signal)
          if (answer.ret !== undefined && Number(answer.ret) !== 0) {
            throw platformError('WeChat', `refused the reply (${stringValue(answer.errmsg) || answer.ret})`, {
              code: 'IM_SEND_REFUSED',
              permanent: true,
            })
          }
          messageId = clientId
        }
        return messageId === undefined ? {} : { messageId }
      },
      stop() {
        stopped = true
        controller.abort(new Error('stopped'))
      },
    }
  },
}

export function weixinRequestError(error: unknown): never {
  throw networkError('WeChat', error)
}
