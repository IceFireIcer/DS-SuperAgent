import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const sourceState = state => ({
  setup: 'Feishu connecting', polling: 'Feishu receiving', failed: 'Feishu unavailable', stopped: 'Feishu stopped',
})[state] ?? 'Feishu unavailable'

export function FeishuSourceStatus({ instanceId, call }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!instanceId) return undefined
    let active = true
    const refresh = () => call('feishu-status', { instanceId }).then(result => {
      if (active) setStatus(result)
    }).catch(() => {
      if (active) setStatus({ configured: true, state: 'failed' })
    })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [instanceId, call])
  if (!status?.configured && status?.state !== 'failed') return null
  const running = status.state === 'polling' || status.state === 'setup'
  const control = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try { setStatus(await call(running ? 'feishu-stop' : 'feishu-start', { instanceId })) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return h('section', { className: 'bt-main-source', 'aria-label': t('Feishu connection') },
    h('div', { className: 'bt-main-work-head' },
      h('strong', null, t('Feishu connection')),
      h('span', { className: 'bt-main-work-status', role: 'status' }, t(sourceState(status.state)))),
    status.cursor ? h('p', { className: 'bt-main-work-detail' }, `${t('Source cursor')}: ${status.cursor}`) : null,
    status.lastError ? h('p', { className: 'bt-main-error', role: 'alert' }, status.lastError) : null,
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    h('button', { type: 'button', className: 'bt-soft', disabled: busy || !status.configured, onClick: () => void control() },
      t(running ? 'Stop Feishu' : 'Reconnect Feishu')))
}
