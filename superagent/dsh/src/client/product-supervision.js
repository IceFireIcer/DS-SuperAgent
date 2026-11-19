import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const inspectionStatus = run => run.status === 'completed' && !run.partial ? 'Inspection complete'
  : run.status === 'budget-exhausted' ? 'Inspection budget exhausted'
    : run.status === 'partial' || run.partial && run.status !== 'failed' ? 'Partial inspection' : 'Inspection failed'

export function ProductSupervisionSettings({ binding, call }) {
  const [state, setState] = useState(null)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const requiresRestart = state?.run?.last?.partial && (state.run.last.status === 'completed' && !state.run.checkpoint
    || state.run.last.status === 'failed' && ['INVALID_INPUT', 'INCOMPLETE_STATE'].includes(state.run.last.error))
  const load = async ticketId => {
    const next = await call('supervision', { instanceId: binding.instanceId, ...(ticketId ? { ticketId } : {}) })
    setState(next)
  }
  useEffect(() => {
    let live = true
    const refresh = () => call('supervision', { instanceId: binding.instanceId,
      ...(selected ? { ticketId: selected } : {}) }).then(value => { if (live) setState(value) })
      .catch(failure => { if (live) setError(failure.message) })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 30_000)
    return () => { live = false; clearInterval(timer) }
  }, [binding.instanceId, selected])
  const choose = async ticketId => {
    setSelected(ticketId)
    setError(null)
    try { await load(ticketId) } catch (failure) { setError(failure.message) }
  }
  const inspect = async () => {
    setBusy(true); setError(null)
    try { await call('supervision-inspect', { instanceId: binding.instanceId,
      ...(requiresRestart ? { restart: true } : {}) }); await load(selected) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const decide = async (proposal, decision) => {
    setBusy(true); setError(null)
    try {
      await call('supervision-decide', { instanceId: binding.instanceId, commandId: crypto.randomUUID(),
        proposalId: proposal.id, fingerprint: proposal.fingerprint, decision })
      await load(selected)
    } catch (failure) { setError(failure.message); await load(selected).catch(() => {}) }
    finally { setBusy(false) }
  }
  return h('section', { className: 'bt-product-supervision', 'aria-label': t('Supervision') },
    h('div', { className: 'bt-product-supervision-head' }, h('h3', null, t('Supervision')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void inspect() } }, t(requiresRestart ? 'Restart inspection' : 'Inspect now'))),
    error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
    h('p', { className: 'bt-main-status' }, state?.watchdogConfigured
      ? state.watchdog?.last ? `${t('Watchdog')}: ${state.watchdog.last.kind} · ${new Date(state.watchdog.last.at).toLocaleString()}` : t('Watchdog has not inspected yet.')
      : t('Independent Watchdog is not configured for this Host.')),
    state?.run?.last ? h('p', { className: 'bt-main-status' }, `${t('Semantic inspection')}: ${t(inspectionStatus(state.run.last))}${state.run.last.error && state.run.last.status === 'failed' ? ` · ${state.run.last.error}` : ''} · ${new Date(state.run.last.at).toLocaleString()} · ${t('Tickets inspected')} ${state.run.last.coverage?.inspected ?? state.run.last.inspectionBudget?.inspected ?? 0} · ${t('Inspection budget')} ${state.run.last.budget.used}/${state.run.last.budget.max}`) : null,
    state?.proposals?.length ? h('div', { className: 'bt-product-supervision-list' },
      state.proposals.slice(0, 30).map(proposal => h('article', { key: proposal.id, className: 'bt-product-supervision-item' },
        h('div', { className: 'bt-product-supervision-head' },
          h('strong', null, `${proposal.kind === 'pause' ? t('Pause work') : t('Correct direction')} · ${proposal.status}`),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void choose(proposal.ticketId) } }, t('View history'))),
        h('p', null, `${t('Work')}: ${proposal.ticketId}`),
        h('p', null, `${t('Reason')}: ${proposal.evidence.assessment.reason}`),
        h('p', null, `${t('Recommendation')}: ${proposal.recommendation}`),
        h('p', null, `${t('Impact')}: ${proposal.impact.summary}`),
        h('p', { className: 'bt-main-status' }, `${t('Configuration')}: ${proposal.version} · ${new Date(proposal.createdAt).toLocaleString()}`),
        proposal.action ? h('p', { role: 'status' }, `${t('Action')}: ${proposal.action.status}${proposal.action.error ? ` · ${proposal.action.error}` : ''}`) : null,
        proposal.status === 'proposed' ? h('div', { className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void decide(proposal, 'reject') } }, t('Reject')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void decide(proposal, 'approve') } }, t('Approve'))) : null)))
      : h('p', { className: 'bt-main-status' }, t('No supervision proposals.')),
    selected && state?.observation ? h('section', { 'aria-label': t('Observation history') },
      h('h4', null, t('Observation history')),
      state.observation.history.slice(0, 20).map(observation => h('p', { key: `${observation.at}:${observation.finding}` },
        `${new Date(observation.at).toLocaleString()} · ${observation.finding}${observation.assessment?.reason ? ` · ${observation.assessment.reason}` : ''}`))) : null,
    state?.watchdog?.history?.length ? h('details', null, h('summary', null, t('Watchdog history')),
      state.watchdog.history.slice(0, 20).map(item => h('p', { key: item.id },
        `${new Date(item.at).toLocaleString()} · ${item.kind} · ${item.action} · ${item.result} · ${item.version}`))) : null)
}

export const PRODUCT_SUPERVISION_CSS = `
.bt-product-supervision{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 0;border-top:1px solid var(--bt-line)}
.bt-product-supervision-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.bt-product-supervision h3,.bt-product-supervision h4{margin:0;font-size:14px}
.bt-product-supervision p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:18px}
.bt-product-supervision-list{display:flex;flex-direction:column;gap:12px}
.bt-product-supervision-item{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--bt-line);border-radius:8px}
.bt-product-supervision-item .bt-actions{display:flex;justify-content:flex-end;gap:8px}
.bt-product-supervision button:focus-visible,.bt-product-supervision summary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.bt-product-supervision *{transition:none}}
`
