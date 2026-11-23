import { t } from './i18n.js'
import { readAsset, readAssetChunk, stageImage } from './product-api-assets.js'

const unavailable = 'This product capability is not connected yet.'
const prefsKey = 'ds-superagent:prefs'
const prefFields = new Map(Object.entries({
  theme: value => ['deepseek', 'mono', 'paper', 'moonlight'].includes(value),
  accent: value => value === null || value === '' || (typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value)),
  motion: value => [null, 'quiet', 'normal', 'lively'].includes(value),
  effects: value => [null, 'full', 'reduced', 'off'].includes(value),
  layout: value => [null, 'bubble', 'flat'].includes(value),
  width: value => value === null || (Number.isInteger(value) && value >= 50 && value <= 100),
  flatWidth: value => value === null || (Number.isInteger(value) && value >= 50 && value <= 100),
  fontSize: value => Number.isInteger(value) && value >= 12 && value <= 18,
  enterToSend: value => value === null || typeof value === 'boolean',
  thinking: value => value === null || typeof value === 'boolean',
}))

const errorCodes = new Map(Object.entries({
  UNAVAILABLE: 'bot/refused', NOT_FOUND: 'bot/not-found',
  INVALID_INPUT: 'bot/invalid', INVALID_CONFIG: 'bot/invalid', INVALID_VIEW: 'bot/invalid',
  SOURCE_NOT_AUTHORIZED: 'bot/refused', ENVIRONMENT_DENIED: 'bot/refused', PATH_DENIED: 'bot/refused',
  RUNTIME_CLOSED: 'bot/refused', CLIENT_REVOKED: 'bot/refused', CLIENT_UNAUTHORIZED: 'bot/refused',
  ATTENTION_STALE: 'bot/stale', STALE_ATTENTION: 'bot/stale', REFERENCE_STALE: 'bot/stale',
  NETWORK: 'NETWORK',
}))

function fail(code, message) { throw Object.assign(new Error(t(message)), { code }) }

function nonempty(value) { return typeof value === 'string' && value.trim() !== '' }

function requireId(value) {
  if (!nonempty(value)) fail('bot/invalid', 'The request needs an identifier.')
  return value
}

function requireMain(value, expected) {
  if (value !== expected) fail('bot/not-found', 'Only the current Main conversation is available.')
}

function hash(value) {
  let result = 2166136261
  for (const character of JSON.stringify(value)) result = Math.imul(result ^ character.codePointAt(0), 16777619)
  return (result >>> 0).toString(16).padStart(8, '0')
}

const refOf = model => model ? `${model.provider}/${model.model}` : null

function modelRows(settings) {
  return settings.providers.flatMap(provider => provider.models.map(model => ({ id: model.model, name: model.name,
    ref: model.ref, provider: provider.id, providerName: provider.name,
    ...(provider.key?.configured === false ? { needsKey: true } : {}) })))
}

function providersView(settings) {
  return { available: true, providers: settings.providers.map(provider => ({ id: provider.id, name: provider.name,
    key: provider.key ?? null, models: provider.models.map(model => ({ id: model.model, name: model.name, ref: model.ref })),
    refreshable: false, removable: false, declaredModels: [] })), addable: [], protocols: [] }
}

function attentionRows(history) {
  return (history.works ?? []).flatMap(({ control }) => {
    const attention = control?.attention
    if (attention?.status !== 'waiting' || !control.permissions?.canAnswer || !control.assignment
      || control.assignment.id !== attention.assignmentId) return []
    return [{ control, attention }]
  })
}

function chatItem(message) {
  const common = { id: message.id, seq: message.sequence, time: message.createdAt, text: message.text }
  if (message.role === 'user') {
    const attachments = message.attachments ?? []
    const imageRefs = attachments.filter(attachment => attachment.kind === 'image').map(attachment => ({
      attachmentId: attachment.id, name: attachment.name, mime: attachment.mediaType,
    }))
    const files = attachments.filter(attachment => attachment.kind === 'file').map(attachment => ({
      attachmentId: attachment.id, name: attachment.name, bytes: attachment.bytes, mediaType: attachment.mediaType,
    }))
    return { ...common, kind: 'user', ...(imageRefs.length ? { images: imageRefs.length, imageRefs } : {}),
      ...(files.length ? { files } : {}) }
  }
  if (message.role === 'main') return { ...common, kind: 'bot' }
  return { ...common, kind: 'event' }
}

function beforeOf(cursor) {
  if (cursor == null) return undefined
  if (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 1 || (cursor.part !== undefined && cursor.part !== 1)) {
    fail('bot/invalid', 'Use a cursor from the Main conversation.')
  }
  return cursor.beforeSeq
}

export function createUpstreamAdapter(productCall, storage, appearance) {
  let prefs = {}
  let snapshotKey
  let revision = 0
  let pendingOpen
  let pendingState
  let shownAttention
  const pendingSends = new Map()

  function readPrefs() {
    let persisted = {}
    try {
      const json = storage()?.getItem(prefsKey)
      if (json) persisted = Object.fromEntries(Object.entries(JSON.parse(json))
        .filter(([key, value]) => prefFields.get(key)?.(value)))
    } catch { /* Local preferences work in memory when storage is unavailable. */ }
    return { ...persisted, ...prefs, ...appearance?.read() }
  }

  function setPrefs(input) {
    const entries = Object.entries(input)
    if (entries.some(([key, value]) => !prefFields.get(key)?.(value))) fail('bot/invalid', 'Check the appearance and input preferences.')
    prefs = { ...readPrefs(), ...input }
    if (appearance) {
      const shared = Object.entries(appearance.read()).filter(([key]) => Object.hasOwn(input, key))
      if (shared.length) appearance.write(Object.fromEntries(shared.map(([key]) => [key, input[key]])))
      for (const key of Object.keys(appearance.read())) delete prefs[key]
    }
    try { storage()?.setItem(prefsKey, JSON.stringify(prefs)) } catch { /* Keep the current window usable. */ }
    return readPrefs()
  }

  function open(signal) {
    if (signal) return productCall('open', {}, signal)
    pendingOpen ??= productCall('open').finally(() => { pendingOpen = undefined })
    return pendingOpen
  }

  async function loadState(request) {
    const [history, settings, status] = await Promise.all([request('history', { limit: 1 }), request('settings', { limit: 1 }),
      request('product-status').catch(error => {
        if (error.code !== 'SOURCE_NOT_AUTHORIZED') throw error
        return undefined
      })])
    return { history, settings, status }
  }

  function stateView(input, { request, signal }) {
    const state = signal ? loadState(request) : (pendingState ??= loadState(request).finally(() => { pendingState = undefined }))
    return state.then(({ history, settings, status }) => {
      const models = modelRows(settings)
      const modelsKey = hash(models)
      const { mainId, mainSessionId, generation, activeTurn, health } = history
      const running = activeTurn?.status === 'running' || activeTurn?.status === 'stopping'
      const works = history.works ?? []
      const live = { work: { bots: running ? { [mainId]: {} } : {}, rooms: {}, approvals: [], waiting: {}, turns: {}, steered: {} },
        partsRunning: running ? { [mainSessionId]: true } : {}, works, activeTurn: activeTurn ?? null, health, status }
      const liveKey = hash(live)
      const localPrefs = readPrefs()
      const main = settings.roles.main
      const key = hash([mainId, mainSessionId, generation, settings.revision, modelsKey, localPrefs, history.messages.at(-1)?.sequence, liveKey])
      if (key !== snapshotKey) { snapshotKey = key; revision++ }
      if (input.since === revision && (input.models === undefined || input.models === modelsKey)) {
        return { revision, unchanged: true, liveKey, ...(input.live === liveKey ? {} : live) }
      }
      const waiting = attentionRows(history)[0]?.attention
      shownAttention = waiting ? { instanceId: history.instanceId, id: waiting.id, version: waiting.version } : undefined
      return { revision, modelsKey, liveKey, mainBotId: mainId, mainBotIds: [mainId],
        bots: [{ id: mainId, sessionId: mainSessionId, name: main?.name ?? 'Main', model: refOf(main?.model), avatar: main?.appearance }],
        models, defaultModel: refOf(main?.model), profileDefaultModel: refOf(main?.model), prefs: localPrefs,
        rooms: [], agents: [], sections: [], privateArchives: [], permissions: null, readOnly: null,
        im: { connections: [], platforms: [] }, computer: { enabled: false }, browser: false,
        questions: waiting && !waiting.view ? { [mainSessionId]: { id: waiting.id, question: waiting.question, options: waiting.options,
          freeText: waiting.freeText } } : {},
        views: waiting?.view ? { [mainSessionId]: { id: waiting.id, ...waiting.view } } : {},
        closedCards: {}, btwCards: {}, sideChats: {}, ...live }
    })
  }

  async function historyPage(input, { binding, request }, earlier) {
    requireMain(earlier ? input.sessionId : input.botId, earlier ? binding.mainSessionId : binding.mainId)
    const before = beforeOf(input.cursor)
    const page = await request('history', { limit: 50, ...(before === undefined ? {} : { before }) })
    return { sessionId: page.mainSessionId, items: page.messages.map(chatItem),
      cursor: page.cursor === undefined ? null : { part: 1, beforeSeq: page.cursor },
      ...(earlier ? { btw: [], startedAt: page.messages[0]?.createdAt ?? null } : {}) }
  }

  async function answer(input, { binding, request }, type) {
    if (type !== 'approval') requireMain(input.sessionId, binding.mainSessionId)
    const key = requireId(type === 'approval' ? input.id : type === 'question' ? input.questionId : input.viewId)
    const text = type === 'approval' ? input.choice : input.answer
    if (type === 'view') {
      requireId(input.action)
      if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) fail('bot/invalid', 'Check the answer fields.')
    } else requireId(text)
    const history = await request('history', { limit: 1 })
    if (type !== 'approval') requireMain(input.sessionId, history.mainSessionId)
    const matches = attentionRows(history).filter(({ attention }) => attention.id === key)
    if (matches.length !== 1) fail('bot/stale', 'This question is no longer open.')
    const { control, attention } = matches[0]
    if (shownAttention && shownAttention.instanceId === history.instanceId && shownAttention.id === key
      && shownAttention.version !== attention.version) {
      fail('bot/stale', 'This question changed. Refresh Main before answering.')
    }
    const payload = { workItemId: control.workItemId, ticketId: control.ticketId, expectedGeneration: control.assignment.generation,
      attentionId: attention.id, attentionVersion: attention.version, commandId: crypto.randomUUID() }
    if (attention.view) {
      if (type === 'question') fail('bot/invalid', 'Use the controls on the open view to answer.')
      await request('work-answer-view', { ...payload, action: type === 'view' ? input.action : text,
        values: type === 'view' ? input.values : {} })
    } else {
      if (type === 'view') fail('bot/stale', 'This view is no longer open.')
      await request('work-answer', { ...payload, text })
    }
    return true
  }

  const actions = new Map(Object.entries({
    state: stateView,
    models: async (input, { request }) => ({ modelsKey: hash(modelRows(await request('settings', { limit: 1 }))) }),
    efforts: (input, { request }) => {
      const slash = typeof input.ref === 'string' ? input.ref.indexOf('/') : -1
      if (slash < 1 || slash === input.ref.length - 1) return { efforts: [] }
      return request('settings-efforts', { provider: input.ref.slice(0, slash), model: input.ref.slice(slash + 1) })
    },
    providers: async (input, { request }) => providersView(await request('settings', { limit: 1 })),
    'provider-key': async (input, { request }) => {
      requireId(input.provider)
      if (input.value !== null && !nonempty(input.value)) fail('bot/invalid', 'Enter a provider key or clear the existing key.')
      await request('provider-key', { provider: input.provider, value: input.value })
      return providersView(await request('settings', { limit: 1 }))
    },
    'file-text': async (input, { request }) => {
      const { chunks, whole } = await readAsset(request, 'attachment-read', { id: requireId(input.file?.attachmentId) }, 64 * 1024)
      const decoder = new TextDecoder()
      let text = ''
      for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
      if (whole) text += decoder.decode()
      return { text, whole }
    },
    earlier: (input, context) => historyPage(input, context, true),
    chat: (input, context) => historyPage(input, context, false),
    'stop-chat': async (input, { binding, request }) => {
      requireMain(input.botId, binding.mainId)
      const messageId = requireId(input.messageId)
      const { activeTurn } = await request('history', { limit: 1 })
      if (!activeTurn || activeTurn.messageId !== messageId || activeTurn.status === 'stopped') return false
      await request('stop-main', { commandId: crypto.randomUUID(), messageId })
      return true
    },
    folders: async (input, { request }) => {
      const { default: directory, picker, directories } = await request('directory-options')
      return { team: directory?.root, picker, folders: directories.map(({ root, title }) => ({ path: root, title })) }
    },
    'folder-pick': (input, { request }) => request('directory-pick'),
    'folder-list': (input, { request }) => {
      if (input.path != null && typeof input.path !== 'string') fail('bot/invalid', 'Choose a directory path.')
      return request('directory-list', input.path ? { path: input.path } : {})
    },
    'approval-answer': (input, context) => answer(input, context, 'approval'),
    'answer-question': (input, context) => answer(input, context, 'question'),
    'view-reply': (input, context) => answer(input, context, 'view'),
    avatar: async (input, { binding, request }) => {
      requireMain(input.botId, binding.mainId)
      const { roles } = await request('settings', { limit: 1 })
      const image = roles.main?.appearance?.image ?? null
      const digest = image ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image)) : null
      const ref = digest ? Array.from(new Uint8Array(digest).subarray(0, 8), byte => byte.toString(16).padStart(2, '0')).join('') : null
      return { botId: binding.mainId, image, ref }
    },
    image: async (input, { binding, request }) => {
      requireMain(input.sessionId, binding.mainSessionId)
      const { chunks, reference } = await readAsset(request, 'attachment-read', { id: requireId(input.attachmentId) })
      if (!/^image\/(?:png|jpeg|gif|webp)$/u.test(reference.mediaType)) fail('bot/invalid', 'The attachment is not a supported image.')
      return { mime: reference.mediaType, data: await assetBase64(chunks) }
    },
    'file-download': async (input, { binding, request }) => {
      if (input.sessionId !== undefined) requireMain(input.sessionId, binding.mainSessionId)
      const attachment = nonempty(input.attachmentId)
      const endpoint = attachment ? 'attachment-read' : 'artifact-read'
      const target = attachment ? { id: input.attachmentId } : { workItemId: requireId(input.workItemId), path: requireId(input.path) }
      if (input.offset !== undefined) return readAssetChunk(request, endpoint, target, input.offset, input.version)
      const { chunks, reference, totalBytes } = await readAsset(request, endpoint, target)
      return { bytes: await assetBase64(chunks), size: totalBytes, name: reference.name ?? 'file',
        mime: reference.mediaType ?? 'application/octet-stream' }
    },
    'stage-image': (input, { binding, request }) => stageImage(input, binding, request, storage),
    send: async (input, { binding, request }) => {
      requireMain(input.sessionId, binding.mainSessionId)
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      const attachments = input.images ?? []
      if (!Array.isArray(attachments) || attachments.some(id => !nonempty(id)) || (!text && !attachments.length)) {
        fail('bot/invalid', 'Write a message or attach an image.')
      }
      const key = JSON.stringify([binding.instanceId, binding.mainId, text, attachments])
      if (!pendingSends.has(key) && pendingSends.size >= 32) fail('bot/refused', 'Check Main for earlier messages before sending more.')
      const commandId = pendingSends.get(key) ?? crypto.randomUUID()
      pendingSends.set(key, commandId)
      try {
        await request('send', { commandId, text, ...(attachments.length ? { attachments } : {}) })
      } catch (error) {
        if (['INVALID_INPUT', 'SOURCE_NOT_AUTHORIZED', 'ENVIRONMENT_DENIED', 'IDENTITY_CONFLICT'].includes(error.code)) pendingSends.delete(key)
        throw error
      }
      pendingSends.delete(key)
      return true
    },
  }))

  return async function call(endpoint, input = null, signal) {
    signal?.throwIfAborted()
    if (!actions.has(endpoint) && endpoint !== 'set-prefs') fail('bot/refused', unavailable)
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) fail('bot/invalid', 'Send a JSON object.')
    if (endpoint === 'set-prefs') return setPrefs(input ?? {})
    try {
      const binding = await open(signal)
      if (!nonempty(binding?.instanceId) || !nonempty(binding.mainId) || !nonempty(binding.mainSessionId)) {
        fail('bot/refused', 'Main is unavailable.')
      }
      const request = (name, payload) => productCall(name, { ...payload, instanceId: binding.instanceId }, signal)
      return await actions.get(endpoint)(input ?? {}, { binding, request, signal })
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code?.startsWith?.('bot/')) throw error
      throw Object.assign(new Error(error?.message ?? t('Main is unavailable.')),
        { code: errorCodes.get(error?.code) ?? (error?.code?.startsWith?.('HTTP_') ? error.code : 'bot/internal') })
    }
  }
}

async function assetBase64(chunks) {
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
