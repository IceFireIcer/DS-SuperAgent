// Adapted from DS Bot 0.3.8 (Apache-2.0), ds-bot/src/client/schedules.js (see NOTICE).
import { dateLocale, t } from './i18n.js'

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const clock = time => String(time ?? '').slice(0, 5)
const when = (value, options) => new Intl.DateTimeFormat(dateLocale(), options).format(value)

function dayAndTime(value) {
  const sameYear = new Date(value).getFullYear() === new Date().getFullYear()
  return when(value, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function weekdayNames(days) {
  const names = days.map(day => when(Date.UTC(2024, 0, day), { weekday: 'short', timeZone: 'UTC' }))
  return names.join(/^(zh|ja)/u.test(dateLocale()) ? '、' : ', ')
}

function everyText(seconds) {
  if (seconds % 86400 === 0) return seconds === 86400 ? t('Every day') : t('Every {count} days', { count: seconds / 86400 })
  if (seconds % 3600 === 0) return seconds === 3600 ? t('Every hour') : t('Every {count} hours', { count: seconds / 3600 })
  return t('Every {count} minutes', { count: Math.round(seconds / 60) })
}

export function timingText(task) {
  const zone = task.timeZone && task.timeZone !== localZone() ? ` (${task.timeZone})` : ''
  if (task.kind === 'at') return t('Once, {time}', { time: dayAndTime(Date.parse(task.scheduledAt)) })
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
  return ''
}
