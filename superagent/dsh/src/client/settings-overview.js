import { createElement as h } from 'react'
import { getAppearance } from './appearance.js'
import {
  CalendarIcon, ChevronRightIcon, ConnectorIcon, FolderIcon, GaugeIcon, GearIcon, PeopleIcon,
  PlusIcon, SlidersIcon, TerminalIcon,
} from './icons.js'
import { t } from './i18n.js'
import { ProductLogo } from './product-logo.js'
import { allThemes } from './themes.js'

function RoleCard({ role, onOpen }) {
  const Icon = role.id === 'worker' ? TerminalIcon : role.id === 'router' ? GearIcon : PeopleIcon
  return h('button', { type: 'button', className: 'bt-ov-bot', onClick: onOpen },
    h('span', { className: 'bt-ov-role-face' },
      role.id === 'main' ? h(ProductLogo, { size: 38 }) : h(Icon)),
    h('span', { className: 'bt-ov-bot-name' }, t(role.label)),
    h('span', { className: 'bt-ov-bot-model' }, role.model || t('No model selected')))
}

function Tile({ icon: Icon, title, onOpen, value, unit, children }) {
  return h('button', { type: 'button', className: 'bt-ov-tile', onClick: onOpen },
    h('span', { className: 'bt-ov-tile-head' },
      h(Icon), h('span', { className: 'bt-ov-tile-title' }, title), h(ChevronRightIcon)),
    h('span', { className: 'bt-ov-tile-body' },
      h('span', { className: 'bt-ov-value' }, value, unit ? h('span', { className: 'bt-ov-unit' }, unit) : null)),
    h('span', { className: 'bt-ov-tile-foot' }, children))
}

export function SettingsOverview({ overview = {}, onNavigate }) {
  const appearance = getAppearance()
  const themes = allThemes()
  const theme = themes[appearance.theme] ?? themes.deepseek
  const roles = overview.roles ?? []
  const shownRoles = roles.length ? roles : [
    { id: 'main', label: 'Main' },
    { id: 'router', label: 'Router' },
    { id: 'worker', label: 'Worker' },
  ]
  const models = [...new Set(roles.map(role => role.model).filter(Boolean))]
  const attention = overview.needsModel ? h('section', {
    className: 'bt-ov-attention', 'aria-label': t('Needs your attention'),
  }, h('div', { className: 'bt-ov-alert' },
    h('span', { className: 'bt-ov-alert-icon', 'aria-hidden': true }, h(GearIcon)),
    h('span', { className: 'bt-ov-alert-copy' },
      h('span', { className: 'bt-ov-alert-title' }, t('Add a model provider')),
      h('span', { className: 'bt-ov-alert-meta' }, t('Set up a provider and choose the models used by Main, Router and Worker.'))),
    h('button', { type: 'button', className: 'bt-send', onClick: () => onNavigate('models') }, t('Set up')))) : null
  const team = h('section', { className: 'bt-ov-section' },
    h('div', { className: 'bt-ov-head' },
      h('h3', null, t('Team')),
      h('button', { type: 'button', className: 'bt-ov-link', onClick: () => onNavigate('roles') },
        h('span', null, t('Main, Router and Worker')))),
    h('div', { className: 'bt-ov-team' },
      shownRoles.map(role => h(RoleCard, { key: role.id, role, onOpen: () => onNavigate('roles') })),
      h('button', { type: 'button', className: 'bt-ov-bot bt-ov-new', onClick: () => onNavigate('models') },
        h(PlusIcon), h('span', { className: 'bt-ov-bot-name' }, t('Configure models')))))
  const tiles = h('section', { className: 'bt-ov-tiles', 'aria-label': t('Overview') },
    h(Tile, { icon: SlidersIcon, title: t('Models'), onOpen: () => onNavigate('models'),
      value: overview.modelCount ?? '–', unit: (overview.modelCount ?? 0) === 1 ? t('model') : t('models') },
    models.slice(0, 3).map(model => h('span', { key: model, className: 'bt-ov-chip' }, model))),
    h(Tile, { icon: ConnectorIcon, title: t('Connect'), onOpen: () => onNavigate('connectors'), value: '–' },
      h('span', null, t('Connectors, IM and phone'))),
    h(Tile, { icon: FolderIcon, title: t('Tools'), onOpen: () => onNavigate('capabilities'), value: '–' },
      h('span', null, t('Browser, computer and capabilities'))),
    h(Tile, { icon: GaugeIcon, title: t('Usage'), onOpen: () => onNavigate('usage'), value: '–' },
      h('span', null, t('Usage and product health'))),
    h(Tile, { icon: CalendarIcon, title: t('Scheduled tasks'), onOpen: () => onNavigate('schedules'), value: '–' },
      h('span', null, t('Calendar and automation'))),
    h(Tile, { icon: SlidersIcon, title: t('Look and feel'), onOpen: () => onNavigate('appearance'),
      value: t(theme.label) }, h('span', null, t('Theme, layout and motion'))))
  return h('div', { className: 'bt-settings-page bt-ov-page', 'data-page': 'overview' }, attention, team, tiles)
}
