// Adapted from DS Bot 0.3.8 (Apache-2.0), ds-bot/src/client/memory-panel.js (see NOTICE).
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { Card, Row } from './product-card.js'
import { EmptyState, InlineNotice, StatusChip } from './product-settings-components.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'
import { useLinger } from './motion.js'

const scopeLabel = scope => scope.kind === 'main' ? t('Main')
  : scope.kind === 'work' ? `${t('Work private')} · ${scope.workItemId}`
    : `${t('Explicitly shared')} · ${[scope.main ? t('Main') : '', ...scope.workItemIds].filter(Boolean).join(', ') || t('No readers')}`

const originalScopeLabel = scope => {
  const kind = scope.kind === 'main' ? t('Main')
    : scope.kind === 'work' ? t('Work private')
      : scope.kind === 'shared' ? t('Explicitly shared') : t('Unknown original scope')
  return [kind, scope.role, scope.work, scope.label, ...(scope.sharedWith ?? [])].filter(Boolean).join(' · ')
}

const importStatusLabel = status => t(status === 'ready' ? 'Ready to import'
  : status === 'partial' ? 'Partially imported'
    : status === 'completed' ? 'Import completed'
      : status === 'cancelled' ? 'Import cancelled'
        : status === 'rejected' ? 'Import item rejected'
          : status === 'imported' ? 'Import item completed'
            : status === 'conflict' ? 'Import conflict' : status)

const fileBase64 = async file => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return window.btoa(binary)
}

function ProductMemoryEntryRow({ entry, remove, open }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const meta = [entry.added, entry.source === 'memory panel' ? t('by you') : entry.by ? t('by {name}', { name: entry.by }) : null]
    .filter(Boolean).join(' · ')
  const click = async () => {
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    if (!await remove(entry)) setBusy(false)
  }
  return h('li', { className: 'bt-product-memory-entry', 'data-busy': busy || undefined },
    h('div', null, h('span', { className: 'bt-product-memory-entry-text' }, entry.text),
      meta ? h('span', { className: 'bt-product-memory-entry-meta' }, meta) : null),
    open ? h('button', { type: 'button', className: 'bt-soft', onClick: () => open(entry) }, t('View full detail')) : null,
    h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void click() },
      confirming ? t('Click again to remove') : t('Remove from memory')))
}

function ProductMemoryProposalCard({ proposal, onAnswer }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const answer = async approve => {
    setBusy(true); setError('')
    try { await onAnswer(proposal, approve) }
    catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setBusy(false) }
  }
  const scope = proposal.scope.kind === 'main' ? 'Main' : `${t('Work private')} · ${proposal.scope.workItemId}`
  return h('section', { className: 'bt-product-memory-proposal', 'aria-labelledby': titleId, 'aria-busy': busy },
    h('h4', { id: titleId }, t('Learning proposal')),
    h('p', null, `${scope} · ${proposal.reason}`),
    h('pre', null, proposal.text ?? ''),
    h('p', null, `${t('Expires')}: ${new Date(proposal.expiresAt).toLocaleString()}`),
    error ? h('p', { className: 'bt-product-memory-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-product-memory-form' },
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void answer(false) }, t('Decline')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void answer(true) }, t('Approve'))))
}

function MemorySideQuery({ instanceId, workItems, call, active }) {
  const [reader, setReader] = useState('main')
  const [workItemId, setWorkItemId] = useState('')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState(null)
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(null)
  const target = reader === 'main' ? { kind: 'main' } : { kind: 'work', workItemId }

  useEffect(() => () => pending.current?.abort(), [active, instanceId])
  const clear = () => {
    pending.current?.abort()
    setMatches(null); setDetail(null); setBusy(false); setError('')
  }
  const run = async (operation, receive) => {
    if (!active) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setError('')
    try {
      const value = await operation(controller.signal)
      if (!controller.signal.aborted) receive(value)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message)
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false) }
    }
  }
  const search = event => {
    event.preventDefault()
    if (busy || !query.trim() || reader === 'work' && !workItemId) return
    setMatches(null); setDetail(null)
    void run(signal => call('memory-side-query', { instanceId, target, query: query.trim() }, signal), setMatches)
  }
  const open = (id, previous) => {
    if (busy) return
    if (!previous) setDetail(null)
    void run(signal => call('memory-side-read', { instanceId, target, id, maxBytes: 4096,
      ...(previous ? { after: previous.pagination.cursor } : {}) }, signal), next => {
      setDetail(previous ? { ...next, text: previous.text + next.text } : next)
    })
  }

  const detailScope = detail && matches?.find(match => match.id === detail.id)?.scope
  return h(Card, { title: t('Side query') },
    h('form', { className: 'bt-product-memory-form', onSubmit: search },
      h('select', { value: reader, 'aria-label': t('Reader'), onChange: event => { setReader(event.target.value); clear() } },
        h('option', { value: 'main' }, t('Main')), h('option', { value: 'work' }, t('Work'))),
      reader === 'work' ? h('select', { value: workItemId, 'aria-label': t('Work'),
        onChange: event => { setWorkItemId(event.target.value); clear() } },
        h('option', { value: '' }, t('Choose work')),
        workItems.map(work => h('option', { key: work.id, value: work.id }, work.goal))) : null,
      h('input', { type: 'search', value: query, maxLength: 256, 'aria-label': t('Side query'),
        placeholder: t('Ask about saved memory'), onChange: event => { setQuery(event.target.value); clear() } }),
      h('button', { type: 'submit', className: 'bt-soft', disabled: busy || !query.trim() || reader === 'work' && !workItemId }, t('Search'))),
    busy ? h('p', { role: 'status' }, t('Loading…')) : null,
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    matches?.length ? h('ul', { className: 'bt-mem-list' }, matches.map(match => h('li', { key: match.id, className: 'bt-mem-entry' },
      h('span', { className: 'bt-mem-entry-copy' }, h('span', { className: 'bt-mem-entry-text' }, match.snippet)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => open(match.id) }, t('View full detail')))))
      : matches && !error ? h(EmptyState, { title: t('No matching memories.') }) : null,
    detailScope ? h('section', { className: 'bt-product-memory-detail', 'aria-label': t('Full detail') },
      h('strong', null, scopeLabel(detailScope)),
      h('pre', null, detail.text),
      detail.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
        onClick: () => open(detail.id, detail) }, t('Load more detail')) : null) : null)
}

function MemoryDialog({ open, onClose, instanceId, workItems, call }) {
  const [kept, leaving] = useLinger(open, 160)
  const title = useId()
  const dialog = useRef(null)
  useEffect(() => {
    if (!kept) return
    const node = dialog.current
    const trigger = node.ownerDocument.activeElement
    node.showModal()
    return () => {
      if (node.open) node.close()
      if (trigger?.isConnected) trigger.focus()
    }
  }, [kept])
  if (!kept) return null
  return h('dialog', { ref: dialog, className: 'bt-mem bt-product-memory-dialog', 'aria-labelledby': title,
    'data-leaving': leaving || undefined, onCancel: event => { event.preventDefault(); onClose() },
    onKeyDown: event => { if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation() } },
  h('header', { className: 'bt-mem-head' }, h('h2', { id: title }, t('Memory')),
    h('span', { className: 'bt-mem-head-gap' }), h('button', { className: 'bt-icon-btn', type: 'button',
      'aria-label': t('Close memory dialog'), onClick: onClose }, h(CloseIcon))),
  h('div', { className: 'bt-mem-body bt-product-memory' }, h(MemorySideQuery, { instanceId, workItems, call, active: !leaving })))
}

export function ProductMemorySettings(props) {
  return h(MemorySettings, { ...props, key: props.binding.instanceId })
}

function MemorySettings({ binding, works = [], call }) {
  const instanceId = binding.instanceId
  const workItems = works.filter(work => work.brief?.workItemId && work.receipt?.status === 'accepted')
    .map(work => ({ id: work.brief.workItemId, goal: work.brief.goal }))
  const [items, setItems] = useState(null)
  const [proposals, setProposals] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [kind, setKind] = useState('main')
  const [workId, setWorkId] = useState('')
  const [mainReader, setMainReader] = useState(true)
  const [recipients, setRecipients] = useState([])
  const [selected, setSelected] = useState(null)
  const [full, setFull] = useState(null)
  const [access, setAccess] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importBatch, setImportBatch] = useState(null)
  const [importBatches, setImportBatches] = useState(null)
  const [savedImportId, setSavedImportId] = useState('')
  const [importChoices, setImportChoices] = useState({})
  const [importBusy, setImportBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [readFailed, setReadFailed] = useState([])
  const pending = useRef(null)
  const importPending = useRef(null)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const activeQuery = useRef('')

  const reload = async (search = activeQuery.current) => {
    const request = ++listRequest.current
    activeQuery.current = search
    const [page, pendingProposals, savedImports] = await Promise.allSettled([
      call('memory-list', { instanceId, limit: 50, ...(search ? { query: search } : {}) }),
      call('memory-proposals', { instanceId }),
      call('memory-import-list', { instanceId, limit: 20 }),
    ])
    if (request !== listRequest.current) return
    setItems(page.value?.items ?? null); setCursor(page.value?.cursor ?? null)
    setProposals(pendingProposals.value ?? null); setImportBatches(savedImports.value?.items ?? null)
    setReadFailed([page.status === 'rejected' && 'Saved memory', pendingProposals.status === 'rejected' && 'Learning proposals',
      savedImports.status === 'rejected' && 'Saved memory imports'].filter(Boolean))
    setSelected(current => current ? page.value?.items?.find(item => item.id === current.id) ?? null : null)
  }
  useEffect(() => {
    void reload().catch(failure => setError(failure.message))
    return () => { listRequest.current++; detailRequest.current++ }
  }, [instanceId, call])
  useEffect(() => {
    let live = true
    setAccess(null)
    if (workId) void call('memory-access-read', { instanceId, workItemId: workId })
      .then(value => { if (live) setAccess(value) }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [instanceId, workId])

  const run = async (action, success) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
      await reload()
      setNotice(t(success))
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const scope = () => kind === 'main' ? { kind: 'main' }
    : kind === 'work' ? { kind: 'work', workItemId: workId }
      : { kind: 'shared', main: mainReader, workItemIds: recipients }
  const save = event => {
    event.preventDefault()
    if (busy || !text.trim()) return
    const input = { scope: scope(), text: text.trim() }
    void run(async () => {
      const key = JSON.stringify(input)
      if (pending.current?.key !== key) pending.current = { key, commandId: crypto.randomUUID() }
      const result = await call('memory-save', { instanceId, commandId: pending.current.commandId, ...input })
      if (result.status !== 'saved') throw new Error(t('Memory was already forgotten.'))
      pending.current = null; setText('')
    }, 'Memory saved.')
  }
  const open = async entry => {
    const request = ++detailRequest.current
    setError(''); setFull(null); setSelected(entry)
    setMainReader(entry.scope.kind === 'shared' ? entry.scope.main : entry.scope.kind === 'main')
    setRecipients(entry.scope.kind === 'shared' ? entry.scope.workItemIds : entry.scope.kind === 'work' ? [entry.scope.workItemId] : [])
    try {
      const detail = await call('memory-read', { instanceId, id: entry.id, maxBytes: 4096 })
      if (request === detailRequest.current) setFull(detail)
    } catch (failure) { if (request === detailRequest.current) setError(failure.message) }
  }
  const moreText = async () => {
    if (!full?.pagination.cursor || !selected) return
    const request = ++detailRequest.current
    try {
      const next = await call('memory-read', { instanceId, id: selected.id, after: full.pagination.cursor, maxBytes: 4096 })
      if (request === detailRequest.current) setFull({ ...next, text: full.text + next.text })
    } catch (failure) { if (request === detailRequest.current) { setError(failure.message); setFull(null) } }
  }
  const remove = async entry => {
    setBusy(true); setError('')
    try {
      await call('memory-forget', { instanceId, commandId: crypto.randomUUID(), id: entry.id, expectedRevision: entry.revision })
      detailRequest.current++
      setFull(null); setSelected(null); await reload()
      setNotice(t('Memory forgotten.'))
      return true
    } catch (failure) { setError(failure.message); return false }
    finally { setBusy(false) }
  }
  const toggleRecipient = id => setRecipients(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  const share = () => {
    if (!selected || busy) return
    void run(async () => {
      const result = await call('memory-share', { instanceId, commandId: crypto.randomUUID(), id: selected.id,
        expectedRevision: selected.revision, main: mainReader, workItemIds: recipients })
      setSelected(current => current ? { ...current, scope: result.scope, revision: result.revision } : current)
    }, 'Memory sharing updated.')
  }
  const toggleAccess = () => {
    if (!workId || !access || busy) return
    void run(async () => {
      const result = await call('memory-grant', { instanceId, commandId: crypto.randomUUID(), workItemId: workId,
        expectedRevision: access.revision, enabled: !access.enabled })
      setAccess(result)
    }, access.enabled ? 'Work memory access revoked.' : 'Work memory access granted.')
  }
  const decide = async (proposal, approve) => {
    setError(''); setNotice('')
    const result = await call('memory-decide', { instanceId, commandId: crypto.randomUUID(), proposalId: proposal.id, approve })
    await reload()
    setNotice(t(result.status === 'stale' ? 'Learning proposal expired or lost authorization.'
      : result.status === 'approved' ? 'Learning approved and saved.' : 'Learning declined.'))
  }
  const search = event => { event.preventDefault(); void reload(query).catch(failure => setError(failure.message)) }
  const loadMore = async () => {
    if (!cursor) return
    const search = activeQuery.current
    const request = ++listRequest.current
    try {
      const page = await call('memory-list', { instanceId, limit: 50, after: cursor, ...(search ? { query: search } : {}) })
      if (request === listRequest.current) { setItems(current => [...current, ...page.items]); setCursor(page.cursor ?? null) }
    } catch (failure) { if (request === listRequest.current) setError(failure.message) }
  }
  const acceptImportBatch = batch => {
    const preserveChoices = importBatch?.id === batch.id
    setImportBatch(batch)
    setSavedImportId(batch.id)
    setImportBatches(current => [batch, ...(current ?? []).filter(item => item.id !== batch.id)])
    setImportChoices(current => Object.fromEntries(batch.items.map(item => [item.sourceId,
      preserveChoices && current[item.sourceId]
        ? current[item.sourceId] : { checked: false, kind: '', workId: '', main: false, workIds: [] }])))
  }
  const chooseImportFile = async event => {
    const file = event.target.files?.[0]
    if (!file || importBusy) return
    setImportBusy(true); setError(''); setNotice('')
    try {
      if (file.size > 512 * 1024) throw new Error(t('Memory export must be at most 512 KiB.'))
      const dataBase64 = await fileBase64(file)
      const key = `${file.name}\0${dataBase64}`
      if (importPending.current?.key !== key) importPending.current = { key, commandId: crypto.randomUUID() }
      const batch = await call('memory-import-preview', { instanceId, commandId: importPending.current.commandId,
        sourceName: file.name, dataBase64 })
      acceptImportBatch(batch)
      setNotice(t('Memory export previewed. Choose each item and target explicitly.'))
    } catch (failure) { setError(failure.message) }
    finally { setImportBusy(false); event.target.value = '' }
  }
  const updateImportChoice = (sourceId, patch) => setImportChoices(current => ({
    ...current, [sourceId]: { ...(current[sourceId]
      ?? { checked: false, kind: '', workId: '', main: false, workIds: [] }), ...patch },
  }))
  const importSelected = async () => {
    if (!importBatch || importBusy) return
    setImportBusy(true); setError(''); setNotice('')
    try {
      const selections = importBatch.items.filter(item => importChoices[item.sourceId]?.checked).map(item => {
        const choice = importChoices[item.sourceId]
        if (choice.kind === 'main') return { sourceId: item.sourceId, scope: { kind: 'main' } }
        if (choice.kind === 'worker' && choice.workId) return { sourceId: item.sourceId,
          scope: { kind: 'work', workItemId: choice.workId } }
        if (choice.kind === 'shared' && (choice.main || choice.workIds.length)) return { sourceId: item.sourceId,
          scope: { kind: 'shared', main: choice.main, workItemIds: choice.workIds } }
        throw new Error(t('Choose a target for every selected item.'))
      })
      if (!selections.length) throw new Error(t('Select at least one memory item.'))
      const batch = await call('memory-import-commit', { instanceId, commandId: crypto.randomUUID(),
        batchId: importBatch.id, selections })
      acceptImportBatch(batch); await reload()
      setNotice(t(batch.status === 'completed' ? 'Memory import completed.'
        : 'Memory import saved. Review remaining or conflicting items.'))
    } catch (failure) { setError(failure.message) }
    finally { setImportBusy(false) }
  }
  const changeImportStatus = async retry => {
    if (!importBatch || importBusy) return
    setImportBusy(true); setError(''); setNotice('')
    try {
      const batch = await call(retry ? 'memory-import-retry' : 'memory-import-cancel',
        { instanceId, commandId: crypto.randomUUID(), batchId: importBatch.id })
      acceptImportBatch(batch)
      setNotice(t(retry ? 'Memory import is ready to continue.' : 'Memory import cancelled.'))
    } catch (failure) { setError(failure.message) }
    finally { setImportBusy(false) }
  }
  const openSavedImport = async () => {
    if (!savedImportId || importBusy) return
    setImportBusy(true); setError(''); setNotice('')
    try {
      acceptImportBatch(await call('memory-import-read', { instanceId, batchId: savedImportId }))
      setNotice(t('Saved memory import opened.'))
    } catch (failure) { setError(failure.message) }
    finally { setImportBusy(false) }
  }

  return h('div', { className: 'bt-ps-content bt-product-memory' },
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    readFailed.length ? h(InlineNotice, { tone: 'warn', action: h('button', { type: 'button', className: 'bt-soft',
      onClick: () => void reload(), disabled: busy || importBusy }, t('Retry')) },
    t('Could not load: {sections}', { sections: readFailed.map(label => t(label)).join(', ') })) : null,
    notice ? h(InlineNotice, { tone: 'success' }, notice) : null,
    h(Card, { title: t('Side query') }, typeof window.HTMLDialogElement?.prototype?.showModal === 'function'
      ? h('button', { type: 'button', className: 'bt-soft', 'aria-haspopup': 'dialog',
        onClick: () => setDialogOpen(true) }, t('Open memory dialog'))
      : h(InlineNotice, { tone: 'warn' }, t('This window cannot open the memory dialog.'))),
    h(MemoryDialog, { open: dialogOpen, onClose: () => setDialogOpen(false), instanceId, workItems, call }),
    h(Card, { title: t('Saved memory') },
      h('p', null, t('Main, work private, and explicitly shared memories have separate readers. Searching does not save new memory.')),
      h('form', { className: 'bt-product-memory-form', onSubmit: search },
        h('input', { type: 'search', value: query, 'aria-label': t('Search memory'), placeholder: t('Search memory'),
          onChange: event => setQuery(event.target.value) }),
        h('button', { type: 'submit', className: 'bt-soft' }, t('Search'))),
      items?.length ? h('ul', { className: 'bt-product-memory-list' }, items.map(entry => h(ProductMemoryEntryRow, {
        key: entry.id, entry: { ...entry, source: 'memory panel' }, open, remove,
      }))) : items ? h(EmptyState, { title: t(activeQuery.current ? 'No matching memories.' : 'Nothing saved yet') }) : null,
      cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => void loadMore() }, t('Load more')) : null,
      selected ? h('section', { className: 'bt-product-memory-detail', 'aria-label': t('Full detail') },
        h('strong', null, scopeLabel(selected.scope)),
        full?.provenance ? h('p', null, `${t('Imported from')} ${full.provenance.originalOwner}: ${originalScopeLabel(full.provenance.originalScope)}`) : null,
        full ? h('pre', null, full.text) : null,
        full?.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft', onClick: () => void moreText() }, t('Load more detail')) : null,
        h('div', { className: 'bt-product-memory-form' },
          h('label', null, h('input', { type: 'checkbox', checked: mainReader, onChange: event => setMainReader(event.target.checked) }), t('Main')),
          workItems.map(work => h('label', { key: work.id }, h('input', { type: 'checkbox', checked: recipients.includes(work.id),
            onChange: () => toggleRecipient(work.id) }), work.goal)),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: share }, t('Update sharing')))) : null),
    h(Card, { title: t('Import memory') },
      h('p', null, t('Preview a portable JSON memory copy before importing selected items.')),
      importBatches?.length ? h('div', { className: 'bt-product-memory-form' },
        h('select', { value: savedImportId, 'aria-label': t('Saved memory imports'),
          onChange: event => setSavedImportId(event.target.value) },
          h('option', { value: '' }, t('Choose saved import')),
          importBatches.map(batch => h('option', { key: batch.id, value: batch.id },
            `${batch.sourceName} · ${importStatusLabel(batch.status)}`))),
        h('button', { type: 'button', className: 'bt-soft', disabled: importBusy || !savedImportId,
          onClick: () => void openSavedImport() }, t('Open import'))) : null,
      h('label', { className: 'bt-product-memory-import-file' }, t('Choose memory export'),
        h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('Choose memory export'),
          disabled: importBusy, onChange: event => void chooseImportFile(event) })),
      importBatch ? h('section', { className: 'bt-product-memory-import', 'aria-label': t('Memory import preview') },
        h('div', { className: 'bt-product-memory-import-meta' },
          h('strong', null, importBatch.sourceName),
          h('span', null, `${t('Original owner')}: ${importBatch.origin.owner}`),
          importBatch.origin.instanceId ? h('span', null, `${t('Original instance')}: ${importBatch.origin.instanceId}`) : null,
          h('span', null, `${t('Original hash')}: ${importBatch.sourceHash}`),
          h('span', null, `${t('Target instance')}: ${importBatch.targetInstanceId}`),
          h('span', null, `${t('Import status')}: ${importStatusLabel(importBatch.status)}`)),
        importBatch.items.length ? h('ul', { className: 'bt-product-memory-import-items' }, importBatch.items.map(item => {
          const choice = importChoices[item.sourceId]
            ?? { checked: false, kind: '', workId: '', main: false, workIds: [] }
          const active = item.status === 'ready'
            || (item.status === 'conflict' && item.reason !== 'SOURCE_CONTENT_CONFLICT')
          return h('li', { key: item.sourceId }, h('div', { className: 'bt-product-memory-import-head' },
            h('input', { type: 'checkbox', checked: choice.checked, disabled: !active || importBatch.status === 'cancelled' || importBusy,
              'aria-label': `${t('Import item')} ${item.sourceId}`,
              onChange: event => updateImportChoice(item.sourceId, { checked: event.target.checked }) }),
            h('strong', null, item.sourceId),
            h('span', null, `${t('Original scope')}: ${originalScopeLabel(item.originalScope)}`),
            h(StatusChip, { tone: ['conflict', 'rejected'].includes(item.status) ? 'danger' : 'neutral' },
              importStatusLabel(item.status), item.reason ? ` · ${t(item.reason)}` : '')),
            item.text ? h('pre', null, item.text) : h('p', null, t('Rejected item content is not retained.')),
            item.status === 'imported' ? h('p', null, `${t('Imported to')}: ${scopeLabel(item.target)}`) : null,
            item.status === 'conflict' ? h('p', null,
              `${t('Conflicts with')}: ${item.existingMemoryId ?? item.existingBatchId ?? t('Earlier import')}`) : null,
            choice.checked && active ? h('div', { className: 'bt-product-memory-form' },
              h('label', null, t('Target role'),
                h('select', { value: choice.kind, 'aria-label': `${t('Target role')} ${item.sourceId}`,
                  onChange: event => updateImportChoice(item.sourceId, { kind: event.target.value }) },
                  h('option', { value: '' }, t('Choose target')),
                  (importBatch.targetRoles ?? ['main', 'worker', 'shared']).map(role => h('option', {
                    key: role, value: role,
                  }, t(role === 'main' ? 'Main' : role === 'worker' ? 'Worker' : 'Explicitly shared'))))),
            choice.kind === 'worker' ? h('label', null, `${t('Target work')} `,
                h('select', { value: choice.workId, 'aria-label': `${t('Target work')} ${item.sourceId}`,
                  onChange: event => updateImportChoice(item.sourceId, { workId: event.target.value }) },
                  h('option', { value: '' }, t('Choose work')),
                  workItems.map(work => h('option', { key: work.id, value: work.id }, work.goal)))) : null,
              choice.kind === 'shared' ? h('fieldset', { className: 'bt-product-memory-import-sharing' },
                h('legend', null, t('Choose shared recipients')),
                h('label', null, h('input', { type: 'checkbox', checked: choice.main,
                  'aria-label': `${t('Share with Main')} ${item.sourceId}`,
                  onChange: event => updateImportChoice(item.sourceId, { main: event.target.checked }) }), t('Main')),
                workItems.map(work => h('label', { key: work.id }, h('input', { type: 'checkbox',
                  checked: choice.workIds.includes(work.id),
                  'aria-label': `${t('Share with work')} ${work.id} ${item.sourceId}`,
                  onChange: event => updateImportChoice(item.sourceId, { workIds: event.target.checked
                    ? [...choice.workIds, work.id] : choice.workIds.filter(id => id !== work.id) }) }), work.goal))) : null,
              h('span', null, `${t('Target instance')}: ${importBatch.targetInstanceId}`)) : null)
        })) : null,
        h('div', { className: 'bt-product-memory-form' },
          h('button', { type: 'button', className: 'bt-soft',
            disabled: importBusy || importBatch.status === 'cancelled' || !importBatch.items.some(item => importChoices[item.sourceId]?.checked),
            onClick: () => void importSelected() }, t('Import selected')),
          importBatch.status === 'ready' || importBatch.status === 'partial'
            ? h('button', { type: 'button', className: 'bt-soft', disabled: importBusy,
              onClick: () => void changeImportStatus(false) }, t('Cancel import')) : null,
          importBatch.status === 'cancelled' ? h('button', { type: 'button', className: 'bt-soft', disabled: importBusy,
            onClick: () => void changeImportStatus(true) }, t('Retry import')) : null)) : null),
    h(Card, { title: t('Save memory') },
      h('form', { className: 'bt-product-memory-form', onSubmit: save },
        h(Row, { label: t('Owner') }, h('select', { value: kind, onChange: event => setKind(event.target.value) },
          h('option', { value: 'main' }, t('Main')), h('option', { value: 'work' }, t('Work private')),
          h('option', { value: 'shared' }, t('Explicitly shared')))),
        kind === 'work' ? h('select', { value: workId, 'aria-label': t('Work'), onChange: event => setWorkId(event.target.value) },
          h('option', { value: '' }, t('Choose work')),
          workItems.map(work => h('option', { key: work.id, value: work.id }, work.goal))) : null,
        kind === 'shared' ? h('div', { className: 'bt-product-memory-form' },
          h('label', null, h('input', { type: 'checkbox', checked: mainReader, onChange: event => setMainReader(event.target.checked) }), t('Main')),
          workItems.map(work => h('label', { key: work.id }, h('input', { type: 'checkbox', checked: recipients.includes(work.id),
            onChange: () => toggleRecipient(work.id) }), work.goal))) : null,
        h('textarea', { value: text, maxLength: 4096, 'aria-label': t('Memory text'), placeholder: t('One lasting fact'),
          onChange: event => setText(event.target.value) }),
        h('button', { type: 'submit', className: 'bt-soft', disabled: busy || !text.trim() }, t('Save')))),
    h(Card, { title: t('Work memory access') },
      h('p', null, t('Worker memory access is off until you grant it for this work. Revoking blocks later reads and proposals.')),
      h('select', { value: workId, 'aria-label': t('Work'), onChange: event => setWorkId(event.target.value) },
        h('option', { value: '' }, t('Choose work')),
        workItems.map(work => h('option', { key: work.id, value: work.id }, work.goal))),
      workId && access ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: toggleAccess },
        t(access.enabled ? 'Revoke Worker access' : 'Grant Worker access')) : null),
    h(Card, { title: t('Learning proposals') }, proposals?.length
      ? proposals.map(proposal => h(ProductMemoryProposalCard, { key: proposal.id, proposal, onAnswer: decide }))
      : proposals ? h(EmptyState, { title: t('No learning proposals are waiting for review.') }) : null))
}

export const PRODUCT_MEMORY_CSS = `
.bt-product-memory-dialog:not([open]){display:none}
.bt-product-memory-dialog:modal{position:fixed;inset:0;margin:auto;padding:0}
.bt-product-memory-dialog::backdrop{background:var(--bt-scrim)}
.bt-product-memory-dialog[data-leaving]{animation:bt-dialog-sink .16s ease-in forwards;pointer-events:none}
@media(prefers-reduced-motion:reduce){.bt-product-memory-dialog[data-leaving]{animation:none}}
.bt-product-memory p:not(.bt-ps-empty p){font-size:var(--bt-ps-small);line-height:18px;color:var(--bt-ink-2)}
.bt-product-memory-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0}
.bt-product-memory-form label:not(.bt-ps-row){display:inline-flex;align-items:center;gap:5px;font-size:var(--bt-ps-small);overflow-wrap:anywhere}
.bt-product-memory select,.bt-product-memory input[type=search],.bt-product-memory textarea{min-width:0;max-width:100%;box-sizing:border-box;padding:7px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-control);background:var(--bt-card);color:var(--bt-ink);font:inherit}
.bt-product-memory textarea{width:100%;min-height:72px;resize:vertical}
.bt-product-memory-detail{padding:10px 0;border-top:1px solid var(--bt-line-2);font-size:var(--bt-ps-small)}
.bt-product-memory-detail pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-product-memory-list{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;list-style:none}
.bt-product-memory-entry{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-small)}
.bt-product-memory-entry>div{flex:1;min-width:180px;display:flex;flex-direction:column;gap:3px}
.bt-product-memory-entry-text{font-size:var(--bt-ps-small);line-height:17px;overflow-wrap:anywhere}
.bt-product-memory-entry-meta{font-size:var(--bt-ps-caption);color:var(--bt-ink-2)}
.bt-product-memory-proposal{display:flex;flex-direction:column;gap:7px;padding:10px}
.bt-product-memory-proposal h4,.bt-product-memory-proposal p{margin:0}
.bt-product-memory-proposal pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:7px;border-radius:var(--bt-ps-radius-small);background:var(--bt-hover);font-size:var(--bt-ps-small)}
.bt-product-memory-error{color:var(--bt-danger)}
.bt-product-memory-import-file{display:flex;flex-direction:column;gap:6px;font-size:var(--bt-ps-small)}
.bt-product-memory-import{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.bt-product-memory-import-meta{display:flex;flex-direction:column;gap:4px;padding:9px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-small);font-size:var(--bt-ps-small);overflow-wrap:anywhere}
.bt-product-memory-import-items{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.bt-product-memory-import-items>li{padding:10px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-small)}
.bt-product-memory-import-head{display:flex;flex-wrap:wrap;align-items:center;gap:7px;font-size:var(--bt-ps-small)}
.bt-product-memory-import-head pre{width:100%;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0}
.bt-product-memory-import-sharing{display:flex;flex-wrap:wrap;gap:7px;margin:0;padding:7px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-small)}
.bt-product-memory-import-sharing legend{padding:0 4px;font-size:var(--bt-ps-small)}
.bt-product-memory-import-sharing label{display:inline-flex;align-items:center;gap:4px;font-size:var(--bt-ps-small)}
.bt-product-memory button:focus-visible,.bt-product-memory select:focus-visible,.bt-product-memory input:focus-visible,.bt-product-memory textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`
