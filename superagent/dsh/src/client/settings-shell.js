// Derived from DS Bot 0.3.8 (Apache-2.0)
import { createElement as h, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarIcon, ClockIcon, CloseIcon, ConnectorIcon, FolderIcon, GaugeIcon, GearIcon, GlobeIcon,
  InfoIcon, MemoryIcon, PeopleIcon, PlugIcon, SideIcon, SlidersIcon, TerminalIcon,
} from './icons.js'
import { t } from './i18n.js'
import { useLinger } from './motion.js'
import { ABOUT_SETTINGS_SECTION } from './settings-about.js'
import { SettingsPage } from './product-settings-components.js'
import { SETTINGS_GROUPS, searchSettings, settingsTarget } from './settings-navigation.js'
import { SETTINGS_SECTION_SLOT, SettingsSectionContext, SettingsSectionOutlet, SettingsSectionState } from './settings-sections.js'

export { installSettingsSections } from './settings-sections.js'

export const SETTINGS_CHILDREN = {
  [SETTINGS_SECTION_SLOT]: { kind: 'list', scope: 'root' },
}

const pageIcons = {
  general: GearIcon, models: SlidersIcon, roles: PeopleIcon, presets: MemoryIcon, 'built-in-plugins': PlugIcon,
  connectors: ConnectorIcon, im: SideIcon, phone: ConnectorIcon, browser: GlobeIcon, computer: TerminalIcon,
  capabilities: FolderIcon, execution: SlidersIcon, schedules: CalendarIcon, preparations: ClockIcon,
  supervision: GaugeIcon, memory: MemoryIcon, usage: GaugeIcon, secrets: GearIcon, 'remote-clients': ConnectorIcon,
  feedback: SideIcon, about: InfoIcon,
}

function SettingsTabs({ page, section, navigate, id }) {
  const tabId = tab => `${id}-tab-${tab.id}`
  const onKeyDown = event => {
    const index = page.tabs.indexOf(section)
    const last = page.tabs.length - 1
    const moves = { ArrowLeft: index === 0 ? last : index - 1, ArrowRight: index === last ? 0 : index + 1, Home: 0, End: last }
    if (!Object.hasOwn(moves, event.key)) return
    event.preventDefault()
    const next = page.tabs[moves[event.key]]
    navigate(next.id)
    event.currentTarget.ownerDocument.getElementById(tabId(next))?.focus()
  }
  return h('div', { className: 'bt-seg bt-settings-tabs', role: 'tablist', 'aria-label': t(page.label), onKeyDown },
    page.tabs.map(tab => h('button', { key: tab.id, type: 'button', role: 'tab', id: tabId(tab),
      'aria-selected': tab === section, 'aria-controls': `${id}-panel-${tab.id}`, tabIndex: tab === section ? 0 : -1,
      onClick: () => navigate(tab.id) }, t(tab.label))))
}

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

function SettingsDialog({ sections, renderSlot, initialPage, onClose, onNavigate, returnFocus, leaving, roleDraft, leaveRequest }) {
  const available = entry => Object.hasOwn(sections, entry.id) && sections[entry.id]?.status !== 'unavailable'
  const resolveTarget = targetId => settingsTarget(targetId, available)
  const [target, setTarget] = useState(() => resolveTarget(initialPage) ?? settingsTarget('general'))
  const [unavailable, setUnavailable] = useState(() => initialPage != null && !settingsTarget(initialPage))
  const [usageTabs, setUsageTabs] = useState(() => new Set())
  const [compact, setCompact] = useState(() => window.innerWidth < 720)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const { page, section } = target
  const id = useId()
  const dialog = useRef(null)
  const scroll = useRef(null)
  const selectedPage = useRef(null)
  const chooser = useRef(null)
  const search = useRef(null)
  const navigation = useRef(null)
  const keepEditing = useRef(null)
  const restoredFocus = useRef(null)
  const focusDestination = useRef('page')
  const searching = query.trim() !== ''
  const results = searching ? searchSettings(query, available) : []

  useLayoutEffect(() => {
    const previous = dialog.current.ownerDocument.activeElement
    return () => {
      if (returnFocus) returnFocus()
      else if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth < 720
      if (next === compact) return
      const active = dialog.current.ownerDocument.activeElement
      const inNavigation = navigation.current?.contains(active)
      if (active === chooser.current) focusDestination.current = 'page'
      setExpanded(Boolean(next && inNavigation))
      setCompact(next)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [compact])
  useLayoutEffect(() => {
    if (confirmation && !leaving) keepEditing.current?.focus()
  }, [confirmation, leaving])
  useLayoutEffect(() => {
    if (leaving || confirmation) return
    const restored = restoredFocus.current
    restoredFocus.current = null
    if (restored) {
      if (restored.isConnected && !restored.closest('[hidden], [inert]') && !restored.matches(':disabled')) restored.focus({ preventScroll: true })
      if (!dialog.current.contains(dialog.current.ownerDocument.activeElement)) focusDestination.current = 'page'
    }
    if (focusDestination.current === 'page') {
      const next = (compact ? chooser.current : selectedPage.current) ?? search.current
      next?.focus()
    } else if (focusDestination.current === 'search') search.current?.focus()
    focusDestination.current = null
  })
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0 }, [section.id])
  useEffect(() => {
    if (page.id === 'usage') setUsageTabs(tabs => tabs.has(section.id) ? tabs : new Set([...tabs, section.id]))
  }, [page.id, section.id])

  const requestLeave = (action, trigger = dialog.current.ownerDocument.activeElement) => {
    if (leaving || confirmation) return
    if (section.id !== 'roles' || !roleDraft?.dirty) { action(); return }
    if (roleDraft.saving()) return
    const source = dialog.current.contains(trigger) ? trigger : dialog.current
    setConfirmation({ action, source })
  }
  useLayoutEffect(() => {
    if (!leaveRequest || leaving) return
    leaveRequest.current = requestLeave
    return () => { leaveRequest.current = null }
  })
  const keep = () => {
    restoredFocus.current = confirmation.source
    setConfirmation(null)
  }
  const discard = () => {
    roleDraft.discard()
    focusDestination.current = 'page'
    setConfirmation(null)
    confirmation.action()
  }
  const close = event => requestLeave(onClose, event?.currentTarget?.matches('button') ? event.currentTarget : undefined)
  const navigate = (targetId, { focusPage = false, select = false, trigger } = {}) => {
    if (leaving || confirmation) return
    const next = resolveTarget(targetId)
    setUnavailable(!next)
    if (!next) return
    const move = () => {
      if (select && compact) closeChooser()
      else if (select && searching) {
        focusDestination.current = 'page'
        setQuery('')
      }
      if (next.section === section) return
      if (focusPage) focusDestination.current = 'page'
      onNavigate?.(section.id)
      setTarget(next)
    }
    if (next.section === section) move()
    else requestLeave(move, trigger)
  }
  const navigateFromSection = targetId => navigate(targetId, { focusPage: true })
  const closeChooser = () => {
    focusDestination.current = 'page'
    setExpanded(false)
    setQuery('')
  }
  const selectDestination = (targetId, event) => navigate(targetId, { select: true, trigger: event.currentTarget })
  const onKeyDown = event => {
    if (event.defaultPrevented || leaving) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (compact && expanded) closeChooser()
      else close()
    }
    if (event.key === 'Tab') keepFocusInDialog(event)
  }
  const content = selected => h(SettingsSectionOutlet, { key: selected.id, id: selected.id,
    section: Object.hasOwn(sections, selected.id) ? sections[selected.id] : undefined,
    renderSlot, close, navigate: navigateFromSection })
  const destinations = searching
    ? h('div', { role: 'group', 'aria-label': t('Settings search results') }, results.length
      ? results.map(result => h('button', { key: result.id, type: 'button', className: 'bt-settings-item',
        onClick: event => selectDestination(result.id, event) }, result.label))
      : h('p', { role: 'status', className: 'bt-main-status' }, t('No matching settings')))
    : SETTINGS_GROUPS.map(group => h('div', { key: group.id, className: 'bt-settings-group', role: 'group', 'aria-labelledby': `${id}-${group.id}` },
      h('span', { id: `${id}-${group.id}`, className: 'bt-settings-group-label' }, t(group.label)),
      group.pages.map(item => h('button', { key: item.id, className: 'bt-settings-item', type: 'button',
        ref: item === page ? selectedPage : undefined, 'aria-current': item === page ? 'page' : undefined,
        onClick: event => {
          if (item !== page) selectDestination(item.id, event)
          else {
            setUnavailable(false)
            if (compact) closeChooser()
          }
        } }, h(pageIcons[item.id]), t(item.label)))))

  return h(SettingsSectionContext.Provider, { value: { sections, navigate: navigateFromSection } },
    h('div', { className: 'bt-settings-layer', 'data-leaving': leaving ? '' : undefined, inert: leaving },
      h('div', { className: 'bt-scrim', onMouseDown: event => event.preventDefault(), onClick: close }),
      h('div', { ref: dialog, className: 'bt-settings bt-superagent-settings', 'data-compact': compact || undefined, role: 'dialog', tabIndex: -1,
        inert: Boolean(confirmation), 'aria-modal': confirmation ? undefined : true, 'aria-label': t('Super-agent settings'), onKeyDown },
      h('div', { className: 'bt-settings-navigation' },
        compact ? h('button', { ref: chooser, type: 'button', className: 'bt-soft bt-settings-chooser', 'aria-label': t('Choose a page'),
          'aria-controls': `${id}-navigation`, 'aria-expanded': expanded, onClick: () => {
            if (expanded) closeChooser()
            else { focusDestination.current = 'search'; setExpanded(true) }
          } }, t('Choose a page')) : null,
        h('nav', { ref: navigation, id: `${id}-navigation`, className: 'bt-settings-nav', 'aria-label': t('Settings pages'), hidden: compact && !expanded },
          h('div', { className: 'bt-settings-search' },
            h('input', { ref: search, type: 'search', className: 'bt-input', value: query, 'aria-label': t('Search settings'),
              placeholder: t('Search settings'), onInput: event => setQuery(event.currentTarget.value) }),
            query ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Clear search'), title: t('Clear search'),
              onClick: () => { setQuery(''); search.current?.focus() } }, h(CloseIcon)) : null),
          h('div', { className: 'bt-settings-destinations' }, destinations))),
      h(SettingsPage, { title: t(page.label), scrollRef: scroll,
        tabs: page.tabs ? h(SettingsTabs, { page, section, navigate, id }) : null }, page.tabs
          ? page.tabs.map(tab => h('div', { key: tab.id, className: 'bt-settings-pane', role: 'tabpanel', id: `${id}-panel-${tab.id}`,
            'aria-labelledby': `${id}-tab-${tab.id}`, tabIndex: tab === section ? 0 : -1, hidden: tab !== section },
          tab === section || page.id === 'usage' && usageTabs.has(tab.id) ? content(tab) : null))
          : h('div', { key: section.id, className: 'bt-settings-pane' }, content(section)), unavailable ? h(SettingsSectionState) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon))),
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
          h('button', { type: 'button', className: 'bt-soft bt-danger', onClick: discard }, t('Discard changes'))))) : null))
}

export function SettingsShell({ open = true, onClose, onNavigate, returnFocus, sections, renderSlot, initialPage, roleDraft, leaveRequest }) {
  const [kept, leaving] = useLinger(open, 160)
  if (!kept) return null
  return createPortal(h(SettingsDialog, { onClose, onNavigate, returnFocus, sections: { about: ABOUT_SETTINGS_SECTION, ...sections },
    renderSlot, initialPage, leaving, roleDraft, leaveRequest }), document.body)
}

export const SETTINGS_SHELL_CSS = `
.bt-superagent-settings{border-radius:var(--bt-radius-dialog)}
.bt-settings-navigation{width:198px;flex:none;display:flex;min-height:0;background:var(--bt-sidebar)}
.bt-superagent-settings .bt-settings-nav{width:100%;min-height:0;overflow:hidden;flex:1;flex-direction:column;align-items:stretch;border-right:.5px solid var(--bt-line)}
.bt-superagent-settings .bt-settings-nav[hidden]{display:none}
.bt-settings-search{display:flex;align-items:center;gap:4px;padding:0 0 8px;flex:none}
.bt-settings-search .bt-input{flex:1;min-width:0;width:100%}
.bt-settings-search input::-webkit-search-cancel-button{display:none}
.bt-settings-destinations{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px}
.bt-settings-destinations .bt-settings-item{width:100%;white-space:normal;overflow-wrap:anywhere}
.bt-settings-group{display:flex;flex-direction:column;gap:2px}
.bt-settings-group+.bt-settings-group{margin-top:12px}
.bt-settings-group-label{padding:0 8px 4px;color:var(--bt-ink-2);font-size:var(--bt-font-small);line-height:16px;font-weight:600}
.bt-settings-group .bt-settings-item{min-height:32px}
.bt-settings-group .bt-settings-item svg{flex:none}
.bt-settings-tabs{align-self:flex-start;margin:4px 20px 0;max-width:calc(100% - 40px)}
.bt-settings-tabs button{height:auto;min-height:28px;padding:4px 12px}
.bt-settings-tabs button[aria-selected=true]{background:var(--bt-card);color:var(--bt-ink)}
.bt-superagent-settings :is(.bt-settings-item,.bt-settings-close,.bt-settings-chooser,.bt-settings-search input,.bt-settings-search button,[role=tab],[role=tabpanel]):focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-superagent-settings:focus{outline:none}
.bt-settings-pane[hidden]{display:none}
.bt-settings-pane:not([hidden]){display:flex;width:min(100%,1040px);max-width:100%;box-sizing:border-box;flex-direction:column;gap:inherit;margin-inline:auto}
.bt-superagent-settings .bt-settings-scroll{overflow-wrap:anywhere;overscroll-behavior:contain}
.bt-superagent-settings[data-compact]{width:100%;max-height:100%;flex-direction:column}
.bt-superagent-settings[data-compact] .bt-settings-navigation{width:100%;flex-direction:column;border-bottom:.5px solid var(--bt-line)}
.bt-settings-chooser{align-self:flex-start;margin:12px 56px 8px 12px;min-height:32px;max-width:calc(100% - 72px);white-space:normal;text-align:start}
.bt-superagent-settings[data-compact] .bt-settings-nav{flex:none;max-height:min(40dvh,320px);border:0;padding:4px 12px 8px}
.bt-superagent-settings[data-compact]>.bt-settings-main{width:100%;flex:1;min-height:0;height:auto}
.bt-superagent-settings[data-compact] .bt-settings-tabs{flex-wrap:wrap}
.bt-settings-confirm-layer{position:absolute;inset:0;display:grid;place-items:center;padding:16px}
.bt-settings-confirm{position:relative;box-sizing:border-box;width:min(100%,420px);padding:20px;border:1px solid var(--bt-line);border-radius:var(--bt-radius-dialog);background:var(--bt-main);color:var(--bt-ink);box-shadow:var(--bt-dialog-shadow)}
.bt-settings-confirm h2{margin:0;font-size:var(--bt-font-heading)}
.bt-settings-confirm p{color:var(--bt-ink-2);font-size:var(--bt-font-body)}
.bt-settings-confirm .bt-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.bt-settings-confirm button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`
