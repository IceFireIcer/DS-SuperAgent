import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './bot-settings.js'
import { t } from './i18n.js'

export function ProductCredentialSettings({ binding, call }) {
  const [resources, setResources] = useState(null)
  const [requests, setRequests] = useState([])
  const [requestCursor, setRequestCursor] = useState(null)
  const [requestError, setRequestError] = useState(null)
  const [feishu, setFeishu] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [rotationValue, setRotationValue] = useState('')
  const [rotationAttempt, setRotationAttempt] = useState(null)
  const [rotationResult, setRotationResult] = useState(null)
  const [rename, setRename] = useState('')
  const [role, setRole] = useState('worker')
  const [purpose, setPurpose] = useState('tool')
  const [workItemId, setWorkItemId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [sourceInstanceId, setSourceInstanceId] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const pendingCreate = useRef(null)
  const pendingRotation = useRef(null)
  const pendingRequest = useRef(null)
  const pendingDecisions = useRef(new Map())
  const instanceId = binding.instanceId

  const rememberRotation = attempt => {
    pendingRotation.current = attempt
    setRotationAttempt(attempt)
    try {
      if (attempt) window.sessionStorage.setItem(`product-rotation:${instanceId}`, JSON.stringify(attempt))
      else window.sessionStorage.removeItem(`product-rotation:${instanceId}`)
    } catch { /* The current view still keeps the command for retry. */ }
  }

  const rememberRequest = attempt => {
    pendingRequest.current = attempt
    try {
      if (attempt) window.sessionStorage.setItem(`product-request:${instanceId}`, JSON.stringify(attempt))
      else window.sessionStorage.removeItem(`product-request:${instanceId}`)
    } catch { /* The current view still keeps the command for retry. */ }
  }

  const loadPages = async (endpoint, errorText) => {
    const items = []
    let after
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await call(endpoint, { instanceId, limit: 100, ...(after ? { after } : {}) })
      items.push(...page.items)
      if (!page.cursor) return items
      after = page.cursor
    }
    throw new Error(t(errorText))
  }
  const load = () => loadPages('resource-list', 'The credential resource list exceeds its bounded limit.')
  const readRequests = async () => {
    try {
      const page = await call('resource-request-list', { instanceId, limit: 100 })
      return { items: page.items, cursor: page.cursor ?? null, available: true }
    } catch (failure) { return { items: [], cursor: null, available: false, error: failure.message } }
  }
  const refresh = async () => {
    const [items, requestResult] = await Promise.all([load(), readRequests()])
    setResources(items)
    setRequests(requestResult.items); setRequestCursor(requestResult.cursor); setRequestError(requestResult.error ?? null)
    const status = await call('feishu-status', { instanceId }).catch(() => null)
    setFeishu(status)
    if (status?.credentialMode === 'managed') setSourceInstanceId(current => current || status.sourceInstanceId)
    return requestResult.available
  }
  useEffect(() => {
    let live = true
    pendingDecisions.current.clear()
    pendingRotation.current = null
    setRotationAttempt(null); setRotationResult(null); setRotationValue('')
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(`product-rotation:${instanceId}`))
      if (stored && typeof stored.commandId === 'string' && typeof stored.resourceId === 'string'
        && Number.isSafeInteger(stored.expectedRevision)) {
        const attempt = { commandId: stored.commandId, resourceId: stored.resourceId, expectedRevision: stored.expectedRevision }
        pendingRotation.current = attempt
        setRotationAttempt(attempt)
        void call('resource-rotation-read', { instanceId, commandId: attempt.commandId })
          .then(result => { if (live) setRotationResult(result) }).catch(() => { /* Keep the original command available for checking. */ })
      }
    } catch { /* Session storage may be unavailable. */ }
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(`product-request:${instanceId}`))
      const payload = stored?.payload
      if (typeof stored?.commandId === 'string' && typeof payload?.resourceId === 'string'
        && ['main', 'router', 'worker'].includes(payload?.scope?.role)
        && ['tool', 'source', 'outbound'].includes(payload?.purpose)) {
        pendingRequest.current = stored
        setSelectedId(payload.resourceId); setRole(payload.scope.role); setPurpose(payload.purpose)
        setWorkItemId(payload.scope.workItemId ?? ''); setEnvironmentId(payload.scope.environmentId ?? '')
        setSourceInstanceId(payload.scope.sourceInstanceId ?? '')
      }
    } catch { /* Session storage may be unavailable. */ }
    Promise.all([load(), readRequests(), call('feishu-status', { instanceId }).catch(() => null)]).then(([items, requestResult, status]) => {
      if (!live) return
      setResources(items); setRequests(requestResult.items); setRequestCursor(requestResult.cursor)
      setRequestError(requestResult.error ?? null); setFeishu(status)
      if (status?.credentialMode === 'managed') setSourceInstanceId(current => current || status.sourceInstanceId)
    },
      failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [call, instanceId])

  const loadMoreRequests = async () => {
    if (!requestCursor || busy) return
    setBusy('requests'); setRequestError(null)
    try {
      const page = await call('resource-request-list', { instanceId, limit: 100, after: requestCursor })
      setRequests(current => {
        const seen = new Set(current.map(request => request.id))
        return [...current, ...page.items.filter(request => !seen.has(request.id))]
      })
      setRequestCursor(page.cursor ?? null)
    } catch (failure) { setRequestError(failure.message) }
    finally { setBusy(null) }
  }

  const run = async (name, action, success, onConfirmed) => {
    setBusy(name); setError(null); setNotice(null)
    try {
      const result = await action()
      const requestsAvailable = await refresh()
      if (requestsAvailable) onConfirmed?.(result)
      setNotice(t(success))
    } catch (failure) {
      setError(failure.message)
      try { await refresh() } catch { /* The original error remains visible. */ }
    } finally { setBusy(null) }
  }
  const create = event => {
    event.preventDefault()
    if (!label.trim() || !value.trim() || busy) return
    void run('create', async () => {
      pendingCreate.current ??= crypto.randomUUID()
      await call('resource-create', { instanceId, commandId: pendingCreate.current, label: label.trim(), value })
      pendingCreate.current = null
      setLabel(''); setValue('')
    }, 'Credential resource saved.')
  }
  const selected = resources?.find(resource => resource.id === selectedId)
  const choose = resource => {
    if (selectedId !== resource.id) setRotationValue('')
    setSelectedId(resource.id); setRename(resource.label); setError(null); setNotice(null)
  }
  const finishRotation = result => {
    setRotationResult(result)
    if (result.status === 'committed') {
      rememberRotation(null)
      setRotationValue('')
      setNotice(t(result.cleanupPending ? 'Credential rotated; old record cleanup pending.' : 'Credential rotated.'))
    } else if (result.status === 'abandoned') {
      rememberRotation(null)
      setRotationValue('')
      setError(t('Rotation was not applied. Refresh the resource before starting another rotation.'))
    } else {
      setError(t('Rotation is pending. Retry with the same value and command, or check its status.'))
    }
  }
  const checkRotation = async attempt => {
    if (busy) return
    setBusy('rotation-check'); setError(null); setNotice(null)
    try {
      finishRotation(await call('resource-rotation-read', { instanceId, commandId: attempt.commandId }))
      await refresh().catch(() => { /* Preserve the verified receipt if list refresh fails. */ })
    } catch {
      setError(t('Rotation result is unknown. Keep this command and check again.'))
    } finally { setBusy(null) }
  }
  const rotate = event => {
    event.preventDefault()
    if (!selected || !rotationValue.trim() || busy || pendingRotation.current?.resourceId !== selected.id && pendingRotation.current) return
    const attempt = pendingRotation.current ?? { commandId: crypto.randomUUID(), resourceId: selected.id,
      expectedRevision: selected.revision }
    rememberRotation(attempt)
    setBusy('rotate'); setError(null); setNotice(null); setRotationResult(null)
    void (async () => {
      try {
        const result = await call('resource-rotate', { instanceId, ...attempt, value: rotationValue })
        finishRotation(result)
      } catch {
        try { finishRotation(await call('resource-rotation-read', { instanceId, commandId: attempt.commandId })) }
        catch { setError(t('Rotation result is unknown. Keep this command and check again.')) }
      } finally {
        try { await refresh() } catch { /* Keep the command and its receipt visible. */ }
        setBusy(null)
      }
    })()
  }
  const grant = event => {
    event.preventDefault()
    if (!selected || busy || purpose !== 'tool' && !sourceInstanceId.trim()) return
    const scope = { role, ...(workItemId.trim() ? { workItemId: workItemId.trim() } : {}),
      ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
      ...(sourceInstanceId.trim() ? { sourceInstanceId: sourceInstanceId.trim() } : {}) }
    void run('grant', () => call('resource-grant', { instanceId, commandId: crypto.randomUUID(), resourceId: selected.id,
      expectedRevision: selected.revision, scope, purposes: [purpose] }), 'Authorization recorded.')
  }
  const requestAuthorization = () => {
    if (!selected || busy || requestError || purpose !== 'tool' && !sourceInstanceId.trim()) return
    const scope = { role, ...(workItemId.trim() ? { workItemId: workItemId.trim() } : {}),
      ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
      ...(sourceInstanceId.trim() ? { sourceInstanceId: sourceInstanceId.trim() } : {}) }
    const payload = { instanceId, resourceId: selected.id, scope, purpose }
    const fingerprint = JSON.stringify(payload)
    if (JSON.stringify(pendingRequest.current?.payload) !== fingerprint) rememberRequest({ payload, commandId: crypto.randomUUID() })
    const commandId = pendingRequest.current.commandId
    void run('request', async () => {
      const result = await call('resource-request', { ...payload, commandId })
      if (result?.status !== 'pending' || result.resourceId !== selected.id) throw new Error(t('The authorization request was not confirmed.'))
      return result
    }, 'Authorization request recorded.', result => {
      rememberRequest(null)
      setRequests(current => current.some(request => request.id === result.id) ? current : [result, ...current])
    })
  }
  const decideRequest = (request, approve) => {
    if (!selected || busy || requestError || request.status !== 'pending') return
    const key = `${approve ? 'approve' : 'cancel'}:${request.id}`
    if (!pendingDecisions.current.has(key)) pendingDecisions.current.set(key,
      { commandId: crypto.randomUUID(), expectedRevision: selected.revision })
    const attempt = pendingDecisions.current.get(key)
    void run(key, async () => {
      try {
        const result = approve
          ? await call('resource-grant', { instanceId, commandId: attempt.commandId, resourceId: selected.id,
            expectedRevision: attempt.expectedRevision, scope: request.scope, purposes: [request.purpose], requestId: request.id })
          : await call('resource-cancel', { instanceId, commandId: attempt.commandId, requestId: request.id })
        if (approve ? !Number.isSafeInteger(result?.revision) || result.revision <= attempt.expectedRevision
          : result?.status !== 'cancelled' || result?.id !== request.id) {
          throw new Error(t('The authorization decision was not confirmed.'))
        }
        return result
      } catch (failure) {
        if (failure.code === 'RESOURCE_REVISION_CONFLICT' || failure.code === 'REQUEST_UNAVAILABLE') pendingDecisions.current.delete(key)
        throw failure
      }
    }, approve ? 'Authorization recorded.' : 'Authorization request cancelled.', result => {
      pendingDecisions.current.delete(key)
      const decided = approve ? { ...request, status: 'granted' } : result
      setRequests(current => current.some(item => item.id === request.id)
        ? current.map(item => item.id === request.id ? decided : item) : [decided, ...current])
    })
  }
  const remove = resource => {
    if (busy || resource.status !== 'deleted' && !window.confirm(t('Delete this credential resource and all its grants?'))) return
    void run('delete', () => resource.status === 'deleted'
      ? call('resource-cleanup', { instanceId, resourceId: resource.id })
      : call('resource-delete', { instanceId, commandId: crypto.randomUUID(), resourceId: resource.id,
        expectedRevision: resource.revision }), 'Resource deletion recorded.')
  }
  const selectFeishu = resourceId => {
    if (busy) return
    void run('select-feishu', () => call('resource-select-feishu', { instanceId, commandId: crypto.randomUUID(), resourceId }),
      'Feishu credential selection saved.')
  }

  return h(Card, { title: t('Credential resources') },
    h('p', { className: 'bt-product-resource-note' }, t('Managed Feishu source and delivery use separate grants. Worker MCP tools require a separate grant and approval.')),
    feishu?.credentialMode === 'managed' ? h('div', { className: 'bt-product-resource-selected' },
      h('p', { className: 'bt-product-resource-note' }, `${t('Feishu source Instance')}: ${feishu.sourceInstanceId}`),
      h('p', { className: 'bt-product-resource-note' }, t('Grant Main/source and Router/outbound for this exact source Instance, then reconnect.')),
      h('p', { role: 'status' }, `${t('Selected Feishu resource')}: ${feishu.resourceId
        ? resources?.find(item => item.id === feishu.resourceId)?.label ?? t('Unavailable resource')
        : t('No Feishu resource selected')} · ${feishu.state}${feishu.lastError ? ` · ${feishu.lastError}` : ''}`),
      feishu.resourceId ? h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy), onClick: () => selectFeishu(null) }, t('Clear Feishu selection')) : null)
      : feishu?.credentialMode === 'legacy' ? h('p', { className: 'bt-product-resource-note' },
        t('Feishu uses an explicit legacy Host secret. Remove it and restart the Host to select a managed resource.'),
        feishu.lastError ? ` · ${feishu.lastError}` : '') : null,
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
    requestError ? h('div', { className: 'bt-product-resource-row' },
      h('p', { className: 'bt-main-error', role: 'alert' }, requestError),
      h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
        onClick: () => { void refresh().catch(failure => setError(failure.message)) } }, t('Retry request list'))) : null,
    rotationAttempt ? h('div', { className: 'bt-product-resource-row', role: 'status' },
      h('span', null, t(rotationResult?.status === 'pending'
        ? 'Rotation pending. Retry with the same value or check its status.'
        : 'Rotation command saved. Check its status before starting another rotation.')),
      h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
        onClick: () => { void checkRotation(rotationAttempt) } }, t('Check rotation'))) : null,
    h('form', { className: 'bt-product-resource-create', onSubmit: create },
      h(Row, { label: t('Resource name') }, h('input', { className: 'bt-bs-input', value: label, maxLength: 128,
        disabled: Boolean(busy), onChange: event => { setLabel(event.target.value); pendingCreate.current = null } })),
      h(Row, { label: t('Credential value') }, h('input', { className: 'bt-bs-input', type: 'password', value,
        autoComplete: 'new-password', disabled: Boolean(busy), onChange: event => { setValue(event.target.value); pendingCreate.current = null } })),
      h('button', { className: 'bt-soft', type: 'submit', disabled: Boolean(busy) || !label.trim() || !value.trim() },
        busy === 'create' ? t('Saving…') : t('Save resource'))),
    resources === null ? h('p', { role: 'status' }, t('Loading…')) : resources.length === 0
      ? h('p', { className: 'bt-main-status' }, t('No credential resources yet.'))
      : h('div', { className: 'bt-product-resource-list' }, resources.map(resource => h('div', { className: 'bt-product-resource-row', key: resource.id },
        h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
          'aria-pressed': selectedId === resource.id, onClick: () => choose(resource) }, resource.label),
        h('span', { role: 'status' }, `${resource.status} · v${resource.revision}`),
        resource.cleanupPending ? h('span', { className: 'bt-main-error' }, t('Vault cleanup pending.')) : null,
        h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy), onClick: () => remove(resource) },
          t(resource.status === 'deleted' ? 'Retry cleanup' : 'Delete resource'))))),
    selected?.status === 'active' ? h('div', { className: 'bt-product-resource-selected' },
      h('h3', null, selected.label),
      feishu?.credentialMode === 'managed' ? h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
        onClick: () => selectFeishu(selected.id) }, t(feishu.resourceId === selected.id ? 'Reconnect Feishu with this resource' : 'Use for Feishu')) : null,
      h('form', { onSubmit: event => { event.preventDefault(); if (!rename.trim() || busy) return
        void run('rename', () => call('resource-rename', { instanceId, commandId: crypto.randomUUID(), resourceId: selected.id,
          expectedRevision: selected.revision, label: rename.trim() }), 'Resource name changed.') } },
      h('input', { className: 'bt-bs-input', value: rename, maxLength: 128, disabled: Boolean(busy),
        'aria-label': t('New resource name'), onChange: event => setRename(event.target.value) }),
      h('button', { className: 'bt-soft', type: 'submit', disabled: Boolean(busy) || !rename.trim() }, t('Rename resource'))),
      h('form', { className: 'bt-product-resource-create', onSubmit: rotate },
        h(Row, { label: t('New credential value') }, h('input', { className: 'bt-bs-input', type: 'password',
          value: rotationValue, autoComplete: 'new-password', disabled: Boolean(busy) || Boolean(rotationAttempt && rotationAttempt.resourceId !== selected.id),
          onChange: event => setRotationValue(event.target.value) })),
        h('button', { className: 'bt-soft', type: 'submit',
          disabled: Boolean(busy) || !rotationValue.trim() || Boolean(rotationAttempt && rotationAttempt.resourceId !== selected.id) },
        busy === 'rotate' ? t('Saving…') : t(rotationAttempt ? 'Retry rotation' : 'Rotate credential'))),
      h('form', { className: 'bt-product-resource-grant', onSubmit: grant },
        h('label', null, t('Role'), h('select', { value: role, disabled: Boolean(busy), onChange: event => setRole(event.target.value) },
          ['main', 'router', 'worker'].map(item => h('option', { key: item, value: item }, item)))),
        h('label', null, t('Purpose'), h('select', { value: purpose, disabled: Boolean(busy), onChange: event => setPurpose(event.target.value) },
          ['tool', 'source', 'outbound'].map(item => h('option', { key: item, value: item }, item)))),
        h('label', null, t('Work item ID'), h('input', { value: workItemId, disabled: Boolean(busy), onChange: event => setWorkItemId(event.target.value) })),
        h('label', null, t('Environment ID'), h('input', { value: environmentId, disabled: Boolean(busy), onChange: event => setEnvironmentId(event.target.value) })),
        h('label', null, t('Source Instance ID'), h('input', { value: sourceInstanceId, disabled: Boolean(busy),
          onChange: event => setSourceInstanceId(event.target.value) })),
        h('button', { className: 'bt-soft', type: 'submit', disabled: Boolean(busy) || purpose !== 'tool' && !sourceInstanceId.trim() },
          t('Record authorization')),
        h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy) || Boolean(requestError)
          || purpose !== 'tool' && !sourceInstanceId.trim(),
          onClick: requestAuthorization }, t('Request authorization'))),
      requests.filter(request => request.resourceId === selected.id).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
        .map(request => h('div', { className: 'bt-product-resource-row', key: request.id },
          h('span', null, `${t(request.status === 'pending' ? 'Pending authorization request'
            : request.status === 'cancelled' ? 'Cancelled authorization request' : 'Granted authorization request')} · ${request.scope.role} · ${request.purpose}`,
            request.scope.workItemId ? ` · ${t('Work item ID')}: ${request.scope.workItemId}` : '',
            request.scope.environmentId ? ` · ${t('Environment ID')}: ${request.scope.environmentId}` : '',
            request.scope.sourceInstanceId ? ` · ${t('Source Instance ID')}: ${request.scope.sourceInstanceId}` : ''),
          request.status === 'granted' && !selected.grants.some(grant => grant.purposes.includes(request.purpose)
            && ['role', 'workItemId', 'environmentId', 'sourceInstanceId'].every(key => grant.scope[key] === request.scope[key]))
            ? h('span', { className: 'bt-main-error', role: 'status' }, t('Current access revoked')) : null,
          request.status === 'pending' ? h('div', { className: 'bt-product-resource-request-actions' },
            h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy) || Boolean(requestError),
              onClick: () => decideRequest(request, true) }, t('Approve request')),
            h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy) || Boolean(requestError),
              onClick: () => decideRequest(request, false) }, t('Cancel request'))) : null)),
      requestCursor ? h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy) || Boolean(requestError),
        onClick: () => { void loadMoreRequests() } }, t('Load more requests')) : null,
      selected.grants.map(grant => h('div', { className: 'bt-product-resource-row', key: grant.id },
        h('span', null, [grant.scope.role, grant.purposes.join(', '),
          grant.scope.workItemId ? `${t('Work item ID')}: ${grant.scope.workItemId}` : null,
          grant.scope.environmentId ? `${t('Environment ID')}: ${grant.scope.environmentId}` : null,
          grant.scope.sourceInstanceId ? `${t('Source Instance ID')}: ${grant.scope.sourceInstanceId}` : null]
          .filter(Boolean).join(' · ')),
        h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy), onClick: () => {
          void run('revoke', () => call('resource-revoke', { instanceId, commandId: crypto.randomUUID(), resourceId: selected.id,
            grantId: grant.id, expectedRevision: selected.revision }), 'Authorization revoked.')
        } }, t('Revoke authorization'))))) : null)
}

export const PRODUCT_CREDENTIAL_CSS = `
.bt-product-resource-note{margin:0 0 10px;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-product-resource-create,.bt-product-resource-selected{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:12px 0}
.bt-product-resource-list{display:flex;flex-direction:column;gap:6px;margin:12px 0;max-height:220px;overflow:auto}
.bt-product-resource-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:6px 0;border-bottom:1px solid var(--bt-line-2);font-size:12px}
.bt-product-resource-row>span{min-width:0;overflow-wrap:anywhere;color:var(--bt-ink-2)}
.bt-product-resource-grant{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%}
.bt-product-resource-grant label{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;color:var(--bt-ink-2)}
.bt-product-resource-grant input,.bt-product-resource-grant select{height:32px;min-width:0;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-main);color:var(--bt-ink);font:inherit;padding:0 8px}
.bt-product-resource-grant button{justify-self:start}.bt-product-resource-create button:focus-visible,.bt-product-resource-row button:focus-visible,.bt-product-resource-selected button:focus-visible,.bt-product-resource-grant button:focus-visible,.bt-product-resource-create input:focus-visible,.bt-product-resource-selected input:focus-visible,.bt-product-resource-grant input:focus-visible,.bt-product-resource-grant select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-product-resource-request-actions{display:flex;flex-wrap:wrap;gap:8px}
@media(max-width:640px){.bt-product-resource-grant{grid-template-columns:minmax(0,1fr)}}
`
