import { createElement as h } from 'react'
import metadata from '../../../package.json' with { type: 'json' }
import { t } from './i18n.js'
import { FieldRow, SectionCard } from './product-settings-components.js'

function AboutSettings({ navigate }) {
  return h(SectionCard, { title: 'DS SuperAgent' },
    h(FieldRow, { label: t('Package'), control: h('span', null, metadata.name) }),
    h(FieldRow, { label: t('Author'), control: h('span', null, metadata.author) }),
    h(FieldRow, { label: t('Plugin version'), control: h('span', null, metadata.version) }),
    h(FieldRow, { label: t('License'), control: h('span', null, metadata.license) }),
    h(FieldRow, { label: t('Project on GitHub'), control: h('a', { href: metadata.homepage,
      target: '_blank', rel: 'noopener noreferrer' }, t('Open')) }),
    navigate ? h(FieldRow, { label: t('Updates'), control: h('button', { type: 'button', className: 'bt-soft',
      onClick: () => navigate('status') }, t('Open product status')) }) : null)
}

export const ABOUT_SETTINGS_SECTION = { render: ({ navigate } = {}) => h(AboutSettings, { navigate }) }
