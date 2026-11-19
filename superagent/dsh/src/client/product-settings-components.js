import { cloneElement, createElement as h, isValidElement, useId } from 'react'

export function SettingsPage({ title, actions, children, scrollRef, tabs }) {
  return h('div', { className: 'bt-settings-main bt-ps-page' },
    h('header', { className: 'bt-settings-head' }, h('h2', null, title),
      actions ? h('div', { className: 'bt-ps-actions' }, actions) : null),
    tabs,
    h('div', { ref: scrollRef, className: 'bt-settings-scroll bt-settings-page' }, children))
}

export function SectionCard({ title, description, children }) {
  return h('section', { className: 'bt-set-section bt-ps-section' },
    title ? h('h3', null, title) : null,
    description ? h('p', { className: 'bt-ps-description' }, description) : null,
    h('div', { className: 'bt-set-card bt-ps-card' }, children))
}

export function FieldRow({ label, hint, control, layout }) {
  const id = useId()
  const nativeField = isValidElement(control) && ['input', 'select', 'textarea'].includes(control.type)
  const field = nativeField && hint ? cloneElement(control, {
    'aria-labelledby': control.props['aria-label'] || control.props['aria-labelledby'] ? control.props['aria-labelledby'] : `${id}-label`,
    'aria-describedby': [control.props['aria-describedby'], `${id}-hint`].filter(Boolean).join(' '),
  }) : control
  return h(nativeField ? 'label' : 'div', {
    className: `bt-set-row bt-ps-row${layout === 'stack' ? ' bt-ps-stack' : ''}`,
  },
  h('span', { className: 'bt-set-copy' },
    h('span', { className: 'bt-ps-label', id: `${id}-label` }, label),
    hint ? h('span', { className: 'bt-set-hint bt-ps-hint', id: `${id}-hint` }, hint) : null),
  h(nativeField ? 'span' : 'div', { className: 'bt-set-control bt-ps-control' }, field))
}

export function EmptyState({ title, detail, action }) {
  return h('div', { className: 'bt-ps-empty' },
    h('p', null, title), detail ? h('p', { className: 'bt-ps-description' }, detail) : null, action)
}

export function StatGrid({ items, columns = 4 }) {
  return h('dl', { className: 'bt-ps-stats', style: { '--bt-ps-columns': columns } },
    items.map(({ label, value, detail }) => h('div', { className: 'bt-ps-stat', key: label },
      h('dt', null, label), h('dd', null, value),
      detail ? h('dd', { className: 'bt-ps-description' }, detail) : null)))
}

export function StatusChip({ tone = 'neutral', children }) {
  return h('span', { className: 'bt-ps-chip', 'data-tone': tone }, children)
}

export function InlineNotice({ tone = 'accent', title, children, action }) {
  return h('div', { className: 'bt-ps-notice', 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' },
    h('div', { className: 'bt-ps-notice-copy' }, title ? h('strong', null, title) : null,
      children ? h('div', { className: 'bt-ps-description' }, children) : null),
    action ? h('div', { className: 'bt-ps-actions' }, action) : null)
}

export function DetailList({ items }) {
  return h('dl', { className: 'bt-ps-details' },
    items.map(({ label, value, mono }) => h('div', { className: 'bt-ps-detail', key: label },
      h('dt', null, label), h('dd', null, mono ? h('code', null, value) : value))))
}
