export const ROLE_IDS = Object.freeze(['main', 'router', 'worker'])

export const ROLE_NAMES = Object.freeze({
  main: 'Main',
  router: 'Router',
  worker: 'Worker',
})

// Product role names do not follow the interface language.
export function roleName(role) {
  const id = typeof role === 'object' && role !== null ? role.id : role
  const key = typeof id === 'string' ? id.toLowerCase() : ''
  return ROLE_NAMES[key] ?? (typeof id === 'string' ? id : '')
}
