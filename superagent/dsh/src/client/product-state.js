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

export function projectTurnCards({ messages, works, sources, preparations }) {
  const visible = new Set(messages.map(message => message.id))
  const sourceMessages = new Map()
  const sourcesByMessage = new Map()
  const byMessage = new Map()
  const empty = () => ({ works: [], sources: [], preparations: [] })
  const unplaced = empty()
  const place = (kind, card, messageId) => {
    if (!visible.has(messageId)) { unplaced[kind].push(card); return }
    if (!byMessage.has(messageId)) byMessage.set(messageId, empty())
    byMessage.get(messageId)[kind].push(card)
  }
  for (const source of sources) {
    const reply = `source-reply:${source.id}`
    const target = visible.has(reply) ? reply : source.mainMessageId
    sourceMessages.set(JSON.stringify([source.sourceInstanceId, source.sourceEventId]), target)
    if (source.mainMessageId) sourcesByMessage.set(source.mainMessageId, target)
    place('sources', source, target)
  }
  for (const work of works) {
    const original = work.brief.mainMessageId
    const reply = `reply:${original}`
    place('works', work, sourcesByMessage.get(original) ?? (visible.has(reply) ? reply : original))
  }
  for (const preparation of preparations) {
    const target = sourceMessages.get(JSON.stringify([preparation.sourceInstanceId, preparation.eventId]))
    place('preparations', preparation, target)
  }
  return { byMessage, unplaced }
}

export function projectNativeTurnCards({ works, sources, preparations }, messageIds, unmatched = false) {
  const includes = id => unmatched ? !messageIds.has(id) : messageIds.has(id)
  const matchedSources = sources.filter(source => includes(source.mainMessageId))
  const matched = new Set(matchedSources.map(source => JSON.stringify([source.sourceInstanceId, source.sourceEventId])))
  const sourceKeys = new Set(sources.map(source => JSON.stringify([source.sourceInstanceId, source.sourceEventId])))
  return {
    works: works.filter(work => includes(work.brief.mainMessageId)),
    sources: matchedSources,
    preparations: preparations.filter(preparation => {
      const key = JSON.stringify([preparation.sourceInstanceId, preparation.eventId])
      return matched.has(key) || unmatched && !sourceKeys.has(key)
    }),
  }
}

export function rebaseRoleDraft(base, draft, latest) {
  const merged = JSON.parse(JSON.stringify(latest))
  for (const role of ['main', 'router', 'worker']) {
    if (!draft[role]) continue
    const edited = draft[role].model
    const original = base[role].model
    if (edited.provider !== original.provider || edited.model !== original.model || edited.effort !== original.effort) {
      merged[role].model = { ...edited }
    }
    if (draft[role].instructions !== base[role].instructions) merged[role].instructions = draft[role].instructions
  }
  return merged
}
