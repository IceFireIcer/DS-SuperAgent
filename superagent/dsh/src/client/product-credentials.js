import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './product-card.js'
import { t } from './i18n.js'

const credentialImportStatusText = status => t(({ pending: 'Credential import pending', importing: 'Credential import in progress',
  unknown: 'Credential import result unknown', applied: 'Credential import completed', conflict: 'Credential import conflict',
  cancelled: 'Credential import cancelled' })[status] ?? 'Credential import status unavailable')

export function ProductCredentialSettings({ binding, call, credentialImportBridge }) {
  const [resources, setResources] = useState(null)
  const [requests, setRequests] = useState([])
  const [requestCursor, setRequestCursor] = useState(null)
  const [requestError, setRequestError] = useState(null)
  const [feishu, setFeishu] = useState(null)
  const [github, setGithub] = useState(null)
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
  const [credentialImports, setCredentialImports] = useState([])
  const [credentialImportBatch, setCredentialImportBatch] = useState(null)
  const [credentialImportTargets, setCredentialImportTargets] = useState({})
  const [credentialImportError, setCredentialImportError] = useState(null)
  const [credentialImportBusy, setCredentialImportBusy] = useState(false)
  const pendingCreate = useRef(null)
  const pendingRotation = useRef(null)
  const pendingRequest = useRef(null)
  const pendingCredentialPreview = useRef(null)
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
  const readCredentialImports = async () => {
    try {
      const result = await call('credential-import-list', { instanceId, limit: 100 })
      setCredentialImports(result.items)
      return true
    } catch (failure) {
      setCredentialImportError(failure.message)
      return false
    }
  }
  const refresh = async () => {
    const [items, requestResult] = await Promise.all([load(), readRequests()])
    setResources(items)
    setRequests(requestResult.items); setRequestCursor(requestResult.cursor); setRequestError(requestResult.error ?? null)
    const [status, githubStatus] = await Promise.all([
      call('feishu-status', { instanceId }).catch(() => null),
      call('github-status', { instanceId }).catch(() => null),
    ])
    setFeishu(status); setGithub(githubStatus)
    if (status?.credentialMode === 'managed' || githubStatus?.credentialMode === 'managed') {
      setSourceInstanceId(current => current || status?.sourceInstanceId || githubStatus?.sourceInstanceId)
    }
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
    Promise.all([load(), readRequests(), call('feishu-status', { instanceId }).catch(() => null),
      call('github-status', { instanceId }).catch(() => null), call('credential-import-list', { instanceId, limit: 100 }).catch(() => null)]).then(([items, requestResult, status, githubStatus, importResult]) => {
      if (!live) return
      setResources(items); setRequests(requestResult.items); setRequestCursor(requestResult.cursor)
      setRequestError(requestResult.error ?? null); setFeishu(status); setGithub(githubStatus)
      if (importResult) { setCredentialImports(importResult.items); setCredentialImportError(null) }
      else setCredentialImportError(t('Credential export import is available only in the desktop app.'))
      if (status?.credentialMode === 'managed' || githubStatus?.credentialMode === 'managed') {
        setSourceInstanceId(current => current || status?.sourceInstanceId || githubStatus?.sourceInstanceId)
      }
    },
      failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [call, instanceId])

  useEffect(() => () => {
    const pendingId = pendingCredentialPreview.current
    pendingCredentialPreview.current = null
    if (pendingId) void credentialImportBridge?.cancel(pendingId).catch(() => {})
  }, [credentialImportBridge, instanceId])

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
  const selectGithub = resourceId => {
    if (busy) return
    if (resourceId && github?.sourceInstanceId) setSourceInstanceId(github.sourceInstanceId)
    void run('select-github', () => call('resource-select-github', { instanceId, commandId: crypto.randomUUID(), resourceId }),
      'GitHub credential selection saved.')
  }
  const pickCredentialExport = async () => {
    if (credentialImportBusy || !credentialImportBridge) return
    setCredentialImportBusy(true); setCredentialImportError(null)
    let picked
    try {
      picked = await credentialImportBridge.pick()
      if (picked.canceled) return
      if (picked.error) throw new Error(t(picked.error === 'too-large'
        ? 'Credential export must be at most 1 MiB.' : 'The credential export could not be read.'))
      const saved = await call('credential-import-preview', { instanceId, pendingId: picked.id, preview: picked.preview })
      if (pendingCredentialPreview.current && pendingCredentialPreview.current !== picked.id) {
        await credentialImportBridge.cancel(pendingCredentialPreview.current)
      }
      pendingCredentialPreview.current = picked.id
      setCredentialImportBatch({ ...picked.preview, pendingId: picked.id, items: saved.items })
      setCredentialImportTargets(Object.fromEntries(picked.preview.entries.map(entry => {
        const prior = saved.items.find(item => item.sourceRef === entry.sourceRef)?.target
        return [entry.sourceRef, { label: prior?.label ?? entry.label, role: prior?.scope.role ?? '',
          purpose: prior?.purpose ?? '', workItemId: prior?.scope.workItemId ?? '',
          environmentId: prior?.scope.environmentId ?? '', sourceInstanceId: prior?.scope.sourceInstanceId ?? '' }]
      })))
      await readCredentialImports()
    } catch (failure) {
      if (picked?.id) await credentialImportBridge.cancel(picked.id).catch(() => {})
      setCredentialImportError(failure.message)
    }
    finally { setCredentialImportBusy(false) }
  }
  const updateCredentialImportTarget = (sourceRef, patch) => setCredentialImportTargets(current => ({
    ...current, [sourceRef]: { ...current[sourceRef], ...patch },
  }))
  const commitCredentialImport = async entry => {
    if (!credentialImportBatch || credentialImportBusy) return
    const target = credentialImportTargets[entry.sourceRef]
    if (!target?.label.trim() || !target.role || !target.purpose) {
      setCredentialImportError(t('Choose a new resource name, role, purpose, and exact scope before importing.'))
      return
    }
    if (target.purpose === 'tool' && !target.workItemId.trim() && !target.environmentId.trim()) {
      setCredentialImportError(t('Choose a work item or Environment for a tool grant.'))
      return
    }
    if (target.purpose !== 'tool' && !target.sourceInstanceId.trim()) {
      setCredentialImportError(t('Choose the exact source Instance for this authorization.'))
      return
    }
    const scope = { role: target.role,
      ...(target.workItemId.trim() ? { workItemId: target.workItemId.trim() } : {}),
      ...(target.environmentId.trim() ? { environmentId: target.environmentId.trim() } : {}),
      ...(target.sourceInstanceId.trim() ? { sourceInstanceId: target.sourceInstanceId.trim() } : {}) }
    setCredentialImportBusy(true); setCredentialImportError(null)
    try {
      await call('credential-import-commit', { instanceId, commandId: crypto.randomUUID(),
        pendingId: credentialImportBatch.pendingId, sourceRef: entry.sourceRef, credentialId: entry.id,
        target: { label: target.label.trim(), purpose: target.purpose, scope } })
      setNotice(t('Credential imported with a new authorization.'))
      const [items, imports] = await Promise.all([load(), call('credential-import-list', { instanceId, limit: 100 })])
      setResources(items); setCredentialImports(imports.items)
      setCredentialImportBatch(current => current ? { ...current,
        items: current.items.map(item => item.sourceRef === entry.sourceRef
          ? imports.items.find(saved => saved.sourceRef === item.sourceRef) ?? item : item) } : current)
    } catch (failure) {
      setCredentialImportError(failure.message)
      await readCredentialImports()
    } finally { setCredentialImportBusy(false) }
  }
  const cancelCredentialImport = async item => {
    if (credentialImportBusy) return
    setCredentialImportBusy(true); setCredentialImportError(null)
    try {
      const result = await call('credential-import-cancel', { instanceId, commandId: crypto.randomUUID(),
        sourceRef: item.sourceRef,
        ...(credentialImportBatch?.pendingId ? { pendingId: credentialImportBatch.pendingId } : {}) })
      setCredentialImports(current => current.map(saved => saved.sourceRef === result.sourceRef ? result : saved))
    } catch (failure) { setCredentialImportError(failure.message); await readCredentialImports() }
    finally { setCredentialImportBusy(false) }
  }

  return h(Card, { title: t('Credential resources') },
    h('p', { className: 'bt-product-resource-note' }, t('Managed Feishu and GitHub source credentials use separate grants. Feishu delivery and Worker MCP tools need their own grants.')),
    h('section', { className: 'bt-product-credential-import', 'aria-label': t('Import credential resources') },
      h('h3', null, t('Import credential resources')),
      h('p', { className: 'bt-product-resource-note' }, t('Import accepts a controlled ds-superagent-credential-export version 1 JSON file. DSH does not provide a safe way to browse old vault records; if you do not have an export, create a new resource manually. Old grants are never copied.')),
      credentialImportBridge ? h('button', { className: 'bt-soft', type: 'button', disabled: credentialImportBusy,
        onClick: () => void pickCredentialExport() }, credentialImportBusy ? t('Reading export…') : t('Choose credential export')) : null,
      credentialImportError ? h('p', { className: 'bt-main-error', role: 'alert' }, credentialImportError) : null,
      credentialImportBatch ? h('div', { className: 'bt-product-credential-import-preview' },
        h('strong', null, credentialImportBatch.sourceLabel),
        h('span', null, `${t('Original owner')}: ${credentialImportBatch.owner.label}`),
        credentialImportBatch.owner.instanceId ? h('span', null, `${t('Original instance')}: ${credentialImportBatch.owner.instanceId}`) : null,
        h('button', { className: 'bt-soft', type: 'button', disabled: credentialImportBusy,
          onClick: () => {
            void credentialImportBridge.cancel(credentialImportBatch.pendingId).catch(() => {})
            pendingCredentialPreview.current = null
            setCredentialImportBatch(null)
          } }, t('Clear credential preview')),
        credentialImportBatch.items.map(item => {
          const entry = credentialImportBatch.entries.find(candidate => candidate.sourceRef === item.sourceRef)
          if (!entry) return null
          const target = credentialImportTargets[entry.sourceRef] ?? {}
          const status = credentialImports.find(saved => saved.sourceRef === entry.sourceRef) ?? item
          const canImport = ['pending', 'unknown', 'importing'].includes(status.status)
          return h('article', { key: entry.sourceRef, className: 'bt-product-credential-import-item' },
            h('div', { className: 'bt-product-resource-row' },
              h('strong', null, entry.label),
              h('span', null, `${t('Credential type')}: ${entry.type}`),
              h('span', null, `${t('Original scope')}: ${[entry.originalScope.kind, entry.originalScope.role,
                entry.originalScope.work, entry.originalScope.environment,
                ...(entry.originalScope.sharedWith ?? [])].filter(Boolean).join(' · ')}`),
              h('span', { role: 'status' }, `${t('Import status')}: ${credentialImportStatusText(status.status)}${status.code ? ` · ${t(status.code)}` : ''}`),
              status.resourceId ? h('span', null, `${t('Imported resource')}: ${resources?.find(resource => resource.id === status.resourceId)?.label ?? status.resourceId}`) : null,
              status.cleanupPending ? h('span', { className: 'bt-main-error' }, t('Import cleanup pending.')) : null),
            canImport ? h('div', { className: 'bt-product-resource-grant' },
              h('label', null, t('New resource name'), h('input', { value: target.label ?? '', maxLength: 128,
                disabled: credentialImportBusy, onChange: event => updateCredentialImportTarget(entry.sourceRef, { label: event.target.value }) })),
              h('label', null, t('New authorization role'), h('select', { value: target.role ?? '', disabled: credentialImportBusy,
                onChange: event => updateCredentialImportTarget(entry.sourceRef, { role: event.target.value }) },
                h('option', { value: '' }, t('Choose target role')),
                ...['main', 'router', 'worker'].map(value => h('option', { key: value, value }, t(value === 'main' ? 'Main' : value === 'router' ? 'Router' : 'Worker'))))),
              h('label', null, t('New authorization purpose'), h('select', { value: target.purpose ?? '', disabled: credentialImportBusy,
                onChange: event => updateCredentialImportTarget(entry.sourceRef, { purpose: event.target.value }) },
                h('option', { value: '' }, t('Choose purpose')),
                ...['source', 'tool', 'outbound'].map(value => h('option', { key: value, value }, t(value))))),
              h('label', null, t('Target work item ID'), h('input', { value: target.workItemId ?? '', maxLength: 512,
                disabled: credentialImportBusy, onChange: event => updateCredentialImportTarget(entry.sourceRef, { workItemId: event.target.value }) })),
              h('label', null, t('Target Environment ID'), h('input', { value: target.environmentId ?? '', maxLength: 512,
                disabled: credentialImportBusy, onChange: event => updateCredentialImportTarget(entry.sourceRef, { environmentId: event.target.value }) })),
              h('label', null, t('Target source Instance ID'), h('input', { value: target.sourceInstanceId ?? '', maxLength: 512,
                disabled: credentialImportBusy, onChange: event => updateCredentialImportTarget(entry.sourceRef, { sourceInstanceId: event.target.value }) })),
              h('span', { className: 'bt-product-resource-note' }, `${t('New authorization')}: ${[target.role, target.purpose,
                target.workItemId, target.environmentId, target.sourceInstanceId].filter(Boolean).join(' · ') || t('Not selected')}`),
              h('button', { className: 'bt-soft', type: 'button', disabled: credentialImportBusy,
                onClick: () => void commitCredentialImport(entry) }, t(status.status === 'unknown' ? 'Retry import' : 'Create resource and grant')),
              h('button', { className: 'bt-soft', type: 'button', disabled: credentialImportBusy,
                onClick: () => void cancelCredentialImport(status) }, t(status.status === 'cancelled' ? 'Retry cleanup' : 'Cancel import'))) : null)
        })) : null,
      credentialImports.length ? h('div', { className: 'bt-product-resource-list' }, credentialImports.map(item => h('div', {
        key: item.sourceRef, className: 'bt-product-resource-row' },
        h('span', null, `${item.sourceLabel} · ${item.credentialLabel} · ${credentialImportStatusText(item.status)}`),
        item.resourceId ? h('span', null, resources?.find(resource => resource.id === item.resourceId)?.label ?? item.resourceId) : null,
        item.cleanupPending ? h('button', { className: 'bt-soft', type: 'button', disabled: credentialImportBusy,
          onClick: () => void cancelCredentialImport(item) }, t('Retry cleanup')) : null))) : null),
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
    github?.credentialMode === 'managed' ? h('div', { className: 'bt-product-resource-selected' },
      h('p', { className: 'bt-product-resource-note' }, `${t('GitHub source Instance')}: ${github.sourceInstanceId}`),
      h('p', { className: 'bt-product-resource-note' }, t('Grant Main/source for this exact GitHub source Instance, then reconnect.')),
      h('p', { role: 'status' }, `${t('Selected GitHub resource')}: ${github.resourceId
        ? resources?.find(item => item.id === github.resourceId)?.label ?? t('Unavailable resource')
        : t('No GitHub resource selected')} · ${github.state}${github.lastError ? ` · ${github.lastError}` : ''}`),
      github.resourceId ? h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy), onClick: () => selectGithub(null) }, t('Clear GitHub selection')) : null) : null,
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
      github?.credentialMode === 'managed' ? h('button', { className: 'bt-soft', type: 'button', disabled: Boolean(busy),
        onClick: () => selectGithub(selected.id) }, t(github.resourceId === selected.id ? 'Reconnect GitHub with this resource' : 'Use for GitHub')) : null,
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
.bt-product-resource-grant input,.bt-product-resource-grant select{height:32px;min-width:0;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;padding:0 8px}
.bt-product-resource-grant button{justify-self:start}.bt-product-resource-create button:focus-visible,.bt-product-resource-row button:focus-visible,.bt-product-resource-selected button:focus-visible,.bt-product-resource-grant button:focus-visible,.bt-product-resource-create input:focus-visible,.bt-product-resource-selected input:focus-visible,.bt-product-resource-grant input:focus-visible,.bt-product-resource-grant select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-product-resource-request-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-product-credential-import{display:flex;flex-direction:column;gap:8px;margin:14px 0;padding:10px 0;border-top:1px solid var(--bt-line-2)}
.bt-product-credential-import>button:focus-visible,.bt-product-credential-import-preview>button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-product-credential-import h3{margin:0;font-size:13px}
.bt-product-credential-import-preview{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.bt-product-credential-import-item{padding:8px 0;border-top:1px solid var(--bt-line-2)}
@media(max-width:640px){.bt-product-resource-grant{grid-template-columns:minmax(0,1fr)}}
`
