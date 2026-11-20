import { createElement as h, useEffect, useMemo, useState } from 'react'
import { t } from './i18n.js'
import { imQrSvg } from './im-qr.js'

export const IM_ENDPOINTS = Object.freeze(['im-registry', 'im-save', 'im-pair', 'im-login'])

export const PRODUCT_IM_PLATFORMS = Object.freeze([
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    fields: [
      { key: 'domain', label: 'Edition', defaultValue: 'feishu', options: [
        { value: 'feishu', label: 'Feishu' },
        { value: 'lark', label: 'Lark' },
      ] },
      { key: 'appId', label: 'App ID', required: true },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true },
    ],
    buttons: true,
    groups: true,
  },
  {
    id: 'dingtalk',
    name: 'DingTalk',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
    ],
    buttons: false,
    groups: true,
  },
  {
    id: 'wecom',
    name: 'WeCom',
    fields: [
      { key: 'botId', label: 'Bot ID', required: true },
      { key: 'secret', label: 'Secret', required: true, secret: true },
    ],
    buttons: true,
    groups: true,
  },
  {
    id: 'qq',
    name: 'QQ',
    fields: [
      { key: 'appId', label: 'App ID', required: true },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true },
    ],
    buttons: false,
    groups: true,
  },
  {
    id: 'weixin',
    name: 'WeChat',
    fields: [],
    buttons: false,
    groups: false,
    login: 'qr',
  },
  {
    id: 'discord',
    name: 'Discord',
    fields: [{ key: 'token', label: 'Bot token', required: true, secret: true }],
    buttons: true,
    groups: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    fields: [
      { key: 'appToken', label: 'App-Level Token', required: true, secret: true },
      { key: 'botToken', label: 'Bot Token', required: true, secret: true },
    ],
    buttons: true,
    groups: true,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    fields: [{ key: 'token', label: 'Bot token', required: true, secret: true }],
    buttons: true,
    groups: true,
  },
])

export function createImCommandId(prefix = 'im') {
  const random = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

export function createProductImApi(call, binding = {}) {
  if (typeof call !== 'function') throw new TypeError('The product IM API needs a call function.')
  const instanceId = () => {
    const value = binding?.instanceId
    if (typeof value !== 'string' || value.trim() === '') throw new Error(t('The product Instance is unavailable.'))
    return value
  }
  const request = (endpoint, payload) => call(endpoint, payload)
  const command = (prefix, supplied) => typeof supplied === 'string' && supplied.trim() !== '' ? supplied : createImCommandId(prefix)
  const api = {
    registry: () => request('im-registry', { instanceId: instanceId() }),
    add: ({ platform, fields, enabled = true, commandId } = {}) => request('im-save', {
      instanceId: instanceId(), commandId: command('im-add', commandId), op: 'add', platform, fields, enabled,
    }),
    update: ({ id, fields, enabled, commandId } = {}) => request('im-save', {
      instanceId: instanceId(), commandId: command('im-update', commandId), op: 'update', id,
      ...(fields === undefined ? {} : { fields }),
      ...(enabled === undefined ? {} : { enabled }),
    }),
    remove: ({ id, commandId } = {}) => request('im-save', {
      instanceId: instanceId(), commandId: command('im-remove', commandId), op: 'remove', id,
    }),
    pair: ({ id, senderId, allow = true, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-pair', commandId), id, op: 'pair', senderId, allow,
    }),
    unpair: ({ id, senderId, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-unpair', commandId), id, op: 'unpair', senderId,
    }),
    chats: ({ id, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-chat', commandId), id, op: 'chat',
    }),
    removeChat: ({ id, chatKey, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-chat-remove', commandId), id, op: 'chat', chatKey, remove: true,
    }),
    retry: ({ id, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-retry', commandId), id, op: 'retry',
    }),
    send: ({ id, chatKey, body, commandId } = {}) => request('im-pair', {
      instanceId: instanceId(), commandId: command('im-send', commandId), id, op: 'send', chatKey, body,
    }),
    loginStart: ({ platform, commandId } = {}) => request('im-login', {
      instanceId: instanceId(), commandId: command('im-login', commandId), op: 'start', platform,
    }),
    loginWait: ({ loginId, commandId } = {}) => request('im-login', {
      instanceId: instanceId(), commandId: command('im-login-wait', commandId), op: 'wait', loginId,
    }),
  }
  return Object.freeze(api)
}

const STATE_TEXT = {
  ready: 'Connected',
  connecting: 'Connecting...',
  retrying: 'Retrying...',
  error: 'Needs attention',
  off: 'Stopped',
}

function platformOf(id) {
  return PRODUCT_IM_PLATFORMS.find(platform => platform.id === id) ?? {
    id, name: id, fields: [], buttons: false, groups: false,
  }
}

function stateText(connection) {
  if (!connection.enabled) return t('Disabled')
  if (connection.state === 'error' && connection.lastError) return `${t(STATE_TEXT.error)}: ${connection.lastError}`
  return t(STATE_TEXT[connection.state] ?? 'Stopped')
}

function missingFields(platform, fields) {
  return platform.fields.some(field => field.required && String(fields[field.key] ?? '').trim() === '')
}

function secondsLeft(expiresAt, now) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function ProductImSettings({ binding, call, qrRenderer, registryPollMs = 3000, loginPollMs = 1500 }) {
  const api = useMemo(() => createProductImApi(call, binding), [call, binding])
  const [registry, setRegistry] = useState(null)
  const [adding, setAdding] = useState(null)
  const [fields, setFields] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [login, setLogin] = useState(null)
  const [loginStatus, setLoginStatus] = useState('waiting')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let active = true
    void api.registry().then(result => {
      if (active) setRegistry(result)
    }).catch(failure => {
      if (active) setError(failure?.message ?? String(failure))
    })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    let active = true
    const timer = setInterval(() => {
      void api.registry().then(result => {
        if (active) setRegistry(result)
      }).catch(() => {
        // Keep the last visible state; explicit actions still report their own failure.
      })
    }, Math.max(10, registryPollMs))
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, registryPollMs])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!login) return undefined
    let active = true
    let timer
    const poll = async () => {
      if (!active) return
      if (Date.now() >= login.expiresAt) {
        setLoginStatus('expired')
        return
      }
      timer = setTimeout(async () => {
        if (!active) return
        try {
          const answer = await api.loginWait({ loginId: login.loginId })
          if (!active) return
          setLoginStatus(answer.status)
          if (answer.status === 'done') {
            setLogin(null)
            setAdding(null)
            setError(null)
            try {
              const result = await api.registry()
              if (active) setRegistry(result)
            } catch {
              // The registry poll retries; the completed login remains saved on the Host.
            }
            return
          }
          if (answer.status === 'expired') return
          void poll()
        } catch (failure) {
          if (!active) return
          setLoginStatus('error')
          setError(failure?.message ?? String(failure))
        }
      }, Math.max(10, loginPollMs))
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [login?.loginId, login?.expiresAt, api, loginPollMs])

  const reload = async () => {
    const result = await api.registry()
    setRegistry(result)
    return result
  }

  const run = async operation => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await operation()
      await reload()
      return result
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const startAdding = platform => {
    setAdding(platform.id)
    setFields(Object.fromEntries(platform.fields.map(field => [field.key, field.defaultValue ?? ''])))
    setLogin(null)
    setLoginStatus('waiting')
    setError(null)
  }

  const add = () => {
    const platform = platformOf(adding)
    void run(async () => {
      await api.add({ platform: platform.id, fields })
      setAdding(null)
      setFields({})
    })
  }

  const beginLogin = platform => {
    void run(async () => {
      const started = await api.loginStart({ platform: platform.id })
      setLogin(started)
      setLoginStatus('waiting')
    })
  }

  const connections = registry?.connections ?? []
  const shownPlatforms = registry?.platforms ?? PRODUCT_IM_PLATFORMS
  const activePlatform = adding === null ? null : platformOf(adding)
  const loginExpired = login !== null && login.expiresAt <= now

  return h('div', { className: 'bt-im-page', 'data-product-im': true },
    error ? h('div', { className: 'bt-im-banner', role: 'alert' }, error) : null,
    activePlatform
      ? h('section', { className: 'bt-set-section' },
        h('div', { className: 'bt-app-sub-head' }, h('h3', null, t(activePlatform.name)),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
            onClick: () => { setAdding(null); setLogin(null); setFields({}) } }, t('Back'))),
        activePlatform.login === 'qr'
          ? h('div', { className: 'bt-set-card bt-im-qr-box' },
            login && !loginExpired && loginStatus !== 'expired'
              ? qrRenderer
                ? qrRenderer({ text: login.qr, expiresAt: login.expiresAt })
                : h('div', { className: 'bt-im-qr-rendered',
                  dangerouslySetInnerHTML: { __html: imQrSvg(login.qr, 'bt-im-qr', t('WeChat pairing QR code')) } })
              : h('span', { className: 'bt-im-qr-blank', 'aria-hidden': true }),
            h('p', { className: 'bt-im-qr-caption', role: 'status' },
              loginExpired || loginStatus === 'expired'
                ? t('Code expired')
                : loginStatus === 'scanned' ? t('Scanned. Confirm on your phone.') : login ? t('Scan with WeChat') : t('Ready to request a code.')),
            h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy,
              onClick: () => beginLogin(activePlatform) }, t(loginExpired || loginStatus === 'expired' ? 'Get a new code' : 'Start login')))
          : h('div', { className: 'bt-set-card bt-im-form' },
            activePlatform.fields.map(field => h('label', { key: field.key, className: 'bt-set-row' },
              h('span', { className: 'bt-set-copy' }, t(field.label)),
              field.options
                ? h('select', { className: 'bt-input', value: fields[field.key] ?? field.defaultValue ?? '',
                  onChange: event => setFields(current => ({ ...current, [field.key]: event.target.value })) },
                field.options.map(option => h('option', { key: option.value, value: option.value }, t(option.label))))
                : h('input', { className: 'bt-input', type: field.secret ? 'password' : 'text', autoComplete: 'off', spellCheck: false,
                  'aria-label': t(field.label), placeholder: t(field.hint ?? field.label), value: fields[field.key] ?? '',
                  onChange: event => setFields(current => ({ ...current, [field.key]: event.target.value })) }))),
            h('div', { className: 'bt-im-foot' },
              h('span', { className: 'bt-im-hint' }, t('Credentials stay in the Host and are never shown again.')),
              h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || missingFields(activePlatform, fields),
                onClick: add }, t('Connect')))))
      : h('div', { className: 'bt-im-page' },
        h('section', { className: 'bt-set-section' },
          h('h3', null, t('IM connections')),
          connections.length === 0
            ? h('div', { className: 'bt-set-card bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No IM platforms are connected.')))
            : h('div', { className: 'bt-set-card' }, connections.map(connection => {
              const platform = platformOf(connection.platform)
              const pending = connection.pairRequests.filter(request => request.expiresAt > now)
              return h('div', { key: connection.id, className: 'bt-set-section' },
                h('div', { className: 'bt-set-row bt-im-head', 'data-state': connection.state },
                  h('span', { className: 'bt-set-copy' },
                    h('span', { className: 'bt-im-title' }, t(platform.name)),
                    h('span', { className: 'bt-im-status' }, stateText(connection))),
                  h('span', { className: 'bt-set-control bt-im-actions' },
                    connection.state === 'error'
                      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                        onClick: () => void run(() => api.retry({ id: connection.id })) }, t('Try again'))
                      : null,
                    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                      onClick: () => void run(() => api.update({ id: connection.id, enabled: !connection.enabled })) },
                    t(connection.enabled ? 'Disable' : 'Enable')),
                    h('button', { type: 'button', className: 'bt-mini bt-im-danger', disabled: busy,
                      onClick: () => { if (globalThis.confirm?.(t('Remove this IM connection?'))) void run(() => api.remove({ id: connection.id })) } },
                    t('Remove')))),
                pending.length
                  ? h('div', { className: 'bt-set-card bt-im-attn' }, pending.map(request => h('div', { key: request.id, className: 'bt-set-row' },
                    h('span', { className: 'bt-set-copy' },
                      h('span', { className: 'bt-im-name' }, request.name),
                      h('span', { className: 'bt-set-hint' }, t('Waiting for approval. Expires in {seconds}s.', {
                        seconds: secondsLeft(request.expiresAt, now),
                      }))),
                    h('span', { className: 'bt-set-control bt-im-actions' },
                      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                        onClick: () => void run(() => api.pair({ id: connection.id, senderId: request.id, allow: false })) }, t('Deny')),
                      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy,
                        onClick: () => void run(() => api.pair({ id: connection.id, senderId: request.id, allow: true })) }, t('Allow'))))))
                  : null,
                connection.paired.length
                  ? h('div', { className: 'bt-set-card' }, connection.paired.map(account => h('div', { key: account.id, className: 'bt-set-row' },
                    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-im-name' }, account.name)),
                    h('button', { type: 'button', className: 'bt-mini bt-im-danger', disabled: busy,
                      onClick: () => void run(() => api.unpair({ id: connection.id, senderId: account.id })) }, t('Unpair')))))
                  : h('p', { className: 'bt-set-hint' }, t('Send a direct message or mention the bot to request pairing.')))
            }))),
        h('section', { className: 'bt-app-section' },
          h('div', { className: 'bt-app-section-head' }, h('h3', null, t('Add an IM connection'))),
          h('div', { className: 'bt-app-grid' }, shownPlatforms.map(platform => h('div', { key: platform.id, className: 'bt-app' },
            h('button', { type: 'button', className: 'bt-app-main', disabled: busy, onClick: () => startAdding(platform) },
              h('span', { className: 'bt-app-text' },
                h('span', { className: 'bt-app-name' }, t(platform.name)),
                h('span', { className: 'bt-app-status' }, platform.login === 'qr' ? t('Pair with a code') : t('Connect with credentials')))),
            h('button', { type: 'button', className: 'bt-app-btn', disabled: busy, onClick: () => startAdding(platform) },
              t(platform.login === 'qr' ? 'Pair' : 'Connect'))))))))
}

export const IM_CSS = `
.bt-im-page{gap:20px}
.bt-im-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.bt-im-head{align-items:flex-start}
.bt-im-title{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink)}
.bt-im-name{font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-im-status{display:block;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
[data-state=error] .bt-im-status{color:var(--bt-danger)}
.bt-im-attn{border-color:color-mix(in srgb,var(--bt-accent) 35%,var(--bt-line))}
.bt-im-form .bt-set-row{min-height:56px}
.bt-im-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px}
.bt-im-hint{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-im-banner{padding:10px 12px;border-radius:12px;background:var(--bt-danger-soft);color:var(--bt-danger);font-size:12px;line-height:16px}
.bt-im-qr-box{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px 12px}
.bt-im-qr-rendered{width:184px;height:184px;padding:8px;box-sizing:border-box;border-radius:12px;background:#fff;box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-im-qr{display:block;width:100%;height:100%;shape-rendering:crispEdges}
.bt-im-qr-blank{display:block;width:184px;height:184px;border-radius:12px;background:var(--bt-hover)}
.bt-im-qr-caption{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2);text-align:center}
.bt-im-danger:hover{color:var(--bt-danger)}
`
