import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

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

export function WorkMemberDock({ workers, routing, activeTurn, execute }) {
  return h('div', { className: 'bt-work-members', role: 'group', 'aria-label': t('Work members') },
    h('span', { className: 'bt-work-member', 'data-active': activeTurn?.status === 'running' }, t('Main')),
    h('span', { className: 'bt-work-member', 'data-active': routing }, t('Router')),
    workers.map(({ sessionId, item, state }) => h('div', { className: 'bt-work-member', key: sessionId, 'data-active': true },
      h('span', { title: item?.goal ?? sessionId }, t(state === 'stopping' ? 'Worker stopping' : 'Worker')),
      execute && item ? h(StopWork, { item, execute }) : null)))
}

const details = { blocked: 'Blocked', failed: 'Work failed', rejected: 'Work declined', unknown: 'Work result unknown',
  dropped: 'Delivery failed', stopping: 'Stopping' }

export function WorkBoard({ items, error, execute }) {
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
          return h('article', { key: item.id, className: 'bt-work-board-item' },
            h('h4', null, item.goal), details[item.detail] ? h('p', { role: 'status' }, t(details[item.detail])) : null,
            h('p', null, item.summary),
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
.bt-work-member{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--bt-line);border-radius:var(--bt-radius-pill)}
.bt-work-member[data-active="true"]{color:var(--bt-ink);border-color:var(--bt-accent)}
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
