import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { DetailList, EmptyState, FieldRow, InlineNotice, SectionCard, StatusChip } from './product-settings-components.js'

const inspectionStatus = run => run.status === 'completed' && !run.partial ? 'Inspection complete'
  : run.status === 'budget-exhausted' ? 'Inspection budget exhausted'
    : run.status === 'partial' || run.partial && run.status !== 'failed' ? 'Partial inspection' : 'Inspection failed'

export function ProductSupervisionSettings({ binding, call }) {
  const [state, setState] = useState(null)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [readError, setReadError] = useState(null)
  const request = useRef(0)
  const requiresRestart = state?.run?.last?.partial && (state.run.last.status === 'completed' && !state.run.checkpoint
    || state.run.last.status === 'failed' && ['INVALID_INPUT', 'INCOMPLETE_STATE'].includes(state.run.last.error))
  const load = async ticketId => {
    const current = ++request.current
    try {
      const next = await call('supervision', { instanceId: binding.instanceId, ...(ticketId ? { ticketId } : {}) })
      if (current === request.current) { setState(next); setReadError(null) }
    } catch (failure) {
      if (current === request.current) { setState(null); setReadError(failure.message) }
    }
  }
  useEffect(() => {
    void load(selected)
    const timer = setInterval(() => { void load(selected) }, 30_000)
    return () => { request.current++; clearInterval(timer) }
  }, [binding.instanceId, call, selected])
  const choose = ticketId => {
    if (ticketId === selected || busy) return
    request.current++
    setSelected(ticketId)
    setState(null)
    setError(null)
    setReadError(null)
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
    } catch (failure) { setError(failure.message); await load(selected) }
    finally { setBusy(false) }
  }
  return h('section', { className: 'bt-ps-content bt-product-supervision', 'aria-label': t('Supervision') },
    h(SectionCard, null, h(FieldRow, { label: t('Semantic inspection'), control:
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !state || busy, onClick: () => { void inspect() } }, t(requiresRestart ? 'Restart inspection' : 'Inspect now')) })),
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    readError ? h(InlineNotice, { tone: 'danger', action: h('button', { type: 'button', className: 'bt-soft', disabled: busy,
      onClick: () => { void load(selected) } }, t('Retry')) }, readError) : !state ? h('p', { role: 'status' }, t('Loading…')) : null,
    state ? h('p', { className: 'bt-main-status' }, state.watchdogConfigured
      ? state.watchdog?.last ? `${t('Watchdog')}: ${state.watchdog.last.kind} · ${new Date(state.watchdog.last.at).toLocaleString()}` : t('Watchdog has not inspected yet.')
      : t('Independent Watchdog is not configured for this Host.')) : null,
    state?.run?.last ? h('p', { className: 'bt-main-status' }, `${t('Semantic inspection')}: ${t(inspectionStatus(state.run.last))}${state.run.last.error && state.run.last.status === 'failed' ? ` · ${state.run.last.error}` : ''} · ${new Date(state.run.last.at).toLocaleString()} · ${t('Tickets inspected')} ${state.run.last.coverage?.inspected ?? state.run.last.inspectionBudget?.inspected ?? 0} · ${t('Inspection budget')} ${state.run.last.budget.used}/${state.run.last.budget.max}`) : null,
    state?.proposals?.length ? h('div', { className: 'bt-product-supervision-list' },
      state.proposals.slice(0, 30).map(proposal => h(SectionCard, { key: proposal.id, title: proposal.kind === 'pause' ? t('Pause work') : t('Correct direction') },
        h(FieldRow, { label: h(StatusChip, { tone: proposal.status === 'proposed' ? 'warn' : 'neutral' }, t(proposal.status)), control:
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || proposal.ticketId === selected,
            onClick: () => choose(proposal.ticketId) }, t('View history')) }),
        h(DetailList, { items: [
          { label: t('Work'), value: proposal.ticketId, mono: true },
          { label: t('Reason'), value: proposal.evidence.assessment.reason },
          { label: t('Recommendation'), value: proposal.recommendation },
          { label: t('Impact'), value: proposal.impact.summary },
          { label: t('Configuration'), value: `${proposal.version} · ${new Date(proposal.createdAt).toLocaleString()}` },
        ] }),
        proposal.action ? h('p', { role: 'status' }, `${t('Action')}: ${proposal.action.status}${proposal.action.error ? ` · ${proposal.action.error}` : ''}`) : null,
        proposal.status === 'proposed' ? h('div', { className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void decide(proposal, 'reject') } }, t('Reject')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void decide(proposal, 'approve') } }, t('Approve'))) : null)))
      : state ? h(SectionCard, null, h(EmptyState, { title: t('No supervision proposals.') })) : null,
    selected ? h(SectionCard, { title: t('Observation history') },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => choose(null) }, t('All work')),
      state?.observation?.history.slice(0, 20).map(observation => h('p', { key: `${observation.at}:${observation.finding}` },
        `${new Date(observation.at).toLocaleString()} · ${observation.finding}${observation.assessment?.reason ? ` · ${observation.assessment.reason}` : ''}`))) : null,
    state?.watchdog?.history?.length ? h('details', null, h('summary', null, t('Watchdog history')),
      state.watchdog.history.slice(0, 20).map(item => h('p', { key: item.id },
        `${new Date(item.at).toLocaleString()} · ${item.kind} · ${item.action} · ${item.result} · ${item.version}`))) : null)
}

export const PRODUCT_SUPERVISION_CSS = `
.bt-product-supervision p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-product-supervision-list{display:flex;flex-direction:column;gap:12px}
`
