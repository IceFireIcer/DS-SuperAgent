// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/palette.js.
import { createElement as h, Fragment, useEffect, useId, useRef, useState } from 'react'
import { CloseIcon, GaugeIcon, GearIcon, GlobeIcon, SearchIcon } from './icons.js'
import { ProductBrandMark } from './product-brand.js'
import { QUICK_EDGES, reducedMotion, useFlip, useGlide } from './motion.js'
import { t } from './i18n.js'

const PALETTE_EXIT_MS = 160

export function ShellPalette({ actions, connectLabel, settingsAvailable, onClose, reportError }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const dialog = useRef(null)
  const input = useRef(null)
  const timer = useRef(null)
  const listId = useId()
  const quiet = document.body.dataset.btMotion === 'quiet'
  const wanted = query.trim().toLowerCase()
  const rows = [
    { key: 'main', title: t('Main'), avatar: h(ProductBrandMark), run: actions.openMain },
    { key: 'activity', title: t('Activity'), icon: h(GaugeIcon), run: actions.openActivity },
    connectLabel ? { key: 'connection', title: connectLabel, icon: h(GlobeIcon), run: actions.openConnection } : null,
    settingsAvailable !== false && actions.openSettings
      ? { key: 'settings', title: t('Settings'), icon: h(GearIcon), run: () => actions.openSettings('general') } : null,
  ].filter(row => row?.run && row.title.toLowerCase().includes(wanted))
  const active = Math.min(cursor, Math.max(rows.length - 1, 0))
  const shown = rows.map(row => row.key).join('\n')
  const glide = useGlide(`${active}\n${shown}`, { axis: 'y', ...QUICK_EDGES })
  const listRef = glide.box
  useFlip(listRef, shown, '[data-flip]')

  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element.showModal()
    input.current?.focus()
    return () => {
      clearTimeout(timer.current)
      if (element.open) element.close()
      if (document.activeElement === document.body && previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query, shown])

  const close = run => {
    if (timer.current !== null) return
    setLeaving(true)
    timer.current = setTimeout(() => {
      dialog.current?.close()
      onClose()
      if (run) void Promise.resolve().then(run).catch(reportError)
    }, quiet || reducedMotion() ? 0 : PALETTE_EXIT_MS)
  }
  const choose = row => { if (row) close(row.run) }

  return h('dialog', {
    ref: dialog, className: 'bt-palette-layer bt-product-palette-layer', 'data-leaving': leaving || undefined,
    'aria-label': t('Search'), 'aria-modal': true, onCancel: event => { event.preventDefault(); close() },
  },
  h('div', { className: 'bt-backdrop', onMouseDown: () => close(), 'aria-hidden': true }),
  h('div', { className: 'bt-palette bt-product-palette' },
    h('div', { className: 'bt-palette-head' },
      h('span', { className: 'bt-palette-glyph', 'aria-hidden': true }, h(SearchIcon)),
      h('input', {
        ref: input, value: query, placeholder: t('Search commands'), 'aria-label': t('Search commands'),
        role: 'combobox', 'aria-expanded': true, 'aria-controls': listId, 'aria-autocomplete': 'list',
        'aria-activedescendant': rows.length ? `${listId}-${rows[active].key}` : undefined,
        onChange: event => { setQuery(event.target.value); setCursor(0) },
        onKeyDown: event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(Math.min(active + 1, Math.max(0, rows.length - 1))) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(Math.max(active - 1, 0)) }
          else if (event.key === 'Enter') { event.preventDefault(); choose(rows[active]) }
        },
      }),
      h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': query ? t('Clear search') : t('Close search'),
        onClick: () => {
          if (!query) { close(); return }
          setQuery(''); setCursor(0); input.current?.focus()
        } }, h(CloseIcon))),
    h('div', { ref: quiet ? undefined : listRef, id: listId, className: 'bt-palette-list', role: 'listbox', 'aria-label': t('Results') },
      h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
      rows.length === 0
        ? h('div', { className: 'bt-palette-empty', role: 'status' },
            h('span', { className: 'bt-palette-empty-icon', 'aria-hidden': true }, h(SearchIcon)),
            h('span', { className: 'bt-palette-empty-label' }, t('No results')))
        : h(Fragment, null,
            h('div', { className: 'bt-palette-section', role: 'presentation', 'data-flip': 'section:commands' }, t('Commands')),
            rows.map((row, index) => h('button', {
              key: row.key, id: `${listId}-${row.key}`, type: 'button', tabIndex: -1, role: 'option', className: 'bt-palette-row',
              'aria-selected': index === active, 'data-flip': row.key,
              onMouseDown: event => event.preventDefault(), onMouseMove: () => { if (cursor !== index) setCursor(index) },
              onClick: () => choose(row),
            },
            h('span', { className: 'bt-palette-lead' }, row.avatar ?? h('span', { className: 'bt-palette-cmd' }, row.icon)),
            h('span', { className: 'bt-palette-text' }, h('span', { className: 'bt-palette-title' }, row.title))))))))
}
