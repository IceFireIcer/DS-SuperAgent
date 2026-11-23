export const SETTINGS_GROUPS = [
  { id: 'general', label: 'General', pages: [
    { id: 'general', label: 'General' },
  ] },
  { id: 'models', label: 'Models', pages: [
    { id: 'models', label: 'Models' },
    { id: 'roles', label: 'Roles' },
    { id: 'presets', label: 'Agent presets' },
    { id: 'built-in-plugins', label: 'Built-in plugins' },
  ] },
  { id: 'connections', label: 'Connections and capabilities', pages: [
    { id: 'connectors', label: 'Connectors' },
    { id: 'im', label: 'IM' },
    { id: 'phone', label: 'Phone' },
    { id: 'browser', label: 'Browser', tabs: [
      { id: 'browser-resources', label: 'Browser resources' },
      { id: 'browser-plugin', label: 'Browser plugin' },
    ] },
    { id: 'computer', label: 'Computer control' },
    { id: 'capabilities', label: 'Capability library' },
  ] },
  { id: 'superagent', label: 'SuperAgent', pages: [
    { id: 'execution', label: 'Execution policy' },
    { id: 'schedules', label: 'Scheduled tasks', tabs: [
      { id: 'calendar', label: 'Calendar' },
      { id: 'scheduled-tasks', label: 'Scheduled tasks' },
    ] },
    { id: 'preparations', label: 'Proactive preparation' },
    { id: 'supervision', label: 'Supervision' },
    { id: 'memory', label: 'Memory' },
    { id: 'usage', label: 'Usage', tabs: [
      { id: 'usage-overview', label: 'Usage' },
      { id: 'status', label: 'Status' },
    ] },
    { id: 'secrets', label: 'Secrets', tabs: [
      { id: 'chat-secrets', label: 'Secrets' },
      { id: 'credential-resources', label: 'Credential resources' },
    ] },
    { id: 'remote-clients', label: 'Remote clients' },
  ] },
  { id: 'help', label: 'Help', pages: [
    { id: 'feedback', label: 'Feedback' },
    { id: 'about', label: 'About' },
  ] },
]

const pages = SETTINGS_GROUPS.flatMap(group => group.pages)
export const SETTINGS_SECTIONS = pages.flatMap(page => page.tabs ?? [page])

export function settingsTarget(id, available = () => true) {
  for (const page of pages) {
    if (page.id === id) return { page, section: page.tabs?.find(available) ?? page.tabs?.[0] ?? page }
    const tab = page.tabs?.find(section => section.id === id)
    if (tab) return { page, section: tab }
  }
  return null
}
