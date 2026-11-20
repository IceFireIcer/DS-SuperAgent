import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

export const WORK_BOARD_GROUPS = Object.freeze([
  { id: 'running', label: 'Running', description: 'Work that is active now.' },
  { id: 'waiting-delivery', label: 'Waiting for delivery', description: 'Verified work waiting to reach its destination.' },
  { id: 'waiting-human', label: 'Waiting for a person', description: 'Work that needs an answer or reconciliation.' },
  { id: 'delivered', label: 'Delivered', description: 'Work whose result has been delivered.' },
  { id: 'stopped', label: 'Stopped', description: 'Work that is stopping or stopped.' },
])

const ACTIVE_ASSIGNMENT_STATES = new Set(['running', 'stopping'])
const OPEN_BOARD_COLUMNS = new Set(['running', 'waiting-delivery', 'waiting-human'])
const NEEDS_HUMAN_STATUSES = new Set(['blocked', 'failed', 'rejected', 'unknown', 'waiting'])
const NOTE_LIMIT = 32768

const boardError = (code, message) => Object.assign(new Error(message), { code })
const nonempty = value => typeof value === 'string' && value.trim() ? value.trim() : undefined
const workItemIdOf = work => nonempty(work?.brief?.workItemId) ?? nonempty(work?.control?.workItemId)
const ticketIdOf = work => nonempty(work?.control?.ticketId) ?? nonempty(work?.receipt?.ticketId)
const assignmentOf = work => work?.control?.assignment
const noteTooLong = value => {
  if (typeof value !== 'string') return false
  if (value.length > NOTE_LIMIT) return true
  return typeof TextEncoder === 'function' && new TextEncoder().encode(value).byteLength > NOTE_LIMIT
}
const stopOf = work => {
  const stop = work?.control?.stop
  return stop && stop.resumedAt === undefined && (stop.state === 'stopping' || stop.state === 'stopped') ? stop : undefined
}

export function useStopConfirmation(timeoutMs = 4000) {
  const [confirming, setConfirming] = useState(false)
  const armed = useRef(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => {
      armed.current = false
      setConfirming(false)
    }, timeoutMs)
    return () => clearTimeout(timer)
  }, [confirming, timeoutMs])
  const reset = () => {
    armed.current = false
    setConfirming(false)
  }
  const requestConfirmation = () => {
    if (armed.current) {
      reset()
      return true
    }
    armed.current = true
    setConfirming(true)
    return false
  }
  return { confirming, requestConfirmation, reset }
}

function deliveryFact(work, sources) {
  const ticketId = ticketIdOf(work)
  if (!ticketId) return { kind: 'main', state: 'delivered', receipts: [] }
  const source = (Array.isArray(sources) ? sources : []).find(candidate =>
    (candidate?.ticketIds ?? []).includes(ticketId))
  if (!source) return { kind: 'main', state: 'delivered', receipts: [] }
  const receipts = (source.deliveries ?? []).filter(delivery =>
    delivery?.ticketId === ticketId && (delivery.purpose === 'answer' || delivery.purpose === 'result'))
  const latest = receipts.toSorted((left, right) =>
    (right.sequence ?? 0) - (left.sequence ?? 0) || (right.createdAt ?? 0) - (left.createdAt ?? 0))[0]
  if (latest?.state === 'sent') {
    return { kind: 'source', state: 'delivered', sourceId: source.id, receipts }
  }
  if (latest?.state === 'unknown' || latest?.state === 'dropped') {
    return { kind: 'source', state: 'needs-human', sourceId: source.id, receipts }
  }
  return { kind: 'source', state: 'pending', sourceId: source.id, receipts }
}

export function classifyProductWork(work, { sources = [] } = {}) {
  const status = work?.status ?? work?.outcome?.status
  if (status === 'stopped' || stopOf(work)
    || assignmentOf(work)?.state === 'stopping') return 'stopped'
  if (NEEDS_HUMAN_STATUSES.has(status) || work?.control?.attention?.status === 'waiting') return 'waiting-human'
  if (status === 'success') {
    const delivery = deliveryFact(work, sources)
    if (delivery.state === 'delivered') return 'delivered'
    if (delivery.state === 'pending') return 'waiting-delivery'
    return 'waiting-human'
  }
  return 'running'
}

function workSummary(work) {
  return nonempty(work?.update?.summary)
    ?? nonempty(work?.outcome?.summary)
    ?? nonempty(work?.control?.attention?.question)
    ?? nonempty(work?.receipt?.reason)
    ?? nonempty(work?.receipt?.nextStep)
    ?? nonempty(work?.brief?.goal)
    ?? t('No work detail is available.')
}

function boardItem(work, sources) {
  const column = classifyProductWork(work, { sources })
  const control = work?.control
  const assignment = assignmentOf(work)
  const attention = control?.attention
  const ticketId = ticketIdOf(work)
  const accepted = work?.receipt?.status === 'accepted' && Boolean(ticketId)
  const workerSessionId = column === 'waiting-human' && attention?.status === 'waiting'
    ? nonempty(attention.sessionId) ?? nonempty(assignment?.sessionId)
    : ACTIVE_ASSIGNMENT_STATES.has(assignment?.state) ? nonempty(assignment.sessionId) : undefined
  return {
    id: workItemIdOf(work) ?? nonempty(work?.brief?.id) ?? `work-${ticketId ?? 'unknown'}`,
    work,
    workItemId: workItemIdOf(work),
    ticketId,
    goal: nonempty(work?.brief?.goal) ?? t('Untitled work'),
    column,
    status: work?.status,
    summary: workSummary(work),
    assignment,
    workerSessionId,
    ticketVersion: control?.ticketVersion,
    canStop: control?.permissions?.canStop === true && column !== 'stopped',
    canNote: accepted && OPEN_BOARD_COLUMNS.has(column),
    delivery: deliveryFact(work, sources),
    stop: stopOf(work),
    createdAt: work?.brief?.createdAt ?? 0,
  }
}

function observationFor(observations, sessionId) {
  if (!sessionId) return undefined
  return (Array.isArray(observations) ? observations : [])
    .filter(observation => observation?.role === 'worker' && observation.current === true
      && observation.sessionId === sessionId)
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0))[0]
}

function memberStateLabel(state) {
  return ({ ready: 'Ready', running: 'Running', routing: 'Routing', stopping: 'Stopping',
    waiting: 'Waiting for a person', blocked: 'Blocked', unknown: 'Needs reconciliation' })[state]
    ?? nonempty(state) ?? t('Ready')
}

export function projectProductMembers({ binding, works = [], observations = [], activeTurn, items = [] } = {}) {
  const safeWorks = Array.isArray(works) ? works : []
  const routing = safeWorks.some(work => work?.receipt?.status === 'routing')
    || (Array.isArray(observations) && observations.some(observation =>
      observation?.role === 'router' && observation?.current === true
        && ['running', 'routing'].includes(observation?.status)))
  const mainState = activeTurn?.status === 'stopping' ? 'stopping'
    : activeTurn?.status === 'running' ? 'running' : 'ready'
  const members = [{
    id: 'main',
    role: 'main',
    name: 'Main',
    sessionId: nonempty(binding?.mainSessionId),
    state: mainState,
    detail: mainState === 'running' ? t('Handling the current Main request.')
      : mainState === 'stopping' ? t('Stopping this Main reply…') : t('Ready for the next request.'),
  }, {
    id: 'router',
    role: 'router',
    name: 'Router',
    sessionId: nonempty(binding?.routerSessionId),
    state: routing ? 'routing' : 'ready',
    detail: routing ? t('Routing accepted work into Tickets.') : t('Ready to route accepted work.'),
  }]
  const workers = new Map()
  const addWorker = (sessionId, state, work) => {
    if (!sessionId) return
    if (!workers.has(sessionId)) workers.set(sessionId, { sessionId, works: [], states: new Set() })
    const worker = workers.get(sessionId)
    if (work && !worker.works.includes(work)) worker.works.push(work)
    worker.states.add(state)
  }
  for (const work of safeWorks) {
    const column = classifyProductWork(work)
    const assignment = assignmentOf(work)
    const attention = work?.control?.attention
    if (column === 'waiting-human' && attention?.status === 'waiting') {
      addWorker(nonempty(attention.sessionId) ?? nonempty(assignment?.sessionId), 'waiting', work)
    } else if (ACTIVE_ASSIGNMENT_STATES.has(assignment?.state)) {
      addWorker(nonempty(assignment.sessionId),
        column === 'stopped' || assignment.state === 'stopping' ? 'stopping' : 'running', work)
    }
  }
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.role !== 'worker' || observation.current !== true
      || !['running', 'waiting'].includes(observation.status) || !nonempty(observation.sessionId)) continue
    const matchingWork = safeWorks.find(work =>
      observation.workItemId && workItemIdOf(work) === observation.workItemId
      || observation.ticketId && ticketIdOf(work) === observation.ticketId)
    if (matchingWork) {
      const assignment = assignmentOf(matchingWork)
      const attention = matchingWork.control?.attention
      const currentSession = classifyProductWork(matchingWork) === 'waiting-human' && attention?.status === 'waiting'
        ? nonempty(attention.sessionId) ?? nonempty(assignment?.sessionId)
        : ACTIVE_ASSIGNMENT_STATES.has(assignment?.state) ? nonempty(assignment.sessionId) : undefined
      if (currentSession !== observation.sessionId) continue
    }
    addWorker(observation.sessionId, observation.status === 'waiting' ? 'waiting' : 'running', matchingWork)
  }
  for (const worker of workers.values()) {
    const observation = observationFor(observations, worker.sessionId)
    const workerItems = items.filter(item => item.workerSessionId === worker.sessionId)
    const primary = workerItems[0]
    const state = worker.states.has('stopping') ? 'stopping'
      : worker.states.has('running') ? 'running' : 'waiting'
    members.push({
      id: `worker:${worker.sessionId}`,
      role: 'worker',
      name: 'Worker',
      sessionId: worker.sessionId,
      state,
      detail: nonempty(observation?.summary) ?? primary?.summary,
      goal: primary?.goal ?? nonempty(observation?.title),
      workItemIds: workerItems.map(item => item.id),
      items: workerItems,
      canStop: workerItems.some(item => item.canStop),
    })
  }
  return members
}

export function projectProductBoard({ binding, works = [], observations = [], sources = [], activeTurn } = {}) {
  const safeWorks = Array.isArray(works) ? works : []
  const safeObservations = Array.isArray(observations) ? observations : []
  const safeSources = Array.isArray(sources) ? sources : []
  const items = safeWorks.map(work => boardItem(work, safeSources))
  const members = projectProductMembers({ binding, works: safeWorks, observations: safeObservations, activeTurn, items })
  const groups = WORK_BOARD_GROUPS.map(group => ({
    ...group,
    items: items.filter(item => item.column === group.id),
  }))
  const counts = Object.fromEntries(groups.map(group => [group.id, group.items.length]))
  return {
    members,
    workerCount: members.filter(member => member.role === 'worker').length,
    items,
    groups,
    counts: { total: items.length, ...counts },
  }
}

const commandId = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

function targetWork(target) {
  return target?.work ?? target
}

function noteTarget(target) {
  const work = targetWork(target)
  return {
    work,
    workItemId: nonempty(target?.workItemId) ?? workItemIdOf(work),
    ticketId: nonempty(target?.ticketId) ?? ticketIdOf(work),
  }
}

export function createProductFollowUp({ binding, productCall, makeCommandId = commandId } = {}) {
  return async (work, text) => {
    if (!nonempty(binding?.instanceId) || typeof productCall !== 'function') {
      throw boardError('BOARD_FOLLOW_UP_UNAVAILABLE', t('User follow-up is unavailable. The note was not sent.'))
    }
    const workTarget = noteTarget(work)
    if (!workTarget.workItemId || !workTarget.ticketId) {
      throw boardError('BOARD_FOLLOW_UP_TARGET_UNAVAILABLE', t('This work has no accepted Ticket for a user follow-up.'))
    }
    if (typeof text !== 'string' || !text.trim()) throw boardError('BOARD_NOTE_EMPTY', t('Write a follow-up note first.'))
    if (noteTooLong(text)) throw boardError('BOARD_NOTE_TOO_LONG', t('The follow-up note is too long.'))
    return productCall('send', {
      instanceId: binding.instanceId,
      commandId: makeCommandId(),
      text,
      followUp: { workItemId: workTarget.workItemId, ticketId: workTarget.ticketId },
    })
  }
}

export function createProductBoardActions({ binding, productCall, refresh, followUp, makeCommandId = commandId,
  stopReason = 'Stopped from the Work view.' } = {}) {
  const refreshBoard = async onRefreshStatus => {
    if (typeof refresh !== 'function') {
      onRefreshStatus?.('unavailable', boardError('BOARD_REFRESH_UNAVAILABLE', t('Work state refresh is unavailable.')))
      return
    }
    onRefreshStatus?.('refreshing')
    try {
      await refresh()
      onRefreshStatus?.('refreshed')
    } catch (error) {
      onRefreshStatus?.('failed', error)
    }
  }
  return {
    async stopWork(target, options = {}) {
      const work = targetWork(target)
      const control = work?.control
      const stopOptions = typeof options === 'string' ? { reason: options } : options ?? {}
      const workItemId = nonempty(target?.workItemId) ?? workItemIdOf(work)
      const ticketId = nonempty(target?.ticketId) ?? ticketIdOf(work)
      if (typeof productCall !== 'function' || !nonempty(binding?.instanceId)
        || !workItemId || !ticketId || control?.ticketVersion === undefined) {
        throw boardError('BOARD_STOP_UNAVAILABLE', t('Work stop is unavailable. The work was not stopped.'))
      }
      if (control?.permissions?.canStop !== true) {
        throw boardError('BOARD_STOP_NOT_ALLOWED', t('This work cannot be stopped.'))
      }
      const assignment = control.assignment
      const payload = {
        instanceId: binding.instanceId,
        commandId: makeCommandId(),
        workItemId,
        ticketId,
        expectedTicketVersion: control.ticketVersion,
        reason: nonempty(stopOptions.reason) ?? stopReason,
        ...(assignment?.generation ? { expectedGeneration: assignment.generation } : {}),
      }
      try {
        const result = await productCall('work-stop', payload)
        await refreshBoard(stopOptions.onRefreshStatus)
        return result
      } catch (error) {
        await refreshBoard(stopOptions.onRefreshStatus)
        throw error
      }
    },
    async addNote(target, text, options = {}) {
      if (typeof followUp !== 'function') {
        throw boardError('BOARD_FOLLOW_UP_UNAVAILABLE', t('User follow-up is unavailable. The note was not sent.'))
      }
      if (typeof text !== 'string' || !text.trim()) throw boardError('BOARD_NOTE_EMPTY', t('Write a follow-up note first.'))
      if (noteTooLong(text)) throw boardError('BOARD_NOTE_TOO_LONG', t('The follow-up note is too long.'))
      try {
        const result = await followUp(target, text)
        await refreshBoard(options?.onRefreshStatus)
        return result
      } catch (error) {
        await refreshBoard(options?.onRefreshStatus)
        throw error
      }
    },
  }
}

export function createProductBoardController({ binding, works = [], observations = [], sources = [], activeTurn,
  productCall, refresh, followUp, makeCommandId, stopReason } = {}) {
  const actions = createProductBoardActions({ binding, productCall, refresh, followUp, makeCommandId, stopReason })
  const project = (next = {}) => projectProductBoard({
    binding: next.binding ?? binding,
    works: next.works ?? works,
    observations: next.observations ?? observations,
    sources: next.sources ?? sources,
    activeTurn: next.activeTurn ?? activeTurn,
  })
  return {
    board: project(),
    project,
    stopWork: actions.stopWork,
    addNote: actions.addNote,
  }
}

function StopControl({ item, actions, compact = false }) {
  const { confirming, requestConfirmation } = useStopConfirmation()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [refreshError, setRefreshError] = useState(null)
  const click = async () => {
    setError(null)
    setRefreshError(null)
    if (typeof actions?.stopWork !== 'function') {
      setError(t('Work stop is unavailable. The work was not stopped.'))
      return
    }
    if (!requestConfirmation()) return
    setBusy('stopping')
    try {
      await actions.stopWork(item, { onRefreshStatus: (status, problem) => {
        if (status === 'refreshing') setBusy('refreshing')
        if (status === 'failed') setRefreshError(problem?.message ?? t('The board refresh failed.'))
        if (status === 'unavailable') setRefreshError(problem?.message ?? t('Work state refresh is unavailable.'))
      } })
    } catch (problem) {
      setError(problem?.message ?? String(problem))
    } finally {
      setBusy(null)
    }
  }
  return h('div', { className: compact ? 'bt-product-board-stop-wrap is-compact' : 'bt-product-board-stop-wrap' },
    h('button', {
      type: 'button',
      className: 'bt-soft bt-product-board-stop',
      'data-confirm': confirming || undefined,
      'aria-label': confirming ? t('Confirm stop for {goal}', { goal: item.goal })
        : t('Stop work: {goal}', { goal: item.goal }),
      disabled: busy !== null,
      onClick: () => void click(),
    }, busy === 'refreshing' ? t('Refreshing work state…')
      : busy ? t('Stopping…') : confirming ? t('Confirm stop') : t('Stop work')),
    error ? h('p', { className: 'bt-product-board-error', role: 'alert' }, error) : null,
    refreshError ? h('p', { className: 'bt-product-board-error', role: 'status' },
      t('Work state could not be refreshed. The next poll will retry: {reason}', { reason: refreshError })) : null)
}

const EMPTY_NOTE_STATE = Object.freeze({
  open: false,
  draft: '',
  busy: null,
  error: null,
  refreshError: null,
  sent: false,
})

function NoteControl({ item, actions, noteState = EMPTY_NOTE_STATE, updateNote = () => {} }) {
  const id = `bt-board-note-${item.id.replace(/[^\w-]/gu, '-')}`
  const update = patch => updateNote(item.id, patch)
  const toggle = () => {
    if (typeof actions?.addNote !== 'function') {
      update({ error: t('User follow-up is unavailable. The note was not sent.'), sent: false })
      return
    }
    update(current => ({ ...current, open: !current.open, error: null, refreshError: null, sent: false }))
  }
  const submit = async event => {
    event.preventDefault()
    if (noteState.busy !== null) return
    const text = noteState.draft
    if (!text.trim()) {
      update({ error: t('Write a follow-up note first.') })
      return
    }
    if (noteTooLong(text)) {
      update({ error: t('The follow-up note is too long.') })
      return
    }
    update({ busy: 'sending', error: null, refreshError: null, sent: false })
    try {
      await actions.addNote(item, text, { onRefreshStatus: (status, problem) => {
        if (status === 'refreshing') update({ busy: 'refreshing' })
        if (status === 'failed') update({ refreshError: problem?.message ?? t('The board refresh failed.') })
        if (status === 'unavailable') update({ refreshError: problem?.message ?? t('Work state refresh is unavailable.') })
      } })
      update({ draft: '', open: false, sent: true })
    } catch (problem) {
      update({ error: problem?.message ?? String(problem) })
    } finally {
      update({ busy: null })
    }
  }
  return h('div', { className: 'bt-product-board-note' },
    h('button', { type: 'button', className: 'bt-soft bt-product-board-note-open',
      'aria-expanded': noteState.open, onClick: toggle }, noteState.open ? t('Close note') : t('Add note')),
    noteState.open ? h('form', { className: 'bt-product-board-note-form', onSubmit: event => void submit(event) },
      h('label', { htmlFor: id }, t('User follow-up for this work')),
      h('textarea', {
        id,
        rows: 2,
        maxLength: NOTE_LIMIT,
        placeholder: t('What should change?'),
        value: noteState.draft,
        disabled: noteState.busy !== null,
        onInput: event => update({ draft: event.currentTarget.value }),
      }),
      h('button', { type: 'submit', className: 'bt-soft', disabled: noteState.busy !== null },
        noteState.busy === 'refreshing' ? t('Refreshing work state…')
          : noteState.busy ? t('Sending…') : t('Send follow-up'))) : null,
    noteState.error ? h('p', { className: 'bt-product-board-error', role: 'alert' }, noteState.error) : null,
    noteState.refreshError ? h('p', { className: 'bt-product-board-error', role: 'status' },
      t('Work state could not be refreshed. The next poll will retry: {reason}', { reason: noteState.refreshError })) : null,
    noteState.sent ? h('p', { className: 'bt-product-board-success', role: 'status' }, t('Follow-up saved in Main.')) : null)
}

function BoardWorkCard({ item, group, actions, readOnly, noteState, updateNote }) {
  return h('article', {
    className: 'bt-product-board-item',
    'data-work-item-id': item.id,
    'data-ticket-id': item.ticketId,
    'data-board-group': item.column,
    'aria-label': t('Work item: {goal}', { goal: item.goal }),
  },
  h('div', { className: 'bt-product-board-item-head' },
    h('div', { className: 'bt-product-board-item-title' },
      h('strong', null, item.goal),
      h('span', { className: 'bt-product-board-status' }, t(group.label))),
    item.workerSessionId ? h('span', { className: 'bt-product-board-session', title: item.workerSessionId },
      t('Worker · {session}', { session: item.workerSessionId.slice(-8) })) : null),
  h('p', { className: 'bt-product-board-summary' }, item.summary),
  item.ticketId ? h('p', { className: 'bt-product-board-meta' },
    `Ticket ${item.ticketId}${item.assignment?.generation ? ` · ${t('Execution version')} ${item.assignment.generation}` : ''}`) : null,
  item.delivery?.kind === 'source' ? h('p', { className: 'bt-product-board-meta' },
    `${t('Delivery')}: ${t(item.delivery.state === 'delivered' ? 'Delivered'
      : item.delivery.state === 'pending' ? 'Pending delivery' : 'Needs reconciliation')}`) : null,
  h('div', { className: 'bt-product-board-actions' },
    !readOnly && item.canNote ? h(NoteControl, { item, actions, noteState, updateNote }) : null,
    !readOnly && item.canStop ? h(StopControl, { item, actions }) : null))
}

export function ProductWorkBoard({ board, actions, title = t('Work'), readOnly = false }) {
  const [filter, setFilter] = useState('all')
  const [noteStates, setNoteStates] = useState({})
  const updateNote = (id, patch) => setNoteStates(current => {
    const previous = current[id] ?? EMPTY_NOTE_STATE
    const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }
    return next === previous ? current : { ...current, [id]: next }
  })
  if (!board) return h('section', { className: 'bt-product-board', role: 'status' }, t('The Work board is unavailable.'))
  const groups = filter === 'all' ? board.groups : board.groups.filter(group => group.id === filter)
  return h('section', { className: 'bt-product-board', 'aria-label': t('Work board') },
    h('header', { className: 'bt-product-board-head' },
      h('div', null, h('h2', null, title),
        h('p', null, t('{count} work items across every active and completed request.', { count: board.counts.total })))),
    h('nav', { className: 'bt-product-board-filter', 'aria-label': t('Filter work by status') },
      h('button', { type: 'button', className: 'bt-soft', 'aria-pressed': filter === 'all',
        onClick: () => setFilter('all') }, `${t('All work')} ${board.counts.total}`),
      board.groups.map(group => h('button', {
        key: group.id,
        type: 'button',
        className: 'bt-soft',
        'aria-pressed': filter === group.id,
        'data-filter-group': group.id,
        onClick: () => setFilter(group.id),
      }, `${t(group.label)} ${board.counts[group.id]}`))),
    h('div', { className: 'bt-product-board-groups' }, groups.map(group => h('section', {
      key: group.id,
      className: 'bt-product-board-group',
      'data-board-group': group.id,
      'aria-label': t(group.label),
    },
    h('header', null, h('div', null, h('h3', null, t(group.label)),
      h('p', null, t(group.description))), h('span', null, group.items.length)),
    group.items.length
      ? h('div', { className: 'bt-product-board-items' }, group.items.map(item =>
        h(BoardWorkCard, { key: item.id, item, group, actions, readOnly,
          noteState: noteStates[item.id] ?? EMPTY_NOTE_STATE, updateNote })))
      : h('p', { className: 'bt-product-board-empty' }, t('No work in this group.'))))))
}

export function ProductMemberDock({ board, actions, title = t('Members'), readOnly = false }) {
  if (!board) return h('section', { className: 'bt-product-member-dock', role: 'status' },
    t('Member status is unavailable.'))
  return h('section', { className: 'bt-product-member-dock', 'aria-label': t('Member status') },
    h('header', { className: 'bt-product-member-dock-head' },
      h('h2', null, title),
      h('span', null, t('{count} members', { count: board.members.length }))),
    h('div', { className: 'bt-product-member-list' }, board.members.map(member => h('div', {
      key: member.id,
      className: 'bt-product-member',
      'data-member-role': member.role,
      'data-member-session': member.sessionId,
    },
    h('span', { className: 'bt-product-member-role' }, t(member.name)),
    h('span', { className: 'bt-product-member-state', 'data-state': member.state },
      t(memberStateLabel(member.state))),
    h('span', { className: 'bt-product-member-detail' }, member.goal ?? member.detail ?? ''),
    !readOnly && member.items?.filter(item => item.canStop).map(item =>
      h(StopControl, { key: item.id, item, actions, compact: true }))))))
}

export const PRODUCT_BOARD_CSS = `
.bt-product-member-dock{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-product-member-dock-head,.bt-product-board-head,.bt-product-board-group>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bt-product-member-dock-head h2,.bt-product-board-head h2,.bt-product-board-group h3{margin:0;font-size:14px;line-height:20px}
.bt-product-member-dock-head span,.bt-product-board-group>header>span{color:var(--bt-ink-3);font-size:12px;font-variant-numeric:tabular-nums}
.bt-product-member-list{display:flex;flex-wrap:wrap;gap:6px}
.bt-product-member{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:6px;min-width:0;padding:5px 8px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-main)}
.bt-product-member-role{font-size:12px;font-weight:600}.bt-product-member-state{padding:1px 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;line-height:16px}
.bt-product-member-state[data-state=running],.bt-product-member-state[data-state=routing]{color:var(--bt-green)}.bt-product-member-state[data-state=stopping],.bt-product-member-state[data-state=blocked],.bt-product-member-state[data-state=unknown]{color:var(--bt-danger)}
.bt-product-member-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:12px}
.bt-product-board{display:flex;flex-direction:column;gap:14px;padding:20px;color:var(--bt-ink);font-family:var(--bt-font)}
.bt-product-board-head p,.bt-product-board-group>header p{margin:2px 0 0;color:var(--bt-ink-3);font-size:12px;line-height:18px}
.bt-product-board-filter{display:flex;flex-wrap:wrap;gap:6px}
.bt-product-board-filter button[aria-pressed=true]{border-color:var(--bt-accent);background:var(--bt-hover);color:var(--bt-ink)}
.bt-product-board-groups{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:12px;align-items:start;overflow:auto;padding-bottom:4px}
.bt-product-board-group{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-main)}
.bt-product-board-group>header{align-items:center;padding-bottom:6px;border-bottom:1px solid var(--bt-line)}
.bt-product-board-items{display:flex;flex-direction:column;gap:8px}
.bt-product-board-item{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-product-board-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.bt-product-board-item-title{min-width:0;display:flex;flex-direction:column;gap:4px}
.bt-product-board-item-title strong{overflow-wrap:anywhere;font-size:13px;line-height:18px}
.bt-product-board-status,.bt-product-board-session{flex:none;padding:1px 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;line-height:16px}
.bt-product-board-session{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-product-board-summary{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.bt-product-board-meta{margin:0;color:var(--bt-ink-3);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.bt-product-board-empty{margin:0;padding:6px 2px;color:var(--bt-ink-3);font-size:12px;line-height:18px}
.bt-product-board-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px}
.bt-product-board-note,.bt-product-board-stop-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-product-board-note-form{display:flex;flex-direction:column;gap:5px;width:100%}
.bt-product-board-note-form label{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-product-board-note-form textarea{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-main);color:var(--bt-ink);padding:6px;font:12px/17px var(--bt-font)}
.bt-product-board-note-form textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-product-board button:focus-visible,.bt-product-board input:focus-visible,.bt-product-board textarea:focus-visible,.bt-product-member-dock button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-product-board-stop[data-confirm]{color:var(--bt-danger)}
.bt-product-board-stop-wrap.is-compact .bt-product-board-stop{min-height:28px;padding:2px 8px;font-size:11px}
.bt-product-board-error{margin:0;color:var(--bt-danger);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.bt-product-board-success{margin:0;color:var(--bt-green);font-size:11px;line-height:16px}
@media(max-width:1100px){.bt-product-board-groups{grid-template-columns:repeat(2,minmax(210px,1fr))}}
@media(max-width:640px){.bt-product-board{padding:14px}.bt-product-board-groups{grid-template-columns:1fr}.bt-product-member{grid-template-columns:auto auto;border-radius:8px}.bt-product-member-detail{grid-column:1/-1}.bt-product-member-dock-head,.bt-product-board-head{flex-direction:column}}
`
