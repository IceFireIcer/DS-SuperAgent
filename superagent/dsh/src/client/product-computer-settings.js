// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/computer.js.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row, SwitchRow } from './product-card.js'
import { InlineNotice, StatusChip } from './product-settings-components.js'
import { t } from './i18n.js'

const states = { off: 'Off', ready: 'Ready', unavailable: 'Unavailable', 'permission-required': 'Desktop permission required' }
const levels = { view: 'View only', background: 'Background control', foreground: 'Foreground control' }
const leaseStates = { approving: 'Waiting for local approval', active: 'Worker control', human: 'Human control' }
const actions = { click: 'Click', type: 'Type text', activate: 'Bring to front' }

export function ProductComputerSettings({ binding, call }) {
  const [model, setModel] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [apps, setApps] = useState([])
  const [selection, setSelection] = useState('')
  const [level, setLevel] = useState('view')
  const [preview, setPreview] = useState(false)
  const command = useRef(false)
  const revision = useRef(0)
  const invoke = (endpoint, payload = {}) => call(endpoint, { instanceId: binding.instanceId, ...payload })
  useEffect(() => {
    let active = true
    let timer
    const poll = async () => {
      const seen = revision.current
      try {
        if (command.current) return
        const status = await invoke('computer-status')
        if (active && revision.current === seen) setModel(status)
      } catch (failure) { if (active && revision.current === seen) setError(failure.message) }
      finally { if (active) timer = setTimeout(poll, 2500) }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [call, binding.instanceId])
  const run = async (endpoint, payload) => {
    if (command.current) return
    command.current = true
    revision.current++
    setBusy(true); setError('')
    try {
      const value = await invoke(endpoint, payload)
      setModel(value)
      if (value.discovered) setApps(value.discovered)
      if (!value.enabled) { setApps([]); setSelection(''); setPreview(false) }
      if (!value.lease) setPreview(false)
    } catch (failure) { setError(failure.message) }
    finally { command.current = false; setBusy(false) }
  }
  const policy = (operation, payload) => run('computer-policy', { ...payload, operation })
  const control = operation => run('computer-control', { operation, leaseId: model.lease.id })
  const button = (label, action, disabled = false) => h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
    onClick: action, disabled: busy || disabled }, t(label))
  const lease = model?.lease
  const shot = preview && lease?.screenshot
  return h('div', { className: 'bt-ps-content' },
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    h(Card, { title: t('Computer control') },
      h(SwitchRow, { label: t('Enable computer control'), on: model?.enabled === true,
        disabled: busy || !model?.available, onChange: enabled => void policy('enable', { enabled }) }),
      h(Row, { label: t('Native driver') }, h(StatusChip, { tone: model?.provider === 'ready' ? 'success' : 'neutral' },
        t(model ? states[model.provider] ?? 'Unavailable' : 'Loading…')),
      button('Check permissions', () => policy('probe'), !model?.enabled))),
    h(Card, { title: t('Allowed applications') },
      h(Row, { label: t('Running application') },
        h('select', { className: 'bt-select', 'aria-label': t('Running application'), value: selection,
          disabled: busy || !model?.enabled, onChange: event => setSelection(event.target.value) },
        h('option', { value: '' }, t('Select an application')),
        apps.map(app => h('option', { key: app.id, value: app.id }, app.name))),
      button('Refresh applications', () => policy('apps'), !model?.enabled)),
      h(Row, { label: t('Access level') },
        h('select', { className: 'bt-select', 'aria-label': t('Access level'), value: level, disabled: busy || !selection,
          onChange: event => setLevel(event.target.value) }, Object.entries(levels).map(([id, label]) => h('option', { key: id, value: id }, t(label)))),
      button('Allow application', () => policy('allow', { appId: selection, level }), !model?.enabled || !selection)),
      ...(model?.apps ?? []).map(app => h(Row, { key: app.id, label: app.name, hint: t(levels[app.level]) },
        button('Revoke', () => policy('revoke', { appId: app.id }))))),
    model?.pending?.length ? h(Card, { title: t('Pending computer actions') },
      model.pending.map(entry => h(Row, { key: entry.operationId,
        label: entry.appName,
        hint: `${t(actions[entry.action])} · ${new Date(entry.recordedAt).toLocaleString()}`,
      }, button('Review on this computer', () => run('computer-control', {
        operation: 'reconcile', appId: entry.appId, operationId: entry.operationId,
      }))))) : null,
    h(Card, { title: t('Current computer session') }, lease
      ? h('div', null, h(Row, { label: lease.app.name, hint: t(leaseStates[lease.state]) },
        button(lease.state === 'human' ? 'Release control' : 'Take over', () => control(lease.state === 'human' ? 'return' : 'takeover')),
        button('Stop', () => control('stop'))),
      lease.screenshot ? h(Row, { label: t('Last window snapshot') }, button(preview ? 'Hide' : 'Show', () => setPreview(!preview))) : null,
      shot ? h('img', { src: `data:${shot.mimeType};base64,${shot.data}`, alt: t('Last window snapshot'), className: 'bt-computer-shot' }) : null)
      : h(Row, { label: t('No current computer session') })))
}

export const PRODUCT_COMPUTER_CSS = `.bt-computer-shot{display:block;max-inline-size:100%;block-size:auto;object-fit:contain}`
