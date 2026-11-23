// Derived from DS Bot 0.3.8 (Apache-2.0)
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarIcon, ClockIcon, CloseIcon, ConnectorIcon, FolderIcon, GaugeIcon, GearIcon, GlobeIcon,
  InfoIcon, MemoryIcon, PeopleIcon, PlugIcon, SideIcon, SlidersIcon, TerminalIcon,
} from './icons.js'
import { t } from './i18n.js'
import { useLinger } from './motion.js'
import { ABOUT_SETTINGS_SECTION } from './settings-about.js'
import { SettingsPage } from './product-settings-components.js'
import { SETTINGS_GROUPS, settingsTarget } from './settings-navigation.js'
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

function SettingsDialog({ sections, renderSlot, initialPage, onClose, onNavigate, returnFocus, leaving }) {
  const resolveTarget = targetId => settingsTarget(targetId, tab =>
    Object.hasOwn(sections, tab.id) && sections[tab.id]?.status !== 'unavailable')
  const [target, setTarget] = useState(() => resolveTarget(initialPage) ?? settingsTarget('general'))
  const [unavailable, setUnavailable] = useState(() => initialPage != null && !settingsTarget(initialPage))
  const [usageTabs, setUsageTabs] = useState(() => new Set())
  const { page, section } = target
  const id = useId()
  const dialog = useRef(null)
  const scroll = useRef(null)
  const selectedPage = useRef(null)
  const focusDestination = useRef(true)

  useEffect(() => {
    const previous = dialog.current.ownerDocument.activeElement
    return () => {
      if (returnFocus) returnFocus()
      else if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0
    if (focusDestination.current) {
      selectedPage.current?.focus()
      focusDestination.current = false
    }
  }, [section.id])
  useEffect(() => {
    if (page.id === 'usage') setUsageTabs(tabs => tabs.has(section.id) ? tabs : new Set([...tabs, section.id]))
  }, [page.id, section.id])

  const close = () => { if (!leaving) onClose() }
  const navigate = (targetId, focusPage = false) => {
    if (leaving) return
    const next = resolveTarget(targetId)
    setUnavailable(!next)
    if (!next || next.section === section) return
    focusDestination.current = focusPage
    onNavigate?.(section.id)
    setTarget(next)
  }
  const navigateFromSection = targetId => navigate(targetId, true)
  const onKeyDown = event => {
    if (event.defaultPrevented || leaving) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    if (event.key === 'Tab') keepFocusInDialog(event)
  }
  const content = selected => h(SettingsSectionOutlet, { key: selected.id, id: selected.id,
    section: Object.hasOwn(sections, selected.id) ? sections[selected.id] : undefined,
    renderSlot, close, navigate: navigateFromSection })

  return h(SettingsSectionContext.Provider, { value: { sections, navigate: navigateFromSection } },
    h('div', { className: 'bt-settings-layer', 'data-leaving': leaving ? '' : undefined, inert: leaving },
      h('div', { className: 'bt-scrim', onClick: close }),
      h('div', { ref: dialog, className: 'bt-settings bt-superagent-settings', role: 'dialog', tabIndex: -1,
        'aria-modal': true, 'aria-label': t('Super-agent settings'), onKeyDown },
      h('nav', { className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
        SETTINGS_GROUPS.map(group => h('div', { key: group.id, className: 'bt-settings-group', role: 'group', 'aria-labelledby': `${id}-${group.id}` },
          h('span', { id: `${id}-${group.id}`, className: 'bt-settings-group-label' }, t(group.label)),
          group.pages.map(item => h('button', { key: item.id, className: 'bt-settings-item', type: 'button',
            ref: item === page ? selectedPage : undefined, 'aria-current': item === page ? 'page' : undefined,
            onClick: () => { if (item !== page) navigate(item.id); else setUnavailable(false) } },
          h(pageIcons[item.id]), t(item.label)))))),
      h(SettingsPage, { title: t(page.label), scrollRef: scroll,
        tabs: page.tabs ? h(SettingsTabs, { page, section, navigate, id }) : null }, page.tabs
          ? page.tabs.map(tab => h('div', { key: tab.id, role: 'tabpanel', id: `${id}-panel-${tab.id}`,
            'aria-labelledby': `${id}-tab-${tab.id}`, tabIndex: tab === section ? 0 : -1, hidden: tab !== section },
          tab === section || page.id === 'usage' && usageTabs.has(tab.id) ? content(tab) : null))
          : content(section), unavailable ? h(SettingsSectionState) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon)))))
}

export function SettingsShell({ open = true, onClose, onNavigate, returnFocus, sections, renderSlot, initialPage }) {
  const [kept, leaving] = useLinger(open, 160)
  if (!kept) return null
  return createPortal(h(SettingsDialog, { onClose, onNavigate, returnFocus, sections: { about: ABOUT_SETTINGS_SECTION, ...sections },
    renderSlot, initialPage, leaving }), document.body)
}

export const SETTINGS_SHELL_CSS = `
.bt-superagent-settings{border-radius:var(--bt-radius-dialog)}
.bt-superagent-settings>.bt-settings-nav{overflow-y:auto;scrollbar-width:thin;overscroll-behavior:contain}
.bt-settings-group{display:flex;flex-direction:column;gap:2px}
.bt-settings-group+.bt-settings-group{margin-top:12px}
.bt-settings-group-label{padding:0 8px 4px;color:var(--bt-ink-2);font-size:var(--bt-font-small);line-height:16px;font-weight:600}
.bt-settings-group .bt-settings-item{min-height:32px}
.bt-settings-group .bt-settings-item svg{flex:none}
.bt-settings-tabs{align-self:flex-start;margin:4px 20px 0;max-width:calc(100% - 40px)}
.bt-settings-tabs button{height:auto;min-height:28px;padding:4px 12px}
.bt-settings-tabs button[aria-selected=true]{background:var(--bt-card);color:var(--bt-ink)}
.bt-superagent-settings :is(.bt-settings-item,.bt-settings-close,[role=tab],[role=tabpanel]):focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-superagent-settings:focus{outline:none}
.bt-superagent-settings [role=tabpanel][hidden]{display:none}
.bt-superagent-settings [role=tabpanel]:not([hidden]){display:flex;flex-direction:column;gap:20px}
@media(max-width:640px){
  .bt-superagent-settings{border-radius:0}
  .bt-superagent-settings>.bt-settings-nav{align-items:flex-start;overflow-y:hidden}
  .bt-settings-group{flex:none;display:grid;grid-auto-flow:column;grid-template-rows:auto auto}
  .bt-settings-group+.bt-settings-group{margin:0 0 0 12px}
  .bt-settings-group-label{grid-column:1/-1}
  .bt-settings-group .bt-settings-item{grid-row:2}
}
`
