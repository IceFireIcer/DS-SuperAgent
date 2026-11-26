import { createElement as h, useEffect, useRef, useState } from 'react'
import { SectionCard, FieldRow, InlineNotice } from './product-settings-components.js'
import { t } from './i18n.js'

export const KeyIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M7 9.5a3.5 3.5 0 1 1 0 .01z' }), h('path', { d: 'M10.4 10.6L17 10.6M14.5 10.6v2.4M16.6 10.6v1.8' }))

const maskByCss = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')

export function MaskedInput({ value, onChange, onEnter, label, disabled }) {
  return h('input', { className: 'bt-secret-input', type: maskByCss ? 'text' : 'password', value, disabled,
    'data-masked': maskByCss ? '' : undefined, autoComplete: maskByCss ? 'off' : 'new-password',
    autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '',
    'data-form-type': 'other', 'aria-label': label, placeholder: label, onChange: event => onChange(event.target.value),
    onKeyDown: event => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      event.preventDefault()
      onEnter()
    } })
}

function CredentialCard({ request, resource, decide, busy }) {
  return h('article', { className: 'bt-q bt-secret', 'aria-label': t('Credential request') },
    h('div', { className: 'bt-q-head' }, h(KeyIcon), h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title' }, t('Allow this work to use {name}?', { name: resource?.label ?? t('Credential resource') })),
      h('p', { className: 'bt-q-detail' }, [request.scope.workItemId, request.scope.environmentId, t(request.purpose)].filter(Boolean).join(' · ')))),
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => decide(request, resource, false) }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || resource?.status !== 'active',
        onClick: () => decide(request, resource, true) }, t('Allow'))))
}

export function ChatSecrets({ binding, call, settings = false }) {
  const instanceId = binding?.instanceId
  const [items, setItems] = useState([])
  const [resources, setResources] = useState(new Map())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const running = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    if (!instanceId) return
    let live = true
    let timer
    const load = async () => {
      const request = revision.current
      try {
        if (running.current) return
        const pending = []
        let after
        for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
          const page = await call('resource-request-list', { instanceId, limit: 100, ...(after ? { after } : {}) })
          pending.push(...page.items.filter(item => item.status === 'pending' && item.scope.role === 'worker' && item.purpose === 'tool'))
          after = page.cursor
          if (!live || !after || pending.length >= 25) break
        }
        const visible = pending.slice(0, 25)
        const entries = await Promise.all([...new Set(visible.map(item => item.resourceId))].map(async resourceId =>
          [resourceId, await call('resource-read', { instanceId, resourceId }).catch(() => null)]))
        if (live && request === revision.current) { setItems(visible); setResources(new Map(entries)) }
      } catch (failure) {
        if (live && settings && request === revision.current) setError(failure.message)
      } finally { if (live) timer = setTimeout(load, 4000) }
    }
    void load()
    return () => { live = false; clearTimeout(timer) }
  }, [call, instanceId, settings])

  const run = async action => {
    if (running.current) return
    running.current = true
    revision.current++
    setBusy(true); setError('')
    try { await action() }
    catch (failure) { setError(failure.message) }
    finally { running.current = false; setBusy(false) }
  }
  const decide = (request, resource, approved) => void run(async () => {
    const commandId = `chat-secret:${request.id}:${approved ? resource.revision : 'cancel'}`
    if (approved) await call('resource-grant', { instanceId, commandId, resourceId: request.resourceId, expectedRevision: resource.revision,
      scope: request.scope, purposes: [request.purpose], requestId: request.id })
    else await call('resource-cancel', { instanceId, commandId, requestId: request.id })
    setItems(current => current.filter(item => item.id !== request.id))
  })
  const save = () => void run(async () => {
    if (!label.trim() || !value.trim()) return
    const captured = value
    setValue('')
    await call('resource-create', { instanceId, commandId: crypto.randomUUID(), label, value: captured })
    setLabel('')
  })
  if (!settings && !items.length && !error) return null
  return h('div', { className: 'bt-ps-content' },
    settings ? h(SectionCard, { title: t('Add credential') },
      h(FieldRow, { label: t('Name'), control: h('input', { className: 'bt-bs-input', value: label, maxLength: 128,
        onChange: event => setLabel(event.target.value) }) }),
      h(FieldRow, { label: t('Value'), control: h(MaskedInput, { label: t('Paste or type the key'), value, onChange: setValue, disabled: busy, onEnter: save }) }),
      h(FieldRow, { label: t('Actions'), control: h('button', { type: 'button', disabled: busy || !value.trim() || !label.trim(), className: 'bt-soft', onClick: save }, t('Save')) })) : null,
    error ? h(InlineNotice, { tone: 'danger' }, t(error)) : null,
    settings && !items.length ? h('p', { role: 'status' }, t('No pending credential requests.')) : null,
    items.map(request => h(CredentialCard, { key: request.id, request, resource: resources.get(request.resourceId), decide, busy })))
}

export const CHAT_SECRET_CSS = `.bt-secret-input{min-width:0;width:100%;font:inherit;color:var(--bt-ink);background:var(--bt-card);border:1px solid var(--bt-line);border-radius:var(--bt-radius-input);padding:8px 12px}.bt-secret-input[data-masked]{-webkit-text-security:disc}`
