import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { Card, Row } from './bot-settings.js'
import { t } from './i18n.js'

const BROWSER_STATES = {
  available: 'Available',
  busy: 'In use',
  unknown: 'Outcome unknown',
  revoked: 'Revoked',
}
const OPERATION_STATES = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  unknown: 'Outcome unknown',
  resolved: 'Checked',
}
const OBSERVATIONS = {
  UNCHANGED: 'Page stayed on the original view',
  CHANGED: 'Page visibly changed',
  CLOSED: 'Browser page was closed',
  INSPECTED: 'I inspected the page without recording its contents',
}
const DETERMINISTIC = new Set(['INVALID_INPUT', 'RESOURCE_STALE', 'SOURCE_NOT_AUTHORIZED', 'ENVIRONMENT_DENIED',
  'RESOURCE_LIMIT', 'IDENTITY_CONFLICT', 'BROWSER_RECONCILE_REQUIRED', 'NOT_FOUND', 'UNAVAILABLE'])

export function ProductBrowserSettings({ binding, works = [], directoryOptions, call }) {
  const instanceId = binding.instanceId
  const storageKey = `product-browser-command:${instanceId}`
  const acceptedWorks = works.filter(work => work.receipt?.status === 'accepted' && work.brief?.workItemId)
  const directories = directoryOptions?.directories ?? []
  const [resources, setResources] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [workItemId, setWorkItemId] = useState('')
  const [environmentId, setEnvironmentId] = useState(directories[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [reasons, setReasons] = useState({})
  const [pending, setPending] = useState({})
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const inFlight = useRef({})
  const refreshGeneration = useRef(0)
  const selected = resources?.find(resource => resource.id === selectedId)
  const selectedWorks = acceptedWorks.filter(work => !selected?.environmentId || !work.brief.environmentId
    || work.brief.environmentId === selected.environmentId)
  const activeGrant = selected?.grants?.find(grant => grant.workItemId === workItemId && grant.active)

  const actionKey = (endpoint, input) => endpoint === 'browser-create' ? `create:${input.environmentId}`
    : endpoint === 'browser-grant' ? `grant:${input.resourceId}:${input.workItemId}`
      : endpoint === 'browser-revoke' ? `resource:${input.resourceId}`
        : endpoint === 'browser-resolve' ? `resolve:${input.resourceId}:${input.operationId}` : endpoint
  const actionLabel = attempt => attempt.endpoint === 'browser-create'
    ? t('Create browser in {environment}', { environment: attempt.input.environmentId })
    : attempt.endpoint === 'browser-grant' ? t('Change browser grant for {workItemId}', { workItemId: attempt.input.workItemId })
      : attempt.endpoint === 'browser-revoke' ? t('Revoke browser {resourceId}', { resourceId: attempt.input.resourceId })
        : t('Check browser operation {operationId}', { operationId: attempt.input.operationId })
  const remember = (attempt, key) => {
    const next = { ...inFlight.current }
    if (attempt) next[key] = attempt
    else delete next[key]
    inFlight.current = next
    setPending(next)
    try {
      if (Object.keys(next).length) window.sessionStorage.setItem(storageKey, JSON.stringify(next))
      else window.sessionStorage.removeItem(storageKey)
    } catch { /* The current view still keeps the command available for retry. */ }
  }

  const refresh = async () => {
    const generation = ++refreshGeneration.current
    try {
      const items = await call('browser-list', { instanceId })
      if (generation !== refreshGeneration.current) return items
      setResources(items)
      setSelectedId(current => items.some(resource => resource.id === current) ? current : items[0]?.id ?? '')
      setUnavailable(false)
      return items
    } catch (failure) {
      if (generation !== refreshGeneration.current) return []
      if (failure.code === 'UNAVAILABLE') {
        setUnavailable(true)
        setResources([])
        return []
      }
      setError(failure.message)
      return []
    }
  }

  useEffect(() => {
    let live = true
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey))
      const values = saved && typeof saved === 'object'
        ? saved.endpoint ? [saved] : Object.values(saved) : []
      const valid = Object.fromEntries(values.filter(attempt =>
        attempt && ['browser-create', 'browser-grant', 'browser-revoke', 'browser-resolve'].includes(attempt.endpoint)
        && typeof attempt.commandId === 'string' && attempt.input && typeof attempt.input === 'object')
        .map(attempt => [actionKey(attempt.endpoint, attempt.input), attempt]))
      inFlight.current = valid
      setPending(valid)
    } catch { /* The Host receipt remains authoritative when session storage is unavailable. */ }
    void refresh().then(items => {
      if (!live) return
      setSelectedId(current => items.some(resource => resource.id === current) ? current : items[0]?.id ?? '')
    })
    const timer = window.setInterval(() => { if (live && !document.hidden) void refresh() }, 15_000)
    return () => { live = false; refreshGeneration.current += 1; window.clearInterval(timer) }
  }, [call, instanceId])

  useEffect(() => {
    if (!directories.some(directory => directory.id === environmentId)) setEnvironmentId(directories[0]?.id ?? '')
  }, [directoryOptions])
  useEffect(() => {
    if (!selectedWorks.some(work => work.brief.workItemId === workItemId)) setWorkItemId(selectedWorks[0]?.brief?.workItemId ?? '')
  }, [selectedId, resources, workItemId])

  const execute = async (endpoint, input, success, retry = false, explicit = null) => {
    const key = actionKey(endpoint, input)
    if (busy || inFlight.current[key] && !retry) return
    const fingerprint = JSON.stringify([endpoint, input])
    const attempt = retry ? explicit ?? inFlight.current[key] : { endpoint, input, fingerprint, commandId: crypto.randomUUID() }
    if (!attempt) return
    remember(attempt, key)
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await call(endpoint, { instanceId, commandId: attempt.commandId, ...attempt.input })
      remember(null, key)
      await refresh()
      setNotice(t(success))
      return result
    } catch (failure) {
      if (DETERMINISTIC.has(failure.code)) remember(null, key)
      setError(failure.message)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const create = event => {
    event.preventDefault()
    if (!label.trim() || !environmentId || busy) return
    void execute('browser-create', { environmentId, label: label.trim() }, 'Browser resource created.')
      .then(result => { if (result) setLabel('') })
  }
  const setGrant = active => {
    if (!selected || !workItemId || busy || selected.state === 'revoked') return
    void execute('browser-grant', { resourceId: selected.id, workItemId, expectedRevision: selected.revision, active },
      active ? 'Browser access granted.' : 'Browser access revoked.')
  }
  const revoke = () => {
    if (!selected || busy || selected.state === 'revoked'
      || !window.confirm(t('Revoke this browser resource and all of its work grants?'))) return
    void execute('browser-revoke', { resourceId: selected.id, expectedRevision: selected.revision },
      'Browser resource revoked.')
  }
  const resolve = operation => {
    const reason = reasons[operation.id]?.trim()
    if (!selected || !reason || busy) return
    void execute('browser-resolve', { resourceId: selected.id, operationId: operation.id, reason },
      'Browser operation checked.', false).then(result => {
      if (result) setReasons(current => ({ ...current, [operation.id]: '' }))
    })
  }

  if (unavailable) return h(Card, { title: t('Browser resources') },
    h('p', { className: 'bt-product-resource-note' }, t('The local Host has no CDP browser bridge. Browser work remains unavailable.')))

  return h(Fragment, null,
    h(Card, { title: t('Browser resources') },
      h('p', { className: 'bt-product-resource-note' },
        t('Each browser keeps an isolated profile. A local Worker needs an exact work-item grant before navigation or a read-only snapshot.')),
      h('button', { type: 'button', className: 'bt-product-browser-refresh bt-soft bt-soft-sm', disabled: Boolean(busy),
        onClick: () => { void refresh() } }, t('Refresh browser resources')),
      !resources ? h('p', { role: 'status' }, t('Loading…'))
        : resources.length === 0 ? h('p', { className: 'bt-main-status' }, t('No browser resources yet.'))
          : h('div', { className: 'bt-product-resource-list' }, resources.map(resource => h('div', {
            key: resource.id, className: 'bt-product-browser-resource',
          },
          h('button', { type: 'button', className: 'bt-soft', disabled: Boolean(busy),
            'aria-pressed': selectedId === resource.id, onClick: () => setSelectedId(resource.id) }, resource.label),
          h('span', { role: 'status' }, `${t(BROWSER_STATES[resource.state] ?? 'Unavailable')} · v${resource.revision} · ${resource.environmentId}`)))),
      error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
      notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
      Object.values(pending).map(attempt => h('div', { key: attempt.commandId, className: 'bt-product-resource-row', role: 'status' },
        h('span', null, `${actionLabel(attempt)} · ${t('pending confirmation. Retry the same command.')}`),
        h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
          'aria-label': t('Retry {action}', { action: actionLabel(attempt) }),
          onClick: () => void execute(attempt.endpoint, attempt.input, 'Browser change confirmed.', true, attempt) },
        t('Retry pending browser change')))),
      h('form', { className: 'bt-product-browser-create', onSubmit: create },
        h(Row, { label: t('Browser name') }, h('input', { className: 'bt-bs-input', value: label, maxLength: 128,
          disabled: Boolean(busy), placeholder: t('Research browser'),
          onChange: event => setLabel(event.target.value) })),
        h(Row, { label: t('Browser Environment') }, h('select', { className: 'bt-bs-input', value: environmentId,
          disabled: Boolean(busy) || directories.length === 0,
          onChange: event => setEnvironmentId(event.target.value) },
        directories.length === 0 ? h('option', { value: '' }, t('No local Environment')) : null,
        directories.map(directory => h('option', { key: directory.id, value: directory.id },
          directory.title ?? directory.id)))),
        h('button', { className: 'bt-soft', type: 'submit', disabled: Boolean(busy)
          || Boolean(pending[actionKey('browser-create', { environmentId })]) || !label.trim() || !environmentId },
          busy ? t('Saving…') : t('Create browser resource')))),
    selected ? h(Card, { title: t('Browser work access') },
      h('div', { className: 'bt-product-resource-selected' },
        h('h3', null, selected.label),
        h('p', { role: 'status' }, `${t(BROWSER_STATES[selected.state] ?? 'Unavailable')} · v${selected.revision}`),
        selected.owner ? h('p', { className: 'bt-product-resource-note' },
          `${t('Browser owner')}: ${selected.owner.ticketId} · ${selected.owner.generation}`) : null,
        h('div', { className: 'bt-product-resource-row' },
          h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy)
            || Boolean(pending[actionKey('browser-revoke', { resourceId: selected.id })]) || selected.state === 'revoked',
          onClick: revoke }, t('Revoke browser resource'))),
        selected.grantsTruncated ? h('p', { className: 'bt-product-resource-note', role: 'status' },
          t('This resource has more than 100 grants. No new grant can be added until stored grants are cleaned up.')) : null,
        selectedWorks.length === 0 ? h('p', { className: 'bt-main-status' },
          t('No accepted work item is available in this Environment.'))
          : h(Fragment, null,
            h(Row, { label: t('Browser work item') }, h('select', { className: 'bt-bs-input', value: workItemId,
              disabled: Boolean(busy) || selected.state === 'revoked',
              onChange: event => setWorkItemId(event.target.value) },
            selectedWorks.map(work => h('option', { key: work.brief.workItemId, value: work.brief.workItemId }, work.brief.goal)))),
            h('div', { className: 'bt-product-resource-row' },
              h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy)
                || Boolean(selected && pending[actionKey('browser-grant', { resourceId: selected.id, workItemId })])
                || selected.state === 'revoked' || !workItemId, onClick: () => setGrant(!activeGrant) },
              t(activeGrant ? 'Revoke browser from this work' : 'Grant browser to this work')))),
        selected.grants?.length ? h('div', { className: 'bt-product-resource-list' },
          selected.grants.map(grant => h('div', { key: grant.workItemId, className: 'bt-product-resource-row' },
            h('span', null, `${grant.workItemId} · ${t(grant.active ? 'Allowed' : 'Revoked')}`)))) : null,
        h('details', { className: 'bt-product-browser-operations', open: selected.state === 'unknown' || undefined },
          h('summary', null, t('Recent browser operations')),
          selected.operations?.length
            ? selected.operations.slice().reverse().map(operation => h('div', {
              key: operation.id, className: 'bt-product-browser-operation',
            },
            h('p', null, `${operation.action} · ${t(OPERATION_STATES[operation.state] ?? operation.state)} · ${new Date(operation.createdAt).toLocaleString()}`),
            h('span', { className: 'bt-set-hint' }, operation.id),
            operation.code ? h('p', { className: 'bt-main-error' }, operation.code) : null,
            operation.resolution ? h('p', { className: 'bt-set-hint' },
              t(OBSERVATIONS[operation.resolution] ?? 'Browser operation checked')) : null,
            operation.state === 'unknown' || selected.state === 'unknown' && operation.state === 'pending'
              ? h('div', { className: 'bt-product-browser-resolve' },
                h('select', { className: 'bt-bs-input', value: reasons[operation.id] ?? '',
                  'aria-label': t('Observed browser state'), disabled: Boolean(busy),
                  onChange: event => setReasons(current => ({ ...current, [operation.id]: event.target.value })) },
                h('option', { value: '' }, t('Choose the observed browser state')),
                Object.entries(OBSERVATIONS).map(([value, label]) => h('option', { key: value, value }, t(label)))),
                h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy)
                  || Boolean(pending[actionKey('browser-resolve', { resourceId: selected.id, operationId: operation.id })])
                  || !(reasons[operation.id] ?? '').trim(), onClick: () => resolve(operation) },
                t('Record browser check')))
              : null))
            : h('p', { className: 'bt-set-hint' }, t('No browser operations yet.'))))) : null)
}

export const PRODUCT_BROWSER_CSS = `
.bt-product-browser-resource{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-product-browser-resource>span{color:var(--bt-ink-2);font-size:12px}
.bt-product-browser-create{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-top:12px}
.bt-product-browser-operations{margin-top:12px}
.bt-product-browser-operations summary{cursor:pointer;font-size:12px;color:var(--bt-ink-2)}
.bt-product-browser-operation{padding:9px 0;border-top:1px solid var(--bt-line-2);font-size:12px}
.bt-product-browser-operation>p{margin:3px 0;overflow-wrap:anywhere}
.bt-product-browser-resolve{display:flex;gap:8px;align-items:center;margin-top:8px}
.bt-product-browser-resolve input{flex:1;min-width:0}
.bt-product-browser-resolve select{flex:1;min-width:0}
.bt-product-browser-refresh:focus-visible,.bt-product-browser-resource button:focus-visible,.bt-product-browser-create button:focus-visible,.bt-product-browser-create input:focus-visible,.bt-product-browser-create select:focus-visible,.bt-product-resource-selected select:focus-visible,.bt-product-browser-operation button:focus-visible,.bt-product-browser-operation select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:640px){.bt-product-browser-resource{align-items:flex-start;flex-direction:column}.bt-product-browser-resolve{align-items:stretch;flex-direction:column}}
`
