import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { ClockIcon, PlusIcon, TrashIcon } from './icons.js'
import { Segmented } from './motion.js'
import { SwitchRow } from './product-card.js'
import { EmptyState, FieldRow, InlineNotice, SectionCard, StatusChip } from './product-settings-components.js'
import { dateLocale, t } from './i18n.js'

const pad = value => String(value).padStart(2, '0')
const nextHour = () => {
  const date = new Date(Date.now() + 3_600_000)
  date.setMinutes(0, 0, 0)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const kinds = [['at', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['every', 'Repeat']]
const clock = value => String(value ?? '').slice(0, 5)
const formatDate = (ms, options) => new Intl.DateTimeFormat(dateLocale(), options).format(ms)
const dayAndTime = (ms) => {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear()
  return formatDate(ms, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' })
}
const weekdayNames = days => days.map(day => formatDate(Date.UTC(2024, 0, day), {
  weekday: 'short', timeZone: 'UTC',
})).join(dateLocale().startsWith('zh') ? '、' : ', ')
const everyText = (seconds) => {
  if (seconds % 86400 === 0) return seconds === 86400 ? t('Every day') : t('Every {count} days', { count: seconds / 86400 })
  if (seconds % 3600 === 0) return seconds === 3600 ? t('Every hour') : t('Every {count} hours', { count: seconds / 3600 })
  return t('Every {count} minutes', { count: Math.round(seconds / 60) })
}

function timingText(task) {
  const zone = task.timeZone && task.timeZone !== localZone() ? ` (${task.timeZone})` : ''
  if (task.kind === 'after' || task.kind === 'at') return t('Once, {time}', { time: dayAndTime(Date.parse(task.scheduledAt)) })
  if (task.kind === 'every') return everyText(task.everySeconds)
  if (task.kind === 'daily') return `${t('Every day at {time}', { time: clock(task.time) })}${zone}`
  if (task.kind === 'weekly') {
    const days = (task.weekdays ?? []).join()
    const text = days === '1,2,3,4,5' ? t('Every weekday at {time}', { time: clock(task.time) })
      : days === '6,7' ? t('Every weekend at {time}', { time: clock(task.time) })
        : days === '1,2,3,4,5,6,7' ? t('Every day at {time}', { time: clock(task.time) })
          : t('Every {days} at {time}', { days: weekdayNames(task.weekdays ?? []), time: clock(task.time) })
    return `${text}${zone}`
  }
  if (task.kind === 'cron') return `${t('On the schedule {expression}', { expression: task.expression })}${zone}`
  return ''
}

function whenText(rule) {
  const when = rule.when
  return timingText({ kind: when.kind, scheduledAt: new Date(when.at ?? rule.nextAt ?? rule.createdAt).toISOString(),
    everySeconds: when.minutes * 60, time: when.time, timeZone: rule.timezone, weekdays: when.weekdays })
}

function occurrenceText(occurrence) {
  const state = { delegated: 'Delegated to Main', accepted: 'Accepted by work', pending: 'Pending delivery',
    blocked: 'Blocked', cancelled: 'Cancelled', missed: 'Missed', failed: 'Delivery failed' }[occurrence.status] ?? occurrence.status
  const reason = { SCHEDULE_CANCELLED: 'This task was cancelled.', SCHEDULE_SOURCE_CLOSED: 'The schedule source is paused. Resume it to continue.',
    TICKET_STOPPED: 'This work is stopped. Resume it before scheduling more work.',
    SOURCE_NOT_AUTHORIZED: 'This schedule no longer has access to the work.',
    SOURCE_NOT_CURRENT: 'The source request is no longer current.' }[occurrence.reason] ?? 'This scheduled delivery could not complete. Check the work status.'
  return `${new Date(occurrence.dueAt).toLocaleString()} · ${t(state)}${occurrence.reason ? ` · ${t(reason)}` : ''}`
}
function executionText(status) {
  const label = { stopped: 'Stopped work', 'waiting-human': 'Waiting for an answer', success: 'Work complete',
    failed: 'Work failed', unknown: 'Work result unknown', 'worker-idle': 'Work failed',
    'ready-report': 'Work complete', 'environment-waiting': 'Blocked work' }[status] ?? 'Running work'
  return t(label)
}

function occurrenceHistory(occurrences, visibleOccurrences, loadEarlier, onViewWork) {
  if (!occurrences.length) return h('p', { className: 'bt-set-hint' }, t('No occurrences yet.'))
  const rows = visibleOccurrences.map(occurrence => {
    const tickets = occurrence.ticketIds?.map(ticketId => h('p', { key: ticketId, className: 'bt-set-hint' }, t('Ticket {id}', { id: ticketId })))
    const workButtons = occurrence.ticketIds?.length
      ? occurrence.ticketIds.map(ticketId => h('button', { key: `view:${ticketId}`, type: 'button',
        className: 'bt-soft bt-soft-sm', 'aria-label': t('View work for Ticket {id}', { id: ticketId }),
        onClick: () => onViewWork?.({ workBriefId: occurrence.workBriefId, ticketIds: [ticketId] }) }, t('View work')))
      : occurrence.workBriefId ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
        'aria-label': t('View work brief {id}', { id: occurrence.workBriefId }),
        onClick: () => onViewWork?.({ workBriefId: occurrence.workBriefId, ticketIds: [] }) }, t('View work')) : null
    return h('div', { key: occurrence.dueAt, className: 'bt-product-schedule-occurrence' },
      h('p', { className: 'bt-task-prompt' }, occurrenceText(occurrence)),
      occurrence.executionStatus ? h('p', { className: 'bt-task-prompt', role: 'status' }, executionText(occurrence.executionStatus)) : null,
      occurrence.workBriefId ? h('p', { className: 'bt-set-hint' }, t('Work brief {id}', { id: occurrence.workBriefId })) : null,
      tickets, workButtons)
  })
  const loadEarlierButton = occurrences.length > visibleOccurrences.length
    ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: loadEarlier }, t('Load earlier occurrences')) : null
  return h('details', { className: 'bt-product-schedule-history' },
    h('summary', null, t('Occurrence history ({count})', { count: occurrences.length })),
    h('div', { className: 'bt-product-schedule-history-list' }, rows), loadEarlierButton)
}

export function ProductScheduleSettings({ binding, works, call, onViewWork }) {
  const [rules, setRules] = useState(null)
  const [sourceEnabled, setSourceEnabled] = useState(true)
  const [details, setDetails] = useState({})
  const [historyCounts, setHistoryCounts] = useState({})
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [kind, setKind] = useState('daily')
  const [at, setAt] = useState(nextHour)
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5])
  const [minutes, setMinutes] = useState(60)
  const [targetId, setTargetId] = useState('main')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const [error, setError] = useState('')
  const pending = useRef(null)
  const available = works.filter(work => work.receipt?.status === 'accepted' && work.control?.ticketId)
  const refresh = async () => {
    try {
      const [list, source] = await Promise.all([
        call('schedule-list', { instanceId: binding.instanceId }), call('schedule-source-read', { instanceId: binding.instanceId }),
      ])
      const rows = await Promise.all(list.items.map(async rule => {
        try { return [rule.ruleId, await call('schedule-read', { instanceId: binding.instanceId, ruleId: rule.ruleId })] }
        catch { return [rule.ruleId, null] }
      }))
      setRules(list.items)
      setSourceEnabled(source.enabled)
      setDetails(Object.fromEntries(rows))
      setError('')
    } catch (failure) { setError(failure.message) }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15_000)
    return () => clearInterval(timer)
  }, [binding.instanceId])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(null), 3_000)
    return () => clearTimeout(timer)
  }, [confirming])

  const submit = async event => {
    event.preventDefault()
    if (busy) return
    const work = available.find(item => item.brief.workItemId === targetId)
    const target = targetId === 'main' ? { kind: 'main' } : work
      ? { kind: 'work', workItemId: work.brief.workItemId, ticketId: work.control.ticketId } : null
    const when = kind === 'at' ? { kind, at: new Date(at).getTime() }
      : kind === 'every' ? { kind, minutes: Number(minutes) }
        : kind === 'weekly' ? { kind, time, weekdays } : { kind, time }
    if (!target || kind === 'at' && (!Number.isFinite(when.at) || when.at <= Date.now())) {
      setError(t(kind === 'at' ? 'Pick a time in the future' : 'Choose an authorized work item.'))
      return
    }
    const request = { instanceId: binding.instanceId, title, text, timezone: localZone(), when, target }
    const fingerprint = JSON.stringify(request)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, commandId: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      await call('schedule-create', { ...request, commandId: pending.current.commandId })
      pending.current = null
      setAdding(false); setTitle(''); setText('')
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const cancel = async ruleId => {
    if (confirming !== ruleId) { setConfirming(ruleId); return }
    setBusy(true); setError('')
    try {
      await call('schedule-cancel', { instanceId: binding.instanceId, commandId: `cancel:${ruleId}`, ruleId })
      setConfirming(null)
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const setSource = async enabled => {
    setBusy(true); setError('')
    try {
      await call('schedule-source-set', { instanceId: binding.instanceId, commandId: crypto.randomUUID(), enabled })
      setSourceEnabled(enabled)
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }

  return h('section', { className: 'bt-ps-content bt-product-schedules', 'aria-label': t('Scheduled tasks') },
    h(SectionCard, null, h(SwitchRow, { label: t('Schedule source'),
      hint: sourceEnabled ? null : t('Scheduled tasks are paused; existing work continues.'),
      on: sourceEnabled, disabled: busy, onChange: value => { void setSource(value) } })),
    h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon',
      onClick: () => setAdding(value => !value) }, h(PlusIcon), t('New task'))),
    adding ? h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
      h(FieldRow, { label: t('Send to'), control: h('select', { className: 'bt-select bt-task-bot', value: targetId,
        'aria-label': t('Send to'), onChange: event => setTargetId(event.target.value) },
      h('option', { value: 'main' }, 'Main'), available.map(work => h('option', { key: work.brief.workItemId, value: work.brief.workItemId }, work.brief.goal))) }),
      h(FieldRow, { label: t('Name'), control: h('input', { className: 'bt-bs-input', value: title, maxLength: 120,
        required: true, onChange: event => setTitle(event.target.value) }) }),
      h(FieldRow, { label: t('What to do'), layout: 'stack', control: h('textarea', { className: 'bt-bs-input bt-bs-area', value: text,
        maxLength: 32768, required: true, rows: 3, onChange: event => setText(event.target.value) }) }),
      h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' }, h('span', { className: 'bt-set-copy' }, t('When')),
        h(Segmented, { label: t('When'), value: kind }, kinds.map(([value, label]) => h('button', {
          key: value, type: 'button', 'aria-pressed': kind === value, onClick: () => setKind(value),
        }, t(label)))),
        h('div', { className: 'bt-task-when' },
          kind === 'at' ? h('input', { type: 'datetime-local', className: 'bt-input', value: at,
            'aria-label': t('Date and time'), onChange: event => setAt(event.target.value) }) : null,
          kind === 'daily' || kind === 'weekly' ? h('input', { type: 'time', className: 'bt-input bt-task-time', value: time,
            'aria-label': t('Time'), onChange: event => setTime(event.target.value) }) : null,
          kind === 'every' ? h(Fragment, null, h('span', null, t('Every')),
            h('input', { type: 'number', className: 'bt-input bt-task-count', value: minutes, min: 1, max: 525600,
              'aria-label': t('Minutes'), onChange: event => setMinutes(event.target.value) }), t('minutes')) : null,
          kind === 'weekly' ? h('div', { className: 'bt-task-days', role: 'group', 'aria-label': t('Days') },
            [1, 2, 3, 4, 5, 6, 7].map(day => h('button', { type: 'button', key: day, className: 'bt-task-day',
              'aria-pressed': weekdays.includes(day), onClick: () => setWeekdays(current => current.includes(day)
                ? current.filter(value => value !== day) : [...current, day].sort()),
            }, new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' }).format(Date.UTC(2024, 0, day))))) : null)),
      h('p', { className: 'bt-main-status' }, `${t('Time zone')}: ${localZone()}`),
      h('div', { className: 'bt-set-row bt-task-foot' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding(false) }, t('Cancel')),
        h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || !title.trim() || !text.trim()
          || kind === 'weekly' && weekdays.length === 0 }, busy ? t('Creating…') : t('Create task')))) : null,
    error ? h(InlineNotice, { tone: 'danger' }, error) : null,
    !rules ? !error && h(InlineNotice, { tone: 'neutral' }, t('Loading…')) : rules.length === 0
      ? h(SectionCard, null, h(EmptyState, { title: t('No scheduled tasks yet.') }))
        : h(SectionCard, null, rules.map(rule => {
          const occurrences = [...(details[rule.ruleId]?.occurrences ?? [])].sort((left, right) => left.dueAt - right.dueAt)
          const last = occurrences.at(-1)
          const visibleCount = Math.min(occurrences.length, historyCounts[rule.ruleId] ?? 20)
          const visibleOccurrences = occurrences.slice(-visibleCount)
          const history = occurrenceHistory(occurrences, visibleOccurrences, () => setHistoryCounts(current => ({ ...current,
            [rule.ruleId]: Math.min(occurrences.length, (current[rule.ruleId] ?? 20) + 20) })), onViewWork)
          const work = available.find(item => item.brief.workItemId === rule.target.workItemId)
          return h('div', { key: rule.ruleId, className: 'bt-set-row bt-task bt-product-schedule-row' },
            h(ClockIcon), h('span', { className: 'bt-set-copy' },
              h('strong', { className: 'bt-task-title' }, rule.title),
              h('span', { className: 'bt-set-hint' }, `${whenText(rule)} · ${rule.timezone} · ${rule.target.kind === 'main' ? 'Main' : work?.brief.goal ?? rule.target.ticketId}`),
              h('span', { className: 'bt-task-prompt' }, rule.text),
              last ? h('span', { className: 'bt-task-prompt', role: 'status' }, occurrenceText(last),
                last.executionStatus ? ` · ${executionText(last.executionStatus)}` : null,
                last.ticketIds?.length ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
                  'aria-label': t('View work for Ticket {id}', { id: last.ticketIds[0] }),
                  onClick: () => onViewWork?.({ workBriefId: last.workBriefId, ticketIds: last.ticketIds }) }, t('View work'))
                  : last.workBriefId ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
                    'aria-label': t('View work brief {id}', { id: last.workBriefId }),
                    onClick: () => onViewWork?.({ workBriefId: last.workBriefId, ticketIds: [] }) }, t('View work')) : null) : null),
            history,
            h(StatusChip, { tone: rule.status === 'active' ? 'accent' : 'neutral' }, rule.status === 'active' && rule.nextAt
              ? t('Next: {time}', { time: new Date(rule.nextAt).toLocaleString() }) : t(rule.status === 'cancelled' ? 'Cancelled' : 'Finished')),
            rule.status === 'active' ? h('button', { type: 'button', className: 'bt-mini bt-task-remove',
              'data-confirm': confirming === rule.ruleId || undefined, 'aria-label': confirming === rule.ruleId ? t('Click again to delete') : t('Delete task'),
              disabled: busy, onClick: () => { void cancel(rule.ruleId) } }, confirming === rule.ruleId ? t('Delete') : h(TrashIcon)) : null)
        })))
}

export const PRODUCT_SCHEDULE_CSS = `
.bt-product-schedule-row{gap:10px;align-items:flex-start;flex-wrap:wrap}
.bt-product-schedule-row>svg{width:18px;height:18px;flex:none;color:var(--bt-ink-2)}
.bt-product-schedule-row .bt-set-copy{min-width:0;display:flex;flex-direction:column;gap:4px}
.bt-product-schedule-history{flex-basis:100%;min-width:0}
.bt-product-schedule-history summary{cursor:pointer;overflow-wrap:anywhere;color:var(--bt-ink-2)}
.bt-product-schedule-history summary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-product-schedule-history-list{padding-left:12px}
.bt-product-schedule-occurrence{padding:8px 0;border-top:1px solid var(--bt-line-2)}
.bt-product-schedule-occurrence p{overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.bt-product-schedules .bt-task-form{animation:none}}
`
