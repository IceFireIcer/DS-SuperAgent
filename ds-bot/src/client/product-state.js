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
