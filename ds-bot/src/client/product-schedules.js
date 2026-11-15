import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { ClockIcon, PlusIcon, TrashIcon } from './icons.js'
import { Segmented, spring, SPRING_SHAPE, SPRING_TAP } from './motion.js'
import { SwitchRow } from './bot-settings.js'
import { timingText } from './schedules.js'
import { t } from './i18n.js'

const pad = value => String(value).padStart(2, '0')
const nextHour = () => {
  const date = new Date(Date.now() + 3_600_000)
  date.setMinutes(0, 0, 0)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const kinds = [['at', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['every', 'Repeat']]

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

export function ProductScheduleSettings({ binding, works, call, onViewWork }) {
  const [rules, setRules] = useState(null)
  const [sourceEnabled, setSourceEnabled] = useState(true)
  const [details, setDetails] = useState({})
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

  return h('section', { className: 'bt-product-schedules', 'aria-label': t('Scheduled tasks') },
    h('div', { className: 'bt-set-card' }, h(SwitchRow, { label: t('Schedule source'),
      hint: sourceEnabled ? null : t('Scheduled tasks are paused; existing work continues.'),
      on: sourceEnabled, disabled: busy, onChange: value => { void setSource(value) } })),
    h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon',
      onClick: () => setAdding(value => !value) }, h(PlusIcon), t('New task'))),
    adding ? h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
      h('label', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-copy' }, t('Send to')),
        h('select', { className: 'bt-select bt-task-bot', value: targetId, 'aria-label': t('Send to'), onChange: event => setTargetId(event.target.value) },
          h('option', { value: 'main' }, 'Main'), available.map(work => h('option', { key: work.brief.workItemId, value: work.brief.workItemId }, work.brief.goal)))),
      h('label', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-copy' }, t('Name')),
        h('input', { className: 'bt-bs-input', value: title, maxLength: 120, required: true, onChange: event => setTitle(event.target.value) })),
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' }, h('span', { className: 'bt-set-copy' }, t('What to do')),
        h('textarea', { className: 'bt-bs-input bt-bs-area', value: text, maxLength: 32768, required: true, rows: 3,
          onChange: event => setText(event.target.value) })),
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
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    !rules ? h('p', { className: 'bt-main-status', role: 'status' }, t('Loading…')) : rules.length === 0
      ? h('p', { className: 'bt-main-status' }, t('No scheduled tasks yet.'))
        : h('div', { className: 'bt-set-card' }, rules.map(rule => {
          const last = details[rule.ruleId]?.occurrences?.at(-1)
          const work = available.find(item => item.brief.workItemId === rule.target.workItemId)
          return h('div', { key: rule.ruleId, className: 'bt-set-row bt-task bt-product-schedule-row' },
            h(ClockIcon), h('span', { className: 'bt-set-copy' },
              h('strong', { className: 'bt-task-title' }, rule.title),
              h('span', { className: 'bt-set-hint' }, `${whenText(rule)} · ${rule.timezone} · ${rule.target.kind === 'main' ? 'Main' : work?.brief.goal ?? rule.target.ticketId}`),
              h('span', { className: 'bt-task-prompt' }, rule.text),
              last ? h('span', { className: 'bt-task-prompt', role: 'status' }, occurrenceText(last),
                last.executionStatus ? ` · ${executionText(last.executionStatus)}` : null,
                last.ticketIds?.length ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onViewWork }, t('View work')) : null) : null),
            h('span', { className: 'bt-task-next' }, rule.status === 'active' && rule.nextAt
              ? t('Next: {time}', { time: new Date(rule.nextAt).toLocaleString() }) : t(rule.status === 'cancelled' ? 'Cancelled' : 'Finished')),
            rule.status === 'active' ? h('button', { type: 'button', className: 'bt-mini bt-task-remove',
              'data-confirm': confirming === rule.ruleId || undefined, 'aria-label': confirming === rule.ruleId ? t('Click again to delete') : t('Delete task'),
              disabled: busy, onClick: () => { void cancel(rule.ruleId) } }, confirming === rule.ruleId ? t('Delete') : h(TrashIcon)) : null)
        })))
}

export const PRODUCT_SCHEDULE_CSS = `
.bt-product-schedules{display:flex;flex-direction:column;gap:12px}
.bt-product-schedules .bt-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--bt-line-2);cursor:pointer;transition:background-color .2s ease}
.bt-product-schedules .bt-switch[aria-checked=true]{background:var(--bt-accent)}
.bt-product-schedules .bt-switch:disabled{opacity:.45;cursor:default}
.bt-product-schedules .bt-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--bt-main);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:${spring(SPRING_SHAPE, 'transform')},${spring(SPRING_TAP, 'width')}}
.bt-product-schedules .bt-switch[aria-checked=true] .bt-switch-knob{transform:translateX(16px)}
.bt-product-schedules .bt-switch:active:not(:disabled) .bt-switch-knob{width:21px}
.bt-product-schedules .bt-switch[aria-checked=true]:active:not(:disabled) .bt-switch-knob{transform:translateX(11px)}
.bt-product-schedule-row{gap:10px;align-items:flex-start}
.bt-product-schedule-row>svg{width:18px;height:18px;flex:none;color:var(--bt-ink-2)}
.bt-product-schedule-row .bt-set-copy{min-width:0;display:flex;flex-direction:column;gap:4px}
.bt-product-schedule-row .bt-task-next{white-space:normal;max-width:180px;text-align:right}
.bt-product-schedules button:focus-visible,.bt-product-schedules input:focus-visible,.bt-product-schedules textarea:focus-visible,
.bt-product-schedules select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:640px){.bt-product-schedule-row{flex-wrap:wrap}.bt-product-schedule-row .bt-task-next{max-width:none;text-align:left}}
@media(prefers-reduced-motion:reduce){.bt-product-schedules .bt-task-form{animation:none}.bt-product-schedules .bt-switch,.bt-product-schedules .bt-switch-knob{transition:none}}
`
