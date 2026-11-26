import { DICTIONARY, t } from './i18n.js'

export const SETTINGS_GROUPS = [
  { id: 'overview', label: 'Overview', icon: 'overview', pages: [
    { id: 'overview', label: 'Overview' },
  ] },
  { id: 'general', label: 'General', icon: 'general', pages: [
    { id: 'general', label: 'General' },
  ] },
  { id: 'appearance', label: 'Look and feel', icon: 'appearance', pages: [
    { id: 'appearance', label: 'Appearance' },
  ] },
  { id: 'models', label: 'Models', icon: 'models', pages: [
    { id: 'models', label: 'Providers' },
    { id: 'presets', label: 'Agent presets' },
    { id: 'built-in-plugins', label: 'Built-in plugins' },
  ] },
  { id: 'team', label: 'Team', icon: 'team', pages: [
    { id: 'roles', label: 'Roles' },
    { id: 'memory', label: 'Memory' },
  ] },
  { id: 'work', label: 'Work', icon: 'work', pages: [
    { id: 'execution', label: 'Execution policy' },
    { id: 'schedules', label: 'Scheduled tasks', tabs: [
      { id: 'calendar', label: 'Calendar' },
      { id: 'scheduled-tasks', label: 'Scheduled tasks' },
    ] },
    { id: 'preparations', label: 'Proactive preparation' },
    { id: 'supervision', label: 'Supervision' },
  ] },
  { id: 'connect', label: 'Connect', icon: 'connect', pages: [
    { id: 'connectors', label: 'Connectors' },
    { id: 'im', label: 'IM' },
    { id: 'phone', label: 'Phone' },
  ] },
  { id: 'tools', label: 'Tools', icon: 'tools', pages: [
    { id: 'browser', label: 'Browser', tabs: [
      { id: 'browser-resources', label: 'Browser resources' },
      { id: 'browser-plugin', label: 'Browser plugin' },
    ] },
    { id: 'computer', label: 'Computer control' },
    { id: 'capabilities', label: 'Capability library' },
    { id: 'secrets', label: 'Secrets', tabs: [
      { id: 'chat-secrets', label: 'Secrets' },
      { id: 'credential-resources', label: 'Credential resources' },
    ] },
    { id: 'remote-clients', label: 'Remote clients' },
  ] },
  { id: 'usage', label: 'Usage', icon: 'usage', pages: [
    { id: 'usage', label: 'Usage', tabs: [
      { id: 'usage-overview', label: 'Usage' },
      { id: 'status', label: 'Status' },
    ] },
  ] },
  { id: 'about', label: 'About DS SuperAgent', icon: 'about', pages: [
    { id: 'feedback', label: 'Feedback' },
    { id: 'about', label: 'About DS SuperAgent' },
  ] },
]

const pages = SETTINGS_GROUPS.flatMap(group => group.pages)
export const SETTINGS_SECTIONS = pages.flatMap(page => page.tabs ?? [page])

const searchTerms = {
  overview: ['settings', 'home', '概览', '设置', '首页'],
  models: ['API key', 'model provider', '密钥', '模型供应商'],
  connectors: ['OAuth', 'authorization', '授权'],
  'scheduled-tasks': ['schedule', 'automation', '自动化'],
  status: ['backup', 'restore', 'diagnostics', 'update', '备份', '恢复', '诊断', '更新'],
  'chat-secrets': ['API key', '凭据'],
}

const normalizeSearch = text => text.normalize('NFKC').toLowerCase().trim()
const availableOrOverview = (entry, available) => entry.id === 'overview' || available(entry)

export function searchSettings(query, available = () => true) {
  const words = normalizeSearch(query).split(/\s+/u).filter(Boolean)
  if (!words.length) return []
  return SETTINGS_GROUPS.flatMap(group => group.pages.flatMap(page => {
    const entries = page.tabs ?? [page]
    return entries.map(entry => ({ entry, page, group }))
  })).filter(({ entry }) => availableOrOverview(entry, available))
    .map(({ entry, page, group }) => {
      const labels = [group.label, page.label, entry.label]
        .flatMap(label => [label, t(label), DICTIONARY.zh[label], DICTIONARY['zh-TW'][label]].filter(Boolean))
      const text = normalizeSearch([...labels, ...(searchTerms[entry.id] ?? [])].join(' '))
      return { id: entry.id, group: group.id, label: `${t(group.label)} › ${t(entry.label)}`, text }
    }).filter(hit => words.every(word => hit.text.includes(word)))
    .map(({ text: _text, ...hit }) => hit)
}

export function settingsTarget(id, available = () => true) {
  for (const group of SETTINGS_GROUPS) {
    for (const page of group.pages) {
      if (page.id === id) {
        const section = page.tabs?.find(entry => availableOrOverview(entry, available)) ?? page
        return { group, page, section }
      }
      const tab = page.tabs?.find(entry => entry.id === id)
      if (tab) return { group, page, section: tab }
    }
  }
  return null
}

export function settingsParts(group, available = () => true) {
  if (!group) return []
  return group.pages.flatMap(page => {
    const entries = page.tabs ?? [page]
    return entries.filter(entry => availableOrOverview(entry, available)).map(entry => ({
      ...entry, page,
    }))
  })
}
