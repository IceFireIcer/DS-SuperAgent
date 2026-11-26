import { createElement as h, useEffect, useRef, useState } from 'react'
import { EmptyState, FieldRow, InlineNotice, SectionCard, StatusChip } from './product-settings-components.js'
import { t } from './i18n.js'
import { ROLE_IDS, roleName } from './roles.js'

const blank = { name: '', kind: 'skill', instructions: '', serverName: '', toolName: '', url: '', resourceId: '', members: [] }
const kindLabels = { skill: 'Skill', mcp: 'MCP tool', bundle: 'Capability bundle' }
const blankScope = { role: 'worker', workItemId: '', environmentId: '' }
const row = (label, control, layout) => h(FieldRow, { label: t(label), control, layout })
const scopeLabel = scope => [roleName(scope.role), scope.workItemId, scope.environmentId].filter(Boolean).join(' · ')

function readDraft(item) {
  return { ...blank, id: item.id, name: item.name, revision: item.revision, kind: item.definition.kind,
    instructions: item.definition.instructions ?? '', ...item.definition.tool, members: item.definition.members ?? [] }
}

export function CapabilitySettings({ binding, call, works, environments }) {
  const instanceId = binding.instanceId
  const [items, setItems] = useState(null)
  const [resources, setResources] = useState([])
  const [draft, setDraft] = useState(blank)
  const [selected, select] = useState('')
  const [scope, setScope] = useState(blankScope)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(null)
  const current = items?.find(item => item.id === selected)

  const refresh = async () => {
    const catalog = await call('capability-list', { instanceId })
    setItems(catalog.items)
    return catalog.items
  }

  useEffect(() => {
    let live = true
    void call('capability-list', { instanceId }).then(result => {
      if (live) setItems(result.items)
    }, failure => { if (live) setError(failure.message) })
    void (async () => {
      const options = []
      let after
      do {
        const page = await call('resource-list', { instanceId, limit: 100, ...(after ? { after } : {}) })
        options.push(...page.items.filter(item => item.status === 'active'))
        after = page.cursor
      } while (after && live)
      if (live) setResources(options)
    })().catch(() => { if (live) setResources([]) })
    return () => { live = false }
  }, [call, instanceId])

  function choose(item) {
    select(item?.id ?? '')
    setDraft(item ? readDraft(item) : blank)
    setScope(blankScope)
    setConfirmDelete(false)
    setNotice('')
    setError('')
  }

  async function run(endpoint, payload) {
    if (pending.current?.running) return
    const identity = JSON.stringify([endpoint, payload])
    const commandId = pending.current?.identity === identity ? pending.current.commandId : crypto.randomUUID()
    pending.current = { identity, commandId, running: true }
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await call(endpoint, { instanceId, commandId, ...payload })
      pending.current = null
      if (result.deleted) {
        setItems(previous => previous.filter(item => item.id !== result.id))
        choose()
      } else {
        setItems(previous => [...previous.filter(item => item.id !== result.id), result])
        select(result.id)
        setDraft(readDraft(result))
      }
      setNotice(t(result.deleted ? 'Capability deleted.' : 'Capability saved.'))
    } catch (failure) {
      pending.current = { identity, commandId, running: false }
      setError(failure.message)
      if (failure.code === 'CAPABILITY_REVISION_CONFLICT') {
        try {
          const latest = (await refresh()).find(item => item.id === selected)
          if (latest) setDraft(readDraft(latest))
        } catch { /* Retain the command error. */ }
      }
    } finally { setBusy(false) }
  }

  const save = () => {
    let definition
    if (draft.kind === 'skill') definition = { kind: 'skill', instructions: draft.instructions }
    else if (draft.kind === 'mcp') definition = { kind: 'mcp', tool: { serverName: draft.serverName,
      toolName: draft.toolName, url: draft.url, resourceId: draft.resourceId } }
    else definition = { kind: 'bundle', members: draft.members }
    return run('capability-save', { ...(draft.id ? { id: draft.id } : {}), expectedRevision: draft.revision ?? 0,
      name: draft.name, definition })
  }
  const address = { id: current?.id, expectedRevision: current?.revision }
  const field = (label, key, input = 'input') => row(label, h(input, { className: 'bt-bs-input', value: draft[key], disabled: busy,
    onChange: event => setDraft(value => ({ ...value, [key]: event.target.value })) }), input === 'textarea' ? 'stack' : undefined)
  const scopeField = (label, key, choices) => row(label, h('select', { className: 'bt-bs-input', value: scope[key], disabled: busy,
    onChange: event => setScope(value => ({ ...value, [key]: event.target.value })) },
  h('option', { value: '' }, t('Any')), choices.map(({ id, label: name }) => h('option', { key: id, value: id }, name ?? id))))
  const action = (label, onClick, disabled = false) => h('button', { className: 'bt-soft', type: 'button', onClick, disabled: busy || disabled }, t(label))
  const bind = () => run('capability-bind', { ...address, enabled: true, scope: { role: scope.role,
    ...(scope.role === 'worker' && scope.workItemId ? { workItemId: scope.workItemId } : {}),
    ...(scope.role === 'worker' && scope.environmentId ? { environmentId: scope.environmentId } : {}) } })
  return h('div', { className: 'bt-product-resource-selected' },
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    notice ? h(InlineNotice, { tone: 'success' }, notice) : null,
    h(SectionCard, { title: t('Capability library') },
      !items ? h(EmptyState, { title: t(error ? 'Capabilities unavailable' : 'Loading…'), action: error
        ? action('Retry', () => { setError(''); void refresh().catch(failure => setError(failure.message)) }) : undefined })
        : row('Capability', h('select', { className: 'bt-bs-input', value: selected, disabled: busy,
          onChange: event => choose(items.find(item => item.id === event.target.value)) },
        h('option', { value: '' }, t('New capability')),
        items.toSorted((left, right) => left.name.localeCompare(right.name)).map(item => h('option', { key: item.id, value: item.id }, item.name))))),
    items ? h(SectionCard, { title: current?.name ?? t('New capability') },
      field('Name', 'name'),
      row('Kind', h('select', { className: 'bt-bs-input', value: draft.kind, disabled: busy, onChange: event => {
        setDraft(value => ({ ...value, kind: event.target.value }))
      } }, Object.entries(kindLabels).map(([value, label]) => h('option', { key: value, value }, t(label))))),
      draft.kind === 'skill' ? field('Instructions', 'instructions', 'textarea') : null,
      draft.kind === 'mcp' ? h('div', null, field('MCP server name', 'serverName'), field('MCP tool name', 'toolName'), field('MCP endpoint', 'url'),
        row('MCP credential resource', h('select', { className: 'bt-bs-input', value: draft.resourceId, disabled: busy,
          onChange: event => setDraft(value => ({ ...value, resourceId: event.target.value })) },
        h('option', { value: '' }, t('Choose a resource')),
        resources.map(item => h('option', { key: item.id, value: item.id }, item.label))))) : null,
      draft.kind === 'bundle' ? row('Bundle members', h('select', { className: 'bt-bs-input', multiple: true, value: draft.members,
        disabled: busy, onChange: event => setDraft(value => ({ ...value, members: Array.from(event.target.selectedOptions, option => option.value) })) },
      items.filter(item => item.id !== selected && item.definition.kind !== 'bundle')
        .map(item => h('option', { key: item.id, value: item.id }, item.name))), 'stack') : null,
      row('Actions', h('div', { className: 'bt-product-resource-row' },
        action('Save capability', save, !draft.name.trim() || draft.kind === 'mcp' && !draft.resourceId),
        current ? action(confirmDelete ? 'Confirm delete' : 'Delete', () => {
          if (!confirmDelete) { setConfirmDelete(true); return }
          setConfirmDelete(false)
          void run('capability-delete', address)
        }) : null))) : null,
    current ? h(SectionCard, { title: t('Execution bindings') },
      row('Approval', h('div', { className: 'bt-product-resource-row' }, h(StatusChip, { tone: current.approved ? 'success' : 'neutral' },
        t(current.approved ? 'Approved' : 'Needs approval')),
      action(current.approved ? 'Revoke approval' : 'Approve', () => run('capability-approve', { ...address, approved: !current.approved })))),
      current.bindings.map(bindingScope => h('div', { key: JSON.stringify(bindingScope) },
        row(scopeLabel(bindingScope), action('Unbind', () => run('capability-bind', { ...address, enabled: false, scope: bindingScope }))))),
      row('Role', h('select', { className: 'bt-bs-input', value: scope.role, disabled: busy,
        onChange: event => setScope({ ...blankScope, role: event.target.value }) },
      ROLE_IDS.map(role => h('option', { value: role, key: role }, roleName(role))))),
      scope.role === 'worker' ? scopeField('Work item', 'workItemId', (works ?? []).map(work => ({ id: work.id, label: work.goal }))) : null,
      scope.role === 'worker' ? scopeField('Execution environment', 'environmentId', environments ?? []) : null,
      row('Binding', action('Bind capability', bind, current.definition.kind === 'mcp'
        && (scope.role !== 'worker' || !(scope.environmentId || scope.workItemId))))) : null)
}
