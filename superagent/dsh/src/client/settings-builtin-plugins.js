import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { DetailList, EmptyState, SectionCard } from './product-settings-components.js'
import { SettingsSectionState } from './settings-sections.js'

const phaseLabels = {
  active: 'Active', pending: 'Pending', loading: 'Loading…', failed: 'Failed', unloading: 'Unloading',
}

export function BuiltinPluginSettings({ binding, call }) {
  const [inventory, setInventory] = useState({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    setInventory({ status: 'loading' })
    void call('builtin-plugins', { instanceId: binding.instanceId }, controller.signal).then(
      ({ entries }) => { if (!controller.signal.aborted) setInventory({ status: 'ready', entries }) },
      () => { if (!controller.signal.aborted) setInventory({ status: 'unavailable' }) },
    )
    return () => controller.abort()
  }, [binding.instanceId, call])
  if (inventory.status !== 'ready') return h(SettingsSectionState, { status: inventory.status })
  return h(SectionCard, { title: t('Built-in plugins') }, inventory.entries.length
    ? h(DetailList, { items: inventory.entries.map(entry => ({ label: entry.name,
      value: t(entry.enabled ? phaseLabels[entry.phase] ?? 'Inactive' : 'Disabled') })) })
    : h(EmptyState, { title: t('No built-in plugins are listed.') }))
}
