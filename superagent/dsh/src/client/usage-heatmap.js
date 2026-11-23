// Derived from DS Bot 0.3.8 (Apache-2.0), 5e9b7da8882da3b68d8a0624342708c2150a9156:ds-bot/src/client/usage-page.js.
import { createElement as h, useState } from 'react'
import { dateLocale, t } from './i18n.js'

const DAY_MS = 86_400_000
const mondayOf = ms => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS
const dayKey = ms => new Date(ms).toISOString().slice(0, 10)
const HEAT_WEEKS = 53
const dates = options => new Intl.DateTimeFormat(dateLocale(), { ...options, timeZone: 'UTC' })
const full = total => Number(total).toLocaleString(dateLocale())
const soften = (paint, opacity) => `color-mix(in srgb,${paint} ${Math.round(opacity * 100)}%,transparent)`

const paint = 'var(--bt-accent)'

export function UsageHeatmap({ now, rows }) {
  const [hover, setHover] = useState(null)
  const [selectedDay, setSelectedDay] = useState('')
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const first = mondayOf(today) - (HEAT_WEEKS - 1) * 7 * DAY_MS
  const daily = new Map()
  for (const row of rows) {
    const day = Math.floor(row.at / DAY_MS) * DAY_MS
    if (day >= first && day <= today) daily.set(day, (daily.get(day) ?? 0) + row.usage.totalTokens)
  }
  const most = Math.max(0, ...daily.values())
  const levels = [0.3, 0.52, 0.76, 1]
  const months = []
  const cells = []
  for (let week = 0; week < HEAT_WEEKS; week += 1) {
    const monday = first + week * 7 * DAY_MS
    if (week > 0 && new Date(monday).getUTCMonth() !== new Date(monday - 7 * DAY_MS).getUTCMonth()) {
      months.push(h('span', { key: week, style: { gridColumn: week + 1 } }, dates({ month: 'short' }).format(monday)))
    }
    for (let day = 0; day < 7; day += 1) {
      const ms = monday + day * DAY_MS
      const value = daily.get(ms) ?? 0
      const level = value > 0 ? Math.max(1, Math.ceil(4 * Math.sqrt(value / most))) : 0
      cells.push(h('span', {
        key: ms, className: 'bt-us-cell',
        'data-on': hover?.ms === ms ? '' : undefined,
        'data-future': ms > today ? '' : undefined, 'data-today': ms === today ? '' : undefined,
        onMouseEnter: ms > today ? undefined : () => setHover({ ms, week, day }),
      }, level > 0 ? h('i', { style: { background: soften(paint, levels[level - 1]) } }) : null))
    }
  }
  const tipSide = hover ? {
    ...(hover.week >= HEAT_WEEKS / 2
      ? { right: `calc(${((HEAT_WEEKS - hover.week) / HEAT_WEEKS) * 100}% + 8px)` }
      : { left: `calc(${((hover.week + 1) / HEAT_WEEKS) * 100}% + 8px)` }),
    ...(hover.day < 4
      ? { top: `calc(${(hover.day / 7) * 100}% - 2px)` }
      : { top: 'auto', bottom: `calc(${((6 - hover.day) / 7) * 100}% - 2px)` }),
  } : null
  const active = [...daily.values()].filter(value => value > 0).length
  const summary = active === 1 ? t('Active on 1 day in the last year') : t('Active on {count} days in the last year', { count: active })
  return h('section', { className: 'bt-us-card bt-us-heat' },
    h('div', { className: 'bt-us-card-head' }, h('h3', null, t('Activity (UTC)')), h('span', { className: 'bt-us-head-note' }, summary)),
    h('div', { className: 'bt-us-heat-scroll', role: 'region', 'aria-label': t('Activity (UTC)'), tabIndex: 0 },
      h('div', { className: 'bt-us-heat-months', 'aria-hidden': true }, months),
      h('div', { className: 'bt-us-heat-plot', onMouseLeave: () => setHover(null) },
        h('div', { className: 'bt-us-heat-grid', role: 'img', 'aria-label': summary }, cells),
        hover ? h('div', { className: 'bt-us-tip bt-us-heat-tip', style: tipSide },
          h('div', { className: 'bt-us-tip-title' }, dates({ month: 'long', day: 'numeric', weekday: 'short' }).format(hover.ms)),
          h('div', { className: 'bt-us-tip-total' }, t('{count} tokens', { count: full(daily.get(hover.ms) ?? 0) }))) : null)),
    h('div', { className: 'bt-us-heat-scale', 'aria-hidden': true }, t('Light'),
      levels.map(level => h('span', { key: level, className: 'bt-us-cell' }, h('i', { style: { background: soften(paint, level) } }))),
      t('Heavy')),
    h('label', { className: 'bt-product-operations-actions' }, t('Daily usage (UTC)'),
      h('input', { className: 'bt-select', type: 'date', value: selectedDay, min: dayKey(first), max: dayKey(today),
        onChange: event => setSelectedDay(event.target.value) }),
      selectedDay ? h('output', null, t('{count} tokens', { count: full(daily.get(Date.parse(selectedDay)) ?? 0) })) : null))
}

export const USAGE_HEATMAP_CSS = `
.bt-us-heat{display:grid;gap:8px;padding:12px 0}
.bt-us-card-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}
.bt-us-card-head h3{margin:0;font-size:var(--bt-font-heading)}
.bt-us-head-note,.bt-us-tip-title{font-size:var(--bt-font-small);color:var(--bt-ink-2)}
.bt-us-heat-scroll{min-width:0;overflow-x:auto;overscroll-behavior-inline:contain;scrollbar-width:thin}
.bt-us-heat-scroll:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-us-heat-scroll>:is(.bt-us-heat-months,.bt-us-heat-plot){min-width:424px}
.bt-us-heat-scroll>.bt-us-heat-months{margin-bottom:8px}
.bt-us-heat-months,.bt-us-heat-grid{display:grid;grid-template-columns:repeat(${HEAT_WEEKS},1fr);gap:3px}
.bt-us-heat-months{height:14px;font-size:var(--bt-font-caption);line-height:14px;color:var(--bt-ink-2)}
.bt-us-heat-months span{white-space:nowrap}
.bt-us-heat-plot{position:relative}
.bt-us-heat-grid{grid-template-rows:repeat(7,auto);grid-auto-flow:column}
.bt-us-heat-grid .bt-us-cell[data-on]{outline:1.5px solid var(--bt-ink-2);outline-offset:1px}
.bt-us-heat-tip{position:absolute;z-index:2;white-space:nowrap;pointer-events:none;padding:6px 8px;border-radius:var(--bt-radius-input);background:var(--bt-card);border:1px solid var(--bt-line-2);font-size:var(--bt-font-small);color:var(--bt-ink)}
.bt-us-cell{position:relative;aspect-ratio:1;border-radius:var(--bt-radius-tag);background:var(--bt-hover);overflow:hidden}
.bt-us-cell>i{position:absolute;inset:0}
.bt-us-cell[data-today]{outline:1.5px solid var(--bt-ink-3);outline-offset:1px}
.bt-us-cell[data-future]{visibility:hidden}
.bt-us-heat-scale{display:flex;align-items:center;justify-content:flex-end;gap:4px;font-size:var(--bt-font-caption);line-height:14px;color:var(--bt-ink-2)}
.bt-us-heat-scale .bt-us-cell{width:10px}
`
