import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { Row } from './product-card.js'
import { t } from './i18n.js'

const IMPORT_STATES = {
  pending: 'Import pending',
  unknown: 'Import needs retry',
  applied: 'Import applied',
  cancelled: 'Import cancelled',
}

const previewText = preview => `${preview.source.label} · ${preview.format ?? preview.source.kind} · ${preview.cookies} cookies`

export function ProductBrowserImport({ binding, call, browserBridge, directoryOptions, onChanged }) {
  const instanceId = binding.instanceId
  const storageKey = `product-browser-import:${instanceId}`
  const directories = directoryOptions?.directories ?? []
  const [pending, setPending] = useState(null)
  const [batches, setBatches] = useState([])
  const [sources, setSources] = useState([])
  const [sourceId, setSourceId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const generation = useRef(0)

  const persist = value => {
    setPending(value)
    try {
      if (value) window.sessionStorage.setItem(storageKey, JSON.stringify(value))
      else window.sessionStorage.removeItem(storageKey)
    } catch { /* The current view still retains the pending preview. */ }
  }
  const refresh = async () => {
    const current = ++generation.current
    try {
      const [imports, available] = await Promise.all([
        call('browser-import-list', { instanceId, limit: 20 }),
        browserBridge?.importSources ? browserBridge.importSources() : Promise.resolve([]),
      ])
      if (current !== generation.current) return
      setBatches(imports.items)
      setSources(available)
      setSourceId(value => available.some(source => source.id === value) ? value : available[0]?.id ?? '')
    } catch (failure) {
      if (current === generation.current) setError(failure.message)
    }
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey))
      if (saved && typeof saved.id === 'string' && typeof saved.sourceRef === 'string'
        && saved.preview && typeof saved.commandId === 'string') {
        setPending(saved)
        setEnvironmentId(saved.environmentId ?? '')
        setLabel(saved.label ?? saved.preview.source?.label ?? '')
      }
    } catch { /* Start a new preview when the saved one is malformed. */ }
    void refresh()
    return () => { generation.current += 1 }
  }, [call, instanceId])
  useEffect(() => {
    if (!pending?.targetLocked && !directories.some(directory => directory.id === environmentId)) {
      setEnvironmentId('')
    }
  }, [directoryOptions, pending?.targetLocked, environmentId])

  const acceptPreview = result => {
    if (!result?.id || !result.preview) throw new Error(t('The browser preview is unavailable.'))
    const next = { id: result.id, sourceRef: crypto.randomUUID(), preview: result.preview, commandId: crypto.randomUUID(),
      environmentId: '', label: '',
      targetLocked: false }
    setEnvironmentId('')
    setLabel('')
    persist(next)
    setError(null); setNotice(t('Browser data previewed. Review the source and target before importing.'))
  }
  const chooseFile = async () => {
    if (busy || !browserBridge?.importPick) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await browserBridge.importPick()
      if (result?.canceled) return
      if (result?.error) throw new Error(t('The browser export could not be read.'))
      acceptPreview(result)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const chooseLive = async () => {
    if (busy || !sourceId || !browserBridge?.importLive) return
    setBusy(true); setError(null); setNotice(null)
    try {
      let result = await browserBridge.importLive(sourceId, false)
      if (result?.running) {
        if (!window.confirm(t('Close the selected browser briefly to copy its cookies, then reopen it with your tabs?'))) return
        result = await browserBridge.importLive(sourceId, true)
      }
      if (result?.error) throw new Error(t('The selected browser profile could not be copied.'))
      acceptPreview(result)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const cancelPreview = async () => {
    if (!pending || busy) return
    try { await browserBridge?.importCancel?.(pending.id) } catch { /* The Host pending import expires on its own. */ }
    persist(null); setLabel(''); setNotice(t('Browser import preview cancelled.'))
  }
  const sendImport = async next => {
    if (!next || !next.environmentId || !next.label.trim() || busy) return
    persist(next)
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await call('browser-import', { instanceId, commandId: next.commandId,
        sourceRef: next.sourceRef, pendingId: next.id, preview: next.preview,
        environmentId: next.environmentId, label: next.label })
      persist(null); setLabel(''); setNotice(t(result.status === 'applied'
        ? 'Browser data imported into a new isolated resource.' : 'Browser import needs another retry.'))
      await refresh()
      if (result.status === 'applied') onChanged?.()
    } catch (failure) {
      setError(failure.message)
      await refresh()
    } finally { setBusy(false) }
  }
  const commit = () => sendImport(pending && ({ ...pending, environmentId,
    label: label.trim(), targetLocked: true }))
  const retryBatch = batch => {
    if (!pending || busy) return
    const next = { ...pending, sourceRef: batch.sourceRef, environmentId: batch.environmentId,
      label: batch.label, commandId: crypto.randomUUID(), targetLocked: true }
    setEnvironmentId(batch.environmentId)
    setLabel(batch.label)
    void sendImport(next)
  }
  const cancelImport = async batch => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await call('browser-import-cancel', { instanceId, commandId: crypto.randomUUID(), importId: batch.id })
      if (pending?.sourceRef === batch.sourceRef) {
        try { await browserBridge?.importCancel?.(pending.id) } catch { /* The Host preview expires on its own. */ }
        persist(null)
      }
      setNotice(t(result.status === 'cancelled' ? 'Browser import cancelled.' : 'Browser import is already complete.'))
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }

  return h('section', { className: 'bt-product-browser-import', 'aria-label': t('Import browser data') },
    h('h3', null, t('Import browser data')),
    h('p', { className: 'bt-product-resource-note' },
      t('Preview a cookie export or installed browser profile before creating a new isolated browser.')),
    browserBridge?.importPick ? h('div', { className: 'bt-product-resource-row' },
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void chooseFile() },
        t('Choose cookie export'))) : null,
    sources.length ? h('div', { className: 'bt-product-resource-row' },
      h('select', { className: 'bt-bs-input', value: sourceId, 'aria-label': t('Installed browser profile'),
        disabled: busy, onChange: event => setSourceId(event.target.value) },
      sources.map(source => h('option', { key: source.id, value: source.id }, source.label))),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !sourceId,
        onClick: () => void chooseLive() }, t('Preview installed profile'))) : null,
    pending ? h('div', { className: 'bt-product-browser-import-preview' },
      h('strong', null, pending.preview.source.label),
      h('p', null, previewText(pending.preview)),
      h('p', null, `${t('Source ownership')}: ${pending.preview.source.kind} · ${t('Privacy scope')}: ${t('Isolated browser profile')}`),
      h('p', null, `${t('Target instance')}: ${instanceId} · ${t('Target role')}: ${t('Local browser')} · ${t('The new browser starts with no work grants.')}`),
      pending.preview.sites?.length ? h('ul', null, pending.preview.sites.slice(0, 20).map(site =>
        h('li', { key: site.site }, `${site.site} · ${site.cookies} cookies · ${site.httpOnly} HTTP-only`))) : null,
      h(Row, { label: t('Browser Environment') }, h('select', { className: 'bt-bs-input', value: environmentId,
        disabled: busy || pending.targetLocked || directories.length === 0, onChange: event => {
          const value = event.target.value
          setEnvironmentId(value)
          persist({ ...pending, environmentId: value, label: label.trim() || pending.label })
        } }, h('option', { value: '' }, t('Choose Environment')), directories.map(directory => h('option', { key: directory.id, value: directory.id },
        directory.title ?? directory.id)))),
      h(Row, { label: t('Browser name') }, h('input', { className: 'bt-bs-input', value: label, maxLength: 128,
        disabled: busy || pending.targetLocked, onChange: event => {
          setLabel(event.target.value)
          persist({ ...pending, environmentId, label: event.target.value })
        } })),
      h('div', { className: 'bt-product-resource-row' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || !environmentId || !label.trim(),
          onClick: () => void commit() }, busy ? t('Importing…') : t('Import into new browser')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => void cancelPreview() }, t('Cancel preview')))) : null,
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
    batches.length ? h('div', { className: 'bt-product-browser-import-history' },
      h('h4', null, t('Recent browser imports')),
      batches.map(batch => h('div', { key: batch.id, className: 'bt-product-browser-import-row' },
        h('div', null, h('strong', null, batch.label),
          h('p', null, `${previewText(batch.preview)} · ${t(IMPORT_STATES[batch.status] ?? batch.status)}`),
          batch.report ? h('p', null, `${t('Stored cookies')}: ${batch.report.stored} · ${t('Dropped')}: ${batch.report.droppedCount} · ${t('Failed')}: ${batch.report.failedCount}`) : null),
        h('div', { className: 'bt-product-resource-row' },
          batch.status === 'pending' || batch.status === 'unknown'
            ? h(Fragment, null,
              pending ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
                onClick: () => retryBatch(batch) }, t('Use preview to retry')) : null,
              h('button', { type: 'button', className: 'bt-soft', disabled: busy,
                onClick: () => void cancelImport(batch) }, t('Cancel browser import'))) : null)))) : null)
}

export const PRODUCT_BROWSER_IMPORT_CSS = `
.bt-product-browser-import{display:flex;flex-direction:column;gap:8px;margin:14px 0;padding:12px;border:1px solid var(--bt-line);border-radius:8px}
.bt-product-browser-import h3,.bt-product-browser-import h4{margin:0;font-size:13px}
.bt-product-browser-import p{margin:3px 0;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-product-browser-import-preview{padding:10px;border:1px solid var(--bt-line);border-radius:8px}
.bt-product-browser-import-preview ul{padding-left:18px;margin:6px 0;font-size:12px}
.bt-product-browser-import-history{display:flex;flex-direction:column;gap:6px}
.bt-product-browser-import-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--bt-line)}
.bt-product-browser-import button:focus-visible,.bt-product-browser-import select:focus-visible,.bt-product-browser-import input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:640px){.bt-product-browser-import-row{align-items:flex-start;flex-direction:column}}
`
