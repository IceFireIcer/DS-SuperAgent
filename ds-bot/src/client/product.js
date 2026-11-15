import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatRows } from './cells.js'
import { MainComposer } from './composer.js'
import { BrandMark } from './sidebar.js'
import { createSource } from './sources.js'
import { installLocale, t } from './i18n.js'
import { allThemes, themeCss } from './themes.js'
import { SHELL_CSS, CONVERSATION_CSS, installCompiledStyles, installStyles } from './styles.js'

export async function productCall(endpoint, payload = {}) {
  const response = await fetch('api/product', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  let result
  try { result = await response.json() } catch { throw new Error(t('Could not reach Main. Check that the app is running.')) }
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? t('Main is unavailable.')), { code: result.error?.code })
  return result.value
}

export function applyProduct(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'superagent: interface copy')
  const view = createSource({
    binding: null,
    messages: [],
    works: [],
    error: null,
    route: 'main',
    observations: [],
    observationCursor: null,
    observationQuery: '',
    selectedObservation: null,
    observation: null,
    observationLoading: false,
    observationError: null,
    activityLoading: false,
    activityError: null,
  })
  const useView = () => useSyncExternalStore(view.subscribe, view.getSnapshot)
  let stopped = false
  let observationListRequest = 0
  let observationRequest = 0

  const refreshMain = async binding => {
    try {
      const messages = []
      let works = []
      let after
      do {
        const page = await productCall('history', { instanceId: binding.instanceId, limit: 100, ...(after === undefined ? {} : { after }) })
        messages.push(...page.messages)
        if (after === undefined) works = page.works ?? []
        after = page.cursor
      } while (after !== undefined && !stopped)
      if (!stopped) view.set(state => ({ ...state, binding, messages, works, error: null }))
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, error: error.message }))
    }
  }

  const loadObservations = async (binding, { append = false } = {}) => {
    const current = view.getSnapshot()
    const query = current.observationQuery
    const request = ++observationListRequest
    try {
      if (!append) view.set(state => ({ ...state, activityLoading: true, activityError: null }))
      const page = await productCall('observe-list', { instanceId: binding.instanceId, limit: 30,
        ...(query ? { query } : {}), ...(append && current.observationCursor ? { after: current.observationCursor } : {}) })
      if (stopped || request !== observationListRequest || view.getSnapshot().observationQuery !== query) return
      view.set(state => {
        const byId = new Map((append ? state.observations : []).map(item => [item.id, item]))
        for (const item of page.items) byId.set(item.id, item)
        const selectedObservation = state.selectedObservation
          ? page.items.find(item => item.id === state.selectedObservation.id) ?? state.selectedObservation
          : null
        return { ...state, observations: [...byId.values()], observationCursor: page.cursor ?? null,
          selectedObservation, activityLoading: false, activityError: null }
      })
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, activityLoading: false, activityError: error.message }))
    }
  }

  const loadObservation = async (binding, item, { reset = false, older = false } = {}) => {
    const current = view.getSnapshot()
    if (!item) return
    if (!reset && !older && current.observation?.hasMore) return
    const after = reset ? undefined : older || !current.observation?.hasMore ? current.observation?.next : undefined
    const request = ++observationRequest
    try {
      if (reset) view.set(state => ({ ...state, observationLoading: true, observationError: null }))
      const detail = await productCall('observe-read', { instanceId: binding.instanceId, observationId: item.id,
        ...(item.generation ? { generation: item.generation } : {}), limit: 50, ...(after === undefined ? {} : { after }) })
      if (stopped || request !== observationRequest || view.getSnapshot().selectedObservation?.id !== item.id) return
      view.set(state => {
        if (reset || !state.observation) return { ...state, observation: detail, observationLoading: false, observationError: null }
        const events = new Map(state.observation.events.map(event => [event.seq, event]))
        for (const event of detail.events) events.set(event.seq, event)
        return { ...state, observation: { ...detail, events: [...events.values()].sort((left, right) => left.seq - right.seq) },
          observationLoading: false, observationError: null }
      })
    } catch (error) {
      if (!stopped && request === observationRequest) {
        view.set(state => ({ ...state, observationLoading: false, observationError: error.message }))
      }
    }
  }

  const refresh = async () => {
    try {
      const current = view.getSnapshot()
      const binding = current.binding ?? await productCall('open')
      if (current.route === 'main') await refreshMain(binding)
      await loadObservations(binding)
      const selected = view.getSnapshot().route === 'observe' ? view.getSnapshot().selectedObservation : null
      if (selected) await loadObservation(binding, selected)
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, error: error.message }))
    }
  }

  ctx.effect(() => {
    let timer
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 750) }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, 'superagent: follow the shared Main')

  const emptyRoster = { bots: [], byId: {}, roomsById: {}, prefs: {} }
  const statusCopy = status => ({ routing: t('Routing work'), pending: t('Pending work'), running: t('Running work'),
    waiting: t('Waiting for an answer'), blocked: t('Blocked work'), stopped: t('Stopped work'), success: t('Work complete'),
    failed: t('Work failed'), rejected: t('Work declined'), accepted: t('Accepted by Router'), ended: t('Generation ended'),
    unknown: t('Work result unknown') })[status] ?? status
  const followUpCopy = status => ({ queued: t('Follow-up queued'), persisted: t('Follow-up persisted'),
    delivering: t('Follow-up delivery started'), ready: t('Direction completed'), waiting: t('Direction waiting'),
    'handed-back': t('Direction handed back'), stopped: t('Direction blocked by stop'),
    expired: t('Follow-up delivery expired') })[status] ?? status
  const receiptCopy = status => ({ routing: t('Router is routing'), accepted: t('Accepted by Router'), rejected: t('Not accepted') })[status] ?? status
  function MainWorkCard({ work }) {
    return h('article', { className: 'bt-main-work', 'aria-label': t('Work item: {goal}', { goal: work.brief.goal }) },
      h('div', { className: 'bt-main-work-head' }, h('strong', null, work.brief.goal),
        h('span', { className: 'bt-main-work-status', role: 'status' }, statusCopy(work.status))),
      h('p', { className: 'bt-main-work-id' }, `${t('Work brief')} ${work.brief.id}`),
      h('p', { className: 'bt-main-work-id' }, `${t('Receipt')}: ${receiptCopy(work.receipt.status)}`),
      work.receipt.ticketId ? h('p', { className: 'bt-main-work-id' }, `${t('Ticket')} ${work.receipt.ticketId}`) : null,
      work.receipt.reason ? h('p', { className: 'bt-main-error' }, `${t('Work receipt')}: ${work.receipt.reason}`) : null,
      work.receipt.status === 'routing' ? h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.receipt.nextStep}`) : null,
      h('p', { className: 'bt-main-work-detail' }, `${t('Constraints')}: ${work.brief.constraints}`),
      h('p', { className: 'bt-main-work-detail' }, `${t('Acceptance criteria')}: ${work.brief.acceptanceCriteria}`),
      work.followUps?.length ? h('div', { className: 'bt-main-work-followups', 'aria-label': t('Follow-up history') },
        work.followUps.map(followUp => h('div', { key: followUp.id, className: 'bt-main-work-followup' },
          h('p', null, `${t('Direction v{version}', { version: followUp.directionVersion })}: ${followUpCopy(followUp.status)}`),
          h('p', { className: 'bt-main-work-detail' }, followUp.text),
          h('p', { className: 'bt-main-work-detail' },
            `${followUp.persisted ? t('Input persisted') : t('Input not yet persisted')} · ${followUp.adopted
              ? t('Direction adopted by Worker') : t('Direction not yet adopted')}`),
          followUp.displayReason
            ? h('p', { className: 'bt-main-work-detail' }, `${t('Reason')}: ${followUp.displayReason}`) : null))) : null,
      work.outcome ? h('div', { className: 'bt-main-work-result' },
        h('p', null, work.outcome.summary), h('p', { className: 'bt-main-work-detail' }, `${t('Verification')}: ${work.outcome.evidence}`),
        h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.outcome.nextStep}`),
        work.outcome.artifacts.map(artifact => h('p', { key: artifact.path, className: 'bt-main-work-artifact' },
          h('code', null, artifact.path), ' ', h('span', null, `${artifact.bytes} ${t('bytes')} · ${artifact.sha256.slice(0, 12)}`)))) : null)
  }

  function MainConversation() {
    const state = useView()
    const [sending, setSending] = useState(false)
    const [sendError, setSendError] = useState(null)
    const bottom = useRef(null)
    const pending = useRef(null)
    const scroll = useRef(null)
    const follow = useRef(true)
    useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' }) }, [state.messages.length])
    const send = async text => {
      if (!state.binding) return false
      const storageKey = `superagent:pending:${state.binding.instanceId}`
      try {
        setSending(true); setSendError(null)
        if (!pending.current) {
          try { pending.current = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') } catch { /* Draft storage is optional. */ }
        }
        if (!pending.current || pending.current.text !== text) pending.current = { commandId: crypto.randomUUID(), text }
        try { sessionStorage.setItem(storageKey, JSON.stringify(pending.current)) } catch { /* The stable identity still lives until this window closes. */ }
        const result = await productCall('send', { instanceId: state.binding.instanceId, ...pending.current })
        pending.current = null
        try { sessionStorage.removeItem(storageKey) } catch { /* Draft storage is optional. */ }
        await refreshMain(state.binding)
        if (result.status === 'failed') { setSendError(t('Main could not finish this reply. Your message is saved.')); return false }
        return true
      } catch (error) { setSendError(error.message); await refreshMain(state.binding); return false }
      finally { setSending(false) }
    }
    const busy = sending || state.messages.some(message => message.status === 'running' || message.status === 'queued')
    return h('section', { className: 'bt-main-conversation', 'aria-label': 'Main' },
      h('header', { className: 'bt-main-header' }, h(BrandMark, { size: 28 }), h('span', null, 'Main')),
      h('div', { className: 'bt-main-history', ref: scroll, onScroll: () => { const node = scroll.current; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 } },
        h('div', { className: 'bt-main-messages' },
          state.messages.length === 0 ? h('p', { className: 'bt-main-empty' }, t('What would you like to discuss?')) : null,
          state.messages.map(message => h('div', { key: message.id },
            h(ChatRows, { items: [{ kind: message.role === 'main' ? 'bot' : 'user', text: message.text, time: message.createdAt }], sessionId: 'main', roster: emptyRoster, actions: {} }),
            message.status === 'failed' ? h('p', { className: 'bt-main-error', role: 'status' }, t('Main could not finish this reply. Your message is saved.')) : null)),
          state.works.map(work => h(MainWorkCard, { key: work.brief.workItemId ?? work.brief.id, work })),
          busy ? h('p', { className: 'bt-main-status', role: 'status' }, t('Main is replying…')) : null,
          h('div', { ref: bottom }))),
      h(MainComposer, { onSend: send, busy: sending || !state.binding, error: sendError ?? state.error }))
  }

  function ObservationConversation() {
    const state = useView()
    const [copyState, setCopyState] = useState('idle')
    const observation = state.observation
    const backToMain = () => {
      view.set(current => ({ ...current, route: 'main', selectedObservation: null, observation: null, observationError: null }))
      void refresh()
      setTimeout(() => document.querySelector('#main-message, .bt-main-composer textarea')?.focus(), 0)
    }
    const copy = async () => {
      if (!observation || !state.binding) return
      try {
        await navigator.clipboard.writeText(JSON.stringify({ ...observation, instanceId: state.binding.instanceId }, null, 2))
        setCopyState('copied')
        setTimeout(() => setCopyState('idle'), 1600)
      } catch {
        setCopyState('failed')
      }
    }
    return h('section', { className: 'bt-observation', 'aria-label': t('Read-only work activity') },
      h('header', { className: 'bt-observation-header' },
        h('button', { type: 'button', className: 'bt-soft', onClick: backToMain }, t('Back to Main')),
        h('div', { className: 'bt-observation-heading' },
          h('span', { className: 'bt-observation-role' }, observation?.role === 'router' ? 'Router' : 'Worker'),
          h('strong', null, observation?.title ?? state.selectedObservation?.title ?? '')),
        h('span', { className: 'bt-observation-readonly' }, t('Read-only'))),
      h('div', { className: 'bt-observation-body' },
        state.observationLoading && !observation ? h('p', { role: 'status', className: 'bt-main-status' }, t('Loading history…')) : null,
        state.observationError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.observationError) : null,
        observation ? h('div', { className: 'bt-observation-content' },
          h('div', { className: 'bt-observation-summary' },
            h('div', null, h('p', { className: 'bt-observation-status', role: 'status' },
              `${statusCopy(observation.status)}${observation.generation && !observation.current ? ` · ${t('Historical generation')}` : ''}`),
              h('p', null, observation.summary),
              h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${t(observation.nextStep)}`)),
            h('div', { className: 'bt-observation-actions' },
              h('button', { type: 'button', className: 'bt-soft', onClick: copy },
                copyState === 'copied' ? t('Copied') : copyState === 'failed' ? t('Copy failed') : t('Copy details')))),
          h('dl', { className: 'bt-observation-facts' }, observation.facts.map(fact => h('div', { key: fact.label },
            h('dt', null, t(fact.label)), h('dd', null, fact.value)))),
          observation.generations.length > 1 ? h('section', { className: 'bt-observation-generations', 'aria-label': t('Assignment generations') },
            h('h2', null, t('Assignment generations')),
            observation.generations.map(generation => h('div', { key: generation.assignmentId, 'aria-current': generation.current ? 'true' : undefined },
              h('span', null, generation.generation), h('span', null, generation.current ? t('Current generation') : t('Historical generation')),
              h('span', null, statusCopy(generation.state))))) : null,
          h('section', { className: 'bt-observation-history', 'aria-label': t('Observation history') },
            h('h2', null, t('Observation history')),
            observation.events.length ? observation.events.map(event => h('article', { key: event.seq, className: 'bt-observation-event' },
              h('div', { className: 'bt-observation-event-head' },
                h('span', null, event.kind === 'user-message' ? t('Input') : event.kind === 'assistant-message' ? t('Response')
                  : event.kind === 'tool-call' ? t('Tool call') : event.kind === 'tool-result' ? t('Tool result') : t('Turn')),
                h('time', null, event.time ? new Date(event.time).toLocaleTimeString() : '')),
              h('p', null, redactObservationText(event.text)),
              event.argumentKeys?.length ? h('p', { className: 'bt-main-work-detail' }, `${t('Arguments')}: ${event.argumentKeys.join(', ')}`) : null))
              : h('p', { className: 'bt-main-status' }, t('No execution history has been recorded yet.')),
            observation.hasMore ? h('button', { type: 'button', className: 'bt-soft bt-observation-more', onClick: () => {
              if (state.binding && state.selectedObservation) void loadObservation(state.binding, state.selectedObservation, { older: true })
            } }, t('Load more history')) : null)) : null))
  }

  function MainNavigation() {
    const state = useView()
    const [search, setSearch] = useState(state.observationQuery)
    const timer = useRef(null)
    useEffect(() => () => clearTimeout(timer.current), [])
    const changeSearch = value => {
      setSearch(value)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (!state.binding) return
        view.set(current => ({ ...current, observationQuery: value, observationCursor: null }))
        void loadObservations(state.binding)
      }, 180)
    }
    return h('nav', { className: 'bt-main-nav', 'aria-label': t('Work navigation') },
      h('button', { type: 'button', className: 'bt-soft', 'aria-current': state.route === 'main' ? 'page' : undefined,
        onClick: () => {
          view.set(current => ({ ...current, route: 'main', selectedObservation: null, observation: null, observationError: null }))
          void refresh()
        } }, h(BrandMark, { size: 24 }), 'Main'),
      h('div', { className: 'bt-observation-search' },
        h('label', { htmlFor: 'work-observation-search' }, t('Find activity')),
        h('input', { id: 'work-observation-search', type: 'search', value: search, placeholder: t('Search Router and Worker history'),
          onChange: event => changeSearch(event.currentTarget.value) })),
      h('div', { className: 'bt-observation-nav-head' },
        h('span', null, t('Work activity')), h('span', null, t('Read-only'))),
      state.observations.length ? state.observations.map(item => h('button', {
        key: item.id,
        type: 'button',
        className: 'bt-observation-nav-item',
        'aria-current': state.route === 'observe' && state.selectedObservation?.id === item.id ? 'page' : undefined,
        onClick: () => {
          view.set(current => ({ ...current, route: 'observe', selectedObservation: item, observation: null, observationError: null }))
          if (state.binding) void loadObservation(state.binding, item, { reset: true })
        },
      }, h('span', { className: 'bt-observation-role' }, item.role === 'router' ? 'Router' : 'Worker'),
        h('span', { className: 'bt-observation-nav-copy' }, h('strong', null, item.title), h('span', null, statusCopy(item.status)))))
        : h('p', { className: 'bt-observation-empty' }, t('No Router or Worker activity yet.')),
      state.activityError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.activityError) : null,
      state.observationCursor ? h('button', { type: 'button', className: 'bt-soft bt-observation-more',
        disabled: state.activityLoading, onClick: () => { if (state.binding) void loadObservations(state.binding, { append: true }) } },
      state.activityLoading ? t('Loading…') : t('Load more activity')) : null)
  }

  function ProductSurface() { return useView().route === 'observe' ? h(ObservationConversation) : h(MainConversation) }
  const shadow = (name, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -200 }, component))
  ctx.effect(() => installCompiledStyles(SHELL_CSS + CONVERSATION_CSS + PRODUCT_CSS, 'main'), 'superagent: existing chat styles')
  ctx.effect(() => { const style = installStyles(themeCss(allThemes().deepseek), 'main-theme'); return () => style.remove() }, 'superagent: existing theme')
  shadow('main.conversation', ProductSurface)
  shadow('sidebar.workspaces', MainNavigation)
  shadow('sidebar.brand.name', () => h('span', null, 'DS-SuperAgent'))
  shadow('sidebar.brand.mark', BrandMark)
}

function redactObservationText(value) {
  return String(value).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\x2f-]+=*/giu, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
}

const PRODUCT_CSS = `
.bt-main-conversation{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-main-header{height:56px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:.5px solid var(--bt-line-2);font-size:15px;font-weight:600}
.bt-main-history{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px}
.bt-main-messages{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.bt-main-composer{width:min(800px,100% - 32px);margin:16px auto 20px;padding:12px;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-card)}
.bt-main-composer textarea{display:block;width:100%;resize:vertical;min-height:80px;max-height:200px;padding:4px;border:0;background:transparent;color:var(--bt-ink);font:inherit;font-size:14px;line-height:22px;box-sizing:border-box}
.bt-main-composer textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-main-send{display:flex;justify-content:flex-end;margin-top:8px}
.bt-main-send button{height:36px;min-width:64px}
.bt-main-label{display:block;margin:0 0 6px;font-size:12px;color:var(--bt-ink-2)}
.bt-main-empty{margin:48px 0;color:var(--bt-ink-2);font-size:14px;line-height:22px;text-align:center}
.bt-main-error{margin:8px 0;color:var(--bt-danger);font-size:13px;line-height:18px}
.bt-main-status{color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-main-work{max-width:800px;margin:0 auto;width:calc(100% - 32px);padding:12px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);box-sizing:border-box}
.bt-main-work-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;color:var(--bt-ink);font-size:14px;line-height:20px}
.bt-main-work-head strong{min-width:0;overflow-wrap:anywhere;font-weight:600}
.bt-main-work-status{flex:none;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-main-work-id,.bt-main-work-detail,.bt-main-work-artifact{margin:6px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-main-work-followups{margin-top:8px;padding-top:8px;border-top:.5px solid var(--bt-line-2)}
.bt-main-work-followup{padding:6px 0;color:var(--bt-ink);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-main-work-followup+.bt-main-work-followup{border-top:.5px solid var(--bt-line-2)}
.bt-main-work-followup p{margin:0}
.bt-main-work-result{margin-top:8px;padding-top:8px;border-top:.5px solid var(--bt-line-2);color:var(--bt-ink);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-main-work-result p{margin:0 0 6px}.bt-main-work-result p:last-child{margin-bottom:0}
.bt-main-work-artifact code{font:inherit;color:var(--bt-ink)}
.bt-main-nav{padding:12px;display:flex;flex-direction:column;gap:6px}
.bt-main-nav>button,.bt-observation-nav-item{width:100%;display:flex;align-items:center;gap:10px;justify-content:flex-start;min-height:40px;text-align:left}
.bt-observation-search{margin:8px 0 4px;color:var(--bt-ink-2);font-size:12px}
.bt-observation-search label{display:block;margin:0 0 5px}
.bt-observation-search input{width:100%;height:34px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:0 9px;font:inherit}
.bt-observation-search input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-observation-nav-head{display:flex;justify-content:space-between;gap:8px;margin:8px 2px 2px;color:var(--bt-ink-2);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-nav-item{align-items:flex-start;padding:8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--bt-ink)}
.bt-observation-nav-item:hover,.bt-observation-nav-item:focus-visible,.bt-observation-nav-item[aria-current=page]{border-color:var(--bt-line);background:var(--bt-card)}
.bt-observation-role{flex:none;padding:1px 6px;border:1px solid var(--bt-line);border-radius:999px;color:var(--bt-ink-2);font-size:10px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-nav-copy{min-width:0;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px}
.bt-observation-nav-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bt-observation-nav-copy>span{color:var(--bt-ink-2);font-size:11px}
.bt-observation-empty{margin:8px;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-observation-more{margin-top:8px}
.bt-observation{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-observation-header{min-height:56px;flex-shrink:0;display:flex;align-items:center;gap:12px;padding:8px 24px;border-bottom:.5px solid var(--bt-line-2);box-sizing:border-box}
.bt-observation-heading{min-width:0;flex:1;display:flex;align-items:center;gap:8px}
.bt-observation-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}
.bt-observation-readonly{flex:none;padding:2px 8px;border:1px solid var(--bt-line);border-radius:999px;color:var(--bt-ink-2);font-size:11px}
.bt-observation-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px}
.bt-observation-content{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.bt-observation-summary{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);font-size:14px;line-height:22px}
.bt-observation-summary>div:first-child{min-width:0}
.bt-observation-summary p{margin:0 0 6px;overflow-wrap:anywhere}.bt-observation-summary p:last-child{margin-bottom:0}
.bt-observation-status{font-size:12px;line-height:18px;color:var(--bt-ink-2);font-weight:600}
.bt-observation-actions{flex:none}
.bt-observation-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:0;overflow:hidden;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-line)}
.bt-observation-facts>div{min-width:0;padding:10px 12px;background:var(--bt-card)}
.bt-observation-facts dt{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-observation-facts dd{margin:2px 0 0;overflow-wrap:anywhere;font-size:12px;line-height:18px}
.bt-observation-generations,.bt-observation-history{display:flex;flex-direction:column;gap:8px}
.bt-observation-generations h2,.bt-observation-history h2{margin:0;font-size:13px;line-height:20px}
.bt-observation-generations>div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;padding:8px 10px;border:1px solid var(--bt-line);border-radius:8px;color:var(--bt-ink-2);font-size:11px;overflow-wrap:anywhere}
.bt-observation-generations>div[aria-current=true]{border-color:var(--bt-accent);color:var(--bt-ink)}
.bt-observation-event{padding:10px 12px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-observation-event-head{display:flex;justify-content:space-between;gap:12px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-observation-event-head>span{font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-event p{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px}
@media(max-width:640px){.bt-main-history,.bt-observation-body{padding:16px}.bt-main-header,.bt-observation-header{padding-left:16px;padding-right:16px}.bt-observation-header{align-items:flex-start;flex-wrap:wrap}.bt-observation-heading{order:3;width:100%}.bt-observation-summary{flex-direction:column}.bt-observation-facts{grid-template-columns:1fr}.bt-observation-generations>div{grid-template-columns:1fr}}
`
