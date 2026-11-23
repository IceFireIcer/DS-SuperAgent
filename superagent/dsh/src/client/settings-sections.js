import { Component, createContext, createElement as h, useContext } from 'react'
import { t } from './i18n.js'
import { SETTINGS_SECTIONS } from './settings-navigation.js'

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SettingsSectionContext = createContext(null)

const statusCopy = new Map([
  ['loading', 'Loading settings…'],
  ['unavailable', 'This setting is unavailable here.'],
  ['error', 'Could not load this setting.'],
])

export function SettingsSectionState({ status = 'unavailable', message }) {
  return h('p', {
    role: status === 'error' ? 'alert' : 'status',
    className: status === 'error' ? 'bt-main-error' : 'bt-main-status',
  }, t(statusCopy.get(status) ?? statusCopy.get('unavailable')),
  typeof message === 'string' && message ? ` ${message}` : null)
}

class SettingsSectionBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? h(SettingsSectionState, { status: 'error' }) : this.props.children
  }
}

function SettingsSectionContent({ section, close, navigate }) {
  if (section?.status !== undefined && section.status !== 'ready') {
    return h(SettingsSectionState, { status: section.status, message: section.message })
  }
  if (typeof section?.render !== 'function') return h(SettingsSectionState)
  return section.render({ close, navigate }) ?? h(SettingsSectionState)
}

export function SettingsSectionOutlet({ id, section, renderSlot, close, navigate }) {
  return h(SettingsSectionBoundary, { key: id }, renderSlot
    ? h(SettingsSlotContent, { id, renderSlot, close })
    : h(SettingsSectionContent, { section, close, navigate }))
}

function SettingsSlotContent({ id, renderSlot, close }) {
  return renderSlot(SETTINGS_SECTION_SLOT, { close }, { only: productSettingsSlotId(id), fallback: h(SettingsSectionState) })
}

const productSettingsSlotId = id => `superagent-${id}`

export function installSettingsSections(slots) {
  return slots.inject(SETTINGS_SECTION_SLOT, () => {
    const disposers = SETTINGS_SECTIONS.map(({ id, label }, order) => slots.register({
      name: SETTINGS_SECTION_SLOT, id: productSettingsSlotId(id), order, label: () => t(label),
    }, function ProductSettingsSection({ close }) {
      const context = useContext(SettingsSectionContext)
      const section = context?.sections && Object.hasOwn(context.sections, id) ? context.sections[id] : undefined
      return h(SettingsSectionContent, { section, close, navigate: context?.navigate })
    }))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}
