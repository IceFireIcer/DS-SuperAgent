import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { BotMark } from './mark.js'
import { MAIN_LOOK } from './characters.js'
import { workStatusCopy } from './work-feedback.js'

const groups = [
  ['running', 'Running'],
  ['waiting-delivery', 'Waiting for delivery'],
  ['waiting-human', 'Waiting for a person'],
  ['delivered', 'Delivered'],
  ['stopped', 'Stopped'],
]

function StopWork({ item, execute }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identity = useRef(null)
  const version = `${item.stop?.expectedTicketVersion}:${item.stop?.expectedGeneration}`
  useEffect(() => { setConfirming(false); identity.current = null }, [version])
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  async function stop() {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    setBusy(true)
    setError('')
    identity.current ??= crypto.randomUUID()
    try {
      await execute('work-stop', { workItemId: item.id, ticketId: item.ticketId,
        ...item.stop, commandId: identity.current, reason: 'Stopped by the user from Work.' })
      identity.current = null
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }

  return h('div', { className: 'bt-work-stop' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
      'aria-label': t(confirming ? 'Confirm stop for {goal}' : 'Stop work: {goal}', { goal: item.goal }),
      onKeyDown: event => { if (event.key === 'Escape') setConfirming(false) }, onClick: stop },
    busy ? t('Stopping…') : t(confirming ? 'Confirm stop' : 'Stop work')),
    error ? h('span', { className: 'bt-main-error', role: 'alert' }, error) : null)
}

function MemberState({ role, identity, goal, label, mark, children }) {
  return h('div', { className: 'bt-work-member', 'data-active': mark !== 'idle' },
    h(BotMark, { bot: { id: identity }, look: role === 'Main' ? MAIN_LOOK : undefined, size: 20, state: mark }),
    h('span', null, t(role)), h('span', { 'data-role-status': '', title: goal }, label), children)
}

export function WorkMemberDock({ workers, routing, activeTurn, mainHealth, execute }) {
  const mainStatus = activeTurn?.status
  const mainLabel = mainStatus === 'running' ? 'Replying' : mainStatus === 'stopping' ? 'Stopping…'
    : mainHealth?.state === 'degraded' ? 'Main degraded' : mainHealth?.queuedInputs ? 'Queued' : 'Ready'
  const mainMark = mainStatus === 'running' ? 'thinking' : mainStatus === 'stopping' ? 'waiting'
    : mainHealth?.state === 'degraded' ? 'alert' : mainHealth?.queuedInputs ? 'waiting' : 'idle'
  return h('div', { className: 'bt-work-members', role: 'group', 'aria-label': t('Work members') },
    h(MemberState, { role: 'Main', identity: 'main', mark: mainMark, label: t(mainLabel) }),
    h(MemberState, { role: 'Router', identity: 'router', mark: routing ? 'orbit' : 'idle', label: t(routing ? 'Routing work' : 'Ready') }),
    workers.map(({ sessionId, item, state }) => h(MemberState, { key: sessionId, role: 'Worker', identity: sessionId, goal: item?.goal,
      mark: state === 'waiting' ? 'alert' : state === 'stopping' ? 'waiting' : 'working', label: workStatusCopy(state) },
      execute && item?.stop ? h(StopWork, { item, execute }) : null)))
}

const deliveryDetails = { dropped: 'Delivery failed', unknown: 'Delivery needs reconciliation' }

export function WorkBoard({ items, error, execute, members, renderQuestion }) {
  const [drafts, setDrafts] = useState({})
  const [filter, setFilter] = useState('')
  const requests = useRef(new Map())
  const setDraft = (id, change) => setDrafts(current => ({ ...current, [id]: { ...current[id], ...change } }))

  async function saveNote(item) {
    const text = drafts[item.id]?.text?.trim()
    if (!text || requests.current.get(item.id)?.running) return
    const previous = requests.current.get(item.id)
    const commandId = previous?.text === text ? previous.commandId : crypto.randomUUID()
    requests.current.set(item.id, { text, commandId, running: true })
    setDraft(item.id, { busy: true, error: '', saved: false })
    try {
      await execute('work-follow-up', { commandId, workItemId: item.id, ticketId: item.ticketId, text })
      requests.current.delete(item.id)
      setDraft(item.id, { text: '', open: false, busy: false, saved: true })
    } catch (failure) {
      requests.current.set(item.id, { text, commandId, running: false })
      setDraft(item.id, { busy: false, error: failure.message })
    }
  }

  const sorted = (items ?? []).toSorted((first, second) => second.createdAt - first.createdAt || first.id.localeCompare(second.id))
  return h('div', { className: 'bt-work-board', 'aria-label': t('Work') },
    members,
    h('label', { className: 'bt-field bt-work-filter' }, t('Filter work'),
      h('select', { className: 'bt-select', value: filter, onChange: event => setFilter(event.target.value) },
        h('option', { value: '' }, t('All work')),
        groups.map(([state, label]) => h('option', { value: state, key: state }, t(label))))),
    error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
    !items && !error ? h('p', { role: 'status', className: 'bt-empty' }, t('Loading…')) : null,
    items ? groups.filter(([state]) => !filter || filter === state).map(([state, label]) => {
      const matching = sorted.filter(item => item.state === state)
      return h('section', { className: 'bt-work-group', key: state, 'aria-label': t(label) },
        h('h3', null, `${t(label)} · ${matching.length}`),
        matching.length ? matching.map(item => {
          const draft = drafts[item.id] ?? {}
          const deliveryDetail = item.status === 'success' ? deliveryDetails[item.detail] : undefined
          return h('article', { key: item.id, className: 'bt-work-board-item', 'data-ticket-id': item.ticketId },
            h('h4', null, item.goal), h('p', { role: 'status' }, workStatusCopy(item.status ?? item.detail)),
            deliveryDetail ? h('p', null, t(deliveryDetail)) : null,
            h('p', null, item.summary), renderQuestion?.(item),
            item.notes?.length ? h('ul', null, item.notes.map(note => h('li', { key: note.id }, note.text))) : null,
            execute && item.ticketId && state !== 'stopped' ? h('div', { className: 'bt-work-actions' },
              item.stop ? h(StopWork, { item, execute }) : null,
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': Boolean(draft.open),
                disabled: draft.busy, onClick: () => setDraft(item.id, { open: !draft.open, saved: false }) },
              t(draft.open ? 'Close note' : 'Add note'))) : null,
            draft.open && execute ? h('form', { onSubmit: event => { event.preventDefault(); void saveNote(item) } },
              h('label', { className: 'bt-field' }, t('Work follow-up'),
                h('textarea', { className: 'bt-input', value: draft.text ?? '', maxLength: 32768, disabled: draft.busy,
                  onChange: event => setDraft(item.id, { text: event.target.value }) })),
              h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: draft.busy || !draft.text?.trim() }, t('Send follow-up'))) : null,
            draft.error ? h('p', { role: 'alert', className: 'bt-main-error' }, draft.error) : null,
            draft.saved ? h('p', { role: 'status' }, t('Follow-up saved.')) : null)
        }) : h('p', { className: 'bt-empty' }, t('No work in this group.')))
    }) : null)
}

export const WORK_BOARD_CSS = `
.bt-work-members,.bt-work-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bt-work-members{padding:4px 12px;color:var(--bt-ink-2);font-size:var(--bt-font-small)}
.bt-work-member{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;padding:3px 8px;border:1px solid var(--bt-line);border-radius:var(--bt-radius-pill)}
.bt-work-member[data-active="true"]{color:var(--bt-ink);border-color:var(--bt-accent)}
.bt-work-member [data-role-status]{color:var(--bt-ink-2)}
.bt-work-board-item .bt-q-dock{margin:0;width:100%;max-width:none}
body[data-bt-motion=quiet] .bt-work-member .bt-mark *{animation:none}
.bt-work-board{overflow:auto;padding:16px;display:grid;gap:16px;align-content:start;min-width:0;color:var(--bt-ink)}
.bt-work-filter{max-width:240px}
.bt-work-group{display:grid;gap:8px;min-width:0}
.bt-work-group h3,.bt-work-board-item h4{font-size:var(--bt-font-body);font-weight:600;margin:0}
.bt-work-board-item{display:grid;gap:8px;padding:12px;border:1px solid var(--bt-line);border-radius:var(--bt-radius-card);background:var(--bt-card);overflow-wrap:anywhere}
.bt-work-board-item p,.bt-work-board-item ul{margin:0;font-size:var(--bt-font-small);color:var(--bt-ink-2)}
.bt-work-board-item form{display:grid;gap:8px;justify-items:start}
.bt-work-board-item form label{width:100%}
.bt-work-board-item textarea{min-height:80px;resize:vertical}
.bt-work-board :focus-visible,.bt-work-members :focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`
