import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { Card, Row } from './product-card.js'
import { DetailList, EmptyState, InlineNotice, StatGrid } from './product-settings-components.js'
import { t } from './i18n.js'

const number = value => Number(value ?? 0).toLocaleString()
const byteCount = value => {
  const bytes = Number(value ?? 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
const updateCopy = phase => ({ checking: 'Checking for updates', current: 'Up to date', available: 'Update available',
  downloading: 'Downloading update', downloaded: 'Update ready', installing: 'Preparing to install update',
  failed: 'Update check failed' }[phase] ?? 'Update status unavailable')
const coverageCopy = status => ({ none: 'No usage yet.', available: 'Included Sessions read',
  partial: 'Partial usage', unavailable: 'Usage unavailable.' }[status] ?? 'Usage unavailable.')
const usageLine = value => value?.status === 'none' ? t('No model calls.')
  : value?.status === 'unavailable' ? t('Usage unavailable.')
    : t('{tokens} tokens · {reported} of {calls} calls reported', {
      tokens: number(value?.totalTokens), reported: number(value?.reportedCalls), calls: number(value?.calls),
    })

function UsageItems({ title, items }) {
  return h(Card, { title }, items?.length
    ? h('ul', { className: 'bt-product-operations-list' }, items.map(item => h('li', { key: item.id },
      h('span', null, item.title), h('strong', null, usageLine(item.total)))))
    : h(EmptyState, { title: t('No attributed work usage.') }))
}

export function ProductOperationsSettings({ binding, call, onNavigate, section = 'combined', app = globalThis.window?.dsSuperagentApp }) {
  const showStatus = section !== 'usage'
  const showUsage = section !== 'status'
  const [status, setStatus] = useState(null)
  const [usage, setUsage] = useState(null)
  const [updates, setUpdates] = useState(null)
  const [backups, setBackups] = useState([])
  const [diagnostics, setDiagnostics] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [checkedAt, setCheckedAt] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const request = useRef(0)
  const working = useRef(false)

  const refresh = async () => {
    const current = ++request.current
    const results = await Promise.allSettled([
      showStatus ? call('product-status', { instanceId: binding.instanceId }) : null,
      showUsage ? call('product-usage', { instanceId: binding.instanceId }) : null,
      showStatus ? app?.backups?.list?.() ?? [] : [],
      showStatus ? app?.diagnostics?.() ?? null : null,
    ])
    if (current !== request.current) return
    if (results[0].status === 'fulfilled') setStatus(results[0].value)
    else setError(results[0].reason.message)
    if (results[1].status === 'fulfilled') setUsage(results[1].value)
    else setError(results[1].reason.message)
    if (results[2].status === 'fulfilled') setBackups(results[2].value)
    else setError(t('Backups could not be listed.'))
    if (results[3].status === 'fulfilled') setDiagnostics(results[3].value)
    else setError(t('Diagnostics could not be loaded.'))
    if (showStatus && results[0].status === 'fulfilled' || showUsage && results[1].status === 'fulfilled') {
      setCheckedAt(Date.now())
    }
  }
  useEffect(() => {
    setError(null)
    setCheckedAt(null)
    setConfirm(null)
    void refresh()
    return () => { request.current++ }
  }, [binding.instanceId, showStatus, showUsage])
  useEffect(() => {
    if (!showStatus) return
    let current = true
    let changed = false
    const off = app?.updates?.subscribe?.(value => { changed = true; setUpdates(value) })
    void app?.updates?.state?.().then(value => { if (current && !changed) setUpdates(value) }).catch(() => {})
    return () => { current = false; off?.() }
  }, [app, showStatus])

  const run = async operation => {
    if (working.current) return
    working.current = true
    setBusy(true); setError(null)
    try { await operation(); await refresh() }
    catch (failure) { setError(t(failure.message)) }
    finally { working.current = false; setBusy(false) }
  }
  const downloadDiagnostics = async () => {
    const extraUsage = showUsage ? usage : await call('product-usage', { instanceId: binding.instanceId }).catch(() => null)
    const diagnostic = { generatedAt: new Date().toISOString(), ...diagnostics, status,
      usageCoverage: extraUsage?.coverage }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(diagnostic, null, 2)}\n`], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'ds-superagent-diagnostics.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  const statusRows = status ? [
    [t('Main'), `${t({ ready: 'Main ready', running: 'Main running', degraded: 'Main degraded' }[status.main.state])}${status.main.errorCode ? ` · ${status.main.errorCode}` : ''}`],
    [t('Processing'), status?.processingPaused ? t('Paused') : t('Running')],
    [t('Semantic inspection'), status?.supervision?.semanticInspection
      ? `${t(status.supervision.semanticInspection.status)}${status.supervision.semanticInspection.errorCode ? ` · ${status.supervision.semanticInspection.errorCode}` : ''}`
      : t('No inspection recorded')],
    [t('Watchdog'), status?.supervision?.watchdog
      ? `${t(status.supervision.watchdog.kind)} · ${new Date(status.supervision.watchdog.at).toLocaleString()}`
      : status?.supervision?.watchdogConfigured ? t('No inspection recorded') : t('Not configured')],
  ] : []
  const coverage = usage?.coverage
  const updateError = updates?.failure === 'install_failed' ? 'Update installation failed' : updates?.failure === 'download_failed' ? 'Update download failed' : null
  return h('section', { className: 'bt-ps-content bt-product-operations', 'aria-label': t(showStatus && showUsage ? 'Status and usage' : showStatus ? 'Status' : 'Usage') },
    h('div', { className: 'bt-product-operations-toolbar' },
      h('span', { role: 'status' }, busy ? t('Working…') : checkedAt ? t('Last checked {time}', { time: new Date(checkedAt).toLocaleTimeString() }) : ''),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { void run(() => Promise.resolve()) } }, t('Refresh status and usage'))),
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    showStatus ? h(Card, { title: t('Product health') },
      statusRows.length ? h(DetailList, { items: statusRows.map(([label, value]) => ({ label, value })) })
        : h(EmptyState, { title: error ? t('Status unavailable') : t('Loading…') }),
      h('div', { className: 'bt-product-operations-actions' },
          h('button', { type: 'button', className: 'bt-soft', onClick: () => onNavigate('supervision') }, t('Open supervision')),
          h('button', { type: 'button', className: 'bt-soft', onClick: () => onNavigate('roles') }, t('Open role settings')))) : null,
    showUsage && !usage && !showStatus ? h(InlineNotice, { tone: 'neutral' }, t(error ? 'Usage unavailable.' : 'Loading…')) : null,
    showUsage && usage ? h('section', { className: 'bt-set-section bt-ps-section' }, h('h3', null, t('Token usage by role')),
      h(StatGrid, { columns: 3, items: ['Main', 'Router', 'Worker'].map(label => {
        const total = usage.roles?.[label.toLowerCase()]
        return { label: t(label), value: total?.totalTokens == null ? '—' : number(total.totalTokens), detail: usageLine(total) }
      }) })) : null,
    showUsage && usage ? h(UsageItems, { title: t('Work usage'), items: usage.works }) : null,
    showUsage && usage ? h(UsageItems, { title: t('Planning usage'), items: usage.planning }) : null,
    showUsage && coverage ? h(Card, { title: t('Usage coverage') },
      h(Row, { label: t('Coverage') }, t(coverageCopy(coverage.status))),
      h('p', { className: 'bt-product-operations-note' }, t('Totals cover recent Main, Router and Worker Sessions. Supervisor, subagent and preparation calls outside those Sessions are excluded.')),
      h(Row, { label: t('Sessions included') }, t('{included} of {known}', {
        included: number(coverage.includedSessions), known: number(coverage.knownSessions),
      })),
      h(Row, { label: t('Omitted') }, t('{uses} role uses · {sessions} Sessions · at least {events} events', {
        uses: number(coverage.omittedRoleUses), sessions: number(coverage.omittedSessions), events: number(coverage.omittedEvents),
      })),
      coverage.missingSessions ? h(Row, { label: t('Unreadable Sessions') }, number(coverage.missingSessions)) : null,
      coverage.overBudgetSessions ? h(Row, { label: t('Sessions over the read limit') }, number(coverage.overBudgetSessions)) : null,
      coverage.conflictingSessions ? h(Row, { label: t('Sessions with conflicting roles') }, number(coverage.conflictingSessions)) : null,
      coverage.workRecordsTruncated ? h('p', null, t('Some work records were outside the attribution limits.')) : null,
      h(Row, { label: t('Unattributed usage') }, usageLine(usage.unattributed)),
      h(Row, { label: t('Cost') }, t(usage.cost.reason)),
      h('p', { className: 'bt-product-operations-note' }, t('Limits: {roles} role uses · {sessions} Sessions · {events} events per Session', {
        roles: number(coverage.limits.roleUses), sessions: number(coverage.limits.sessions), events: number(coverage.limits.eventsPerSession),
      }))) : null,
    showStatus ? h(Fragment, null, h(Card, { title: t('Updates') },
      h(Row, { label: t('DS SuperAgent') }, t(updateCopy(updates?.phase))),
      diagnostics?.appVersion ? h(Row, { label: t('Installed version') }, diagnostics.appVersion) : null,
      diagnostics?.dshVersion ? h(Row, { label: 'DSH' }, diagnostics.dshVersion) : null,
      updates?.version ? h(Row, { label: t('Version') }, updates.version) : null,
      updateError ? h(InlineNotice, { tone: 'danger' }, t(updateError)) : null,
      updates?.phase === 'downloaded' ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
        onClick: () => { void run(() => app?.updates?.install?.()) } }, t('Install and restart')) : null,
      ['failed', 'current', 'available'].includes(updates?.phase) ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
        onClick: () => { void run(() => app.updates.check()) } }, t('Check for updates')) : null,
      updates?.phase === 'available' ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
        onClick: () => { void run(() => app.updates.open()) } }, t('Open download page')) : null,
      updates === null ? h('p', { className: 'bt-product-operations-note' }, t('Updates come with the DS SuperAgent app.')) : null),
    diagnostics?.backupsAvailable ? h(Card, { title: t('Backups') },
      h('p', { className: 'bt-product-operations-note' }, t('Business state and DSH Sessions are backed up separately. Restores refuse changed authority or unresolved external effects.')),
      h('div', { className: 'bt-product-operations-actions' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => { void run(() => app.backups.create()) } }, t('Create backup'))),
      confirm ? h('div', { className: 'bt-product-operations-actions', role: 'group', 'aria-label': t('Restore this backup') },
        h('p', null, t('Restore the business and Session snapshot from {time}? The Host will restart.', { time: new Date(confirm.createdAt).toLocaleString() })),
        h('button', { type: 'button', className: 'bt-soft bt-danger', disabled: busy, onClick: () => {
          void run(() => app.backups.restore(confirm.id)); setConfirm(null)
        } }, t('Confirm restore')),
        h('button', { type: 'button', className: 'bt-soft', onClick: () => setConfirm(null) }, t('Cancel'))) : null,
      backups.length ? h('ul', { className: 'bt-product-operations-list' }, backups.slice(0, 10).map(backup => h('li', { key: backup.id },
        h('div', null, h('strong', null, new Date(backup.createdAt).toLocaleString()),
          h('span', null, t('{records} records · {sessions} Sessions · {size}', {
            records: number(backup.business.recordCount), sessions: number(backup.sessions.sessionCount ?? backup.sessions.fileCount),
            size: byteCount(backup.business.sizeBytes + backup.sessions.totalBytes),
          }))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !backup.restorable,
          title: backup.restorable ? t('Restore this backup') : t('Unresolved external effects prevent restoring this backup.'),
          onClick: () => setConfirm(backup) }, t('Restore')))))
        : h(EmptyState, { title: t('No backups yet.') })) : null,
    h(Card, { title: t('Diagnostics') },
      diagnostics?.events?.length ? h('details', null, h('summary', null, t('Recent operational events')),
        h('ul', { className: 'bt-product-operations-list' }, diagnostics.events.map((event, index) => h('li', { key: index },
          h('time', { dateTime: new Date(event.at).toISOString() }, new Date(event.at).toLocaleString()),
          h('span', null, `${event.code}${event.version ? ` · ${event.version}` : ''}`))))) : null,
      h('button', { type: 'button', className: 'bt-soft', onClick: () => { void downloadDiagnostics() } }, t('Download diagnostic summary')))) : null)
}

export const PRODUCT_OPERATIONS_CSS = `
.bt-product-operations-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-height:32px;color:var(--bt-ink-2);font-size:var(--bt-ps-small)}
.bt-product-operations-list{display:grid;gap:9px;margin:0;padding:0;list-style:none}
.bt-product-operations-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.bt-product-operations-list li>div{display:grid;gap:3px;min-width:0}
.bt-product-operations-list li span{color:var(--bt-ink-2);font-size:var(--bt-ps-small);overflow-wrap:anywhere}
.bt-product-operations-list li strong{overflow-wrap:anywhere}
.bt-product-operations-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-product-operations-note{margin:0;color:var(--bt-ink-2);font-size:var(--bt-ps-small);line-height:18px;overflow-wrap:anywhere}
@media(max-width:640px){.bt-product-operations-list li{align-items:flex-start;flex-wrap:wrap}.bt-product-operations-list li>button{margin-left:auto}}
`
