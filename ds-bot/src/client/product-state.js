export function mergeObservationItems(existing, incoming) {
  const byId = new Map(existing.map(item => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
}

export function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map(message => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

export function rebaseRoleDraft(base, draft, latest) {
  const merged = JSON.parse(JSON.stringify(latest))
  for (const role of ['main', 'router', 'worker']) {
    if (!draft[role]) continue
    for (const field of ['provider', 'model', 'effort']) {
      if (draft[role].model?.[field] === base[role].model?.[field]) continue
      if (draft[role].model?.[field] === undefined) delete merged[role].model[field]
      else merged[role].model[field] = draft[role].model[field]
    }
    if (draft[role].instructions !== base[role].instructions) merged[role].instructions = draft[role].instructions
  }
  return merged
}
