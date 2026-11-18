import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row } from './product-card.js'
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
    : h('p', { className: 'bt-product-operations-note' }, t('No attributed work usage.')))
}

export function ProductOperationsSettings({ binding, call, onNavigate, app = globalThis.window?.dsSuperagentApp }) {
  const [status, setStatus] = useState(null)
  const [usage, setUsage] = useState(null)
  const [updates, setUpdates] = useState(null)
  const [backups, setBackups] = useState([])
  const [diagnostics, setDiagnostics] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const working = useRef(false)

  const refresh = async () => {
    const current = ++request.current
    const results = await Promise.allSettled([
      call('product-status', { instanceId: binding.instanceId }),
      call('product-usage', { instanceId: binding.instanceId }),
      app?.backups?.list?.() ?? Promise.resolve([]),
      app?.diagnostics?.() ?? Promise.resolve(null),
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
  }
  useEffect(() => {
    void refresh()
    return () => { request.current++ }
  }, [binding.instanceId])
  useEffect(() => {
    let current = true
    let changed = false
    const off = app?.updates?.subscribe?.(value => { changed = true; setUpdates(value) })
    void app?.updates?.state?.().then(value => { if (current && !changed) setUpdates(value) }).catch(() => {})
    return () => { current = false; off?.() }
  }, [app])

  const run = async operation => {
    if (working.current) return
    working.current = true
    setBusy(true); setError(null)
    try { await operation(); await refresh() }
    catch (failure) { setError(t(failure.message)) }
    finally { working.current = false; setBusy(false) }
  }
  const [confirm, setConfirm] = useState(null)
  const downloadDiagnostics = async () => {
    const diagnostic = { generatedAt: new Date().toISOString(), ...diagnostics, status,
      usageCoverage: usage?.coverage }
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
  return h('section', { className: 'bt-product-operations', 'aria-label': t('Status and usage') },
    h('div', { className: 'bt-product-operations-toolbar' },
      h('span', { role: 'status' }, busy ? t('Working…') : status ? t('Last checked {time}', { time: new Date(usage?.createdAt ?? Date.now()).toLocaleTimeString() }) : ''),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { void run(() => Promise.resolve()) } }, t('Refresh status and usage'))),
    error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
    h(Card, { title: t('Product health') },
      statusRows.length ? statusRows.map(([label, value]) => h(Row, { key: label, label }, value)) : t('Status unavailable'),
      h('div', { className: 'bt-product-operations-actions' },
          h('button', { type: 'button', className: 'bt-soft', onClick: () => onNavigate('supervision') }, t('Open supervision')),
          h('button', { type: 'button', className: 'bt-soft', onClick: () => onNavigate('roles') }, t('Open role settings')))),
    usage ? h(Card, { title: t('Token usage by role') },
      [['main', 'Main'], ['router', 'Router'], ['worker', 'Worker']].map(([role, label]) =>
        h(Row, { key: role, label: t(label) }, usageLine(usage.roles?.[role])))) : null,
    usage ? h(UsageItems, { title: t('Work usage'), items: usage.works }) : null,
    usage ? h(UsageItems, { title: t('Planning usage'), items: usage.planning }) : null,
    coverage ? h(Card, { title: t('Usage coverage') },
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
    h(Card, { title: t('Updates') },
      h(Row, { label: t('DS SuperAgent') }, t(updateCopy(updates?.phase))),
      diagnostics?.appVersion ? h(Row, { label: t('Installed version') }, diagnostics.appVersion) : null,
      diagnostics?.dshVersion ? h(Row, { label: 'DSH' }, diagnostics.dshVersion) : null,
      updates?.version ? h(Row, { label: t('Version') }, updates.version) : null,
      updateError ? h('p', { role: 'alert', className: 'bt-main-error' }, t(updateError)) : null,
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
        : h('p', { className: 'bt-product-operations-note' }, t('No backups yet.'))) : null,
    h(Card, { title: t('Diagnostics') },
      diagnostics?.events?.length ? h('details', null, h('summary', null, t('Recent operational events')),
        h('ul', { className: 'bt-product-operations-list' }, diagnostics.events.map((event, index) => h('li', { key: index },
          h('time', { dateTime: new Date(event.at).toISOString() }, new Date(event.at).toLocaleString()),
          h('span', null, `${event.code}${event.version ? ` · ${event.version}` : ''}`))))) : null,
      h('button', { type: 'button', className: 'bt-soft', onClick: () => { void downloadDiagnostics() } }, t('Download diagnostic summary'))))
}

export const PRODUCT_OPERATIONS_CSS = `
.bt-product-operations{display:grid;gap:12px;min-width:0}
.bt-product-operations-toolbar{display:flex;align-items:center;justify-content:space-between;min-height:32px;color:var(--bt-ink-2);font-size:12px}
.bt-product-operations-list{display:grid;gap:9px;margin:0;padding:0;list-style:none}
.bt-product-operations-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.bt-product-operations-list li>div{display:grid;gap:3px;min-width:0}
.bt-product-operations-list li span{color:var(--bt-ink-2);font-size:12px;overflow-wrap:anywhere}
.bt-product-operations-list li strong{overflow-wrap:anywhere}
.bt-product-operations-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-product-operations-note{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
@media(max-width:640px){.bt-product-operations-list li{align-items:flex-start;flex-wrap:wrap}.bt-product-operations-list li>button{margin-left:auto}}
`
