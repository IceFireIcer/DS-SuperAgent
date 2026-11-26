// The settings surface follows DS Bot 0.3.10's grouped console: one landing page,
// one rail of destinations, and every part of a domain on one scrolling page.
import { createElement as h, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarIcon, CloseIcon, ConnectorIcon, FolderIcon, GaugeIcon,
  GearIcon, GlobeIcon, InfoIcon, MemoryIcon, PeopleIcon, PlugIcon, SearchIcon, SideIcon, SlidersIcon,
  TerminalIcon,
} from './icons.js'
import { t } from './i18n.js'
import { useLinger } from './motion.js'
import { ABOUT_SETTINGS_SECTION } from './settings-about.js'
import { SETTINGS_GROUPS, searchSettings, settingsParts, settingsTarget } from './settings-navigation.js'
import { SettingsOverview } from './settings-overview.js'
import { SettingsPage } from './product-settings-components.js'
import { SETTINGS_SECTION_SLOT, SettingsSectionContext, SettingsSectionOutlet, SettingsSectionState } from './settings-sections.js'

export { installSettingsSections } from './settings-sections.js'

export const SETTINGS_CHILDREN = {
  [SETTINGS_SECTION_SLOT]: { kind: 'list', scope: 'root' },
}

const pageIcons = {
  overview: GaugeIcon, general: GearIcon, appearance: SlidersIcon, models: SlidersIcon, team: PeopleIcon,
  work: CalendarIcon, connect: ConnectorIcon, tools: TerminalIcon, usage: GaugeIcon, about: InfoIcon,
}

const sectionIcons = {
  general: GearIcon, appearance: SlidersIcon, models: SlidersIcon, presets: MemoryIcon, 'built-in-plugins': PlugIcon,
  roles: PeopleIcon, memory: MemoryIcon, execution: SlidersIcon, calendar: CalendarIcon, 'scheduled-tasks': CalendarIcon,
  preparations: CalendarIcon, supervision: GaugeIcon, connectors: ConnectorIcon, im: SideIcon, phone: ConnectorIcon,
  'browser-resources': GlobeIcon, 'browser-plugin': GlobeIcon, computer: TerminalIcon, capabilities: FolderIcon,
  'chat-secrets': GearIcon, 'credential-resources': GearIcon, 'remote-clients': ConnectorIcon,
  'usage-overview': GaugeIcon, status: GaugeIcon, feedback: SideIcon, about: InfoIcon,
}

const nextFrame = callback => typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame(callback) : setTimeout(callback, 0)
const stopFrame = handle => typeof window.cancelAnimationFrame === 'function'
  ? window.cancelAnimationFrame(handle) : clearTimeout(handle)

function keepFocusInDialog(event) {
  const dialog = event.currentTarget
  const candidates = [...dialog.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter(node => node.tabIndex >= 0 && !node.matches(':disabled, input[type=hidden]') && !node.closest('[hidden], [inert]'))
  const first = candidates[0]
  const last = candidates.at(-1)
  const active = dialog.ownerDocument.activeElement
  if (event.shiftKey ? active === first || active === dialog : active === last) {
    event.preventDefault()
    const next = event.shiftKey ? last : first
    next?.focus()
  }
}

function SettingsDialog({ sections, renderSlot, initialPage, onClose, onNavigate, returnFocus, leaving, roleDraft, leaveRequest, overview }) {
  const available = entry => entry.id === 'overview' || (Object.hasOwn(sections, entry.id) && sections[entry.id]?.status !== 'unavailable')
  const resolveTarget = targetId => settingsTarget(targetId, available)
  const [target, setTarget] = useState(() => resolveTarget(initialPage) ?? resolveTarget('overview'))
  const [unavailable, setUnavailable] = useState(() => initialPage != null && !resolveTarget(initialPage))
  const [activePart, setActivePart] = useState(() => target?.section?.id ?? 'overview')
  const [compact, setCompact] = useState(() => window.innerWidth < 720)
  const [expanded, setExpanded] = useState(false)
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const [hitAt, setHitAt] = useState(0)
  const [confirmation, setConfirmation] = useState(null)
  const id = useId()
  const dialog = useRef(null)
  const scroll = useRef(null)
  const navigation = useRef(null)
  const selectedGroup = useRef(null)
  const chooser = useRef(null)
  const searchButton = useRef(null)
  const paletteInput = useRef(null)
  const keepEditing = useRef(null)
  const restoredFocus = useRef(null)
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform)
  const searchShortcut = mac ? '⌘K' : 'Ctrl K'
  const group = target?.group
  const parts = settingsParts(group, available)
  const hits = query.trim() ? searchSettings(query, available) : []

  useLayoutEffect(() => {
    const previous = dialog.current.ownerDocument.activeElement
    return () => {
      if (returnFocus) returnFocus()
      else if (previous?.isConnected) previous.focus()
    }
  }, [])
  useLayoutEffect(() => {
    if (confirmation && !leaving) keepEditing.current?.focus()
  }, [confirmation, leaving])
  useLayoutEffect(() => {
    if (compact) chooser.current?.focus({ preventScroll: true })
    else selectedGroup.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (confirmation || leaving) return
    if (compact) chooser.current?.focus({ preventScroll: true })
    else selectedGroup.current?.focus({ preventScroll: true })
  }, [group?.id, compact])
  useLayoutEffect(() => {
    if (!palette || leaving) return
    paletteInput.current?.focus({ preventScroll: true })
  }, [palette, leaving])
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth < 720
      if (next === compact) return
      const active = dialog.current.ownerDocument.activeElement
      if (active === chooser.current) setExpanded(false)
      if (!next) setExpanded(false)
      setCompact(next)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [compact])
  useEffect(() => {
    if (!group || group.id === 'overview') {
      if (scroll.current) scroll.current.scrollTop = 0
      setActivePart('overview')
      return
    }
    const next = target.section.id
    setActivePart(next)
    const frame = nextFrame(() => scrollToPart(next, false))
    return () => stopFrame(frame)
  }, [target])
  useEffect(() => {
    if (!roleDraft) return
    if (leaveRequest) leaveRequest.current = requestLeave
    return () => { if (leaveRequest) leaveRequest.current = null }
  }, [roleDraft, target])
  useEffect(() => { setHitAt(0) }, [query])
  useEffect(() => {
    const restored = restoredFocus.current
    if (!restored) return
    restoredFocus.current = null
    if (restored.isConnected && !restored.matches(':disabled')) restored.focus({ preventScroll: true })
  }, [confirmation])

  const rolesMounted = () => target?.group?.id === 'team' && parts.some(part => part.id === 'roles')
  const requestLeave = (action, trigger = dialog.current.ownerDocument.activeElement) => {
    if (leaving || confirmation) return
    if (!rolesMounted() || !roleDraft?.dirty) { action(); return }
    if (roleDraft.saving()) return
    const source = dialog.current.contains(trigger) ? trigger : dialog.current
    setConfirmation({ action, source })
  }
  const keep = () => {
    restoredFocus.current = confirmation.source
    setConfirmation(null)
  }
  const discard = () => {
    roleDraft.discard()
    setConfirmation(null)
    confirmation.action()
  }
  const closeChooser = () => {
    setExpanded(false)
    nextFrame(() => chooser.current?.focus({ preventScroll: true }))
  }
  const closePalette = () => {
    setPalette(false)
    nextFrame(() => searchButton.current?.focus({ preventScroll: true }))
  }
  const openPalette = () => {
    setPalette(true)
    setQuery('')
    setHitAt(0)
    setExpanded(false)
  }
  const scrollToPart = (partId, smooth = true) => {
    const box = scroll.current
    const node = box?.querySelector(`[data-part="${partId}"]`)
    if (!box || !node) return
    const top = partId === parts[0]?.id ? 0
      : node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 4
    box.scrollTo?.({ top: Math.max(0, top), behavior: smooth && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' })
  }
  const showPart = partId => {
    setActivePart(partId)
    scrollToPart(partId)
  }
  const navigateTo = (targetId, { fromPalette = false } = {}) => {
    if (leaving || confirmation) return
    const next = resolveTarget(targetId)
    setUnavailable(!next)
    if (!next) return
    const move = () => {
      if (fromPalette) setPalette(false)
      if (compact) setExpanded(false)
      if (next.section === target.section && next.group === target.group) {
        if (next.section.id !== 'overview') showPart(next.section.id)
        return
      }
      onNavigate?.(target.section.id)
      setTarget(next)
    }
    if (next.group !== target.group) requestLeave(move)
    else move()
  }
  const openGroup = nextGroup => {
    const next = settingsTarget(nextGroup.pages[0].id, available)
    if (!next) return
    if (nextGroup.id === target.group.id) {
      setActivePart(next.section.id)
      scroll.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
      if (compact) setExpanded(false)
      return
    }
    requestLeave(() => {
      onNavigate?.(target.section.id)
      setTarget(next)
      setUnavailable(false)
      if (compact) setExpanded(false)
    })
  }
  const pickHit = hit => {
    if (!hit) return
    navigateTo(hit.id, { fromPalette: true })
  }
  const onSearchKeyDown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!hits.length) return
      setHitAt(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length)
    } else if (event.key === 'Enter' && hits[hitAt]) {
      event.preventDefault()
      pickHit(hits[hitAt])
    }
  }
  const onKeyDown = event => {
    if (event.defaultPrevented || leaving) return
    const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (modifier && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'k') {
      event.preventDefault()
      if (palette) closePalette()
      else openPalette()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (palette) closePalette()
      else if (compact && expanded) closeChooser()
      else requestLeave(onClose)
    }
    if (event.key === 'Tab') keepFocusInDialog(event)
  }
  const sectionContent = part => h(SettingsSectionOutlet, { key: part.id, id: part.id, section: sections[part.id],
    renderSlot, close: () => requestLeave(onClose), navigate: targetId => navigateTo(targetId) })
  const pageBody = group?.id === 'overview'
    ? h(SettingsOverview, { key: 'overview', overview, onNavigate: targetId => navigateTo(targetId) })
    : parts.map(part => h('section', { key: part.id, className: 'bt-set-part', 'data-part': part.id,
      'aria-labelledby': `bt-part-${part.id}` },
    parts.length > 1 ? h('h3', { id: `bt-part-${part.id}`, className: 'bt-set-part-title' }, t(part.label)) : null,
    sectionContent(part)))
  const anchors = group?.id !== 'overview' && parts.length > 1
    ? h('nav', { className: 'bt-settings-anchors', 'aria-label': t('On this page') },
      parts.map(part => h('button', { key: part.id, type: 'button', className: 'bt-anchor',
        'aria-current': activePart === part.id ? 'location' : undefined, onClick: () => showPart(part.id) },
      t(part.label))))
    : null
  const groupStatus = nextGroup => {
    if (nextGroup.id === 'models' && overview?.needsModel) return h('span', { className: 'bt-settings-dot', 'data-tone': 'warn' })
    if (nextGroup.id === 'team') return h('span', { className: 'bt-settings-count' }, '3')
    return null
  }
  const groupButtons = SETTINGS_GROUPS.flatMap((nextGroup, index) => [
    index === SETTINGS_GROUPS.length - 1 ? h('span', { key: 'fill', className: 'bt-settings-fill', 'aria-hidden': true }) : null,
    h('button', {
      key: nextGroup.id,
      ref: nextGroup.id === group?.id ? selectedGroup : undefined,
      type: 'button',
      className: 'bt-settings-item',
      'aria-current': nextGroup.id === group?.id ? 'page' : undefined,
      onClick: () => openGroup(nextGroup),
    }, h(pageIcons[nextGroup.icon] ?? GearIcon), h('span', { className: 'bt-settings-label' }, t(nextGroup.label)), groupStatus(nextGroup)),
  ])

  return h(SettingsSectionContext.Provider, { value: { sections, navigate: targetId => navigateTo(targetId) } },
    h('div', { className: 'bt-settings-layer', 'data-leaving': leaving ? '' : undefined, inert: leaving },
      h('div', { className: 'bt-scrim', onMouseDown: event => event.preventDefault(), onClick: () => requestLeave(onClose) }),
      h('div', { ref: dialog, className: 'bt-settings bt-superagent-settings', 'data-compact': compact || undefined,
        role: 'dialog', tabIndex: -1, 'aria-modal': true, 'aria-label': t('Settings'), onKeyDown },
      h('div', { className: 'bt-settings-rail', inert: palette || confirmation || undefined },
        compact ? h('button', { ref: chooser, type: 'button', className: 'bt-soft bt-settings-chooser',
          'aria-label': t('Choose a page'), 'aria-controls': `${id}-navigation`, 'aria-expanded': expanded,
          onClick: () => expanded ? closeChooser() : setExpanded(true) }, t('Choose a page')) : null,
        h('button', { ref: searchButton, type: 'button', className: 'bt-set-search', 'aria-label': t('Search'), 'aria-haspopup': 'dialog',
          'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K', onClick: openPalette },
        h(SearchIcon), h('span', { className: 'bt-set-search-label' }, t('Search')), h('kbd', { className: 'bt-set-kbd' }, searchShortcut)),
        h('nav', { ref: navigation, id: `${id}-navigation`, className: 'bt-settings-nav', 'aria-label': t('Settings pages'),
          hidden: compact && !expanded }, groupButtons)),
      h('div', { className: 'bt-settings-main-wrap', inert: palette || confirmation || undefined }, h(SettingsPage, {
        title: t(group?.label ?? 'Overview'),
        actions: null,
        scrollRef: scroll,
        tabs: anchors,
      }, unavailable ? h(SettingsSectionState) : null, pageBody)),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'),
        inert: palette || confirmation || undefined, onClick: event => requestLeave(onClose, event.currentTarget) }, h(CloseIcon)),
      palette && !leaving ? h('div', { className: 'bt-set-palette-layer' },
        h('div', { className: 'bt-set-palette-scrim', onMouseDown: event => event.preventDefault(), onClick: closePalette }),
        h('div', { className: 'bt-set-palette', role: 'dialog', 'aria-modal': true, 'aria-label': t('Search settings') },
          h('div', { className: 'bt-set-palette-head' },
            h(SearchIcon),
            h('input', { ref: paletteInput, className: 'bt-set-search-input', type: 'search', value: query,
              placeholder: t('Search settings'), 'aria-label': t('Search settings'),
              onInput: event => setQuery(event.currentTarget.value), onKeyDown: onSearchKeyDown }),
            h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close search'), onClick: closePalette }, h(CloseIcon))),
          h('div', { className: 'bt-set-search-list' },
            hits.length ? hits.map((hit, index) => h('button', { key: `${hit.group}:${hit.id}`, type: 'button',
              className: 'bt-set-search-hit', 'data-active': index === hitAt || undefined, onMouseEnter: () => setHitAt(index),
              onClick: () => pickHit(hit) },
            h('span', { className: 'bt-set-hit-icon' }, h(sectionIcons[hit.id] ?? pageIcons[hit.group] ?? GearIcon)),
            h('span', { className: 'bt-set-search-title' }, hit.label)))
              : h('p', { className: 'bt-set-search-empty', role: 'status' }, query.trim() ? t('No matching settings') : t('Search settings'))))) : null,
      confirmation ? h('div', { className: 'bt-settings-confirm-layer' },
        h('div', { className: 'bt-scrim', onClick: keep }),
        h('div', { className: 'bt-settings-confirm', role: 'alertdialog', 'aria-modal': true,
          'aria-labelledby': `${id}-unsaved`, 'aria-describedby': `${id}-discard`, onKeyDown: event => {
            if (event.key === 'Tab') keepFocusInDialog(event)
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            keep()
          } },
        h('h2', { id: `${id}-unsaved` }, t('Unsaved role changes')),
        h('p', { id: `${id}-discard` }, t('Keep editing, or discard the changes to continue.')),
        h('div', { className: 'bt-actions' },
          h('button', { ref: keepEditing, type: 'button', className: 'bt-soft', onClick: keep }, t('Keep editing')),
          h('button', { type: 'button', className: 'bt-soft bt-danger', onClick: discard }, t('Discard changes'))))) : null)))
}

export function SettingsShell({ open = true, onClose, onNavigate, returnFocus, sections, renderSlot, initialPage,
  roleDraft, leaveRequest, overview }) {
  const [kept, leaving] = useLinger(open, 160)
  if (!kept) return null
  return createPortal(h(SettingsDialog, { onClose, onNavigate, returnFocus, sections: { about: ABOUT_SETTINGS_SECTION, ...sections },
    renderSlot, initialPage, leaving, roleDraft, leaveRequest, overview }), document.body)
}

export const SETTINGS_SHELL_CSS = `
.bt-superagent-settings{--bt-set-nav-w:212px;border-radius:20px}
.bt-settings-rail{width:var(--bt-set-nav-w);flex:none;display:flex;flex-direction:column;min-height:0;border-right:.5px solid var(--bt-line);background:color-mix(in srgb,var(--bt-sidebar) 88%,var(--bt-main));box-sizing:border-box}
.bt-set-search{flex:none;display:flex;align-items:center;gap:7px;margin:16px 10px 10px;padding:0 6px 0 10px;height:32px;border-radius:10px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-3);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;transition:border-color .14s ease,box-shadow .14s ease,color .14s ease}
.bt-set-search:hover{color:var(--bt-ink-2);border-color:var(--bt-line-2)}
.bt-set-search:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-set-search-label{flex:1;min-width:0}
.bt-set-kbd{flex:none;font:500 var(--bt-font-caption)/16px var(--bt-font);padding:0 5px;border-radius:4px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-set-search>svg{flex:none;width:14px;height:14px}
.bt-set-search-input{flex:1;min-width:0;border:0;outline:none;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px}
.bt-set-search-input::placeholder{color:var(--bt-ink-3)}
.bt-set-search-list{flex:1;min-height:0;overflow-y:auto;padding:4px 10px 16px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin}
.bt-set-search-hit{display:flex;align-items:center;gap:10px;min-height:40px;padding:7px 10px;border:0;border-radius:10px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-set-search-hit:hover,.bt-set-search-hit[data-active]{background:var(--bt-hover);color:var(--bt-ink)}
.bt-set-hit-icon{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-set-hit-icon svg{width:14px;height:14px}
.bt-set-search-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-set-search-empty{padding:16px 10px;font-size:12px;line-height:16px;color:var(--bt-ink-3);text-align:center}
.bt-set-palette-layer{position:absolute;inset:0;z-index:20;display:flex;justify-content:center;padding-top:84px;border-radius:inherit}
.bt-set-palette-scrim{position:absolute;inset:0;background:rgba(0,0,0,.28);border-radius:inherit;animation:bt-fade .16s ease-out}
body[data-ds-dark-theme] .bt-set-palette-scrim{background:rgba(0,0,0,.5)}
.bt-set-palette{position:relative;align-self:flex-start;width:min(620px,calc(100% - 32px));max-height:min(520px,calc(100% - 120px));display:flex;flex-direction:column;border-radius:16px;border:.5px solid var(--bt-glass-rim);background:var(--bt-card);box-shadow:var(--bt-dialog-shadow);overflow:hidden;animation:bt-q-in 420ms cubic-bezier(.2,.8,.2,1),bt-veil-in .16s ease-out}
.bt-set-palette-head{flex:none;display:flex;align-items:center;gap:12px;height:52px;padding:0 16px;border-bottom:.5px solid var(--bt-line);color:var(--bt-ink-3)}
.bt-set-palette-head>svg{flex:none;width:18px;height:18px}
.bt-set-palette .bt-set-search-list{padding:6px 8px 10px}
.bt-superagent-settings .bt-settings-nav{position:relative;width:100%;flex:1;min-height:0;padding:0 10px 16px;border:0;background:none;overflow-y:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:2px;box-sizing:border-box}
.bt-superagent-settings .bt-settings-nav[hidden]{display:none}
.bt-settings-item{position:relative;z-index:1;display:flex;align-items:center;gap:10px;min-height:34px;padding:7px 10px;border:0;border-radius:10px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:20px;font-weight:450;cursor:pointer;text-align:left;transition:background-color .14s ease,color .14s ease}
.bt-settings-item:hover{color:var(--bt-ink);background:var(--bt-hover)}
.bt-settings-item[aria-current=page]{background:var(--bt-nav-thumb-bg);box-shadow:var(--bt-nav-thumb-shadow);color:var(--bt-ink);font-weight:500}
.bt-settings-item[aria-current=page]>svg{color:var(--bt-accent)}
.bt-settings-item>svg{flex:none;width:15px;height:15px}
.bt-settings-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-settings-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3)}
.bt-settings-dot[data-tone=warn]{background:var(--bt-warn)}
.bt-settings-count{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-settings-fill{flex:1 0 12px}
.bt-settings-main-wrap{flex:1;min-width:0;min-height:0;display:flex}
.bt-superagent-settings .bt-settings-main{width:calc(var(--bt-set-w) - var(--bt-set-nav-w))}
.bt-superagent-settings .bt-settings-head{padding:16px 60px 12px 28px;min-height:32px}
.bt-superagent-settings .bt-settings-head h2{font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.015em}
.bt-superagent-settings .bt-settings-head-end{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0}
.bt-superagent-settings .bt-settings-actions{display:flex;align-items:center;gap:8px;min-width:0}
.bt-superagent-settings .bt-settings-actions:empty{display:none}
.bt-settings-anchors{position:relative;flex:none;display:flex;align-items:center;gap:2px;padding:0 22px;border-bottom:.5px solid var(--bt-line);overflow-x:auto;scrollbar-width:none}
.bt-settings-anchors::-webkit-scrollbar{display:none}
.bt-anchor{position:relative;flex:none;display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 6px;margin:0 4px;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap;transition:color .14s ease}
.bt-anchor:hover,.bt-anchor[aria-current=location]{color:var(--bt-ink)}
.bt-anchor[aria-current=location]{font-weight:500}
.bt-anchor::after{content:'';position:absolute;left:6px;right:6px;bottom:-.5px;height:2px;border-radius:999px;background:var(--bt-ink);opacity:0;transform:scaleX(.4);transition:opacity .14s ease,transform .2s ease}
.bt-anchor[aria-current=location]::after{opacity:1;transform:scaleX(1)}
.bt-anchor:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-4px;border-radius:8px}
.bt-superagent-settings .bt-settings-scroll{padding:4px 28px 28px;gap:20px;overflow-wrap:anywhere;overscroll-behavior:contain}
.bt-settings-parts{gap:36px;padding-top:20px}
.bt-set-part{display:flex;flex-direction:column;gap:16px;min-width:0;width:100%;max-width:760px;box-sizing:border-box}
.bt-set-part-title{margin:0;padding:0 4px;display:flex;align-items:center;gap:10px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-3)}
.bt-set-part-title::after{content:'';flex:1;height:.5px;background:var(--bt-line)}
.bt-settings-page>.bt-set-part{animation:bt-page-up 420ms cubic-bezier(.2,.8,.2,1) backwards,bt-fade .22s ease-out backwards}
.bt-settings-page>.bt-set-part:nth-child(2){animation-delay:30ms}
.bt-settings-page>.bt-set-part:nth-child(3){animation-delay:60ms}
.bt-settings-page>.bt-set-part:nth-child(4){animation-delay:90ms}
.bt-settings-page>.bt-set-part:nth-child(n+5){animation-delay:120ms}
.bt-settings-close{position:absolute;top:16px;right:16px;width:32px;height:32px;border-radius:50%;border:0;background:var(--bt-hover);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.bt-settings-close:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-ov-page{display:flex;flex-direction:column;gap:28px;padding-top:12px;width:100%;max-width:760px;box-sizing:border-box;animation:bt-page-up 420ms cubic-bezier(.2,.8,.2,1) backwards,bt-fade .22s ease-out backwards}
.bt-ov-attention{display:flex;flex-direction:column;gap:8px}
.bt-ov-alert{display:flex;align-items:center;gap:14px;padding:10px 10px 10px 14px;border-radius:12px;border:.5px solid color-mix(in srgb,var(--bt-warn) 30%,transparent);background:color-mix(in srgb,var(--bt-warn) 8%,var(--bt-card))}
.bt-ov-alert-icon{flex:none;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--bt-card);color:var(--bt-warn);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bt-warn) 30%,transparent)}
.bt-ov-alert-icon svg{width:16px;height:16px}
.bt-ov-alert-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-ov-alert-title{font-size:13px;line-height:18px;font-weight:600}
.bt-ov-alert-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-ov-section{display:flex;flex-direction:column;gap:10px}
.bt-ov-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 4px}
.bt-ov-head>h3{margin:0;font-size:13px;line-height:18px;font-weight:600}
.bt-ov-link{display:inline-flex;gap:12px;border:0;background:none;padding:0;font:inherit;font-size:12px;line-height:16px;color:var(--bt-ink-2);cursor:pointer}
.bt-ov-link:hover{color:var(--bt-ink)}
.bt-ov-team{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.bt-ov-bot{min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px 12px;border-radius:12px;border:.5px solid var(--bt-glass-rim);background:var(--bt-card);box-shadow:var(--bt-card-shadow);color:var(--bt-ink);font:inherit;cursor:pointer;transition:border-color .14s ease,background-color .14s ease}
.bt-ov-bot:hover{border-color:var(--bt-line-2)}
.bt-ov-role-face{height:40px;display:flex;align-items:center;justify-content:center;color:var(--bt-ink)}
.bt-ov-role-face>svg{width:22px;height:22px}
.bt-ov-bot-name{max-width:100%;font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ov-bot-model{max-width:100%;font-size:11px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ov-new{justify-content:center;background:none;box-shadow:none;border-style:dashed;border-color:var(--bt-line-2);color:var(--bt-ink-2)}
.bt-ov-new svg{width:20px;height:20px;margin-top:8px}
.bt-ov-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.bt-ov-tile{min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:6px;min-height:112px;padding:14px 16px;border-radius:12px;border:.5px solid var(--bt-glass-rim);background:var(--bt-card);box-shadow:var(--bt-card-shadow);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:border-color .14s ease}
.bt-ov-tile:hover{border-color:var(--bt-line-2)}
.bt-ov-tile-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-ov-tile-head>svg{flex:none;width:15px;height:15px}
.bt-ov-tile-head>svg:last-child{width:14px;height:14px;color:var(--bt-ink-3)}
.bt-ov-tile-title{flex:1;min-width:0}
.bt-ov-tile-body{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;min-height:28px}
.bt-ov-value{min-width:0;font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ov-unit{margin-left:6px;font-size:13px;font-weight:400;color:var(--bt-ink-2)}
.bt-ov-tile-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:18px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-ov-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-settings-confirm-layer{position:absolute;inset:0;display:grid;place-items:center;padding:16px;z-index:30}
.bt-settings-confirm{position:relative;box-sizing:border-box;width:min(100%,420px);padding:20px;border:1px solid var(--bt-line);border-radius:var(--bt-radius-dialog);background:var(--bt-main);color:var(--bt-ink);box-shadow:var(--bt-dialog-shadow)}
.bt-settings-confirm h2{margin:0;font-size:var(--bt-font-title)}
.bt-settings-confirm p{color:var(--bt-ink-2);font-size:var(--bt-font-body)}
.bt-settings-confirm .bt-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.bt-settings-confirm button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-superagent-settings[data-compact]{width:100%;max-height:100%;flex-direction:column}
.bt-superagent-settings[data-compact] .bt-settings-rail{width:100%;border-right:0;border-bottom:.5px solid var(--bt-line);max-height:min(58dvh,440px)}
.bt-settings-chooser{align-self:flex-start;margin:12px 56px 0 12px;min-height:32px;max-width:calc(100% - 72px);white-space:normal;text-align:start}
.bt-superagent-settings[data-compact] .bt-settings-nav{flex:none;max-height:min(40dvh,320px);padding:0 12px 10px}
.bt-superagent-settings[data-compact] .bt-set-search{margin:10px 0}
.bt-superagent-settings[data-compact] .bt-settings-main-wrap{width:100%;flex:1;min-height:0}
.bt-superagent-settings[data-compact] .bt-settings-main{width:100%;height:auto}
.bt-superagent-settings[data-compact] .bt-settings-anchors{padding-inline:10px}
.bt-superagent-settings[data-compact] .bt-ov-team,.bt-superagent-settings[data-compact] .bt-ov-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
.bt-superagent-settings[data-compact] .bt-settings-head{padding-inline:16px 56px}
.bt-superagent-settings[data-compact] .bt-settings-scroll{padding-inline:16px}
@media (max-width:640px){.bt-ov-team,.bt-ov-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (prefers-reduced-motion:reduce){.bt-settings-page>.bt-set-part,.bt-ov-page{animation:bt-fade .12s ease-out!important}.bt-anchor::after{transition:none}}
`
