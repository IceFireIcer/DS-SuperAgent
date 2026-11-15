import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './bot-settings.js'
import { t } from './i18n.js'

export function ProductCredentialSettings({ binding, call }) {
  const [resources, setResources] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
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
  const instanceId = binding.instanceId

  const load = async () => {
    const items = []
    let after
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await call('resource-list', { instanceId, limit: 100, ...(after ? { after } : {}) })
      items.push(...page.items)
      if (!page.cursor) return items
      after = page.cursor
    }
    throw new Error(t('The credential resource list exceeds its bounded limit.'))
  }
  const refresh = async () => {
    const items = await load()
    setResources(items)
    return items
  }
  useEffect(() => {
    let live = true
    load().then(items => { if (live) setResources(items) },
      failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [call, instanceId])

  const run = async (name, action, success) => {
    setBusy(name); setError(null); setNotice(null)
    try {
      await action()
      await refresh()
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
  const choose = resource => { setSelectedId(resource.id); setRename(resource.label); setError(null); setNotice(null) }
  const grant = event => {
    event.preventDefault()
    if (!selected || busy || purpose !== 'tool' && !sourceInstanceId.trim()) return
    const scope = { role, ...(workItemId.trim() ? { workItemId: workItemId.trim() } : {}),
      ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
      ...(sourceInstanceId.trim() ? { sourceInstanceId: sourceInstanceId.trim() } : {}) }
    void run('grant', () => call('resource-grant', { instanceId, commandId: crypto.randomUUID(), resourceId: selected.id,
      expectedRevision: selected.revision, scope, purposes: [purpose] }), 'Authorization recorded.')
  }
  const remove = resource => {
    if (busy || resource.status !== 'deleted' && !window.confirm(t('Delete this credential resource and all its grants?'))) return
    void run('delete', () => resource.status === 'deleted'
      ? call('resource-cleanup', { instanceId, resourceId: resource.id })
      : call('resource-delete', { instanceId, commandId: crypto.randomUUID(), resourceId: resource.id,
        expectedRevision: resource.revision }), 'Resource deletion recorded.')
  }

  return h(Card, { title: t('Credential resources') },
    h('p', { className: 'bt-product-resource-note' }, t('Saved authorizations are not yet available to source, tool or delivery consumers.')),
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
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
      h('form', { onSubmit: event => { event.preventDefault(); if (!rename.trim() || busy) return
        void run('rename', () => call('resource-rename', { instanceId, commandId: crypto.randomUUID(), resourceId: selected.id,
          expectedRevision: selected.revision, label: rename.trim() }), 'Resource name changed.') } },
      h('input', { className: 'bt-bs-input', value: rename, maxLength: 128, disabled: Boolean(busy),
        'aria-label': t('New resource name'), onChange: event => setRename(event.target.value) }),
      h('button', { className: 'bt-soft', type: 'submit', disabled: Boolean(busy) || !rename.trim() }, t('Rename resource'))),
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
          t('Record authorization'))),
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
.bt-product-resource-grant button{justify-self:start}.bt-product-resource-create button:focus-visible,.bt-product-resource-row button:focus-visible,.bt-product-resource-selected button:focus-visible,.bt-product-resource-create input:focus-visible,.bt-product-resource-selected input:focus-visible,.bt-product-resource-grant input:focus-visible,.bt-product-resource-grant select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:640px){.bt-product-resource-grant{grid-template-columns:minmax(0,1fr)}}
`
