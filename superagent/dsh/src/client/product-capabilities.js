import { createElement as h, useEffect, useRef, useState } from 'react'
import { PlusIcon } from './icons.js'
import { t } from './i18n.js'
import {
  EmptyState, FieldRow, InlineNotice, SectionCard, SettingsPage, StatusChip,
} from './product-settings-components.js'

const blank = () => ({
  name: '', kind: 'mcp', description: '', resourceId: '', serverName: '', toolName: '', url: '',
  content: '', items: [],
})

const kindName = kind => kind === 'mcp' ? t('MCP') : kind === 'skill' ? t('Skill') : t('Pack')
const kindDetail = capability => capability.kind === 'pack'
  ? (capability.items ?? []).join(', ') || t('No items')
  : capability.kind === 'mcp'
    ? capability.mcp ? `${capability.mcp.serverName} / ${capability.mcp.toolName}` : t('MCP server')
    : t('Skill instructions')

const bindingStatus = status => status === 'ready' ? t('Ready')
  : status === 'needs-approval' ? t('Needs approval')
    : status === 'needs-grant' ? t('Needs credential grant')
      : status === 'needs-scope' ? t('Needs work or Environment')
        : status === 'resource-unavailable' ? t('Credential resource unavailable')
          : status === 'blocked' ? t('Blocked')
            : status === 'disabled' ? t('Removed') : status

const capabilityState = state => state === 'ready' ? t('Ready')
  : state === 'partial' ? t('Partially ready')
    : state === 'blocked' ? t('Blocked')
      : t('Unbound')

const stateTone = state => state === 'ready' ? 'success'
  : state === 'partial' ? 'warn'
    : state === 'blocked' ? 'danger' : 'neutral'

const scopeText = scope => [
  scope.role === 'main' ? t('Main') : scope.role === 'router' ? t('Router') : t('Worker'),
  scope.workItemId ? `${t('Work item')}: ${scope.workItemId}` : null,
  scope.environmentId ? `${t('Environment')}: ${scope.environmentId}` : null,
].filter(Boolean).join(' · ')

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const reserved = new Set(['github', 'mail'])

function CapabilityForm({ draft, setDraft, items, resources, resourceError, busy, submit, close }) {
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))
  const activeResources = (resources ?? []).filter(resource => resource.status === 'active')
  const selectedMissing = draft.resourceId && !activeResources.some(resource => resource.id === draft.resourceId)
  const availableItems = items.filter(item => item.name !== draft.name && ['mcp', 'skill'].includes(item.kind))
  const original = draft.originalName !== undefined
  const canSave = !busy && !(draft.kind === 'mcp' && (resourceError || !draft.resourceId))
  return h('form', { className: 'bt-product-capability-form', onSubmit: submit },
    h(FieldRow, { label: t('Name'), hint: t('Lowercase letters, digits and single hyphens.'), layout: 'stack',
      control: h('input', { className: 'bt-bs-input', 'aria-label': t('Name'), value: draft.name, maxLength: 32,
        disabled: busy || original, placeholder: 'review-tools', spellCheck: false,
        onChange: event => set('name', event.target.value) }) }),
    h(FieldRow, { label: t('Type'), layout: 'stack',
      control: h('select', { className: 'bt-bs-input', 'aria-label': t('Type'), value: draft.kind, disabled: busy || original,
        onChange: event => set('kind', event.target.value) },
      ['mcp', 'skill', 'pack'].map(kind => h('option', { key: kind, value: kind }, kindName(kind)))) }),
    h(FieldRow, { label: t('Description'), layout: 'stack',
      control: h('input', { className: 'bt-bs-input', 'aria-label': t('Description'), value: draft.description,
        maxLength: 2000, disabled: busy, onChange: event => set('description', event.target.value) }) }),
    draft.kind === 'mcp' ? h('div', { className: 'bt-product-capability-fields' },
      h(FieldRow, { label: t('Credential resource'), hint: t('The selected credential supplies the MCP bearer token.'),
        layout: 'stack',
        control: h('select', { className: 'bt-bs-input', 'aria-label': t('Credential resource'), value: draft.resourceId,
          disabled: busy || Boolean(resourceError), onChange: event => set('resourceId', event.target.value) },
        h('option', { value: '' }, t('Choose a resource')),
        activeResources.map(resource => h('option', { key: resource.id, value: resource.id },
          `${resource.label} · ${resource.id}`)),
        selectedMissing ? h('option', { value: draft.resourceId }, `${t('Unavailable resource')} · ${draft.resourceId}`) : null) }),
      h(FieldRow, { label: t('MCP endpoint'), layout: 'stack',
        control: h('input', { className: 'bt-bs-input', 'aria-label': t('MCP endpoint'), value: draft.url,
          placeholder: 'https://mcp.example.test/mcp', spellCheck: false, disabled: busy,
          onChange: event => set('url', event.target.value) }) }),
      h('div', { className: 'bt-product-capability-pair' },
        h(FieldRow, { label: t('Server name'), layout: 'stack',
          control: h('input', { className: 'bt-bs-input', 'aria-label': t('Server name'), value: draft.serverName,
            maxLength: 32, spellCheck: false, disabled: busy,
            onChange: event => set('serverName', event.target.value) }) }),
        h(FieldRow, { label: t('Tool name'), layout: 'stack',
          control: h('input', { className: 'bt-bs-input', 'aria-label': t('Tool name'), value: draft.toolName,
            maxLength: 24, spellCheck: false, disabled: busy,
            onChange: event => set('toolName', event.target.value) }) })),
      resourceError ? h(InlineNotice, { tone: 'warn', title: t('Credential resources unavailable') },
        `${resourceError} ${t('MCP capability changes are disabled until the credential resource list is available.')}`) : null,
      !resourceError && activeResources.length === 0
        ? h('p', { className: 'bt-set-hint' }, t('Create an active credential resource before adding an MCP capability.')) : null)
      : draft.kind === 'skill' ? h(FieldRow, { label: t('Skill instructions'), layout: 'stack',
        control: h('textarea', { className: 'bt-bs-input', 'aria-label': t('Skill instructions'), rows: 6,
          value: draft.content, disabled: busy, onChange: event => set('content', event.target.value) }) })
        : h('fieldset', { className: 'bt-product-capability-pack' },
          h('legend', null, t('Included capabilities')),
          availableItems.length === 0
            ? h('p', { className: 'bt-set-hint' }, t('Save an MCP capability or skill first.'))
            : availableItems.map(item => h('label', { key: item.name, className: 'bt-product-capability-check' },
              h('input', { type: 'checkbox', checked: draft.items.includes(item.name), disabled: busy,
                onChange: event => set('items', event.target.checked
                  ? [...draft.items, item.name]
                  : draft.items.filter(name => name !== item.name)) }),
              h('span', null, item.name), h(StatusChip, null, kindName(item.kind))))),
    h('div', { className: 'bt-product-capability-form-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: close }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: !canSave },
        original ? t('Save capability') : t('Add capability'))) )
}

export function ProductCapabilitiesSettings({ binding, call }) {
  const instanceId = binding.instanceId
  const [items, setItems] = useState(null)
  const [resources, setResources] = useState(null)
  const [listError, setListError] = useState(null)
  const [resourceError, setResourceError] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(null)
  const [confirming, setConfirming] = useState('')
  const [scopes, setScopes] = useState({})
  const attempts = useRef(new Map())

  const refresh = async () => {
    let page
    try {
      page = await call('capability-list', { instanceId })
    } catch (failure) {
      setListError(failure?.message ?? String(failure))
      return false
    }
    setItems(page.items ?? [])
    setListError(null)
    try {
      const resourcePage = await call('resource-list', { instanceId, limit: 100 })
      setResources(resourcePage.items ?? [])
      setResourceError(null)
    } catch (failure) {
      setResources(null)
      setResourceError(failure?.message ?? String(failure))
    }
    return true
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const page = await call('capability-list', { instanceId })
        if (!live) return
        setItems(page.items ?? [])
        setListError(null)
      } catch (failure) {
        if (live) setListError(failure?.message ?? String(failure))
        return
      }
      try {
        const resourcePage = await call('resource-list', { instanceId, limit: 100 })
        if (live) {
          setResources(resourcePage.items ?? [])
          setResourceError(null)
        }
      } catch (failure) {
        if (live) {
          setResources(null)
          setResourceError(failure?.message ?? String(failure))
        }
      }
    })()
    return () => { live = false }
  }, [call, instanceId])

  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const execute = async (label, endpoint, payload, success) => {
    if (busy) return false
    const fingerprint = JSON.stringify([endpoint, payload])
    const prior = attempts.current.get(label)
    const commandId = prior?.fingerprint === fingerprint ? prior.commandId : crypto.randomUUID()
    attempts.current.set(label, { fingerprint, commandId })
    setBusy(label)
    setError(null)
    setNotice(null)
    let result
    try {
      result = await call(endpoint, { instanceId, commandId, ...payload })
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      if (['CAPABILITY_REVISION_CONFLICT', 'CAPABILITY_KIND_CONFLICT', 'NOT_FOUND',
        'RESOURCE_UNAVAILABLE', 'CAPABILITY_NOT_APPROVABLE'].includes(failure?.code)) {
        await refresh().catch(() => {})
      }
      setBusy(null)
      return false
    }
    attempts.current.delete(label)
    await refresh().catch(() => {})
    setBusy(null)
    setNotice(success)
    return result
  }

  const startNew = () => {
    setDraft(blank())
    setError(null)
    setNotice(null)
  }

  const startEdit = item => {
    setDraft({
      ...blank(),
      originalName: item.name,
      name: item.name,
      kind: item.kind,
      description: item.description,
      resourceId: item.mcp?.resourceId ?? '',
      serverName: item.mcp?.serverName ?? '',
      toolName: item.mcp?.toolName ?? '',
      url: item.mcp?.url ?? '',
      content: item.content ?? '',
      items: [...(item.items ?? [])],
    })
    setError(null)
    setNotice(null)
  }

  const submit = async event => {
    event.preventDefault()
    if (busy || !draft) return
    const name = draft.name.trim()
    if (!namePattern.test(name) || name.length > 32 || reserved.has(name)) {
      setError(t('Use lowercase letters, digits and single hyphens; connector names are reserved.'))
      return
    }
    const payload = {
      name, kind: draft.kind, description: draft.description,
      expectedRevision: draft.originalName === undefined ? 0 : ((items ?? []).find(item => item.name === draft.name)?.revision ?? 0),
    }
    if (draft.kind === 'mcp') {
      if (!draft.resourceId || !draft.url.trim() || !draft.serverName.trim() || !draft.toolName.trim()) {
        setError(t('Choose a credential resource and enter the MCP endpoint, server and tool names.'))
        return
      }
      payload.mcp = {
        resourceId: draft.resourceId,
        url: draft.url.trim(),
        serverName: draft.serverName.trim(),
        toolName: draft.toolName.trim(),
      }
    } else if (draft.kind === 'skill') {
      if (!draft.content.trim()) {
        setError(t('Enter the skill instructions.'))
        return
      }
      payload.content = draft.content
    } else {
      if (!draft.items.length) {
        setError(t('Choose at least one capability for the pack.'))
        return
      }
      payload.items = draft.items
    }
    if (await execute(`save:${name}`, 'capability-save', payload,
      draft.originalName === undefined ? t('Capability added.') : t('Capability saved.'))) {
      setDraft(null)
    }
  }

  const remove = async item => {
    if (confirming !== item.name) {
      setConfirming(item.name)
      return
    }
    setConfirming('')
    await execute(`delete:${item.name}`, 'capability-delete',
      { capabilityId: item.name, expectedRevision: item.revision }, t('Capability deleted.'))
  }

  const approve = item => execute(`approve:${item.name}`, 'capability-approve',
    { capabilityId: item.name, expectedRevision: item.revision, approved: !item.approved },
    item.approved ? t('MCP approval revoked.') : t('MCP capability approved.'))

  const scopeFor = name => scopes[name] ?? { role: 'worker', workItemId: '', environmentId: '' }
  const updateScope = (name, key, value) => setScopes(current => ({
    ...current,
    [name]: { ...scopeFor(name), [key]: value },
  }))
  const bind = item => {
    const draftScope = scopeFor(item.name)
    const scope = draftScope.role === 'worker' ? {
      role: 'worker',
      ...(draftScope.workItemId.trim() ? { workItemId: draftScope.workItemId.trim() } : {}),
      ...(draftScope.environmentId.trim() ? { environmentId: draftScope.environmentId.trim() } : {}),
    } : { role: draftScope.role }
    if (item.kind === 'mcp' && scope.role === 'worker' && !scope.workItemId && !scope.environmentId) {
      setError(t('A Worker MCP capability needs a work item or Environment.'))
      return
    }
    void execute(`bind:${item.name}:${JSON.stringify(scope)}`, 'capability-bind',
      { capabilityId: item.name, expectedRevision: item.revision, scope, active: true }, t('Capability bound.'))
  }
  const unbind = (item, binding) => execute(`unbind:${item.name}:${binding.id}`, 'capability-bind',
    { capabilityId: item.name, expectedRevision: item.revision, scope: binding.scope, active: false },
    t('Capability removed from this scope.'))

  const renderCapability = item => {
    const activeBindings = item.bindings.filter(binding => binding.active)
    const draftScope = scopeFor(item.name)
    const bindings = activeBindings.length === 0
      ? h('p', { className: 'bt-set-hint' }, t('No active bindings.'))
      : h('div', { className: 'bt-product-capability-binding-list' }, activeBindings.map(binding =>
        h('div', { key: binding.id, className: 'bt-product-capability-binding' },
          h('span', null, scopeText(binding.scope)),
          h(StatusChip, { tone: binding.status === 'ready' ? 'success'
            : ['needs-approval', 'needs-grant', 'needs-scope'].includes(binding.status) ? 'warn' : 'danger' },
          bindingStatus(binding.status)),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
            onClick: () => void unbind(item, binding) }, t('Remove')))))
    return h('article', { key: item.name, className: 'bt-connector bt-product-capability' },
      h('div', { className: 'bt-connector-head' },
        h('span', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-title' },
            h('span', { className: 'bt-connector-name' }, item.name),
            h('span', { className: 'bt-tag' }, kindName(item.kind))),
          h('span', { className: 'bt-connector-status' }, item.description || kindDetail(item))),
        h('span', { className: 'bt-connector-actions' },
          item.kind === 'mcp' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
            disabled: Boolean(busy), onClick: () => void approve(item) },
          item.approved ? t('Revoke approval') : t('Approve capability')) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
            onClick: () => startEdit(item) }, t('Edit')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
            onClick: () => void remove(item) },
          confirming === item.name ? t('Click again to delete') : t('Delete')))),
      h('div', { className: 'bt-product-capability-badges' },
        h(StatusChip, { tone: item.approved ? 'success' : 'warn' },
          item.approved ? t('Approved') : t('Needs approval')),
        h(StatusChip, { tone: stateTone(item.state) }, capabilityState(item.state)),
        item.resource && item.resource.status !== 'active'
          ? h(StatusChip, { tone: 'danger' }, t('Credential resource unavailable')) : null,
        item.resource?.status === 'active'
          ? h('span', { className: 'bt-product-capability-resource' },
            `${t('Credential resource')}: ${item.resource.label ?? item.resource.id}`) : null),
      item.kind === 'mcp' ? h('p', { className: 'bt-set-hint' },
        t('Approval permits the MCP tool definition. The credential resource grant still authorizes each exact role and work scope.')) : null,
      h('div', { className: 'bt-product-capability-bindings' },
        h('h4', null, t('Role and work scope')),
        bindings,
        h('div', { className: 'bt-product-capability-bind-form' },
          h('label', null, t('Role'),
            h('select', { className: 'bt-bs-input', 'aria-label': `${t('Role')} ${item.name}`,
              value: draftScope.role, disabled: Boolean(busy),
              onChange: event => updateScope(item.name, 'role', event.target.value) },
            h('option', { value: 'main' }, t('Main')),
            h('option', { value: 'router' }, t('Router')),
            h('option', { value: 'worker' }, t('Worker')))),
          draftScope.role === 'worker' ? h('label', null, t('Work item ID'),
            h('input', { className: 'bt-bs-input', 'aria-label': `${t('Work item ID')} ${item.name}`,
              value: draftScope.workItemId, disabled: Boolean(busy),
              onChange: event => updateScope(item.name, 'workItemId', event.target.value) })) : null,
          draftScope.role === 'worker' ? h('label', null, t('Environment ID'),
            h('input', { className: 'bt-bs-input', 'aria-label': `${t('Environment ID')} ${item.name}`,
              value: draftScope.environmentId, disabled: Boolean(busy),
              onChange: event => updateScope(item.name, 'environmentId', event.target.value) })) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
            disabled: Boolean(busy) || item.kind === 'mcp' && draftScope.role === 'worker'
              && !draftScope.workItemId.trim() && !draftScope.environmentId.trim(),
            onClick: () => bind(item) }, t('Bind capability'))),
        item.kind === 'mcp' && draftScope.role === 'worker'
          ? h('p', { className: 'bt-set-hint' },
            t('Worker MCP bindings need a work item or Environment; role-wide Worker tool authority is not allowed.'))
          : draftScope.role !== 'worker'
            ? h('p', { className: 'bt-set-hint' }, t('Main and Router bindings use role-only scope.')) : null))
  }

  const library = listError
    ? h(InlineNotice, { tone: 'danger', title: t('Capability library unavailable'),
      action: h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
        onClick: () => void refresh() }, t('Retry')) }, listError)
    : h('div', { className: 'bt-ps-content' },
      draft ? h(SectionCard, { title: draft.originalName === undefined ? t('New capability') : t('Edit capability') },
        h(CapabilityForm, { draft, setDraft, items: items ?? [], resources, resourceError, busy,
          submit, close: () => setDraft(null) })) : null,
      h(SectionCard, { title: t('Shared capabilities'),
        description: t('Capabilities are bound to a role and work scope. A binding does not grant credentials, and Worker MCP capability needs a work item or Environment.') },
      error ? h(InlineNotice, { tone: 'danger', title: t('Capability change failed') }, error) : null,
      notice ? h(InlineNotice, { tone: 'success', title: t('Capability updated') }, notice) : null,
      items === null ? h('p', { role: 'status' }, t('Loading…'))
        : items.length === 0 ? h(EmptyState, { title: t('No capabilities saved'),
          detail: t('Add an MCP capability, a skill or a pack.') })
          : h('div', { className: 'bt-product-capability-list' }, items.map(renderCapability))))
  return h(SettingsPage, { title: t('Capabilities'),
    actions: draft || listError ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon',
      disabled: Boolean(busy), onClick: startNew }, h(PlusIcon), t('Add capability')) }, library)
}

export const PRODUCT_CAPABILITIES_CSS = `
.bt-product-capability-list{display:grid;gap:10px}
.bt-product-capability{padding:0;overflow:hidden}
.bt-product-capability>.bt-connector-head{padding:12px 14px}
.bt-product-capability-badges{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:0 14px 10px}
.bt-product-capability-resource{color:var(--bt-ink-2);font-size:var(--bt-ps-small);overflow-wrap:anywhere}
.bt-product-capability-bindings{display:grid;gap:10px;padding:12px 14px;border-top:.5px solid var(--bt-line)}
.bt-product-capability-bindings h4{margin:0;font-size:var(--bt-ps-text);font-weight:600}
.bt-product-capability-binding-list{display:grid;gap:6px}
.bt-product-capability-binding{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;
  padding:8px 0;border-bottom:.5px solid var(--bt-line-2);font-size:var(--bt-ps-small);overflow-wrap:anywhere}
.bt-product-capability-binding>span{min-width:0}
.bt-product-capability-bind-form{display:grid;grid-template-columns:minmax(120px,.6fr) minmax(0,1fr) minmax(0,1fr) auto;align-items:end;gap:8px}
.bt-product-capability-bind-form label,.bt-product-capability-fields label{display:grid;gap:4px;min-width:0;color:var(--bt-ink-2);font-size:var(--bt-ps-small)}
.bt-product-capability-form{display:grid;gap:10px;padding:8px 12px 12px}
.bt-product-capability-fields{display:grid;gap:10px}
.bt-product-capability-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.bt-product-capability-pack{display:grid;gap:6px;margin:0;padding:0;border:0}
.bt-product-capability-pack>legend{padding:0 0 6px;font-size:var(--bt-ps-small);color:var(--bt-ink-2)}
.bt-product-capability-check{display:flex;align-items:center;gap:8px;min-height:32px;font-size:var(--bt-ps-small)}
.bt-product-capability-check>span:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}
.bt-product-capability-form-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.bt-product-capability :is(button,input,select,textarea):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:720px){
  .bt-product-capability-binding{grid-template-columns:minmax(0,1fr) auto}
  .bt-product-capability-binding>button{grid-column:1/-1;justify-self:start}
  .bt-product-capability-bind-form{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bt-product-capability-bind-form>button{grid-column:1/-1;justify-self:start}
}
@media(max-width:520px){
  .bt-product-capability-pair,.bt-product-capability-bind-form{grid-template-columns:minmax(0,1fr)}
}
`
