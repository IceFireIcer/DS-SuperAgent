import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './bot-settings.js'
import { MemoryEntryRow } from './memory-panel.js'
import { ProductMemoryProposalCard } from './learning-card.js'
import { t } from './i18n.js'

const scopeLabel = scope => scope.kind === 'main' ? t('Main')
  : scope.kind === 'work' ? `${t('Work private')} · ${scope.workItemId}`
    : `${t('Explicitly shared')} · ${[scope.main ? t('Main') : '', ...scope.workItemIds].filter(Boolean).join(', ') || t('No readers')}`

export function ProductMemorySettings({ binding, works, call }) {
  const instanceId = binding.instanceId
  const workItems = works.filter(work => work.brief?.workItemId && work.receipt?.status === 'accepted')
    .map(work => ({ id: work.brief.workItemId, goal: work.brief.goal }))
  const [items, setItems] = useState([])
  const [proposals, setProposals] = useState([])
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
  const [sideKind, setSideKind] = useState('main')
  const [sideWorkId, setSideWorkId] = useState('')
  const [sideQuery, setSideQuery] = useState('')
  const [sideMatches, setSideMatches] = useState([])
  const [sideSelected, setSideSelected] = useState(null)
  const [sideFull, setSideFull] = useState(null)
  const [sideBusy, setSideBusy] = useState(false)
  const sideGeneration = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(null)

  const reload = async (search = query) => {
    const [page, pendingProposals] = await Promise.all([
      call('memory-list', { instanceId, limit: 50, ...(search ? { query: search } : {}) }),
      call('memory-proposals', { instanceId }),
    ])
    setItems(page.items); setCursor(page.cursor ?? null); setProposals(pendingProposals)
    setSelected(current => current ? page.items.find(item => item.id === current.id) ?? null : null)
  }
  useEffect(() => { void reload().catch(failure => setError(failure.message)) }, [instanceId])
  useEffect(() => {
    sideGeneration.current++
    setSideMatches([]); setSideSelected(null); setSideFull(null); setSideBusy(false)
  }, [instanceId])
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
      sideGeneration.current++
      setSideMatches([]); setSideSelected(null); setSideFull(null); setSideBusy(false)
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
    setError(''); setFull(null); setSelected(entry)
    setMainReader(entry.scope.kind === 'shared' ? entry.scope.main : entry.scope.kind === 'main')
    setRecipients(entry.scope.kind === 'shared' ? entry.scope.workItemIds : entry.scope.kind === 'work' ? [entry.scope.workItemId] : [])
    try { setFull(await call('memory-read', { instanceId, id: entry.id, maxBytes: 4096 })) }
    catch (failure) { setError(failure.message) }
  }
  const moreText = async () => {
    if (!full?.pagination.cursor || !selected) return
    try {
      const next = await call('memory-read', { instanceId, id: selected.id, after: full.pagination.cursor, maxBytes: 4096 })
      setFull(current => current && current.id === next.id ? { ...next, text: current.text + next.text } : next)
    } catch (failure) { setError(failure.message); setFull(null) }
  }
  const remove = async entry => {
    setBusy(true); setError('')
    try {
      await call('memory-forget', { instanceId, commandId: crypto.randomUUID(), id: entry.id, expectedRevision: entry.revision })
      sideGeneration.current++
      setSideMatches([]); setSideSelected(null); setSideFull(null); setSideBusy(false)
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
    try {
      const page = await call('memory-list', { instanceId, limit: 50, after: cursor, ...(query ? { query } : {}) })
      setItems(current => [...current, ...page.items]); setCursor(page.cursor ?? null)
    } catch (failure) { setError(failure.message) }
  }
  const clearSide = () => {
    sideGeneration.current++
    setSideMatches([]); setSideSelected(null); setSideFull(null); setSideBusy(false); setError('')
  }
  const sideTarget = () => sideKind === 'main' ? { kind: 'main' } : { kind: 'work', workItemId: sideWorkId }
  const sideSearch = async event => {
    event.preventDefault()
    if (sideBusy || !sideQuery.trim() || sideKind === 'work' && !sideWorkId) return
    const generation = ++sideGeneration.current
    setSideBusy(true); setError(''); setSideSelected(null); setSideFull(null); setSideMatches([])
    try {
      const matches = await call('memory-side-query', { instanceId, target: sideTarget(), query: sideQuery.trim() })
      if (generation === sideGeneration.current) setSideMatches(matches)
    } catch (failure) { if (generation === sideGeneration.current) setError(failure.message) }
    finally { if (generation === sideGeneration.current) setSideBusy(false) }
  }
  const sideOpen = async match => {
    const generation = ++sideGeneration.current
    setSideSelected(match); setSideFull(null); setError('')
    try {
      const page = await call('memory-side-read', { instanceId, target: sideTarget(), id: match.id, maxBytes: 4096 })
      if (generation === sideGeneration.current) setSideFull(page)
    } catch (failure) { if (generation === sideGeneration.current) { setSideFull(null); setError(failure.message) } }
  }
  const sideMore = async () => {
    if (!sideFull?.pagination.cursor || !sideSelected) return
    const generation = sideGeneration.current
    try {
      const page = await call('memory-side-read', { instanceId, target: sideTarget(), id: sideSelected.id,
        after: sideFull.pagination.cursor, maxBytes: 4096 })
      if (generation === sideGeneration.current) setSideFull(current => current?.id === page.id
        ? { ...page, text: current.text + page.text } : page)
    } catch (failure) { if (generation === sideGeneration.current) { setSideFull(null); setError(failure.message) } }
  }

  return h('div', { className: 'bt-product-memory' },
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
    h(Card, { title: t('Side query') },
      h('form', { className: 'bt-product-memory-form', onSubmit: sideSearch },
        h('select', { value: sideKind, 'aria-label': t('Reader'), onChange: event => { setSideKind(event.target.value); clearSide() } },
          h('option', { value: 'main' }, t('Main')), h('option', { value: 'work' }, t('Work'))),
        sideKind === 'work' ? h('select', { value: sideWorkId, 'aria-label': t('Work'),
          onChange: event => { setSideWorkId(event.target.value); clearSide() } },
          h('option', { value: '' }, t('Choose work')),
          workItems.map(work => h('option', { key: work.id, value: work.id }, work.goal))) : null,
        h('input', { type: 'search', value: sideQuery, maxLength: 256, 'aria-label': t('Side query'),
          placeholder: t('Ask about saved memory'), onChange: event => { setSideQuery(event.target.value); clearSide() } }),
        h('button', { type: 'submit', className: 'bt-soft', disabled: sideBusy || !sideQuery.trim() || sideKind === 'work' && !sideWorkId }, t('Search'))),
      sideMatches.length ? h('ul', { className: 'bt-mem-list' }, sideMatches.map(match => h('li', { key: match.id, className: 'bt-mem-entry' },
        h('span', { className: 'bt-mem-entry-copy' }, h('span', { className: 'bt-mem-entry-text' }, match.snippet)),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void sideOpen(match) }, t('View full detail'))))) : null,
      sideSelected ? h('section', { className: 'bt-product-memory-detail', 'aria-label': t('Full detail') },
        h('strong', null, scopeLabel(sideSelected.scope)),
        sideFull ? h('pre', null, sideFull.text) : null,
        sideFull?.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft', onClick: () => void sideMore() }, t('Load more detail')) : null) : null),
    h(Card, { title: t('Saved memory') },
      h('p', null, t('Main, work private, and explicitly shared memories have separate readers. Searching does not save new memory.')),
      h('form', { className: 'bt-product-memory-form', onSubmit: search },
        h('input', { type: 'search', value: query, 'aria-label': t('Search memory'), placeholder: t('Search memory'),
          onChange: event => setQuery(event.target.value) }),
        h('button', { type: 'submit', className: 'bt-soft' }, t('Search'))),
      items.length ? h('ul', { className: 'bt-mem-list' }, items.map(entry => h(MemoryEntryRow, {
        key: entry.id, entry: { ...entry, source: 'memory panel' }, open, remove,
      }))) : h('p', null, t('Nothing saved yet')),
      cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => void loadMore() }, t('Load more')) : null,
      selected ? h('section', { className: 'bt-product-memory-detail', 'aria-label': t('Full detail') },
        h('strong', null, scopeLabel(selected.scope)),
        full ? h('pre', null, full.text) : null,
        full?.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft', onClick: () => void moreText() }, t('Load more detail')) : null,
        h('div', { className: 'bt-product-memory-form' },
          h('label', null, h('input', { type: 'checkbox', checked: mainReader, onChange: event => setMainReader(event.target.checked) }), t('Main')),
          workItems.map(work => h('label', { key: work.id }, h('input', { type: 'checkbox', checked: recipients.includes(work.id),
            onChange: () => toggleRecipient(work.id) }), work.goal)),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: share }, t('Update sharing')))) : null),
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
    h(Card, { title: t('Learning proposals') }, proposals.length
      ? proposals.map(proposal => h(ProductMemoryProposalCard, { key: proposal.id, proposal, onAnswer: decide }))
      : h('p', null, t('No learning proposals are waiting for review.'))))
}

export const PRODUCT_MEMORY_CSS = `
.bt-product-memory{display:flex;flex-direction:column;gap:12px}
.bt-product-memory p{font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-product-memory-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0}
.bt-product-memory-form label{display:inline-flex;align-items:center;gap:5px;font-size:12px;overflow-wrap:anywhere}
.bt-product-memory select,.bt-product-memory input[type=search],.bt-product-memory textarea{min-width:0;max-width:100%;box-sizing:border-box;padding:7px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-main);color:var(--bt-ink);font:inherit}
.bt-product-memory textarea{width:100%;min-height:72px;resize:vertical}
.bt-product-memory-detail{padding:10px 0;border-top:1px solid var(--bt-line-2);font-size:12px}
.bt-product-memory-detail pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-product-memory button:focus-visible,.bt-product-memory select:focus-visible,.bt-product-memory input:focus-visible,.bt-product-memory textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`
