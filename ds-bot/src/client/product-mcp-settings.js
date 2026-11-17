import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './product-card.js'
import { t } from './i18n.js'

export function ProductMcpSettings({ binding, call }) {
  const instanceId = binding.instanceId
  const [status, setStatus] = useState(null)
  const [resources, setResources] = useState([])
  const [resourceId, setResourceId] = useState('')
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const inFlight = useRef(null)
  const storageKey = `product-mcp-command:${instanceId}`

  const refresh = async () => {
    const next = await call('mcp-status', { instanceId })
    setStatus(next)
    if (!next.configured) return next
    const items = []
    let after
    for (let page = 0; page < 10; page++) {
      const result = await call('resource-list', { instanceId, limit: 100, ...(after ? { after } : {}) })
      items.push(...result.items.filter(item => item.status === 'active'))
      if (!result.cursor) {
        setResources(items)
        setResourceId(current => current || next.resourceId)
        return next
      }
      after = result.cursor
    }
    throw new Error(t('The credential resource list exceeds its bounded limit.'))
  }

  useEffect(() => {
    let live = true
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey))
      if (saved && ['mcp-save', 'mcp-approve', 'mcp-connect', 'mcp-disconnect', 'mcp-retry'].includes(saved.endpoint)
        && typeof saved.commandId === 'string' && Number.isSafeInteger(saved.expectedRevision)
        && saved.expectedRevision >= 0 && (saved.endpoint !== 'mcp-save' || typeof saved.resourceId === 'string')
        && (saved.endpoint !== 'mcp-approve' || typeof saved.approved === 'boolean')) {
        const attempt = { endpoint: saved.endpoint, commandId: saved.commandId, expectedRevision: saved.expectedRevision,
          ...(saved.endpoint === 'mcp-save' ? { resourceId: saved.resourceId } : {}),
          ...(saved.endpoint === 'mcp-approve' ? { approved: saved.approved } : {}) }
        inFlight.current = attempt
        setPending(attempt)
      } else if (saved) {
        window.sessionStorage.removeItem(storageKey)
      }
    } catch { /* An unavailable session store does not affect the Host receipt. */ }
    void refresh().catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [call, instanceId])

  const remember = attempt => {
    inFlight.current = attempt
    setPending(attempt)
    try {
      if (attempt) window.sessionStorage.setItem(storageKey, JSON.stringify(attempt))
      else window.sessionStorage.removeItem(storageKey)
    } catch { /* Keep the command identity until the view closes. */ }
  }

  const execute = async (endpoint, extra = {}, retry = false) => {
    if (busy || !status?.configured || inFlight.current && !retry) return
    const attempt = retry ? inFlight.current : { endpoint, commandId: crypto.randomUUID(), expectedRevision: status.revision,
      ...extra }
    if (!attempt) return
    remember(attempt)
    setBusy(true); setError(null); setNotice(null)
    try {
      await call(attempt.endpoint, { instanceId, commandId: attempt.commandId,
        expectedRevision: attempt.expectedRevision, ...(attempt.resourceId ? { resourceId: attempt.resourceId } : {}),
        ...(typeof attempt.approved === 'boolean' ? { approved: attempt.approved } : {}) })
      remember(null)
      await refresh()
      setNotice(t('MCP setting saved.'))
    } catch (failure) {
      if (['GRANT_DENIED', 'MCP_NOT_APPROVED', 'RESOURCE_UNAVAILABLE', 'CONFIG_CHANGED',
        'MCP_REVISION_CONFLICT', 'INVALID_CONFIG', 'IDENTITY_CONFLICT'].includes(failure.code)) remember(null)
      setError(failure.message)
      await refresh().catch(() => { /* Preserve the original error and command ID. */ })
    } finally { setBusy(false) }
  }

  return h(Card, { title: t('MCP tools') },
    !status ? h('p', { role: 'status' }, t('Loading…')) : !status.configured
      ? h('p', { className: 'bt-product-resource-note' }, t('No trusted Host MCP tool is configured.'))
      : h('div', { className: 'bt-product-resource-selected' },
        h('p', { className: 'bt-product-resource-note' }, `${status.serverName} / ${status.toolName} · ${t('Host only; remote execution unsupported.')}`),
        h('p', { className: 'bt-product-resource-note' }, t('Grant Worker/tool for the intended work item or Environment in Credential resources. The MCP endpoint is checked when work calls it.')),
        h('p', { role: 'status' }, `${t('MCP state')}: ${t(status.state)}${status.error ? ` · ${status.error}` : ''} · v${status.revision}`),
        h(Row, { label: t('MCP credential resource') }, h('select', { className: 'bt-bs-input', value: resourceId,
          disabled: busy || Boolean(pending), onChange: event => setResourceId(event.target.value) },
        h('option', { value: '' }, t('Choose a resource')),
        resources.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        h('div', { className: 'bt-product-resource-row' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy || Boolean(pending) || !resourceId,
            onClick: () => void execute('mcp-save', { resourceId }) }, t('Save MCP resource')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy || Boolean(pending) || status.state === 'error',
            onClick: () => void execute('mcp-approve', { approved: !status.approved }) },
          t(status.approved ? 'Revoke tool approval' : 'Approve tool')),
          status.connected ? h('button', { type: 'button', className: 'bt-soft', disabled: busy || Boolean(pending),
            onClick: () => void execute('mcp-disconnect') }, t('Disconnect'))
            : h('button', { type: 'button', className: 'bt-soft', disabled: busy || Boolean(pending) || !status.approved || status.state === 'error',
              onClick: () => void execute('mcp-connect') }, t('Connect')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy || Boolean(pending) || !status.approved || status.state === 'error',
            onClick: () => void execute('mcp-retry') }, t('Try again'))),
        pending ? h('div', { className: 'bt-product-resource-row', role: 'status' },
          h('span', null, t('MCP change pending confirmation. Retry the same command.')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy,
            onClick: () => void execute(pending.endpoint, {}, true) }, t('Retry pending change'))) : null,
        error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null))
}
