import { Fragment, createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ProductChatRow } from './product-chat.js'
import { MainComposer } from './composer.js'
import { installMainCells } from './main-cells.js'
import { MainQuestion } from './main-question.js'
import { plainSpeech } from './product-speech.js'
import { createMainVoice, MAIN_VOICE_CSS } from './main-voice.js'
import { readProductArtifact, readProductAttachment, uploadPayload, uploadWithRetry } from './product-attachments.js'
import { FeishuSourceStatus } from './product-feishu.js'
import { Card, Row } from './product-card.js'
import { CloseIcon, SlidersIcon } from './icons.js'
import { ProductScheduleSettings, PRODUCT_SCHEDULE_CSS } from './product-schedules.js'
import { ProductProactiveSettings, ProactiveReview, PRODUCT_PROACTIVE_CSS } from './product-proactive.js'
import { ProductPresetSettings, PRODUCT_PRESET_CSS } from './product-presets.js'
import { ProductCredentialSettings, PRODUCT_CREDENTIAL_CSS } from './product-credentials.js'
import { ChatSecrets, CHAT_SECRET_CSS } from './chat-secrets.js'
import { ProductMemorySettings, PRODUCT_MEMORY_CSS } from './product-memory.js'
import { ProductSupervisionSettings, PRODUCT_SUPERVISION_CSS } from './product-supervision.js'
import { FolderMenu, FOLDER_CSS } from './folder-menu.js'
import { createSource } from './sources.js'
import { mergeMessages, mergeObservationItems, projectNativeTurnCards, projectTurnCards, rebaseRoleDraft } from './product-state.js'
import { installLocale, t } from './i18n.js'
import { AppearanceSettings, installAppearance } from './appearance.js'
import { SettingsShell, SETTINGS_CHILDREN, SETTINGS_SHELL_CSS, installSettingsSections } from './settings-shell.js'
import { SettingsSectionState } from './settings-sections.js'
import { FeedbackSettings } from './settings-feedback.js'
import { BuiltinPluginSettings } from './settings-builtin-plugins.js'
import { installProductShell } from './product-shell.js'
import { ClassicReturn, RETURN_CSS, surfaceGroups } from './product-surface.js'
import { DEEPSEEK_SIGN_IN_SLOT, mainModelSetup, MODEL_ONBOARDING_CSS, SuperagentModelChoice } from './product-model-onboarding.js'
import { SHELL_CSS, CONVERSATION_CSS, installCompiledStyles, installStyles } from './styles.js'
import { ProductMcpSettings } from './product-mcp-settings.js'
import { CapabilitySettings } from './capability-settings.js'
import { ConnectorSettings } from './connector-settings.js'
import { ProductImSettings } from './im-settings.js'
import { ProductPhoneSettings } from './product-phone-settings.js'
import { ProductComputerSettings, PRODUCT_COMPUTER_CSS } from './product-computer-settings.js'
import { WorkBoard, WorkMemberDock, WORK_BOARD_CSS } from './work-board.js'
import { workStatusCopy as statusCopy } from './work-feedback.js'
import { ProductBrowserSettings, ProductBrowserPluginSettings, PRODUCT_BROWSER_CSS } from './product-browser-settings.js'
import { ProductExecutionSettings, PRODUCT_EXECUTION_CSS } from './product-execution.js'
import { ProductWorkView } from './product-work-view.js'
import { ProductOperationsSettings, PRODUCT_OPERATIONS_CSS } from './product-operations.js'
import { USAGE_HEATMAP_CSS } from './usage-heatmap.js'
import { PRODUCT_SETTINGS_CSS } from './product-settings-css.js'
import { call, productCall } from './api.js'
export { productCall } from './api.js'

const clientBridge = () => window.dsSuperagentApp?.productClient
const classicBridge = () => window.dsSuperagentApp?.classicAgent
const focusMainInput = () => document.getElementById('main-message')?.focus()
const returnTo = trigger => { if (trigger?.isConnected) trigger.focus(); else focusMainInput() }

function offerDownload(data, name, mediaType = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type: mediaType }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

const rolesNeedingModels = ({ roles, providers }) => ['main', 'router', 'worker'].filter(role => {
  const model = roles[role]?.model
  return !model || !providers.some(provider => provider.id === model.provider
    && provider.models.some(candidate => candidate.model === model.model))
})

export function applyProduct(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'superagent: interface copy')
  const nativeSession = Boolean(ctx.sessions?.binding && ctx.uiWorkspace?.openSession)
  const nativeWorkspaces = ctx.get('workspaces')?.list
  const view = createSource({
    binding: null,
    messages: [],
    readReplyId: null,
    works: [],
    boardItems: null,
    workerMembers: [],
    boardError: '',
    activeTurn: null,
    health: null,
    modelsNeedSetup: null,
    mainModelSetup: null,
    modelSettingsError: false,
    sources: [],
    preparations: [],
    mainEvidence: null,
    mainEvidenceWorkItemId: null,
    mainEvidenceLoading: false,
    mainEvidenceError: null,
    error: null,
    mainDraft: '',
    mainAttachments: [],
    mainUploading: false,
    mainSending: false,
    messageBefore: null,
    messagesComplete: false,
    messagesLoading: false,
    route: 'main',
    surface: 'product',
    surfaceChanging: false,
    restoreMainFocus: false,
    observations: [],
    observationCursor: null,
    observationQuery: '',
    selectedObservation: null,
    observationGeneration: null,
    observation: null,
    observationLoading: false,
    observationError: null,
    observationDetail: null,
    observationDetailLoading: false,
    observationDetailError: null,
    activityLoading: false,
    activityError: null,
    settingsOpen: false,
    settingsPage: null,
    nativeModelsOpen: false,
    signInOpen: false,
    connection: null,
    connectOpen: false,
    directoryOptions: null,
    directoryOverride: null,
    executionTarget: null,
    localEnvironmentOverride: null,
    remoteEnvironmentOverride: null,
    directoryBusy: false,
    directoryError: null,
  })
  const useView = () => useSyncExternalStore(view.subscribe, view.getSnapshot)
  let settingsTrigger
  let signInTrigger
  let stopped = false
  let modelSettingsRequest = 0
  let observationListRequest = 0
  let observationRequest = 0
  let observationDetailRequest = 0
  let boardFlight
  let nextBoardPoll = 0
  let nextMemberPoll = 0
  let memberRequest = 0

  async function refreshMembers(binding) {
    const request = ++memberRequest
    nextMemberPoll = Number.POSITIVE_INFINITY
    try {
      const { workers } = await productCall('work-members', { instanceId: binding.instanceId })
      if (!stopped && request === memberRequest) view.set(state => ({ ...state, workerMembers: workers }))
    } catch { /* Hold the last confirmed membership until the next successful read. */ }
    finally { if (request === memberRequest) nextMemberPoll = Date.now() + 2000 }
  }

  function refreshBoard(binding) {
    if (boardFlight) return boardFlight
    boardFlight = (async () => {
      try {
        const items = new Map()
        const visited = new Set()
        let after
        do {
          if (stopped) return
          const page = await productCall('work-board', { instanceId: binding.instanceId, ...(after ? { after } : {}) })
          for (const item of page.items) items.set(item.id, item)
          after = page.cursor
          if (after && visited.has(after)) throw new Error(t('Could not refresh Work.'))
          if (after) visited.add(after)
        } while (after)
        if (!stopped) view.set(state => ({ ...state, boardItems: [...items.values()], boardError: '' }))
      } catch (error) {
        if (!stopped) view.set(state => ({ ...state, boardError: error.message }))
      } finally {
        boardFlight = undefined
        nextBoardPoll = Date.now() + 2000
      }
    })()
    return boardFlight
  }

  function BoardSurface({ dock = false }) {
    const state = useView()
    const instanceId = state.binding?.instanceId
    useEffect(() => {
      if (dock || !instanceId) return
      view.set(current => ({ ...current, route: 'work' }))
      void refreshBoard({ instanceId })
      return () => view.set(current => current.route === 'work' ? { ...current, route: 'main' } : current)
    }, [dock, instanceId])
    const allowed = !state.connection?.connected || state.connection.capabilities.includes('command')
    const execute = state.binding && allowed ? async (endpoint, input) => {
      const result = await productCall(endpoint, { ...input, instanceId: state.binding.instanceId })
      if (dock) await refreshMembers(state.binding)
      else {
        if (boardFlight) await boardFlight
        await Promise.all([refreshMain(state.binding), refreshBoard(state.binding), refreshMembers(state.binding)])
      }
      return result
    } : undefined
    const workers = new Map(state.workerMembers.map(worker => [worker.sessionId, worker]))
    const questions = dock ? state.works.map(work => ({ goal: work.brief.goal, question: work.control })) : state.boardItems ?? []
    for (const { goal, question } of questions) {
      const attention = question?.attention
      if (attention?.status === 'waiting' && attention.sessionId && !workers.get(attention.sessionId)?.item?.stop) {
        workers.set(attention.sessionId, { sessionId: attention.sessionId, state: 'waiting', item: { goal } })
      }
    }
    const members = h(WorkMemberDock, { workers: [...workers.values()], mainHealth: state.health,
      routing: state.works.some(work => work.receipt?.status === 'routing'), activeTurn: state.activeTurn,
      execute: dock ? execute : undefined })
    if (dock) return members
    return h(WorkBoard, { items: state.boardItems, error: state.boardError, execute, members, renderQuestion: item => item.question
      && h(MainWorkCard, { key: `${item.question.attention.id}:${item.question.attention.version}`, questionOnly: true,
        work: { brief: { goal: item.goal }, control: item.question }, onQuestionSettled: async () => {
          if (boardFlight) await boardFlight
          await Promise.all([refreshBoard(state.binding), refreshMembers(state.binding)])
        } }) })
  }

  const refreshMain = async binding => {
    try {
      const page = await productCall('history', { instanceId: binding.instanceId, limit: 100 })
      if (!stopped) view.set(state => {
        const messages = mergeMessages(state.messages, page.messages)
        const lastReply = messages.findLast(message => message.role === 'main')
        const reading = state.surface === 'product' && state.route === 'main' && document.hasFocus() && document.visibilityState !== 'hidden'
        const nextBinding = page.mainSessionId ? { ...binding, mainSessionId: page.mainSessionId, generation: page.generation,
          mainSessionMode: page.mainSessionMode ?? binding.mainSessionMode } : binding
        return { ...state, binding: nextBinding, messages, readReplyId: reading ? lastReply?.id ?? null : state.readReplyId,
          works: page.works ?? state.works,
          activeTurn: page.activeTurn ?? null,
          health: page.health ?? state.health,
          sources: page.sources ?? state.sources,
          preparations: page.preparations ?? state.preparations,
          messageBefore: state.messagesComplete ? null : state.messageBefore ?? page.cursor ?? null,
          messagesComplete: state.messagesComplete || page.cursor === undefined, error: null }
      })
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, error: error.message }))
    }
  }

  const loadDirectories = async binding => {
    try {
      const [options, execution] = await Promise.all([
        productCall('directory-options', { instanceId: binding.instanceId }),
        productCall('execution-options', { instanceId: binding.instanceId }),
      ])
      options.execution = execution
      if (!stopped) view.set(state => ({ ...state, directoryOptions: options }))
      return options
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, directoryError: error.message }))
      throw error
    }
  }

  const directoryActions = binding => ({
    folders: async () => {
      const options = await loadDirectories(binding)
      return { team: options.default?.root ?? null, picker: options.picker,
        folders: options.directories.map(directory => ({ path: directory.root, title: directory.title })) }
    },
    folderPick: () => productCall('directory-pick', { instanceId: binding.instanceId }),
    folderList: path => productCall('directory-list', { instanceId: binding.instanceId, ...(path ? { path } : {}) }),
  })

  const registerDirectory = (binding, path) => productCall('directory-register', {
    instanceId: binding.instanceId, commandId: crypto.randomUUID(), path,
  })

  const effectiveTarget = state => {
    const target = state.directoryOptions?.execution?.policy?.defaultTarget
    return state.executionTarget ?? (target === 'remote-only' || target === 'auto' ? target : 'local-only')
  }
  const mainBusy = state => state.mainSending || Boolean(state.activeTurn)
    || state.messages.some(message => ['queued', 'running', 'stopping'].includes(message.status))
  const pendingQuestion = state => state.works.find(work => work.control?.assignment && work.control.permissions?.canAnswer
    && work.control.attention?.status === 'waiting')
  const nativeStatus = ctx.uiSession?.sessionStatus
  const nativeQuestion = state => nativeStatus?.getSnapshot().get(state.binding?.mainSessionId)?.pendingInteraction
  const mainVoice = createMainVoice({ speechRemote: () => ctx.get('remote.speech'), readMain: () => {
    const state = view.getSnapshot()
    return { messages: state.messages, question: nativeQuestion(state) || pendingQuestion(state),
      active: state.surface === 'product' && state.route === 'main' && (!state.connection?.connected || state.connection.capabilities.includes('command')),
      busy: mainBusy(state) || state.directoryBusy || state.mainUploading }
  } })
  ctx.effect(() => {
    const stopView = view.subscribe(mainVoice.sync)
    const stopNative = nativeStatus?.subscribe(mainVoice.sync)
    document.addEventListener('visibilitychange', mainVoice.sync)
    window.addEventListener('pagehide', mainVoice.close)
    return () => {
      stopView()
      stopNative?.()
      document.removeEventListener('visibilitychange', mainVoice.sync)
      window.removeEventListener('pagehide', mainVoice.close)
      mainVoice.close()
    }
  }, 'superagent: Main voice lifecycle')
  const directoryError = error => view.set(current => ({ ...current, directoryError: error ? t(error.message) : null }))
  const changeWorkDirectory = async pick => {
    const state = view.getSnapshot()
    if (!state.binding || state.connection?.connected || effectiveTarget(state) !== 'local-only'
      || state.directoryBusy || state.mainUploading || mainBusy(state)) return
    view.set(current => ({ ...current, directoryBusy: true, directoryError: null }))
    try {
      const path = await pick(state.binding)
      if (path === null || path === undefined || path === state.directoryOverride?.root) return
      if (view.getSnapshot().mainAttachments.length) throw new Error('Remove attached files before changing directories.')
      const selected = path ? await registerDirectory(state.binding, path) : null
      await loadDirectories(state.binding)
      view.set(current => ({ ...current, directoryOverride: selected }))
    } catch (error) { directoryError(error) }
    finally { view.set(current => ({ ...current, directoryBusy: false })) }
  }

  function MainWorkDirectory({ sidebar = false, wide = true }) {
    const state = useView()
    if (!state.binding || !state.directoryOptions || state.connection?.connected || effectiveTarget(state) !== 'local-only') return null
    const actions = directoryActions(state.binding)
    const fallback = state.directoryOptions.default?.root
    return h('div', { className: sidebar ? 'bt-sidebar-directory' : 'bt-main-directory' },
      sidebar ? null : h('span', { className: 'bt-main-label' }, t('Work directory')),
      h(FolderMenu, { value: state.directoryOverride?.root, defaultPath: fallback,
        label: t('Work directory'), fallbackLabel: t(fallback ? 'Instance default' : 'No directory selected'),
        actions, onNativePick: () => changeWorkDirectory(() => actions.folderPick()),
        onPick: path => changeWorkDirectory(() => path), compact: sidebar && !wide,
        dismiss: state.settingsOpen || state.connectOpen || state.signInOpen,
        disabled: mainBusy(state) || state.directoryBusy || state.mainUploading }),
      state.directoryError ? h('p', { className: 'bt-main-error', role: 'alert' }, state.directoryError) : null)
  }

  const loadEarlierMessages = async binding => {
    const current = view.getSnapshot()
    if (!current.messageBefore || current.messagesLoading) return
    try {
      view.set(state => ({ ...state, messagesLoading: true }))
      const page = await productCall('history', { instanceId: binding.instanceId, before: current.messageBefore, limit: 100 })
      if (stopped) return
      view.set(state => {
        return { ...state, messages: mergeMessages(state.messages, page.messages),
          messageBefore: page.cursor ?? null, messagesComplete: page.cursor === undefined, messagesLoading: false }
      })
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, messagesLoading: false, error: error.message }))
    }
  }

  const loadMainEvidence = async (binding, work, { append = false } = {}) => {
    const current = view.getSnapshot().mainEvidence
    const same = current?.workItemId === work.brief.workItemId
    if (append && (!same || !current.pagination?.truncated || !current.pagination?.cursor)) return
    try {
      view.set(state => ({ ...state, mainEvidenceWorkItemId: work.brief.workItemId,
        mainEvidenceLoading: true, mainEvidenceError: null, mainEvidence: same ? state.mainEvidence : null }))
      const page = await productCall('evidence', { instanceId: binding.instanceId, workItemId: work.brief.workItemId,
        ref: { kind: 'trigger' }, maxBytes: 4096, ...(append && same ? { after: current.pagination.cursor } : {}) })
      if (stopped) return
      view.set(state => state.mainEvidenceWorkItemId !== work.brief.workItemId ? state : ({ ...state,
        mainEvidence: { ...page, workItemId: work.brief.workItemId, goal: work.brief.goal,
          text: append && state.mainEvidence?.workItemId === work.brief.workItemId
            ? state.mainEvidence.text + page.text : page.text },
        mainEvidenceLoading: false, mainEvidenceError: null,
      }))
    } catch (error) {
      if (!stopped) view.set(state => state.mainEvidenceWorkItemId !== work.brief.workItemId ? state
        : { ...state, mainEvidenceLoading: false, mainEvidenceError: error.message })
    }
  }

  const loadObservations = async (binding, { append = false, reset = false } = {}) => {
    const current = view.getSnapshot()
    const query = current.observationQuery
    const request = ++observationListRequest
    try {
      view.set(state => ({ ...state, activityLoading: true, activityError: null }))
      const page = await productCall('observe-list', { instanceId: binding.instanceId, limit: 30,
        ...(query ? { query } : {}), ...(append && current.observationCursor ? { after: current.observationCursor } : {}) })
      if (stopped || request !== observationListRequest || view.getSnapshot().observationQuery !== query) return
      view.set(state => {
        const selectedObservation = state.selectedObservation
          ? page.items.find(item => item.id === state.selectedObservation.id) ?? state.selectedObservation
          : null
        return { ...state, observations: mergeObservationItems(reset ? [] : state.observations, page.items),
        observationCursor: reset || append ? page.cursor ?? null : state.observationCursor ?? page.cursor ?? null,
          selectedObservation, activityLoading: false, activityError: null }
      })
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, activityLoading: false, activityError: error.message }))
    }
  }

  const loadObservation = async (binding, item, { reset = false, older = false } = {}) => {
    const current = view.getSnapshot()
    if (!item) return
    if (!reset && !older && current.observation?.hasMore) return
    const after = reset ? undefined : older || !current.observation?.hasMore ? current.observation?.next : undefined
    const request = ++observationRequest
    try {
      if (reset) view.set(state => ({ ...state, observationLoading: true, observationError: null }))
      const generation = current.observationGeneration ?? item.generation
      const detail = await productCall('observe-read', { instanceId: binding.instanceId, observationId: item.id,
        ...(generation ? { generation } : {}), limit: 50, ...(after === undefined ? {} : { after }) })
      if (stopped || request !== observationRequest || view.getSnapshot().selectedObservation?.id !== item.id
        || view.getSnapshot().observationGeneration !== generation) return
      view.set(state => {
        if (reset) return { ...state, observation: detail, observationLoading: false, observationError: null,
          observationDetail: null, observationDetailLoading: false, observationDetailError: null }
        if (!state.observation) return { ...state, observation: detail, observationLoading: false, observationError: null }
        const events = new Map(state.observation.events.map(event => [event.seq, event]))
        for (const event of detail.events) events.set(event.seq, event)
        return { ...state, observation: { ...detail, events: [...events.values()].sort((left, right) => left.seq - right.seq) },
          observationLoading: false, observationError: null }
      })
    } catch (error) {
      if (!stopped && request === observationRequest) {
        view.set(state => ({ ...state, observationLoading: false, observationError: error.message }))
      }
    }
  }

  const loadObservationDetail = async (binding, item, detailId, { append = false } = {}) => {
    const current = view.getSnapshot()
    if (!item || !detailId) return
    const same = current.observationDetail?.detailId === detailId
    if (append && (!same || !current.observationDetail?.hasMore)) return
    const generation = current.observationGeneration ?? item.generation
    const request = ++observationDetailRequest
    try {
      view.set(state => ({ ...state, observationDetailLoading: true, observationDetailError: null }))
      const page = await productCall('observe-detail', { instanceId: binding.instanceId, observationId: item.id,
        detailId, limit: 8192, ...(generation ? { generation } : {}),
        ...(append && same ? { offset: current.observationDetail.next } : {}) })
      if (stopped || request !== observationDetailRequest || view.getSnapshot().selectedObservation?.id !== item.id
        || view.getSnapshot().observationGeneration !== generation) return
      view.set(state => {
        const text = append && state.observationDetail?.detailId === detailId
          ? state.observationDetail.text + page.text : page.text
        return { ...state, observationDetail: { ...page, text }, observationDetailLoading: false, observationDetailError: null }
      })
    } catch (error) {
      if (!stopped && request === observationDetailRequest) {
        view.set(state => ({ ...state, observationDetailLoading: false, observationDetailError: error.message }))
      }
    }
  }

  const applyModelSettings = snapshot => {
    const setup = mainModelSetup(snapshot)
    if ((!setup || view.getSnapshot().modelSettingsError) && document.activeElement?.closest('.bt-superagent-model-dock')) focusMainInput()
    view.set(state => ({ ...state, modelsNeedSetup: Boolean(setup) || rolesNeedingModels(snapshot).length > 0,
      mainModelSetup: setup, modelSettingsError: false }))
  }
  const readModelSettings = async (binding, limit) => {
    const request = ++modelSettingsRequest
    const isCurrent = () => {
      const state = view.getSnapshot()
      return !stopped && request === modelSettingsRequest && !state.connection?.connected && state.binding?.instanceId === binding.instanceId
    }
    try {
      const snapshot = await productCall('settings', { instanceId: binding.instanceId, limit })
      if (isCurrent()) applyModelSettings(snapshot)
      return snapshot
    } catch (failure) {
      if (isCurrent() && view.getSnapshot().modelsNeedSetup === null) view.set(state => ({ ...state, modelSettingsError: true }))
      throw failure
    }
  }
  const refreshModelSettings = async (binding = view.getSnapshot().binding) => {
    if (!binding || view.getSnapshot().connection?.connected) return false
    try {
      await readModelSettings(binding, 1)
      return true
    } catch { return false }
  }
  const saveSetupKey = async (provider, value) => {
    const state = view.getSnapshot()
    if (!state.binding || state.connection?.connected || state.mainModelSetup?.keyProvider !== provider) {
      throw new Error(t('This setting is unavailable here.'))
    }
    await productCall('provider-key', { instanceId: state.binding.instanceId, provider, value })
  }

  const refresh = async () => {
    try {
      const bridge = clientBridge()
      const connection = bridge ? await bridge.status() : { connected: false }
      const previous = view.getSnapshot().connection
      if (previous && (previous.connected !== connection.connected
        || previous.connected && (previous.address !== connection.address || previous.instanceId !== connection.instanceId
          || previous.client.id !== connection.client.id))) { location.reload(); return }
      if (!stopped) view.set(state => ({ ...state, connection }))
      if (connection.connected) await bridge.events()
      const current = view.getSnapshot()
      const binding = current.binding ?? await productCall('open')
      if (Date.now() >= nextMemberPoll) void refreshMembers(binding)
      if ((current.route === 'work' || current.settingsOpen) && !boardFlight && Date.now() >= nextBoardPoll) void refreshBoard(binding)
      await refreshMain(binding)
      if (!connection.connected && !current.binding) void refreshModelSettings(binding)
      if (!connection.connected && !view.getSnapshot().directoryOptions) await loadDirectories(binding)
      else if (connection.connected && !view.getSnapshot().directoryOptions?.execution) {
        const execution = await productCall('execution-options', { instanceId: binding.instanceId })
        if (!stopped) view.set(state => ({ ...state, directoryOptions: { directories: [], ...state.directoryOptions, execution } }))
      }
      await loadObservations(binding)
      const selected = view.getSnapshot().route === 'observe' ? view.getSnapshot().selectedObservation : null
      if (selected) await loadObservation(binding, selected)
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, error: error.message }))
    }
  }

  ctx.effect(() => {
    let timer
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 750) }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, 'superagent: follow the shared Main')

  const followUpCopy = status => ({ queued: t('Follow-up queued'), persisted: t('Follow-up persisted'),
    delivering: t('Follow-up delivery started'), ready: t('Direction completed'), waiting: t('Direction waiting'),
    'handed-back': t('Direction handed back'), stopped: t('Direction blocked by stop'),
    expired: t('Follow-up delivery expired') })[status] ?? status
  const receiptCopy = status => ({ routing: t('Router is routing'), accepted: t('Accepted by Router'), rejected: t('Not accepted') })[status] ?? status
  const mainHealthCopy = health => health?.state === 'running' ? t('Main running')
    : health?.state === 'degraded' ? t('Main degraded') : t('Main ready')
  const sourceStatusCopy = status => ({ pending: t('Waiting for Main'), presented: t('Reviewed by Main'),
    delegated: t('Delegated by Main'), discarded: t('Dismissed by Main') })[status] ?? status
  const deliveryCopy = status => ({ pending: t('Delivery pending'), sent: t('Delivery sent'),
    dropped: t('Delivery dropped'), unknown: t('Delivery needs reconciliation') })[status] ?? status
  const deliveryPurposeCopy = purpose => ({ acknowledgement: t('Acknowledgement'), answer: t('Answer'),
    attention: t('Question'), result: t('Result'), policy: t('Policy update') })[purpose] ?? purpose
  const conditionCopy = state => ({ open: t('Pull request open'), draft: t('Pull request draft'),
    merged: t('Pull request merged'), closed: t('Pull request closed') })[state] ?? state
  const executionTargetCopy = target => ({ 'local-only': t('Local'), 'remote-only': t('Remote only'),
    auto: t('Auto') })[target] ?? target
  const executionSourceCopy = source => ({ default: t('Policy default'), ticket: t('Main request'),
    explicit: t('Exact Environment') })[source] ?? source
  const executionStatusCopy = status => ({ selected: t('Selected'),
    waiting: t('Waiting for an eligible Environment') })[status] ?? status
  const permissionLabels = { read: t('Read access'), write: t('Write access'), search: t('Search access'),
    command: t('Command access'), browser: t('Browser'), mcp: t('MCP'), office: t('Office') }
  const permissionCopy = values => (values ?? []).map(value => permissionLabels[value] ?? t(value)).join(', ')
  const capabilityReasonCopy = reason => {
    const target = /^target ([^ ]+) excludes (local|remote) Environments$/u.exec(reason)
    if (target) return t('target {target} excludes {kind} Environments',
      { target: executionTargetCopy(target[1]), kind: target[2] === 'local' ? t('Local') : t('Remote') })
    if (reason.startsWith('Environment is offline:')) return t('Environment is offline: {reason}',
      { reason: reason.slice('Environment is offline: '.length) })
    if (reason === 'Environment is offline') return t('Environment is offline')
    if (reason === 'Environment version is unverified') return t('Environment version is unverified')
    if (reason === 'Environment fingerprint is unverified') return t('Environment fingerprint is unverified')
    if (reason === 'Environment capacity is unknown') return t('Environment capacity is unknown')
    const missing = /^missing capability: ([^ (]+)(?: \((.+)\))?$/u.exec(reason)
    if (missing) return missing[2]
      ? t('Missing capability: {capability} ({detail})', { capability: t(missing[1]), detail: missing[2] })
      : t('Missing capability: {capability}', { capability: t(missing[1]) })
    const capacity = /^capacity is full \((.+)\)$/u.exec(reason)
    if (capacity) return t('Execution capacity is full ({count}).', { count: capacity[1] })
    return t(reason)
  }
  const handoffStatusCopy = status => ({ requested: t('Handoff requested'), blocked: t('Handoff blocked'),
    flushing: t('Flushing source Session'), switching: t('Switching execution Environment'),
    completed: t('Handoff completed'), prepared: t('Handoff prepared'), verified: t('Handoff copy verified'),
    'handoff-blocked': t('Handoff blocked'), available: t('Handoff available') })[status] ?? status
  const handoffOwnerCopy = owner => ({ worker: t('Worker'), operator: t('Operator'), human: t('You'),
    host: t('Host') })[owner] ?? t('Unknown')
  const handoffNextStepCopy = nextStep => ({ prepare: t('Choose a target Environment and prepare the work copy.'),
    synchronize: t('Synchronize the prepared changes to the target, then verify the copy.'),
    verify: t('Verify the prepared work copy before handing off.'),
    handoff: t('The copied work is verified. Hand off the same work when ready.'),
    reconcile: t('The Host is reconciling the original execution before switching generations.'),
    continue: t('Continue in the new execution Environment.'),
    resolve: t('Resolve the current handoff blocker.') })[nextStep] ?? t('Review the handoff state.')
  const handoffBlockerCopy = blocker => {
    const excluded = /^The (local|remote) Environment is excluded by the Ticket execution target (.+)$/u.exec(blocker.message)
    if (excluded) return t('The {kind} Environment is excluded by the Ticket execution target {target}.',
      { kind: excluded[1] === 'local' ? t('Local') : t('Remote'), target: executionTargetCopy(excluded[2]) })
    const unknownChange = /^The target has an unlisted change at (.+); it will not be overwritten\.$/u.exec(blocker.message)
    if (unknownChange) return t('The target has an unlisted change at {path}; it will not be overwritten.',
      { path: unknownChange[1] })
    const conflict = /^The target already has a different change at (.+)\.$/u.exec(blocker.message)
    if (conflict) return t('The target already has a different change at {path}.', { path: conflict[1] })
    const mismatch = /^The target content at (.+) does not match the prepared copy\.$/u.exec(blocker.message)
    if (mismatch) return t('The target content at {path} does not match the prepared copy.', { path: mismatch[1] })
    const messages = {
      'target-ineligible': t('The target Environment is not eligible for this handoff.'),
      'source-environment-changed': t('The source Environment changed after the work copy was prepared.'),
      'target-environment-changed': t('The target Environment changed after the work copy was prepared.'),
      'handoff-copy-missing': t('Prepare and verify a work copy before handing off.'),
      'handoff-copy-not-verified': t('The work copy has not been verified.'),
      'handoff-copy-stale': t('The work copy belongs to another execution generation or Environment.'),
      'assignment-changed': t('The work Assignment changed during the handoff.'),
      'source-changed': t('The source work copy changed after preparation.'),
      'target-commit-mismatch': t('The target repository version differs from the source.'),
      'target-missing-change': t('The target is missing a prepared work-copy file.'),
      'target-file-conflict': t('A prepared work-copy file conflicts with the target.'),
      'ticket-ended': t('The work has ended.'),
      'ticket-constrained': t('The work is stopped or waiting for a person.'),
      'ticket-stopping': t('The work has an active stop request.'),
      'waiting-human': t('Answer the current work question before handing off.'),
      'unknown-effect': t('Reconcile an external result before handing off.'),
      'handoff-superseded': t('The source Assignment was replaced before recovery.'),
      'session-flush-failed': t('The source Session could not be flushed.'),
      'handoff-recovery-failed': t('The interrupted handoff could not be reconciled.'),
      'active-turn': t('Wait for the Worker turn to reach a safe boundary.'),
      'active-job': t('Wait for the background job to settle.'),
      'active-subagent': t('Wait for the child Agent to settle.'),
      'active-preview': t('Close the retained preview before handing off.'),
      'handoff-stale': t('The work generation changed during the handoff.'),
      'handoff-revalidation-failed': t('The target or work copy could not be revalidated after flush.'),
      'same-environment': t('Choose a different target Environment.'),
      'no-assignment': t('The work has no active Assignment.'),
      'assignment-not-running': t('The source Assignment is not running.'),
      'ready-report': t('A verified result already ended this Assignment.'),
      'setup-failed': t('The source workspace setup failed.'),
      'processing-paused': t('Processing is paused, so a handoff cannot start.'),
      'WORK_COPY_UNSUPPORTED': t('The work copy uses a format or size outside the safe handoff limits.'),
      'WORK_COPY_GIT_FAILED': t('The work copy could not be inspected safely.'),
    }
    return messages[blocker.code] ?? t('This handoff step is blocked.')
  }
  function MainWorkHandoffPanel({ handoff, busy, canHandoff, onRun }) {
    const [targetId, setTargetId] = useState('')
    const targets = handoff.targets ?? []
    const copy = handoff.copy
    const record = handoff.record
    const selectedTarget = targets.find(target => target.id === targetId) ?? targets[0]
    const active = ['requested', 'flushing', 'switching'].includes(handoff.status)
    const completed = record?.state === 'completed'
    return h('section', {
      className: 'bt-main-work-handoff', 'aria-label': t('Execution Environment handoff') },
      h('h3', null, t('Execution Environment handoff')),
      h('p', { role: 'status' }, `${t('Handoff status')}: ${handoffStatusCopy(handoff.status)}`),
      h('p', { className: 'bt-main-work-detail' }, `${t('Responsible')}: ${handoffOwnerCopy(handoff.owner)}`),
      h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${handoffNextStepCopy(handoff.nextStep)}`),
      handoff.blockers?.length ? h('ul', { className: 'bt-main-work-handoff-blockers' }, handoff.blockers.map(blocker =>
        h('li', { key: `${blocker.code}:${blocker.message}` },
          `${handoffBlockerCopy(blocker)} · ${t('Responsible')}: ${handoffOwnerCopy(blocker.nextOwner)}`))) : null,
      copy ? h('div', { className: 'bt-main-work-handoff-copy' },
        h('p', null, `${t('Source')}: ${copy.source.id} · ${copy.source.root}`),
        h('p', null, `${t('Target')}: ${copy.target.id} · ${copy.target.root}`),
        h('p', null, `${t('Base version')}: ${copy.baseCommit.slice(0, 12)} · ${t('Changed files')}: ${copy.files.length}`
          + ` · ${copy.totalBytes} ${t('bytes')}`),
        h('ul', { 'aria-label': t('Prepared work-copy files') }, copy.files.map(file =>
          h('li', { key: file.path }, h('code', null, file.path), ` · ${t(file.state)} · ${file.bytes} ${t('bytes')}`)))) : null,
      canHandoff ? h('div', { className: 'bt-main-work-handoff-actions' },
        targets.length ? h('label', null, t('Handoff target'), h('select', {
          className: 'bt-select', 'aria-label': t('Handoff target'), value: selectedTarget?.id ?? '',
          disabled: busy, onChange: event => setTargetId(event.target.value),
        }, targets.map(target => h('option', { key: target.id, value: target.id },
          `${target.id} · ${target.kind === 'remote' ? t('Remote') : t('Local')}`
            + `${target.deviceId ? ` · ${t('Device')}: ${target.deviceId}` : ''}`)))) : null,
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || !selectedTarget,
          onClick: () => void onRun('work-handoff-prepare', selectedTarget.id) },
        busy === 'work-handoff-prepare' ? t('Preparing handoff…') : t('Prepare handoff')),
        copy && !active && !completed ? h('button', { type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => void onRun('work-handoff-verify') },
        busy === 'work-handoff-verify' ? t('Verifying handoff copy…') : t('Verify handoff copy')) : null,
        copy?.status === 'verified' && !active && !completed ? h('button', {
          type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => void onRun('work-handoff', selectedTarget.id),
        }, busy === 'work-handoff' ? t('Handing off…') : t('Hand off work')) : null,
        !targets.length ? h('p', { className: 'bt-main-work-detail' },
          t('No other Environment is available for handoff.')) : null) : null)
  }
  function MainWorkCard({ work, onEvidence, questionOnly = false, questionInComposer = false, showEvidence = false, onQuestionSettled }) {
    const state = useView()
    const canCommand = !state.connection?.connected || state.connection.capabilities.includes('command')
    const [controlBusy, setControlBusy] = useState(null)
    const [controlError, setControlError] = useState(null)
    const [toolFactsBusy, setToolFactsBusy] = useState(false)
    const [toolFactsError, setToolFactsError] = useState(null)
    const [attentionDraft, setAttentionDraft] = useState('')
    const control = work.control
    const [artifactBusy, setArtifactBusy] = useState(null)
    const [artifactError, setArtifactError] = useState(null)
    const [viewError, setViewError] = useState(null)
    const downloadArtifact = async artifact => {
      if (!state.binding) return
      setArtifactBusy(artifact.path); setArtifactError(null)
      try {
        const data = await readProductArtifact(productCall, state.binding.instanceId, work.brief.workItemId, artifact.path)
        offerDownload(data, artifact.path.split(/[\\/]/u).at(-1) || 'artifact')
      } catch (error) { setArtifactError(t(error.message)) }
      finally { setArtifactBusy(null) }
    }
    const assignment = control?.assignment
    const handoff = control?.handoff
    const runControl = async endpoint => {
      if (!state.binding || !control || !assignment && endpoint !== 'work-stop' && endpoint !== 'work-reconcile-stop') return
      setControlBusy(endpoint)
      setControlError(null)
      const payload = { instanceId: state.binding.instanceId, commandId: crypto.randomUUID(),
        workItemId: control.workItemId, ticketId: control.ticketId,
        ...(assignment ? { expectedGeneration: assignment.generation } : {}) }
      if (endpoint === 'work-stop') {
        payload.expectedTicketVersion = control.ticketVersion
        payload.reason = t('Stopped from the Main work card.')
      }
      if (endpoint === 'work-retry') payload.reason = t('Retry requested from the Main work card.')
      try {
        await productCall(endpoint, payload)
        await refreshMain(state.binding)
      } catch (error) {
        setControlError(error.message)
        await refreshMain(state.binding)
      } finally {
        setControlBusy(null)
      }
    }
    const runHandoff = async (endpoint, targetEnvironmentId) => {
      if (!state.binding || !control || !assignment || controlBusy) return
      if (endpoint !== 'work-handoff-verify' && !targetEnvironmentId) return
      setControlBusy(endpoint)
      setControlError(null)
      const payload = { instanceId: state.binding.instanceId, commandId: crypto.randomUUID(),
        workItemId: control.workItemId, ticketId: control.ticketId, expectedGeneration: assignment.generation,
        ...(endpoint === 'work-handoff-verify' ? {} : { targetEnvironmentId }),
        ...(endpoint === 'work-handoff' ? { reason: t('Hand off from the Main work card.') } : {}) }
      try {
        await productCall(endpoint, payload)
        await refreshMain(state.binding)
      } catch (error) {
        setControlError(error.message)
        await refreshMain(state.binding)
      } finally {
        setControlBusy(null)
      }
    }
    const stop = control?.stop
    const openToolFacts = async () => {
      if (!state.binding || !work.receipt.ticketId || toolFactsBusy) return
      setToolFactsBusy(true); setToolFactsError(null)
      try {
        const page = await productCall('observe-list', { instanceId: state.binding.instanceId,
          query: work.receipt.ticketId, limit: 100 })
        const item = page.items.find(candidate => candidate.role === 'worker' && candidate.ticketId === work.receipt.ticketId)
        if (!item) throw new Error(t('Worker activity is unavailable.'))
        view.set(current => ({ ...current, route: 'observe', selectedObservation: item,
          observationGeneration: item.generation ?? null, observation: null, observationError: null,
          observationDetail: null, observationDetailError: null }))
        if (nativeSession && !usesProductHistory(state)) ctx.layout.selectPanel('superagent-activity')
        await loadObservation(state.binding, item, { reset: true })
      } catch (error) { setToolFactsError(error.message) }
      finally { setToolFactsBusy(false) }
    }
    const attention = control?.attention
    const canAnswer = attention?.status === 'waiting' && canCommand && control.permissions.canAnswer && assignment
    const answer = async text => {
      if (!state.binding || !canAnswer || controlBusy || !text) return
      setControlBusy('work-answer')
      setControlError(null)
      try {
        await productCall('work-answer', { instanceId: state.binding.instanceId, commandId: crypto.randomUUID(),
          workItemId: control.workItemId, ticketId: control.ticketId, expectedGeneration: assignment.generation,
          attentionId: attention.id, attentionVersion: attention.version, text })
        setAttentionDraft('')
        await refreshMain(state.binding)
      } catch (error) {
        setControlError(error.message)
        await refreshMain(state.binding)
      } finally {
        await onQuestionSettled?.()
        setControlBusy(null)
      }
    }
    const answerView = async (action, values) => {
      if (!state.binding || !control || !assignment || !attention?.view) return
      setControlBusy('work-answer-view')
      setViewError(null)
      try {
        await productCall('work-answer-view', { instanceId: state.binding.instanceId, commandId: crypto.randomUUID(),
          workItemId: control.workItemId, ticketId: control.ticketId, expectedGeneration: assignment.generation,
          attentionId: attention.id, attentionVersion: attention.version, action, values })
        await refreshMain(state.binding)
      } catch (error) {
        setViewError(error.message)
        await refreshMain(state.binding)
      } finally {
        await onQuestionSettled?.()
        setControlBusy(null)
      }
    }
    const questionView = attention ? h('div', { className: 'bt-main-work-attention' },
      h('p', { className: 'bt-main-work-id' }, `${t(attention.view ? 'View version' : 'Question version')} ${attention.version} · ${attention.status}`),
      attention.view ? h(ProductWorkView, { title: attention.view.title, view: attention.view.view,
        answer: attention.answerView ?? null, busy: controlBusy === 'work-answer-view',
        ...(canAnswer && !questionInComposer ? { onSubmit: answerView } : {}) }) : h('p', null, attention.question),
      !attention.view && canAnswer && !questionInComposer ? h('form', { className: 'bt-main-work-answer', onSubmit: event => {
        event.preventDefault(); void answer(attentionDraft.trim())
      } },
        attention.options.length ? h('div', { className: 'bt-main-work-options' }, attention.options.map(option =>
          h('button', { key: option, type: 'button', className: 'bt-soft', onClick: () => setAttentionDraft(option) }, option))) : null,
        h('label', { htmlFor: `work-answer-${attention.id}` }, t('Answer this work question')),
        h('textarea', { id: `work-answer-${attention.id}`, value: attentionDraft, maxLength: 65536, rows: 2,
          placeholder: t('Type an answer…'), onChange: event => setAttentionDraft(event.currentTarget.value) }),
        h('button', { type: 'submit', className: 'bt-soft', disabled: Boolean(controlBusy) || !attentionDraft.trim() },
          controlBusy === 'work-answer' ? t('Sending answer…') : t('Send answer')))
        : attention.status === 'answered' ? h('p', { className: 'bt-main-work-detail' },
          `${t('Answered by')} ${attention.answeredBy ?? control.permissions.actorId}${attention.answerText ? `: ${attention.answerText}` : ''}`)
          : attention.status === 'waiting' && attention.view ? h('p', { className: 'bt-main-work-detail' }, t('Answer this view to continue the same work.'))
            : attention.status !== 'waiting' ? h('p', { className: 'bt-main-work-detail' }, t('This question is no longer active.')) : null) : null
    if (questionOnly) return canAnswer && !attention.view
      ? h(MainQuestion, { attention, goal: work.brief.goal, draft: attentionDraft, onDraft: setAttentionDraft, onSubmit: answer,
        busy: Boolean(controlBusy), error: controlError })
      : h('section', { className: 'bt-main-composer', 'data-main-question': '', 'aria-label': t('Question') }, questionView,
        viewError ? h('p', { className: 'bt-main-error', role: 'alert' }, viewError) : null)
    return h('article', { className: 'bt-main-work', 'aria-label': t('Work item: {goal}', { goal: work.brief.goal }),
      'data-ticket-id': control?.ticketId ?? work.receipt.ticketId, 'data-work-brief-id': work.brief.id, tabIndex: -1 },
      h('div', { className: 'bt-main-work-head' }, h('div', { className: 'bt-main-work-title' },
        h('span', { className: 'bt-main-work-source' }, t('System work fact')), h('strong', null, work.brief.goal)),
        h('span', { className: 'bt-main-work-status', role: 'status' }, statusCopy(work.status))),
      h('p', { className: 'bt-main-work-id' }, `${t('Work brief')} ${work.brief.id}`),
      work.brief.configurationRevision ? h('p', { className: 'bt-main-work-id' },
        `${t('Configuration version')} v${work.brief.configurationRevision}`) : null,
      work.brief.target ? h('p', { className: 'bt-main-work-id' },
        `${t('Execution target')}: ${executionTargetCopy(work.brief.target)}`) : null,
      work.brief.capabilities?.length ? h('p', { className: 'bt-main-work-id' },
        `${t('Required capabilities')}: ${permissionCopy(work.brief.capabilities)}`) : null,
      work.brief.directory ? h('p', { className: 'bt-main-work-id' }, `${t('Work directory')}: ${work.brief.directory}`) : null,
      work.executionLocation ? h('p', { className: 'bt-main-work-id' },
        `${t('Bound Environment')}: ${work.executionLocation.kind === 'remote' ? t('Remote') : t('Local')}`
        + `${work.executionLocation.deviceId ? ` · ${t('Device')}: ${work.executionLocation.deviceId}` : ''}`
        + ` · ${t('Directory')}: ${work.executionLocation.root}`
        + `${work.executionLocation.version ? ` · ${t('Version')}: ${work.executionLocation.version}` : ''}`) : null,
      work.executionSelection ? h('div', { className: 'bt-main-work-detail' },
        h('p', null, `${t('Selection basis')}: ${executionSourceCopy(work.executionSelection.source)} · ${executionStatusCopy(work.executionSelection.status)}`
          + `${work.executionSelection.reason ? ` · ${capabilityReasonCopy(work.executionSelection.reason)}` : ''}`),
        work.executionSelection.candidates?.length ? h('ul', null, work.executionSelection.candidates.slice(0, 8).map(candidate =>
          h('li', { key: candidate.id }, `${candidate.kind === 'remote' ? t('Remote') : t('Local')} · ${candidate.id}`
            + `${candidate.deviceId ? ` · ${t('Device')}: ${candidate.deviceId}` : ''} · ${candidate.eligible ? t('Eligible') : t('Not eligible')}`
            + `${candidate.permissions?.length ? ` · ${t('Capabilities')}: ${permissionCopy(candidate.permissions)}` : ''}`
            + `${candidate.reasons?.length ? ` · ${candidate.reasons.map(capabilityReasonCopy).join('; ')}` : ''}`))) : null) : null,
      h('p', { className: 'bt-main-work-id' }, `${t('Receipt')}: ${receiptCopy(work.receipt.status)}`),
      work.receipt.ticketId ? h('p', { className: 'bt-main-work-id' }, `${t('Ticket')} ${work.receipt.ticketId}`) : null,
      control ? h('p', { className: 'bt-main-work-id' }, `${t('Ticket version')}: ${control.ticketVersion}`) : null,
      assignment ? h('p', { className: 'bt-main-work-id' }, `${t('Execution version')}: ${assignment.generation}`) : null,
      control && canCommand && handoff ? h(MainWorkHandoffPanel, { handoff, busy: controlBusy,
        canHandoff: control.permissions.canHandoff, onRun: runHandoff }) : null,
      stop ? h('p', { className: 'bt-main-work-detail' }, stop.pendingDeviceConfirmation
        ? t('Stopping · waiting for device cancellation confirmation.')
        : stop.state === 'stopping' ? t('Stopping · waiting for the current execution to become quiet.')
        : stop.cancellationConfirmedAt ? t('Stopped · execution cancellation confirmed.')
          : t('Stopped · cancellation confirmation is unavailable.')) : null,
      stop?.pendingDeviceConfirmation && canCommand ? h('button', { type: 'button', className: 'bt-soft',
        disabled: Boolean(controlBusy), onClick: () => runControl('work-reconcile-stop') },
      controlBusy === 'work-reconcile-stop' ? t('Checking device stop…') : t('Check device stop')) : null,
      questionView,
      controlError ? h('p', { className: 'bt-main-error', role: 'alert' }, controlError) : null,
      viewError ? h('p', { className: 'bt-main-error', role: 'alert' }, viewError) : null,
      work.receipt.reason ? h('p', { className: 'bt-main-error' }, `${t('Work receipt')}: ${work.receipt.reason}`) : null,
      work.receipt.status === 'routing' ? h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.receipt.nextStep}`) : null,
      h('p', { className: 'bt-main-work-detail' }, `${t('Constraints')}: ${work.brief.constraints}`),
      h('p', { className: 'bt-main-work-detail' }, `${t('Acceptance criteria')}: ${work.brief.acceptanceCriteria}`),
      work.followUps?.length ? h('div', { className: 'bt-main-work-followups', 'aria-label': t('Follow-up history') },
        work.followUps.map(followUp => h('div', { key: followUp.id, className: 'bt-main-work-followup' },
          h('p', null, `${t('Direction v{version}', { version: followUp.directionVersion })}: ${followUpCopy(followUp.status)}`),
          h('p', { className: 'bt-main-work-detail' }, followUp.text),
          h('p', { className: 'bt-main-work-detail' },
            `${followUp.persisted ? t('Input persisted') : t('Input not yet persisted')} · ${followUp.adopted
              ? t('Direction adopted by Worker') : t('Direction not yet adopted')}`),
          followUp.displayReason
            ? h('p', { className: 'bt-main-work-detail' }, `${t('Reason')}: ${followUp.displayReason}`) : null))) : null,
      work.outcome ? h('div', { className: 'bt-main-work-result' },
        h('p', null, work.outcome.summary), h('p', { className: 'bt-main-work-detail' }, `${t('Verification')}: ${work.outcome.evidence}`),
        h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.outcome.nextStep}`),
        work.outcome.view ? h(ProductWorkView, { title: work.outcome.view.title, view: work.outcome.view.view }) : null,
        work.outcome.artifacts.map(artifact => h('p', { key: artifact.path, className: 'bt-main-work-artifact' },
          h('code', null, artifact.path), ' ', h('span', null, `${artifact.bytes} ${t('bytes')} · ${artifact.sha256.slice(0, 12)}`),
          artifact.reference && !state.connection?.connected ? h('button', { type: 'button', className: 'bt-soft',
            disabled: artifactBusy === artifact.path, onClick: () => void downloadArtifact(artifact) },
          artifactBusy === artifact.path ? t('Loading…') : t('Download')) : null))) : null,
      artifactError ? h('p', { className: 'bt-main-error', role: 'alert' }, artifactError) : null,
      toolFactsError ? h('p', { className: 'bt-main-error', role: 'alert' }, toolFactsError) : null,
      control && canCommand ? h('div', { className: 'bt-main-work-controls' },
        control.permissions.canStop ? h('button', { type: 'button', className: 'bt-soft',
          disabled: Boolean(controlBusy), onClick: () => runControl('work-stop') },
        controlBusy === 'work-stop' ? t('Stopping…') : t('Stop work')) : null,
        assignment && control.permissions.canResume ? h('button', { type: 'button', className: 'bt-soft',
          disabled: Boolean(controlBusy), onClick: () => runControl('work-resume') },
        controlBusy === 'work-resume' ? t('Resuming…') : t('Resume work')) : null,
        assignment && control.permissions.canRetry ? h('button', { type: 'button', className: 'bt-soft',
          disabled: Boolean(controlBusy), onClick: () => runControl('work-retry') },
        controlBusy === 'work-retry' ? t('Retrying…') : t('Retry work')) : null) : null,
      work.receipt.status === 'accepted' ? h('div', { className: 'bt-main-work-evidence-actions' },
        h('button', { type: 'button', className: 'bt-soft', onClick: () => onEvidence(work) }, t('View original request')),
        h('button', { type: 'button', className: 'bt-soft', disabled: toolFactsBusy, onClick: () => void openToolFacts() },
          toolFactsBusy ? t('Loading…') : t('View tool facts'))) : null,
      showEvidence && state.mainEvidenceWorkItemId === work.brief.workItemId ? h(MainEvidence) : null)
  }

  function MainEvidence() {
    const state = useView()
    const evidence = state.mainEvidence
    if (!evidence) return state.mainEvidenceError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.mainEvidenceError)
      : state.mainEvidenceLoading ? h('p', { role: 'status' }, t('Loading…')) : null
    return h('section', { className: 'bt-main-evidence', 'aria-label': t('Original request evidence') },
      h('div', { className: 'bt-main-evidence-head' }, h('div', null,
        h('strong', null, t('Original request evidence')), h('p', null, t(evidence.goal))),
      h('span', null, t(evidence.pagination.truncated ? 'Partial evidence' : 'Complete evidence'))),
      h('pre', null, redactObservationText(evidence.text)),
      state.mainEvidenceError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.mainEvidenceError) : null,
      evidence.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft', disabled: state.mainEvidenceLoading,
        onClick: () => void loadMainEvidence(state.binding, { brief: evidence }, { append: true }) },
      state.mainEvidenceLoading ? t('Loading…') : t('Load more evidence')) : null)
  }

  function MainAttachmentLinks({ attachments }) {
    const state = useView()
    const [error, setError] = useState(null)
    const download = async attachment => {
      setError(null)
      try {
        const data = await readProductAttachment(productCall, state.binding.instanceId, attachment.id)
        offerDownload(data, attachment.name, attachment.mediaType)
      } catch (failure) { setError(failure.message) }
    }
    return h('div', { className: 'bt-main-message-attachments', 'aria-label': t('Attached files') },
      attachments.map(attachment => h('button', { key: attachment.id, type: 'button', className: 'bt-soft',
        disabled: Boolean(state.connection?.connected), onClick: () => void download(attachment) },
      `${t('Download')} ${attachment.name} · ${attachment.bytes} ${t('bytes')}`)),
      error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null)
  }

  function MainPreparationCard({ preparation }) {
    const state = useView()
    const [expanded, setExpanded] = useState(false)
    return h('article', { className: 'bt-main-work', 'aria-label': t('Prepared review') },
      h('div', { className: 'bt-main-work-head' }, h('strong', null, t('Prepared review')),
        h('span', { className: 'bt-main-work-status' }, preparation.ruleId)),
      h('p', { className: 'bt-main-work-detail' }, preparation.summary),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': expanded,
        onClick: () => setExpanded(value => !value) }, t(expanded ? 'Hide review' : 'Review')),
      expanded ? h(ProactiveReview, { runId: preparation.id, instanceId: state.binding.instanceId,
        call: productCall, remote: Boolean(state.connection?.connected),
        canStop: !state.connection?.connected || state.connection.capabilities.includes('command'),
        onStopped: () => { void refreshMain(state.binding) } }) : null)
  }

  function MainSourceCard({ source, instanceId, onRefresh, canCommand }) {
    const [receipts, setReceipts] = useState(source.deliveries ?? [])
    const [receiptCursor, setReceiptCursor] = useState(source.deliveryCursor ?? null)
    const [receiptsBusy, setReceiptsBusy] = useState(false)
    const [receiptsError, setReceiptsError] = useState(null)
    const [reconciling, setReconciling] = useState(null)
    const receiptPagesLoaded = useRef(false)
    useEffect(() => {
      setReceipts(current => {
        const merged = new Map(current.map(receipt => [`${receipt.ticketId}:${receipt.id}:${receipt.sequence}`, receipt]))
        for (const receipt of source.deliveries ?? []) merged.set(`${receipt.ticketId}:${receipt.id}:${receipt.sequence}`, receipt)
        return [...merged.values()].sort((left, right) => right.createdAt - left.createdAt || right.sequence - left.sequence
          || left.ticketId.localeCompare(right.ticketId) || left.id.localeCompare(right.id))
      })
      if (!receiptPagesLoaded.current) setReceiptCursor(source.deliveryCursor ?? null)
    }, [source.deliveries, source.deliveryCursor])
    const loadEarlierReceipts = async () => {
      if (!receiptCursor || receiptsBusy) return
      receiptPagesLoaded.current = true
      setReceiptsBusy(true); setReceiptsError(null)
      try {
        const page = await productCall('source-deliveries', { instanceId, sourceId: source.id, after: receiptCursor, limit: 10 })
        setReceipts(current => {
          const merged = new Map(current.map(receipt => [`${receipt.ticketId}:${receipt.id}:${receipt.sequence}`, receipt]))
          for (const receipt of page.items) merged.set(`${receipt.ticketId}:${receipt.id}:${receipt.sequence}`, receipt)
          return [...merged.values()].sort((left, right) => right.createdAt - left.createdAt || right.sequence - left.sequence
            || left.ticketId.localeCompare(right.ticketId) || left.id.localeCompare(right.id))
        })
        setReceiptCursor(page.cursor ?? null)
      } catch (error) { setReceiptsError(error.message) }
      finally { setReceiptsBusy(false) }
    }
    const reconcile = async receipt => {
      if (reconciling) return
      setReconciling(receipt.id); setReceiptsError(null)
      try {
        await productCall('reconcile-delivery', { instanceId, commandId: `reconcile:${receipt.ticketId}:${receipt.id}:${receipt.sequence}`,
          ticketId: receipt.ticketId, deliveryId: receipt.id })
        await onRefresh()
      } catch (error) { setReceiptsError(error.message) }
      finally { setReconciling(null) }
    }
    const scheduled = source.sourceInstanceId.startsWith('schedule:')
    const feishu = source.sourceInstanceId.startsWith('feishu:')
    const im = source.sourceInstanceId.startsWith('im:')
    return h('article', { className: 'bt-main-source', 'aria-label': t(im ? 'Paired IM message' : scheduled ? 'Scheduled occurrence' : feishu ? 'Feishu source request' : 'GitHub source request') },
      h('div', { className: 'bt-main-work-head' }, h('strong', null, t(im ? 'Paired IM message' : scheduled ? 'Scheduled occurrence' : feishu ? 'Feishu request' : 'GitHub request')),
        h('span', { className: 'bt-main-work-status', role: 'status' }, sourceStatusCopy(source.state))),
      h('p', { className: 'bt-main-work-detail' }, `${source.objectId} · @${source.authorId}`),
      h('p', { className: 'bt-main-work-detail' }, source.text),
      h('code', { className: 'bt-main-source-reference' }, source.reference),
      source.lastError ? h('p', { className: 'bt-main-error', role: 'status' }, `${t('Main source failed')}: ${source.lastError}`) : null,
      receipts.length ? h('div', { className: 'bt-main-source-deliveries', 'aria-label': t('Delivery receipts') },
        receipts.map(delivery => h('div', {
          key: `${delivery.ticketId}:${delivery.id}:${delivery.sequence}`, className: delivery.state === 'unknown' ? 'bt-main-error' : 'bt-main-work-detail',
        },
        h('p', null, `${deliveryPurposeCopy(delivery.purpose)}: ${deliveryCopy(delivery.state)}${delivery.reason ? ` · ${delivery.reason}` : ''}`),
        h('p', null, `${delivery.destination.sourceInstanceId} · ${delivery.destination.eventId}${delivery.destination.threadId ? ` · ${delivery.destination.threadId}` : ''} · @${delivery.destination.actorId}`),
        canCommand && (delivery.state === 'unknown' || (delivery.state === 'pending' && delivery.attempts > 0)) ? h('button', { type: 'button', className: 'bt-soft',
          disabled: reconciling === delivery.id, onClick: () => void reconcile(delivery) },
        reconciling === delivery.id ? t('Reconciling…') : t('Reconcile delivery')) : null)),
        receiptCursor ? h('button', { type: 'button', className: 'bt-soft', disabled: receiptsBusy,
          onClick: () => void loadEarlierReceipts() }, receiptsBusy ? t('Loading…') : t('Load earlier receipts')) : null,
        receiptsError ? h('p', { className: 'bt-main-error', role: 'status' }, receiptsError) : null) : null,
      !feishu && source.conditions.length ? h('div', { className: 'bt-main-source-deliveries', 'aria-label': t('Pull request conditions') },
        source.conditions.map(condition => h('p', { key: `${condition.ticketId}:${condition.number}`, className: 'bt-main-work-detail' },
          `#${condition.number}: ${conditionCopy(condition.state)}${condition.reason ? ` · ${condition.reason}` : ''}`))) : null)
  }

  function MainConversation({ composerOnly = false, sessionEvents } = {}) {
    useModelSlots()
    const state = useView()
    const canCommand = !state.connection?.connected || state.connection.capabilities.includes('command')
    const question = canCommand && pendingQuestion(state)
    const voiceState = useSyncExternalStore(mainVoice.subscribe, mainVoice.getSnapshot)
    useEffect(() => {
      if (!state.restoreMainFocus) return
      const input = document.getElementById('main-message')
        ?? document.querySelector('.bt-q-dock :is(textarea, button):enabled, [data-main-question] button:enabled')
      if (!input) return
      input.focus({ preventScroll: true, focusVisible: true })
      view.set(current => ({ ...current, restoreMainFocus: false }))
    }, [state.restoreMainFocus, question])
    const turnCards = projectTurnCards(state)
    const renderCards = cards => cards ? h(Fragment, null,
      cards.sources.map(source => h(MainSourceCard, { key: source.id, source, instanceId: state.binding?.instanceId, onRefresh: refresh, canCommand })),
      cards.preparations.map(preparation => h(MainPreparationCard, { key: preparation.id, preparation })),
      cards.works.map(work => h(MainWorkCard, { key: work.brief.workItemId ?? work.brief.id, work,
        questionInComposer: work === question,
        onEvidence: selected => { if (state.binding) void loadMainEvidence(state.binding, selected) } }))) : null
    const [sendError, setSendError] = useState(null)
    const { mainAttachments: attachments, mainUploading: uploading } = state
    const setAttachments = update => view.set(current => ({ ...current,
      mainAttachments: typeof update === 'function' ? update(current.mainAttachments) : update }))
    const setUploading = mainUploading => view.set(current => ({ ...current, mainUploading }))
    const [speakingId, setSpeakingId] = useState(null)
    useEffect(() => () => {
      if (composerOnly && nativeQuestion(view.getSnapshot())) mainVoice.pause()
      else mainVoice.close()
      window.speechSynthesis?.cancel()
    }, [composerOnly, state.binding?.mainSessionId])
    useEffect(() => {
      const acknowledge = () => {
        if (!document.hasFocus() || document.visibilityState === 'hidden') return
        view.set(current => {
          const readReplyId = current.messages.findLast(message => message.role === 'main')?.id ?? null
          return current.readReplyId === readReplyId ? current : { ...current, readReplyId }
        })
      }
      acknowledge()
      window.addEventListener('focus', acknowledge)
      document.addEventListener('visibilitychange', acknowledge)
      return () => {
        window.removeEventListener('focus', acknowledge)
        document.removeEventListener('visibilitychange', acknowledge)
      }
    }, [])
    const bottom = useRef(null)
    const pending = useRef(null)
    const scroll = useRef(null)
    const follow = useRef(true)
    const restoreHeight = useRef(null)
    const execution = state.directoryOptions?.execution
    const executionTarget = effectiveTarget(state)
    const localEnvironments = execution?.environments?.filter(environment => environment.kind === 'local') ?? []
    const remoteEnvironments = execution?.environments?.filter(environment => environment.kind === 'remote') ?? []
    const selectedRemoteEnvironment = remoteEnvironments.find(environment =>
      environment.id === state.remoteEnvironmentOverride) ?? remoteEnvironments[0]
    const selectedLocalEnvironmentId = state.directoryOverride?.id ?? state.directoryOptions?.default?.environmentId
      ?? state.localEnvironmentOverride ?? (state.connection?.connected ? localEnvironments[0]?.id : undefined)
    const selectedEnvironmentId = executionTarget === 'remote-only' ? selectedRemoteEnvironment?.id
      : executionTarget === 'local-only' ? selectedLocalEnvironmentId : undefined
    const selectedEnvironment = execution?.environments?.find(environment => environment.id === selectedEnvironmentId)
    useEffect(() => {
      if (restoreHeight.current !== null && scroll.current) {
        scroll.current.scrollTop += scroll.current.scrollHeight - restoreHeight.current
        restoreHeight.current = null
      } else if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
    }, [state.messages.length])
    const uploadFiles = async files => {
      if (view.getSnapshot().directoryBusy) return
      if (executionTarget === 'auto') { setSendError(t('Choose Local or Remote only before adding files.')); return }
      const environmentId = selectedEnvironmentId
      if (!state.binding || !environmentId) { setSendError(t('Choose a work directory before adding files.')); return }
      if (attachments.some(attachment => attachment.environmentId !== environmentId)) {
        setSendError(t('Remove attached files before changing directories.')); return
      }
      if (attachments.length + files.length > 10) { setSendError(t('Attach at most ten files.')); return }
      setUploading(true); setSendError(null)
      try {
        for (const file of files) {
          const payload = await uploadPayload(file)
          const uploaded = await uploadWithRetry(productCall, sessionStorage, state.binding.instanceId, environmentId, payload)
          setAttachments(current => current.some(item => item.id === uploaded.id) ? current : [...current, uploaded])
        }
      } catch (error) { setSendError(t(error.message)) }
      finally { setUploading(false) }
    }
    const removeAttachment = async attachment => {
      if (!state.binding) return
      try {
        await productCall('attachment-revoke', { instanceId: state.binding.instanceId, id: attachment.id })
        setAttachments(current => current.filter(item => item.id !== attachment.id))
      } catch (error) { setSendError(t(error.message)) }
    }
    const speakReply = message => {
      if (speakingId === message.id) { window.speechSynthesis.cancel(); setSpeakingId(null); return }
      const text = plainSpeech(message.text)
      if (!text || !window.speechSynthesis) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = /[\u3400-\u9fff]/u.test(text) ? 'zh-CN' : 'en-US'
      utterance.onend = () => setSpeakingId(current => current === message.id ? null : current)
      utterance.onerror = utterance.onend
      window.speechSynthesis.speak(utterance)
      setSpeakingId(message.id)
    }
    const send = async text => {
      const current = view.getSnapshot()
      if (!state.binding) throw new Error(t('Main is unavailable.'))
      if (current.directoryBusy || current.mainSending) throw new Error(t('Wait for the current action before sending.'))
      const attachmentIds = attachments.map(attachment => attachment.id)
      const environmentId = attachments[0]?.environmentId ?? selectedEnvironmentId
      if (executionTarget === 'local-only' && !environmentId || attachmentIds.length && !environmentId) {
        throw new Error(t('Choose an authorized Environment for this execution target.'))
      }
      if (executionTarget === 'auto' && attachmentIds.length) {
        throw new Error(t('Remove attached files before using automatic target selection.'))
      }
      const storageKey = `superagent:pending:${state.connection?.connected
        ? `${state.connection.address}:${state.connection.client.id}` : 'local'}:${state.binding.instanceId}`
      try {
        view.set(current => ({ ...current, mainSending: true })); setSendError(null)
        if (!pending.current) {
          try { pending.current = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') } catch { /* Draft storage is optional. */ }
        }
        if (!pending.current || pending.current.text !== text
          || pending.current.target !== executionTarget
          || pending.current.environmentId !== environmentId
          || JSON.stringify(pending.current.attachments ?? []) !== JSON.stringify(attachmentIds)) {
          pending.current = { commandId: crypto.randomUUID(), text,
          ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
          target: executionTarget, ...(environmentId ? { environmentId } : {}) }
        }
        try { sessionStorage.setItem(storageKey, JSON.stringify(pending.current)) } catch { /* The stable identity still lives until this window closes. */ }
        const result = await productCall('send', { instanceId: state.binding.instanceId, ...pending.current })
        pending.current = null
        try { sessionStorage.removeItem(storageKey) } catch { /* Draft storage is optional. */ }
        setAttachments([])
        view.set(current => ({ ...current, ...(executionTarget === 'local-only' ? { directoryOverride: null } : {}),
          localEnvironmentOverride: null, remoteEnvironmentOverride: null, directoryError: null }))
        await refreshMain(state.binding)
        return result
      } catch (error) { await refreshMain(state.binding); throw error }
      finally { view.set(current => ({ ...current, mainSending: false })) }
    }
    const sendText = async text => {
      try {
        const receipt = await send(text)
        if (receipt.status === 'failed') throw new Error(t('Main could not finish this reply. Your message is saved.'))
        return true
      } catch (error) { setSendError(error.message); return false }
    }
    const latestSend = useRef(send)
    latestSend.current = send
    const startVoice = () => {
      setSendError(null)
      if (speakingId) {
        window.speechSynthesis?.cancel()
        setSpeakingId(null)
      }
      mainVoice.start(text => latestSend.current(text))
    }
    const busy = mainBusy(state)
    const stopping = state.activeTurn?.status === 'stopping'
    const stop = async () => {
      if (!state.binding || !state.activeTurn) return
      mainVoice.pause()
      try {
        setSendError(null)
        await call('stop-chat', { botId: state.binding.mainId, messageId: state.activeTurn.messageId })
        await refreshMain(state.binding)
      } catch (error) {
        setSendError(error.message)
      }
    }
    const chooseTarget = value => {
      if (attachments.length) { setSendError(t('Remove attached files before changing execution targets.')); return }
      view.set(current => ({ ...current, executionTarget: value, localEnvironmentOverride: null, remoteEnvironmentOverride: null }))
    }
    const targetControl = execution ? h('div', { className: 'bt-main-directory' },
      h('span', { className: 'bt-main-label' }, t('Execution target')),
      h('select', { className: 'bt-select', 'aria-label': t('Execution target'), value: executionTarget,
        onChange: event => chooseTarget(event.target.value), disabled: busy || state.directoryBusy },
      h('option', { value: 'local-only' }, t('Local')),
      h('option', { value: 'remote-only' }, t('Remote only')),
      h('option', { value: 'auto' }, t('Auto'))),
      executionTarget === 'remote-only' ? h('select', { className: 'bt-select', 'aria-label': t('Remote Environment'),
        value: selectedRemoteEnvironment?.id ?? '', onChange: event => {
          if (attachments.length) { setSendError(t('Remove attached files before changing Environments.')); return }
          view.set(current => ({ ...current, remoteEnvironmentOverride: event.target.value || null }))
        }, disabled: busy },
      h('option', { value: '' }, t('Choose an authorized remote Environment')),
      remoteEnvironments.map(environment => h('option', { key: environment.id, value: environment.id },
        `${environment.label || environment.title || environment.id} · ${environment.root}`))) : null,
      state.connection?.connected && executionTarget === 'local-only' ? h('select', { className: 'bt-select',
        'aria-label': t('Local Environment'), value: selectedLocalEnvironmentId ?? '',
        onChange: event => view.set(current => ({ ...current, localEnvironmentOverride: event.target.value || null })) },
      h('option', { value: '' }, t('Choose an authorized local Environment')),
      localEnvironments.map(environment => h('option', { key: environment.id, value: environment.id },
        `${environment.title || environment.id} · ${environment.root}`))) : null,
      selectedEnvironment ? h('span', { className: 'bt-main-directory-note' },
        `${selectedEnvironment.eligible ? t('Eligible') : t('Not eligible')}`
        + `${selectedEnvironment.version ? ` · ${t('Version')}: ${selectedEnvironment.version}` : ''}`
        + `${selectedEnvironment.deviceId ? ` · ${t('Device')}: ${selectedEnvironment.deviceId}` : ''}`
        + `${selectedEnvironment.reasons?.length ? ` · ${selectedEnvironment.reasons.map(capabilityReasonCopy).join('; ')}` : ''}`) : null,
      h('span', { className: 'bt-main-directory-note' }, executionTarget === 'auto'
        ? t('This work chooses an eligible Environment when its Ticket starts. Attachments need an exact target.')
        : executionTarget === 'remote-only' && !selectedEnvironmentId
          ? t('No remote Environment is available. This work will wait for an eligible device.')
          : t('New work uses this Environment. Active work keeps its original binding.'))) : null
    const composer = question ? h(MainWorkCard, { work: question, questionOnly: true, key: question.control.attention.id })
      : h(MainComposer, { onSend: sendText, onStop: canCommand && state.activeTurn ? stop : undefined, busy, stopping,
      directoryBusy: state.directoryBusy, ready: Boolean(state.binding && execution), readOnly: !canCommand,
      error: sendError ?? state.error,
      value: state.mainDraft, onValueChange: mainDraft => view.set(current => ({ ...current, mainDraft })),
      voice: voiceState, onVoiceStart: state.binding ? startVoice : undefined,
      onVoicePause: () => mainVoice.pause(), onVoiceResume: startVoice, onVoiceClose: mainVoice.close,
      attachments, uploading, onRemoveAttachment: removeAttachment,
      speechRemote: () => ctx.get('remote.speech') ?? undefined,
      onFiles: !state.connection?.connected && executionTarget !== 'auto' && selectedEnvironmentId
        ? files => void uploadFiles(files) : undefined,
      directoryControl: execution ? h('div', { className: 'bt-main-directory' },
        targetControl, h(MainWorkDirectory)) : null })
    const showModelSetup = !question && state.binding && !state.connection?.connected
    let modelChoice
    if (showModelSetup && state.mainModelSetup) {
      modelChoice = h(SuperagentModelChoice, { setup: state.mainModelSetup, saveKey: saveSetupKey,
        refreshModels: refreshModelSettings, focusMain: focusMainInput,
        signIn: canSignIn() ? openSignIn : undefined, openModels: () => shellActions.openSettings('models'),
        openCustomModels: hasNativeSettings('models') ? openCustomModels : undefined,
        openRoles: () => shellActions.openSettings('roles') })
    } else if (showModelSetup && state.modelSettingsError) {
      modelChoice = h('div', { className: 'bt-superagent-model-dock' },
        h('p', { className: 'bt-main-error', role: 'alert' }, t('Could not check which models are available.')),
        h('button', { className: 'bt-model-chip', type: 'button', onClick: () => { void refreshModelSettings() } }, t('Retry')))
    }
    if (composerOnly) {
      const entries = sessionEvents?.entries ?? []
      const userEvents = entries.filter(({ event }) => event.type === 'user/message')
      const visible = new Set(userEvents.map(({ event }) => event.data.id))
      const cutoff = sessionEvents?.hasMore ? entries[0]?.event.time : 0
      const pending = cutoff === undefined ? [] : state.messages.filter(message => message.role === 'user'
        && message.status !== 'completed' && message.createdAt >= cutoff && !visible.has(message.id))
      const unplaced = projectNativeTurnCards(state, visible, true)
      return h('div', { className: 'bt-native-main-input' },
        h(FeishuSourceStatus, { instanceId: state.binding?.instanceId, call: productCall }),
        state.binding && !state.connection?.connected ? h(ChatSecrets, { binding: state.binding, call: productCall }) : null,
        pending.map(message => h('details', { key: message.id, className: 'bt-main-status' },
          h('summary', null, `${t('Input')} · ${mainInputStatus(message.status)}`), h('p', null, message.text),
          message.attachments?.length ? h(MainAttachmentLinks, { attachments: message.attachments }) : null)),
        unplaced.works.length || unplaced.sources.length || unplaced.preparations.length ? h('details', { className: 'bt-native-turn-cards' },
          h('summary', null, t('Work, sources and preparations')), renderCards(unplaced)) : null,
        h(BoardSurface, { dock: true }),
        modelChoice, composer)
    }
    return h('section', { className: 'bt-main-conversation', 'aria-label': 'Main' },
      h('header', { className: 'bt-main-header' }, h(Header),
        h('span', { className: `bt-main-health bt-main-health-${state.health?.state ?? 'ready'}`, role: 'status' },
          state.modelsNeedSetup && state.health?.state !== 'running' ? t('Models need setup') : mainHealthCopy(state.health)),
        state.health?.queuedInputs ? h('span', { className: 'bt-main-health-detail' },
          t('{count} inputs queued', { count: state.health.queuedInputs })) : null,
        state.connection?.connected ? h('span', { className: 'bt-main-remote', title: state.connection.address },
          `${t('Remote Host')} · ${state.connection.client.label}`) : null,
        h('button', { type: 'button', className: 'bt-soft', onClick: () => view.set(current => ({ ...current, route: 'work' })) }, t('Work')),
        clientBridge() ? h('button', { type: 'button', className: 'bt-soft', onClick: () => view.set(current => ({ ...current, connectOpen: true })) },
          state.connection?.connected ? t('Connection') : t('Connect to Host')) : null,
        !state.connection?.connected ? h('button', { type: 'button', className: 'bt-icon-btn bt-main-settings', title: t('Settings'),
          'aria-label': t('Settings'), onClick: () => shellActions.openSettings() }, h(SlidersIcon)) : null),
      state.modelsNeedSetup ? h('p', { className: 'bt-main-health-warning', role: 'alert' },
        t('Open Settings to select models for Main, Router and Worker.'))
        : state.health?.state === 'degraded' ? h('p', { className: 'bt-main-health-warning', role: 'alert' },
        t(state.connection?.connected ? 'Main model failed. Ask the Host operator to check the model and provider configuration.'
          : 'Main model failed. Check the model and provider credentials in Settings.')) : null,
      h('div', { className: 'bt-main-history', ref: scroll, onScroll: () => { const node = scroll.current; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 } },
        h('div', { className: 'bt-main-messages' },
          !state.messagesComplete && state.messageBefore ? h('button', { type: 'button', className: 'bt-soft bt-main-history-more',
            disabled: state.messagesLoading, onClick: async () => {
              follow.current = false
              restoreHeight.current = scroll.current?.scrollHeight ?? null
              await loadEarlierMessages(state.binding)
            } }, state.messagesLoading ? t('Loading…') : t('Load earlier messages')) : null,
          state.messages.length === 0 ? h('p', { className: 'bt-main-empty' }, t('What would you like to discuss?')) : null,
          state.messages.map(message => h('div', { key: message.id },
            message.role === 'system'
              ? h('div', { className: 'bt-main-system-fact', role: 'status' },
                h('span', null, t('System fact')), h('p', null, message.text))
              : h('div', null,
                message.source ? h('p', { className: 'bt-main-source-label' },
                  message.source.kind === 'client' ? `${t('Client')} · ${message.source.clientId}`
                    : message.source.kind === 'schedule' ? `${t('Scheduled occurrence')} · ${message.source.objectId}`
                      : `${t(message.source.kind === 'im' ? 'IM' : message.source.kind === 'feishu' ? 'Feishu' : 'GitHub')} · @${message.source.authorId} · ${message.source.objectId}`) : null,
                h(ProductChatRow, { kind: message.role === 'main' ? 'bot' : 'user', text: message.text }),
                voiceState.phase === 'off' && message.role === 'main' && message.text && window.speechSynthesis
                  ? h('button', { type: 'button', className: 'bt-soft bt-main-read-aloud',
                    onClick: () => speakReply(message) }, t(speakingId === message.id ? 'Stop reading' : 'Read aloud')) : null,
                message.attachments?.length ? h(MainAttachmentLinks, { attachments: message.attachments }) : null,
                message.status === 'failed' ? h('p', { className: 'bt-main-error', role: 'status' },
                  t('Main could not finish this reply. Your message is saved.')) : null),
            renderCards(turnCards.byMessage.get(message.id)))),
          !state.connection?.connected ? h(FeishuSourceStatus, { instanceId: state.binding?.instanceId, call: productCall }) : null,
          state.binding && !state.connection?.connected ? h(ChatSecrets, { binding: state.binding, call: productCall }) : null,
          renderCards(turnCards.unplaced),
          h(MainEvidence),
          stopping ? h('p', { className: 'bt-main-status', role: 'status' }, t('Stopping this Main reply…')) : busy
            ? h('p', { className: 'bt-main-status', role: 'status' }, t('Main is replying…')) : null,
          h('div', { ref: bottom }))),
      h(BoardSurface, { dock: true }), modelChoice, composer)
  }

  function ObservationConversation({ onBack } = {}) {
    const state = useView()
    const [copyState, setCopyState] = useState('idle')
    const [detailCopyState, setDetailCopyState] = useState('idle')
    const observation = state.observation
    const openDetail = (detailId, append = false) => {
      if (state.binding && state.selectedObservation) {
        void loadObservationDetail(state.binding, state.selectedObservation, detailId, { append })
      }
    }
    const copy = async () => {
      if (!observation || !state.binding) return
      try {
        await navigator.clipboard.writeText(JSON.stringify({ ...observation, instanceId: state.binding.instanceId }, null, 2))
        setCopyState('copied')
        setTimeout(() => setCopyState('idle'), 1600)
      } catch {
        setCopyState('failed')
      }
    }
    const copyDetail = async () => {
      if (!state.observationDetail) return
      try {
        await navigator.clipboard.writeText(state.observationDetail.text)
        setDetailCopyState('copied')
        setTimeout(() => setDetailCopyState('idle'), 1600)
      } catch {
        setDetailCopyState('failed')
      }
    }
    return h('section', { className: 'bt-observation', 'aria-label': t('Read-only work activity') },
      h('header', { className: 'bt-observation-header' },
        onBack ? h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, t('Back to Main')) : h(Header),
        h('div', { className: 'bt-observation-heading' },
          h('span', { className: 'bt-observation-role' }, observation?.role === 'router' ? 'Router' : 'Worker'),
          h('strong', null, observation?.title ?? state.selectedObservation?.title ?? '')),
        h('span', { className: 'bt-observation-readonly' }, t('Read-only')),
        !state.connection?.connected ? h('button', { type: 'button', className: 'bt-icon-btn', title: t('Settings'), 'aria-label': t('Settings'),
          onClick: () => shellActions.openSettings() }, h(SlidersIcon)) : null),
      h('div', { className: 'bt-observation-body' },
        h(ActivityNavigation),
        state.observationLoading && !observation ? h('p', { role: 'status', className: 'bt-main-status' }, t('Loading history…')) : null,
        state.observationError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.observationError) : null,
        observation ? h('div', { className: 'bt-observation-content' },
          h('div', { className: 'bt-observation-summary' },
            h('div', null, h('p', { className: 'bt-observation-status', role: 'status' },
              `${statusCopy(observation.status)}${observation.generation && !observation.current ? ` · ${t('Historical generation')}` : ''}`),
              h('p', null, t(observation.summary)),
              h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${t(observation.nextStep)}`)),
              observation.historyStatus === 'missing' ? h('p', { className: 'bt-main-error', role: 'alert' },
                t('The Session history is missing. Durable work facts remain available.')) : null,
              observation.historyStatus === 'not-started' ? h('p', { className: 'bt-main-status', role: 'status' },
                t('The assigned Session has not started.')) : null,
            h('div', { className: 'bt-observation-actions' },
              h('button', { type: 'button', className: 'bt-soft', onClick: copy },
                copyState === 'copied' ? t('Copied') : copyState === 'failed' ? t('Copy failed') : t('Copy details')))),
          h('dl', { className: 'bt-observation-facts' }, observation.facts.map((fact, index) => h('div', { key: `${fact.label}:${index}` },
            h('dt', null, t(fact.label)), h('dd', null,
              h('span', null, t(fact.value)),
              fact.detailId ? h('button', { type: 'button', className: 'bt-soft bt-observation-detail-open',
                onClick: () => openDetail(fact.detailId) },
              `${t('View full detail')}${fact.detailBytes ? ` · ${fact.detailBytes} ${t('bytes')}` : ''}`) : null)))),
          state.observationDetail ? h('section', { className: 'bt-observation-detail', 'aria-label': t('Full detail') },
            h('div', { className: 'bt-observation-detail-head' }, h('h2', null, t(state.observationDetail.label)),
              h('span', null, `${state.observationDetail.bytes} ${t('bytes')}`)),
            h('pre', null, redactObservationText(state.observationDetail.text)),
            h('div', { className: 'bt-observation-detail-actions' },
              state.observationDetail.hasMore ? h('button', { type: 'button', className: 'bt-soft',
                disabled: state.observationDetailLoading, onClick: () => openDetail(state.observationDetail.detailId, true) },
              state.observationDetailLoading ? t('Loading…') : t('Load more detail')) : null,
              h('button', { type: 'button', className: 'bt-soft', onClick: copyDetail },
                detailCopyState === 'copied' ? t('Copied') : detailCopyState === 'failed' ? t('Copy failed') : t('Copy loaded detail'))),
            state.observationDetailError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.observationDetailError) : null) : null,
          observation.generations.length > 1 ? h('section', { className: 'bt-observation-generations', 'aria-label': t('Assignment generations') },
            h('h2', null, t('Assignment generations')),
            observation.generations.map(generation => h('button', { key: generation.assignmentId, type: 'button',
              className: 'bt-observation-generation', 'aria-current': generation.current ? 'true' : undefined,
              'aria-pressed': generation.generation === observation.generation ? 'true' : 'false',
              disabled: generation.generation === observation.generation,
              onClick: () => {
                if (!state.binding || !state.selectedObservation) return
                view.set(current => ({ ...current, observationGeneration: generation.generation, observationDetail: null,
                  observationDetailError: null }))
                void loadObservation(state.binding, state.selectedObservation, { reset: true })
              } },
            h('span', null, generation.generation), h('span', null,
              `${generation.configurationRevision ? `${t('Configuration')} v${generation.configurationRevision} · ` : ''}${generation.current ? t('Current generation') : t('Historical generation')}`),
            h('span', null, statusCopy(generation.state))))) : null,
          h('section', { className: 'bt-observation-history', 'aria-label': t('Observation history') },
            h('h2', null, t('Observation history')),
            observation.events.length ? observation.events.map(event => h('article', { key: event.seq, className: 'bt-observation-event' },
              h('div', { className: 'bt-observation-event-head' },
                h('span', null, event.kind === 'user-message' ? t('Input') : event.kind === 'assistant-message' ? t('Response')
                  : event.kind === 'tool-call' ? t('Tool call') : event.kind === 'tool-result' ? t('Tool result') : t('Turn')),
                h('time', null, event.time ? new Date(event.time).toLocaleTimeString() : '')),
              h('p', null, event.kind === 'tool-call' ? t('Called {tool}.', { tool: event.tool ?? 'tool' })
                : event.kind === 'tool-result' ? t(event.isError ? 'Tool call failed.' : 'Tool call completed.')
                  : event.kind === 'turn' && event.reason ? t('Turn ended: {reason}.', { reason: event.reason })
                    : redactObservationText(event.text)),
              event.detail ? h('p', { className: 'bt-main-work-detail' }, redactObservationText(event.detail)) : null,
              event.detailId ? h('button', { type: 'button', className: 'bt-soft bt-observation-detail-open',
                onClick: () => openDetail(event.detailId) },
              `${t('View full detail')}${event.detailBytes ? ` · ${event.detailBytes} ${t('bytes')}` : ''}`) : null,
              event.argumentKeys?.length ? h('p', { className: 'bt-main-work-detail' }, `${t('Arguments')}: ${event.argumentKeys.join(', ')}`) : null))
              : h('p', { className: 'bt-main-status' }, observation.historyStatus === 'missing'
                ? t('The Session history is missing. Durable work facts remain available.')
                : observation.historyStatus === 'not-started' ? t('The assigned Session has not started.')
                  : t('No execution history has been recorded yet.')),
            observation.hasMore ? h('button', { type: 'button', className: 'bt-soft bt-observation-more', onClick: () => {
              if (state.binding && state.selectedObservation) void loadObservation(state.binding, state.selectedObservation, { older: true })
            } }, t('Load more history')) : null)) : null))
  }

  function ActivityNavigation() {
    const state = useView()
    const [search, setSearch] = useState(state.observationQuery)
    const timer = useRef(null)
    useEffect(() => () => clearTimeout(timer.current), [])
    const changeSearch = value => {
      setSearch(value)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (!state.binding) return
        view.set(current => ({ ...current, observationQuery: value, observationCursor: null }))
        void loadObservations(state.binding, { reset: true })
      }, 180)
    }
    return h('nav', { className: 'bt-main-nav', 'aria-label': t('Work activity') },
      h('div', { className: 'bt-observation-search' },
        h('label', { htmlFor: 'work-observation-search' }, t('Find activity')),
        h('input', { id: 'work-observation-search', type: 'search', value: search, placeholder: t('Search Router and Worker history'),
          onChange: event => changeSearch(event.currentTarget.value) })),
      h('div', { className: 'bt-observation-nav-head' },
        h('span', null, t('Work activity')), h('span', null, t('Read-only'))),
      state.observations.length ? state.observations.map(item => h('button', {
        key: item.id,
        type: 'button',
        className: 'bt-observation-nav-item',
        'aria-current': state.route === 'observe' && state.selectedObservation?.id === item.id ? 'page' : undefined,
        onClick: () => {
          view.set(current => ({ ...current, route: 'observe', selectedObservation: item, observationGeneration: item.generation ?? null,
            observation: null, observationError: null, observationDetail: null, observationDetailError: null }))
          if (state.binding) void loadObservation(state.binding, item, { reset: true })
        },
      }, h('span', { className: 'bt-observation-role' }, item.role === 'router' ? 'Router' : 'Worker'),
        h('span', { className: 'bt-observation-nav-copy' }, h('strong', null, item.title), h('span', null, statusCopy(item.status)))))
        : h('p', { className: 'bt-observation-empty' }, t('No Router or Worker activity yet.')),
      state.activityError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.activityError) : null,
      state.observationCursor ? h('button', { type: 'button', className: 'bt-soft bt-observation-more',
        disabled: state.activityLoading, onClick: () => { if (state.binding) void loadObservations(state.binding, { append: true }) } },
      state.activityLoading ? t('Loading…') : t('Load more activity')) : null)
  }

  function ClientSettings({ binding }) {
    const [clients, setClients] = useState([])
    const [label, setLabel] = useState('')
    const [readOnly, setReadOnly] = useState(false)
    const [issued, setIssued] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const pending = useRef(null)
    const load = async () => setClients(await productCall('clients-list', { instanceId: binding.instanceId }))
    useEffect(() => { void load().catch(failure => setError(failure.message)) }, [binding.instanceId])
    const enroll = async event => {
      event.preventDefault()
      if (!label.trim() || busy) return
      setBusy(true); setError(null); setIssued(null)
      try {
        const capabilities = readOnly ? ['read'] : ['read', 'command']
        if (!pending.current || pending.current.label !== label.trim() || pending.current.readOnly !== readOnly) {
          pending.current = { commandId: crypto.randomUUID(), label: label.trim(), readOnly }
        }
        const result = await productCall('client-enroll', { instanceId: binding.instanceId, commandId: pending.current.commandId,
          label: pending.current.label, capabilities })
        pending.current = null
        setLabel('')
        if (result.token) setIssued(result.token)
        else setError(t('This enrollment already completed. Its credential cannot be shown again; revoke it and create a new client.'))
        await load()
      } catch (failure) { setError(failure.message) }
      finally { setBusy(false) }
    }
    const revoke = async client => {
      if (busy || !confirm(t('Revoke this client’s access now?'))) return
      setBusy(true); setError(null); setIssued(null)
      try {
        await productCall('client-revoke', { instanceId: binding.instanceId,
          commandId: `revoke-client:${client.id}`, clientId: client.id, reason: 'Revoked from the product settings.' })
        await load()
      } catch (failure) { setError(failure.message) }
      finally { setBusy(false) }
    }
    return h(Card, { title: t('Authorized clients') },
      h('form', { className: 'bt-main-client-form', onSubmit: event => { void enroll(event) } },
        h('label', { htmlFor: 'client-label' }, t('Client name')),
        h('input', { id: 'client-label', className: 'bt-bs-input', value: label, maxLength: 128, required: true,
          onChange: event => setLabel(event.currentTarget.value) }),
        h('label', { htmlFor: 'client-scope' }, t('Client access')),
        h('select', { id: 'client-scope', className: 'bt-select', value: readOnly ? 'read' : 'command',
          onChange: event => setReadOnly(event.currentTarget.value === 'read') },
          h('option', { value: 'command' }, t('Read and command')),
          h('option', { value: 'read' }, t('Read-only'))),
        h('button', { type: 'submit', className: 'bt-soft', disabled: busy || !label.trim() }, t('Issue credential'))),
      issued ? h('div', { className: 'bt-main-client-issued', role: 'status' },
        h('p', null, t('This credential is shown once. Transfer it to the desktop client securely.')),
        h('input', { type: 'password', readOnly: true, value: issued, 'aria-label': t('Issued client credential') }),
        h('button', { type: 'button', className: 'bt-soft', onClick: () => {
          void navigator.clipboard.writeText(issued).catch(() => setError(t('Could not copy the credential.')))
        } }, t('Copy credential'))) : null,
      error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
      clients.map(client => h('div', { key: client.id, className: 'bt-main-client-row' },
        h('div', null, h('strong', null, client.label), h('span', null, client.id),
          h('span', null, client.revokedAt ? t('Revoked') : client.grants[0]?.capabilities.includes('command') ? t('Read and command') : t('Read-only'))),
        client.revokedAt ? null : h('button', { type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => { void revoke(client) } }, t('Revoke')))))
  }

  function SettingsDialog({ binding, onClose, open, initialPage, renderSlot, returnFocus }) {
    const viewState = useView()
    const [snapshot, setSnapshot] = useState(null)
    const [draft, setDraft] = useState(null)
    const [base, setBase] = useState(null)
    const [efforts, setEfforts] = useState({})
    const [keyDrafts, setKeyDrafts] = useState({})
    const [error, setError] = useState(null)
    const [notice, setNotice] = useState(null)
    const [conflict, setConflict] = useState(false)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const draftRef = useRef(draft)
    const draftVersion = useRef(0)
    const savingRef = useRef(false)
    const loadRequest = useRef(0)
    const clone = value => JSON.parse(JSON.stringify(value))
    const roleRows = [['main', 'Main'], ['router', 'Router'], ['worker', 'Worker']]
    const refOf = model => `${model.provider}/${model.model}`
    const loadEfforts = async (roles) => {
      const refs = [...new Set([roles.main, roles.router, roles.worker].filter(Boolean).map(profile => refOf(profile.model)))]
      const values = await Promise.all(refs.map(async ref => {
        const [provider, ...model] = ref.split('/')
        try { return [ref, await productCall('settings-efforts', { instanceId: binding.instanceId, provider, model: model.join('/') })] }
        catch { return [ref, { efforts: [] }] }
      }))
      setEfforts(Object.fromEntries(values))
    }
    const applySnapshot = (value, preserve = false) => {
      setSnapshot(value)
      if (!preserve) {
        const nextDraft = clone(value.roles)
        draftRef.current = nextDraft
        draftVersion.current += 1
        setDraft(nextDraft)
        setBase(clone(value.roles))
        void loadEfforts(value.roles)
      }
    }
    const load = async ({ preserve = false } = {}) => {
      const request = ++loadRequest.current
      setLoading(true)
      try {
        const value = await readModelSettings(binding, 50)
        if (request !== loadRequest.current) return
        applySnapshot(value, preserve)
        setError(null)
      } catch (failure) {
        if (request === loadRequest.current) setError(failure.message)
      } finally {
        if (request === loadRequest.current) setLoading(false)
      }
    }
    useEffect(() => { void load() }, [binding.instanceId])
    const updateRole = (role, change) => {
      if (savingRef.current) return
      draftVersion.current += 1
      setDraft(current => {
      const next = clone(current)
      next[role] = { ...next[role], ...change }
      draftRef.current = next
      return next
      })
    }
    const updateModel = async (role, ref) => {
      if (savingRef.current) return
      const [provider, ...model] = ref.split('/')
      updateRole(role, { model: { provider, model: model.join('/') } })
      if (!efforts[ref]) {
        try {
          const value = await productCall('settings-efforts', { instanceId: binding.instanceId, provider, model: model.join('/') })
          setEfforts(current => ({ ...current, [ref]: value }))
        } catch { /* A model without a readable effort list uses its provider default. */ }
      }
    }
    const updateEffort = (role, effort) => {
      if (savingRef.current) return
      const current = draft[role]
      updateRole(role, { model: { ...current.model, ...(effort ? { effort } : {}) } })
      if (!effort) setDraft(latest => {
        const next = clone(latest)
        delete next[role].model.effort
        draftRef.current = next
        return next
      })
    }
    const validate = () => {
      if (draft.router.instructions.trim() && !draft.router.instructions.includes('{{goal}}')) return 'The Router prompt must keep the {{goal}} placeholder.'
      if (draft.worker.instructions.trim() && (!draft.worker.instructions.includes('{{goal}}') || !draft.worker.instructions.includes('{{constraints}}'))) {
        return 'The Worker prompt must keep the {{goal}} and {{constraints}} placeholders.'
      }
      return null
    }
    const save = async () => {
      if (savingRef.current) return
      const problem = validate()
      if (problem) { setError(problem); return }
      const submitted = clone(draftRef.current)
      const submittedVersion = draftVersion.current
      savingRef.current = true
      setSaving(true); setError(null); setNotice(null)
      try {
        const value = await productCall('settings-save', { instanceId: binding.instanceId, commandId: crypto.randomUUID(),
          expectedRevision: snapshot.revision, roles: submitted })
        const editedDuringSave = draftVersion.current !== submittedVersion
        const nextDraft = editedDuringSave ? rebaseRoleDraft(submitted, draftRef.current, value.roles) : clone(value.roles)
        setSnapshot(current => ({ ...current, ...value, providers: current.providers, history: current.history }))
        setBase(clone(value.roles)); setDraft(nextDraft); draftRef.current = nextDraft
        draftVersion.current += 1
        setConflict(false)
        setNotice(t('Configuration v{revision} is active for new turns.', { revision: value.revision }))
        const latest = await readModelSettings(binding, 50)
        applySnapshot(latest, true)
      } catch (failure) {
        if (failure.code === 'CONFIG_REVISION_CONFLICT') {
          setConflict(true)
          setError(t('The configuration changed elsewhere. Your edits are still here.'))
        } else setError(failure.message)
      } finally { savingRef.current = false; setSaving(false) }
    }
    const rebase = async () => {
      setSaving(true); setError(null)
      try {
        const latest = await readModelSettings(binding, 50)
        const merged = rebaseRoleDraft(base, draft, latest.roles)
        applySnapshot(latest)
        draftRef.current = merged
        draftVersion.current += 1
        setDraft(merged); setBase(clone(latest.roles)); setConflict(false)
        setNotice(t('Your changed fields were applied over configuration v{revision}. Review and save.', { revision: latest.revision }))
      } catch (failure) { setError(failure.message) }
      finally { setSaving(false) }
    }
    const refreshAfterPreset = async () => {
      const latest = await readModelSettings(binding, 50)
      applySnapshot(latest)
      setConflict(false)
      setError(null)
    }
    const saveKey = async (provider, value) => {
      if (value === undefined) return
      setError(null); setNotice(null)
      try {
        const result = await productCall('provider-key', { instanceId: binding.instanceId, provider, value })
        setKeyDrafts(current => ({ ...current, [provider]: '' }))
        setSnapshot(current => ({ ...current, providers: current.providers.map(item => item.id === provider
          ? { ...item, key: { ...item.key, configured: result.configured } } : item) }))
        setNotice(value === null ? t('Provider key removed.') : t('Provider key saved.'))
        void refreshModelSettings(binding)
      } catch (failure) {
        setKeyDrafts(current => ({ ...current, [provider]: '' }))
        setError(failure.message)
      }
    }
    const chooseDefaultDirectory = async path => {
      if (!path || viewState.directoryBusy) return
      view.set(current => ({ ...current, directoryBusy: true, directoryError: null }))
      try {
        const selected = await registerDirectory(binding, path)
        await productCall('directory-default-save', { instanceId: binding.instanceId, commandId: crypto.randomUUID(),
          expectedRevision: viewState.directoryOptions?.default?.revision ?? 0, environmentId: selected.id })
        await loadDirectories(binding)
      } catch (failure) { view.set(current => ({ ...current, directoryError: failure.message })); await loadDirectories(binding).catch(() => {}) }
      finally { view.set(current => ({ ...current, directoryBusy: false })) }
    }
    const models = snapshot?.providers.flatMap(provider => provider.models) ?? []
    const viewWork = ({ ticketIds = [], workBriefId } = {}) => {
      onClose()
      view.set(current => ({ ...current, route: 'main' }))
      void refreshMain(binding).then(() => {
        requestAnimationFrame(() => {
          const cards = [...document.querySelectorAll('[data-ticket-id], [data-work-brief-id]')]
          const card = cards.find(item => ticketIds.includes(item.dataset.ticketId)
            || workBriefId && item.dataset.workBriefId === workBriefId)
          if (!card) return
          card.focus({ preventScroll: true })
          card.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
        })
      })
    }
    const loadingSettings = loading ? h(SettingsSectionState, { status: 'loading' }) : h(Fragment, null,
      h(SettingsSectionState, { status: 'error', message: error }),
      h('button', { type: 'button', className: 'bt-soft', onClick: () => { void load() } }, t('Retry')))
    const roles = draft && !loading ? h(Fragment, null,
            error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
            viewState.directoryError ? h('p', { className: 'bt-main-error', role: 'alert' }, viewState.directoryError) : null,
            conflict ? h('div', { className: 'bt-main-settings-conflict', role: 'status' },
              h('p', null, t('Newer settings exist. Rebase only your changed fields, then review and save.')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: saving, onClick: () => { void rebase() } }, t('Rebase my edits'))) : null,
            notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
            models.length === 0 ? h('p', { className: 'bt-main-health-warning', role: 'alert' },
              t('No models are available. Configure a provider in DSH settings, then reopen this panel to select the role models.'))
              : rolesNeedingModels({ roles: draft, providers: snapshot.providers }).length ? h('p', { className: 'bt-main-health-warning', role: 'alert' },
                t('Select an available model for each role before saving.')) : null,
            roleRows.map(([role, label]) => {
              const profile = draft[role]
              if (!profile) return null
              const ref = refOf(profile.model)
              const reasoning = efforts[ref]
              return h(Card, { key: role, title: label },
                h(Row, { label: t('Model'), hint: t('The provider and model this role uses. New turns use the saved version.') },
                  h('select', { className: 'bt-select bt-main-settings-select', 'aria-label': t('{role} model', { role: label }), value: ref,
                    disabled: saving,
                    onChange: event => { void updateModel(role, event.target.value) } },
                  !models.some(model => model.ref === ref) ? h('option', { value: ref }, ref) : null,
                  snapshot.providers.map(provider => h('optgroup', { key: provider.id, label: provider.name },
                    provider.models.map(model => h('option', { key: model.ref, value: model.ref }, model.name)))))),
                reasoning?.efforts?.length ? h(Row, { label: t('Thinking effort'), hint: t('Kept with the model route and recorded in configuration uses.') },
                  h('select', { className: 'bt-select bt-main-settings-select', 'aria-label': t('{role} thinking effort', { role: label }),
                    value: profile.model.effort ?? '', disabled: saving, onChange: event => updateEffort(role, event.target.value) },
                  h('option', { value: '' }, t('Provider default')),
                  reasoning.efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)))) : null,
                h(Row, { label: t('Instructions'), hint: t('Role prompts are versioned. Router keeps {{goal}}; Worker keeps {{goal}} and {{constraints}}.'), stack: true },
                  h('textarea', { className: 'bt-bs-input bt-bs-area bt-main-settings-prompt', value: profile.instructions,
                    maxLength: 16384, spellCheck: false, disabled: saving, 'aria-label': t('{role} instructions', { role: label }),
                    onChange: event => updateRole(role, { instructions: event.target.value }) })),
                h(Row, { label: t('Profile'), hint: `${profile.name} · ${profile.skills.length ? t('Skills: {skills}', { skills: profile.skills.join(', ') }) : t('No reserved skills')}` },
                  h('span', { className: 'bt-main-settings-route' }, ref)))
            }),
            h('div', { className: 'bt-actions bt-main-settings-save' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: saving, onClick: onClose }, t('Cancel')),
              h('button', { type: 'button', className: 'bt-send bt-soft bt-soft-sm', disabled: saving, onClick: () => { void save() } },
                saving ? t('Saving…') : t('Save configuration'))),
            h(Card, { title: t('Recent configuration uses') },
              snapshot.uses.length ? snapshot.uses.slice(0, 20).map(use => h('div', { key: use.id, className: 'bt-main-settings-use' },
                h('span', { className: 'bt-observation-role' }, use.role),
                h('span', null, `${t('Configuration')} v${use.revision}`),
                h('span', null, refOf(use[use.role] ?? use.worker ?? use.router)),
                h('span', { className: 'bt-main-settings-use-session', title: use.sessionId }, use.sessionId),
                h('time', null, new Date(use.createdAt).toLocaleString()))) : h('p', { className: 'bt-main-status' }, t('No role turn has recorded a configuration version yet.')))) : loadingSettings
    const providers = snapshot ? h(Fragment, null,
            error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
            notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
            h(Card, { title: t('Providers') },
              snapshot.providers.length ? snapshot.providers.map(provider => h('div', { key: provider.id, className: 'bt-main-provider' },
                h('div', { className: 'bt-main-provider-copy' }, h('strong', null, provider.name), h('span', null, t('{count} models', { count: provider.models.length }))),
                provider.key ? h('div', { className: 'bt-main-provider-key' },
                  h('span', { role: 'status' }, provider.key.configured ? t('API key configured') : t('API key missing')),
                  provider.key.writable ? h(Fragment, null,
                    h('input', { type: 'password', value: keyDrafts[provider.id] ?? '', autoComplete: 'off', 'aria-label': t('{provider} API key', { provider: provider.name }),
                      disabled: saving, placeholder: t('Paste a new key'), onChange: event => setKeyDrafts(current => ({ ...current, [provider.id]: event.target.value })) }),
                    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: saving || !(keyDrafts[provider.id] ?? '').trim(),
                      onClick: () => { void saveKey(provider.id, keyDrafts[provider.id]) } }, t('Save key')),
                    provider.key.configured ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-bs-danger',
                      disabled: saving, onClick: () => { void saveKey(provider.id, null) } }, t('Remove key')) : null) : h('span', null, t('Set outside this product'))) : null))
                : h('p', { className: 'bt-main-status' }, t('No provider catalog is available. Configure providers in DSH settings.')))) : loadingSettings
    const pageProps = { binding, call: productCall }
    const pages = {
      general: h(Fragment, null, h(AppearanceSettings, { ctx }),
        viewState.directoryError ? h('p', { className: 'bt-main-error', role: 'alert' }, viewState.directoryError) : null,
        viewState.directoryOptions ? h(Card, { title: t('Work directories') },
          viewState.directoryOptions.default?.unavailable ? h('p', { role: 'alert', className: 'bt-main-error' },
            t('The saved work directory is unavailable. Choose another directory.')) : null,
          h(Row, { label: t('Instance default directory'), hint: t('New work starts here unless you choose a work directory in Main.') },
            h(FolderMenu, { value: viewState.directoryOptions.default?.root, team: true,
              label: t('Instance default directory'), actions: directoryActions(binding),
              run: promise => void Promise.resolve(promise).catch(failure =>
                view.set(current => ({ ...current, directoryError: failure.message }))),
              onPick: chooseDefaultDirectory, disabled: viewState.directoryBusy }))) : null),
      roles,
      models: providers,
      'built-in-plugins': h(BuiltinPluginSettings, pageProps),
      execution: h(ProductExecutionSettings, { ...pageProps, onChanged: () => { void loadDirectories(binding) } }),
      calendar: h(ProductScheduleSettings, { ...pageProps, works: viewState.works, onViewWork: viewWork }),
      'scheduled-tasks': h(ProductScheduleSettings, { ...pageProps, onViewWork: viewWork, taskMode: true }),
      preparations: h(ProductProactiveSettings, pageProps),
      presets: snapshot ? h(ProductPresetSettings, { ...pageProps,
        settingsRevision: snapshot.revision, roleSettings: snapshot, onApplied: refreshAfterPreset, onReload: refreshAfterPreset }) : loadingSettings,
      memory: h(ProductMemorySettings, { ...pageProps, key: binding.instanceId, works: viewState.works }),
      'browser-resources': h(ProductBrowserSettings, { ...pageProps, works: viewState.works,
        directoryOptions: viewState.directoryOptions, browserBridge: globalThis.dsSuperagentApp?.browser }),
      'browser-plugin': h(ProductBrowserPluginSettings, pageProps),
      supervision: h(ProductSupervisionSettings, pageProps),
      'credential-resources': h(ProductCredentialSettings, { ...pageProps, credentialImportBridge: globalThis.dsSuperagentApp?.browser?.credentialImport }),
      'chat-secrets': h(ChatSecrets, { ...pageProps, settings: true }),
      connectors: h(ConnectorSettings, pageProps),
      im: h(ProductImSettings, pageProps),
      phone: h(ProductPhoneSettings, pageProps),
      computer: h(ProductComputerSettings, pageProps),
      capabilities: h(Fragment, null, h(CapabilitySettings, { ...pageProps, works: viewState.boardItems,
        environments: viewState.directoryOptions?.execution?.environments }), h(ProductMcpSettings, pageProps)),
      'remote-clients': h(ClientSettings, { binding }),
    }
    const sections = Object.fromEntries(Object.entries(pages).map(([id, content]) => [id, { render: () => content }]))
    const useNativeModels = viewState.nativeModelsOpen && renderSlot && hasNativeSettings('models')
    if (useNativeModels) sections.models = { render: ({ close }) =>
      renderSlot('settings.section', { close }, { only: 'models', fallback: providers }) }
    sections['usage-overview'] = { render: ({ navigate }) => h(ProductOperationsSettings, { ...pageProps, section: 'usage', onNavigate: navigate }) }
    sections.status = { render: ({ navigate }) => h(ProductOperationsSettings, { ...pageProps, section: 'status', onNavigate: navigate }) }
    sections.feedback = { render: ({ navigate }) => h(FeedbackSettings, { ...pageProps, onNavigate: navigate,
      ...(viewState.connection?.connected ? { app: null } : {}) }) }
    return h(SettingsShell, { open, onClose, returnFocus, initialPage, renderSlot, sections,
      onNavigate: useNativeModels ? previous => { if (previous === 'models') void load({ preserve: draft !== null }) } : undefined })
  }

  function ConnectionDialog({ connection, onClose }) {
    const [address, setAddress] = useState('')
    const [instanceId, setInstanceId] = useState('personal')
    const [credential, setCredential] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    useEffect(() => { document.getElementById('product-host-address')?.focus() }, [])
    const connect = async event => {
      event.preventDefault()
      if (busy) return
      setBusy(true); setError(null)
      try {
        await clientBridge().connect({ address: address.trim(), instanceId: instanceId.trim(), credential: credential.trim() })
        setCredential('')
        location.reload()
      } catch (failure) {
        setCredential('')
        setError(failure.message)
        setBusy(false)
      }
    }
    const disconnect = async () => {
      setBusy(true); setError(null)
      try { await clientBridge().disconnect(); location.reload() }
      catch (failure) { setError(failure.message); setBusy(false) }
    }
    return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: onClose }),
      h('div', { className: 'bt-settings bt-main-connect-dialog', role: 'dialog', 'aria-modal': true,
        'aria-label': t('Host connection'), onKeyDown: event => { if (event.key === 'Escape') onClose() } },
        h('div', { className: 'bt-settings-main' },
          h('div', { className: 'bt-settings-head' }, h('h2', null, t('Host connection'))),
          connection?.connected ? h('div', { className: 'bt-main-connect-body' },
            h('p', { role: 'status' }, `${t('Remote Host')} · ${connection.address} · ${connection.instanceId}`),
            h('p', null, `${t('Client')} · ${connection.client.label} · ${connection.capabilities.includes('command') ? t('Read and command') : t('Read-only')}`),
            error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
            h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void disconnect() }, t('Disconnect'))) :
            h('form', { className: 'bt-main-connect-body', onSubmit: event => { void connect(event) } },
              h('label', { htmlFor: 'product-host-address' }, t('Host address')),
              h('input', { id: 'product-host-address', type: 'url', required: true, value: address,
                placeholder: 'https://host.example:8443', onChange: event => setAddress(event.currentTarget.value) }),
              h('label', { htmlFor: 'product-host-instance' }, t('Instance')),
              h('input', { id: 'product-host-instance', required: true, value: instanceId,
                onChange: event => setInstanceId(event.currentTarget.value) }),
              h('label', { htmlFor: 'product-host-credential' }, t('Client credential')),
              h('input', { id: 'product-host-credential', type: 'password', required: true, autoComplete: 'off', value: credential,
                onChange: event => setCredential(event.currentTarget.value) }),
              h('p', { className: 'bt-main-status' }, t('Use HTTPS or an authorized local SSH tunnel. The credential stays in this app process until disconnect or quit.')),
              error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
              h('button', { type: 'submit', className: 'bt-soft', disabled: busy }, busy ? t('Connecting…') : t('Connect')))),
          h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close connection'), onClick: onClose }, h(CloseIcon))))
  }

  function ProductSurface() {
    const state = useView()
    if (state.route === 'work') return h('section', { className: 'bt-main-conversation' },
      h('header', { className: 'bt-main-header' }, h(Header),
        h('button', { type: 'button', className: 'bt-soft', onClick: shellActions.openMain }, t('Main'))),
      h(BoardSurface))
    return state.route === 'observe' ? h(ObservationConversation) : h(MainConversation)
  }

  const usesProductHistory = state => state.connection?.connected || state.binding?.mainSessionMode === 'product-history'
  const openNativeMain = sessionId => {
    ctx.layout.beginNavigation()
    ctx.uiWorkspace.openSession(sessionId)
  }

  function NativeComposer({ pendingInteraction }) {
    const state = useView()
    const sessionEvents = useNativeSessionEvents(state.binding?.mainSessionId)
    return pendingInteraction ? null : h(MainConversation, { composerOnly: true, sessionEvents })
  }

  function useNativeSessionEvents(sessionId) {
    const source = sessionId && ctx.sessions.binding(sessionId)?.eventSource
    return useSyncExternalStore(source ? listener => source.subscribe(listener) : noopSubscribe,
      source ? () => source.getSnapshot() : noEvents)
  }

  const mainInputStatus = status => ({ queued: t('Queued'), running: t('Running'), stopping: t('Stopping'),
    stopped: t('Stopped'), interrupted: t('Interrupted'), failed: t('Failed') })[status] ?? status

  function NativeTurnCards({ turn, seq }) {
    const state = useView()
    const events = useNativeSessionEvents(state.binding?.mainSessionId)
    const status = useSyncExternalStore(ctx.uiSession.sessionStatus.subscribe, ctx.uiSession.sessionStatus.getSnapshot)
    if (!events || state.connection?.connected) return null
    const ids = new Set(events.entries.flatMap(({ event }) => event.type === 'user/message' && event.seq > (turn.start?.seq ?? -1)
      && event.seq <= seq ? [event.data.id] : []))
    const { works, sources, preparations } = projectNativeTurnCards(state, ids)
    const attachments = state.messages.filter(message => ids.has(message.id)).flatMap(message => message.attachments ?? [])
    if (!works.length && !sources.length && !preparations.length && !attachments.length) return null
    const pending = status.get(state.binding.mainSessionId)?.pendingInteraction
    const question = pendingQuestion(state)
    return h('div', { className: 'bt-native-turn-cards' },
      sources.map(source => h(MainSourceCard, { key: source.id, source, instanceId: state.binding.instanceId, onRefresh: refresh, canCommand: true })),
      preparations.map(preparation => h(MainPreparationCard, { key: preparation.id, preparation })),
      attachments.length ? h(MainAttachmentLinks, { attachments }) : null,
      works.map(work => h(MainWorkCard, { key: work.brief.workItemId ?? work.brief.id, work,
        questionInComposer: !pending && work === question, showEvidence: true,
        onEvidence: selected => void loadMainEvidence(state.binding, selected) })))
  }

  function NativeActivity({ openView }) {
    const state = useView()
    const instanceId = state.binding?.instanceId
    useEffect(() => {
      if (!instanceId) return
      view.set(current => ({ ...current, route: 'observe' }))
      return () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId !== 'superagent-activity') {
          view.set(current => ({ ...current, route: 'main' }))
        }
      }
    }, [instanceId])
    return instanceId ? h(ObservationConversation, { onBack: () => openView('chat', '') }) : null
  }

  function NativeMainActions() {
    const state = useView()
    const sessionState = useSyncExternalStore(nativeStatus?.subscribe ?? noopSubscribe, nativeStatus?.getSnapshot ?? noEvents)
    return h('div', { className: 'bt-native-main-actions',
      'data-native-main-question': sessionState?.get(state.binding?.mainSessionId)?.pendingInteraction ? '' : undefined },
      h('span', { role: 'status' }, state.modelsNeedSetup ? t('Models need setup') : mainHealthCopy(state.health)),
      h('button', { type: 'button', className: 'bt-icon-btn bt-main-settings', 'aria-label': t('Settings'),
        onClick: () => shellActions.openSettings() }, h(SlidersIcon)))
  }

  const slotEntries = name => ctx.slots.entries?.(name) ?? []
  const modelSlots = ['settings.section', DEEPSEEK_SIGN_IN_SLOT]
  const subscribeModelSlots = listener => {
    const subscriptions = modelSlots.map(name => ctx.slots.subscribe?.(name, listener))
    return () => { for (const unsubscribe of subscriptions) unsubscribe?.() }
  }
  const modelSlotVersion = () => modelSlots.map(name => ctx.slots.getVersion?.(name) ?? 0).join(':')
  const useModelSlots = () => useSyncExternalStore(subscribeModelSlots, modelSlotVersion)
  const hasNativeSettings = id => slotEntries('settings.section').some(entry => entry.options?.id === id)
  const canSignIn = () => slotEntries(DEEPSEEK_SIGN_IN_SLOT).length > 0 && !hasNativeSettings('account')
  const openSignIn = () => {
    const state = view.getSnapshot()
    if (!state.binding || state.connection?.connected || !canSignIn()) return
    signInTrigger = document.activeElement
    view.set({ ...state, signInOpen: true })
  }
  const closeSignIn = () => {
    view.set(state => ({ ...state, signInOpen: false }))
    void refreshModelSettings()
  }
  const openCustomModels = () => shellActions.openSettings('models', { nativeModels: true })

  function SignInDialog({ renderSlot }) {
    useEffect(() => {
      const trigger = signInTrigger
      return () => { if (!view.getSnapshot().settingsOpen) returnTo(trigger) }
    }, [])
    return renderSlot(DEEPSEEK_SIGN_IN_SLOT, {
      complete: closeSignIn,
      useApiKey: () => {
        shellActions.openSettings('models', { trigger: signInTrigger })
        closeSignIn()
      },
    })
  }

  function Overlay({ renderSlot }) {
    useModelSlots()
    const state = useView()
    const signInAvailable = slotEntries(DEEPSEEK_SIGN_IN_SLOT).length > 0
    useEffect(() => {
      if (state.signInOpen && (!signInAvailable || state.connection?.connected)) closeSignIn()
    }, [state.signInOpen, signInAvailable, state.connection?.connected])
    const trigger = settingsTrigger
    return h(Fragment, null,
      state.binding && !state.connection?.connected && state.settingsPage ? h(SettingsDialog, { binding: state.binding,
        key: `${state.settingsPage}:${state.nativeModelsOpen}`, open: state.settingsOpen, initialPage: state.settingsPage, renderSlot,
        returnFocus: () => returnTo(trigger),
        onClose: () => {
          view.set(current => ({ ...current, settingsOpen: false }))
          void refreshModelSettings()
        } }) : null,
      state.signInOpen && signInAvailable && !state.connection?.connected && renderSlot ? h(SignInDialog, { renderSlot }) : null,
      state.connectOpen && clientBridge() ? h(ConnectionDialog, { connection: state.connection,
        onClose: () => view.set(current => ({ ...current, connectOpen: false })) }) : null)
  }

  const classicAvailable = state => Boolean(nativeSession && nativeWorkspaces && classicBridge()?.call && state.binding && !state.connection?.connected)
  let classicTimer
  async function callClassic(endpoint, instanceId) {
    const response = await classicBridge()?.call(endpoint, { instanceId })
    if (response?.ok === true) return response.value
    throw new Error(t(response?.error?.message ?? 'Classic Agent mode is unavailable here.'))
  }

  async function returnToMain() {
    await Promise.resolve(ctx.sessions.refresh?.()).catch(() => {})
    if (stopped) return
    view.set(current => ({ ...current, surface: 'product', route: 'main', restoreMainFocus: true }))
    void refresh()
  }

  function renewClassic(instanceId, sessionId) {
    classicTimer = setTimeout(async () => {
      try {
        const renewed = await callClassic('classic-renew', instanceId)
        if (renewed.sessionId !== sessionId) throw new Error(t('No authorized classic Agent Session is available.'))
        if (!stopped && view.getSnapshot().surface === 'classic' && !view.getSnapshot().surfaceChanging) renewClassic(instanceId, sessionId)
      } catch (error) {
        if (!stopped && view.getSnapshot().surface === 'classic' && !view.getSnapshot().surfaceChanging) {
          void setSurface('product', error)
        }
      }
    }, 20_000)
  }

  function waitForClassicWorkspace(sessionId, workspaceId) {
    const listed = () => nativeWorkspaces.getSnapshot().items.some(workspace =>
      workspace.workspaceId === workspaceId && workspace.sessionIds.includes(sessionId))
    if (listed()) return Promise.resolve(true)
    return new Promise(resolve => {
      const finish = found => { clearTimeout(timer); unsubscribe(); resolve(found) }
      const unsubscribe = nativeWorkspaces.subscribe(() => { if (listed()) finish(true) })
      const timer = setTimeout(() => finish(false), 5000)
    })
  }

  async function setSurface(surface, failure) {
    const state = view.getSnapshot()
    if (!state.binding || state.surfaceChanging || state.surface === surface) return
    view.set(current => ({ ...current, surfaceChanging: true }))
    const instanceId = state.binding.instanceId
    let granted = false
    try {
      if (surface === 'classic') {
        if (!classicAvailable(state)) throw new Error(t('Classic Agent mode is unavailable here.'))
        const { sessionId, workspaceId } = await callClassic('classic-open', instanceId)
        granted = true
        if (typeof sessionId !== 'string' || !sessionId || typeof workspaceId !== 'string' || !workspaceId
          || sessionId === state.binding.mainSessionId) {
          throw new Error(t('No authorized classic Agent Session is available.'))
        }
        const [, hasWorkspace] = await Promise.all([ctx.sessions.refresh?.(), waitForClassicWorkspace(sessionId, workspaceId)])
        const current = view.getSnapshot()
        if (stopped || current.binding?.instanceId !== instanceId || !classicAvailable(current)) {
          throw new Error(t('Classic Agent mode is unavailable here.'))
        }
        if (!hasWorkspace || !ctx.sessions.list.getSnapshot().byId?.[sessionId]) {
          throw new Error(t('No authorized classic Agent Session is available.'))
        }
        mainVoice.close()
        closeOverlays()
        view.set(latest => ({ ...latest, surface, settingsOpen: false, settingsPage: null, nativeModelsOpen: false, signInOpen: false,
          connectOpen: false, mainEvidence: null, mainEvidenceWorkItemId: null, restoreMainFocus: false }))
        await Promise.resolve()
        if (stopped) return
        ctx.layout.beginNavigation()
        ctx.uiWorkspace.openSession(sessionId)
        renewClassic(instanceId, sessionId)
      } else {
        clearTimeout(classicTimer)
        await callClassic('classic-close', instanceId).catch(error => { failure ??= error })
        if (stopped) return
        await returnToMain()
        if (failure && !stopped) reportError(failure)
      }
    } catch (error) {
      if (granted) {
        await callClassic('classic-close', instanceId).catch(() => {})
        if (view.getSnapshot().surface === 'classic') await returnToMain()
        else if (!stopped) void Promise.resolve(ctx.sessions.refresh?.()).catch(() => {})
      }
      if (!stopped) reportError(error)
    } finally {
      if (!stopped) view.set(current => ({ ...current, surfaceChanging: false }))
    }
  }

  function ReturnToProduct({ wide }) {
    const state = useView()
    if (state.surface !== 'classic') return null
    return h(ClassicReturn, { wide, onReturn: () => void setSurface('product'), busy: state.surfaceChanging })
  }

  const shellActions = {
    openMain() {
      if (view.getSnapshot().surface === 'classic') { void setSurface('product'); return }
      view.set(current => ({ ...current, route: 'main', selectedObservation: null, observationGeneration: null,
        observation: null, observationError: null, observationDetail: null, observationDetailError: null }))
      void refresh()
      const state = view.getSnapshot()
      if (nativeSession && !usesProductHistory(state) && state.binding?.mainSessionId) openNativeMain(state.binding.mainSessionId)
    },
    openClassic() { void setSurface('classic') },
    openActivity() {
      const state = view.getSnapshot()
      view.set(current => ({ ...current, route: 'observe' }))
      if (nativeSession && !usesProductHistory(state)) ctx.layout.selectPanel('superagent-activity')
      if (state.binding) void loadObservations(state.binding, { reset: true })
    },
    openSettings(settingsPage = 'general', { nativeModels = false, trigger = document.activeElement } = {}) {
      const state = view.getSnapshot()
      if (!state.binding || state.connection?.connected) return
      settingsTrigger = trigger
      view.set({ ...state, settingsOpen: true, settingsPage, nativeModelsOpen: nativeModels })
    },
    openConnection() { if (clientBridge()) view.set(current => ({ ...current, connectOpen: true })) },
  }
  const shellSteps = []
  const { Header, closeOverlays, reportError } = installProductShell(ctx, { actions: shellActions, Overlay,
    collect: step => shellSteps.push(step),
    WorkDirectory: ({ wide }) => h(MainWorkDirectory, { sidebar: true, wide }),
    overlayChildren: { ...SETTINGS_CHILDREN, [DEEPSEEK_SIGN_IN_SLOT]: { kind: 'single', scope: 'root' } },
    useShell() {
      useModelSlots()
      const state = useView()
      const lastReply = state.messages.findLast(message => message.role === 'main')
      const question = state.works.find(work => work.control?.attention?.status === 'waiting')
      return { activity: state.route === 'observe', markState: state.activeTurn ? 'run' : 'idle',
        preview: lastReply?.text, unread: lastReply?.id === state.readReplyId ? undefined : lastReply?.id, pending: question?.control?.attention?.id,
        notificationScope: state.binding?.instanceId,
        connectLabel: clientBridge() ? (state.connection?.connected ? t('Connection') : t('Connect to Host')) : null,
        settingsAvailable: Boolean(state.binding && !state.connection?.connected), signIn: canSignIn() ? openSignIn : undefined,
        classicAvailable: classicAvailable(state),
        modalOpen: state.settingsOpen || state.connectOpen || state.signInOpen }
    },
  })
  shellSteps.push(() => installSettingsSections(ctx.slots), () => installAppearance(ctx.get('theme')))
  const register = (name, component, options = {}) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -200, ...options }, component))
  const conversationSteps = [() => installCompiledStyles(SHELL_CSS + CONVERSATION_CSS + SETTINGS_SHELL_CSS + PRODUCT_SETTINGS_CSS + FOLDER_CSS + PRODUCT_CSS + MODEL_ONBOARDING_CSS + PRODUCT_SCHEDULE_CSS + PRODUCT_CREDENTIAL_CSS + CHAT_SECRET_CSS + PRODUCT_PRESET_CSS + PRODUCT_PROACTIVE_CSS + PRODUCT_SUPERVISION_CSS + PRODUCT_MEMORY_CSS + PRODUCT_BROWSER_CSS + PRODUCT_COMPUTER_CSS + PRODUCT_EXECUTION_CSS + PRODUCT_OPERATIONS_CSS + USAGE_HEATMAP_CSS + WORK_BOARD_CSS + MAIN_VOICE_CSS, 'main')]
  if (!nativeSession) conversationSteps.push(() => register('main.conversation', ProductSurface))
  else {
    conversationSteps.push(() => installMainCells(ctx), () => register('conversation.header.leading', NativeMainActions))
    conversationSteps.push(() => register('conversation.composer', NativeComposer, { select: owner => {
      const state = view.getSnapshot()
      return !usesProductHistory(state) && state.binding?.mainSessionId === owner.sessionId && !owner.pendingInteraction ? true : null
    } }),
    () => register('conversation.chat.turnTail', NativeTurnCards, { id: 'superagent-cards', order: 900 }),
    () => register('conversation.view', NativeActivity, { id: 'superagent-activity', order: 30, label: t('Activity') }),
    () => register('conversation.view', BoardSurface, { id: 'superagent-work', order: 31, label: t('Work') }),
    () => register('main', () => h(ObservationConversation, { onBack: shellActions.openMain }), { key: 'superagent-activity' }))
    conversationSteps.push(() => {
      let sessionId
      let fallback
      const sync = () => {
        const state = view.getSnapshot()
        if (state.surface !== 'product') return
        if (usesProductHistory(state)) {
          fallback ??= register('main.conversation', ProductSurface)
          sessionId = undefined
        } else {
          const nextSessionId = state.binding?.mainSessionId
          const catalog = ctx.sessions.list.getSnapshot()
          if (!nextSessionId || nextSessionId === sessionId || catalog.phase !== 'ready' || !catalog.byId?.[nextSessionId]) return
          sessionId = nextSessionId
          fallback?.()
          fallback = undefined
          void Promise.resolve().then(() => {
            if (sessionId !== nextSessionId || stopped) return
            const latest = view.getSnapshot()
            const latestCatalog = ctx.sessions.list.getSnapshot()
            if (latest.surface !== 'product' || usesProductHistory(latest) || latest.binding?.mainSessionId !== nextSessionId
              || latestCatalog.phase !== 'ready' || !latestCatalog.byId?.[nextSessionId]) {
              sessionId = undefined
              return
            }
            openNativeMain(nextSessionId)
          }).catch(error => {
            if (sessionId === nextSessionId) sessionId = undefined
            if (!stopped) reportError(error)
          })
        }
      }
      sync()
      const unsubscribe = view.subscribe(sync)
      const unsubscribeSessions = ctx.sessions.list.subscribe(sync)
      return () => { sessionId = undefined; unsubscribe(); unsubscribeSessions(); fallback?.() }
    })
  }
  register('sidebar.footer.action', ReturnToProduct, { id: 'superagent-return', order: -300 })
  ctx.effect(() => {
    const style = installStyles(RETURN_CSS, 'classic-return')
    const groups = surfaceGroups({ shell: shellSteps, conversation: conversationSteps }, reportError)
    let surface
    const sync = () => {
      const current = view.getSnapshot().surface
      if (surface === current) return
      surface = current
      groups.reconcile(surface === 'product')
    }
    const unsubscribe = view.subscribe(sync)
    sync()
    return () => {
      clearTimeout(classicTimer)
      const state = view.getSnapshot()
      if (state.surface === 'classic') void callClassic('classic-close', state.binding.instanceId).catch(() => {})
      unsubscribe()
      groups.dispose()
      style.remove()
    }
  }, 'superagent: active surface')
}

const noopSubscribe = () => () => {}
const noEvents = () => undefined

function redactObservationText(value) {
  return String(value).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\x2f-]+=*/giu, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
}

const PRODUCT_CSS = `
.bt-native-main-input{width:100%}.bt-native-turn-cards{display:flex;flex-direction:column;gap:var(--bt-font-small);width:100%}.bt-native-main-actions{display:flex;align-items:center;gap:8px}
.bt-product-message{display:flex;margin:10px 0}.bt-product-message-bot{justify-content:flex-start}.bt-product-message-user{justify-content:flex-end}.bt-product-message .bt-bubble{max-width:min(720px,88%);box-sizing:border-box;padding:12px 14px;border-radius:16px;background:var(--bt-bubble);color:var(--bt-ink)}.bt-product-message-user .bt-bubble{background:var(--bt-user);color:var(--bt-user-ink)}
.bt-main-settings-nav-item{display:flex;width:100%;border:0;text-align:left;cursor:pointer;font:inherit}
.bt-main-settings-nav-item:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-conversation{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-main-header{height:56px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:.5px solid var(--bt-line-2);font-size:15px;font-weight:600}
.bt-main-health{margin-left:auto;padding:2px 8px;border:1px solid var(--bt-line);border-radius:999px;color:var(--bt-ink-2);font-size:11px;line-height:16px;font-weight:500}
.bt-main-health-running{border-color:var(--bt-accent);color:var(--bt-ink)}
.bt-main-health-degraded{border-color:var(--bt-danger);color:var(--bt-danger)}
.bt-main-health-detail{color:var(--bt-ink-2);font-size:11px;font-weight:400}
.bt-main-remote{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:11px;font-weight:400}
.bt-main-connect-dialog{--bt-set-w:min(480px,calc(100vw - 32px));--bt-set-h:auto;width:var(--bt-set-w);height:auto;max-height:calc(100vh - 32px);overflow:auto}
.bt-main-connect-dialog .bt-settings-main{width:100%;height:auto}
.bt-main-connect-body{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px;color:var(--bt-ink);font-size:13px;line-height:18px}
.bt-main-connect-body label{font-size:12px;color:var(--bt-ink-2)}
.bt-main-connect-body input{width:100%;height:36px;box-sizing:border-box;padding:0 10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit}
.bt-main-connect-body input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-connect-body p{margin:4px 0;overflow-wrap:anywhere}
.bt-main-connect-body button{min-height:36px}
.bt-main-client-form{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;padding:10px 12px;font-size:var(--bt-font-small)}
.bt-main-client-form label{align-self:center;color:var(--bt-ink-2)}
.bt-main-client-form input{max-width:190px}.bt-main-client-form select{max-width:170px}
.bt-main-client-issued{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;border-top:1px solid var(--bt-line);font-size:var(--bt-font-small)}
.bt-main-client-issued p{width:100%;margin:0}.bt-main-client-issued input{max-width:300px;min-width:0;border:1px solid var(--bt-line);border-radius:var(--bt-radius-input);background:var(--bt-card);color:var(--bt-ink);padding:8px}
.bt-main-client-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-top:1px solid var(--bt-line);font-size:var(--bt-font-small)}
.bt-main-client-row>div{min-width:0;display:flex;flex-direction:column;gap:2px}.bt-main-client-row span{color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-main-health-warning{margin:0;padding:8px 24px;border-bottom:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-danger);font-size:12px;line-height:18px}
.bt-main-settings{margin-left:2px}
.bt-main-history{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px}
.bt-main-messages{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.bt-main-composer{width:min(800px,100% - 32px);margin:16px auto 20px;padding:12px;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-card)}
.bt-main-composer textarea{display:block;width:100%;resize:vertical;min-height:80px;max-height:200px;padding:4px;border:0;background:transparent;color:var(--bt-ink);font:inherit;font-size:14px;line-height:22px;box-sizing:border-box}
.bt-main-composer textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-main-attachments,.bt-main-message-attachments{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.bt-main-attachment{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 7px;border:1px solid var(--bt-line);border-radius:6px;color:var(--bt-ink-2);font-size:12px;overflow-wrap:anywhere}
.bt-main-attachment button{border:0;background:transparent;color:var(--bt-ink);cursor:pointer;font:inherit}
.bt-main-attachment button:focus-visible,.bt-main-message-attachments button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-read-aloud{margin:4px 0 4px 12px}.bt-main-read-aloud:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-send button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-directory{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}.bt-main-directory .bt-main-label{margin:0}.bt-main-directory-note{color:var(--bt-ink-2);font-size:11px;line-height:16px}.bt-main-directory .bt-main-error{width:100%;margin:0}
.bt-main-send{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.bt-main-send button{height:36px;min-width:64px}
.bt-main-label{display:block;margin:0 0 6px;font-size:12px;color:var(--bt-ink-2)}
.bt-main-empty{margin:48px 0;color:var(--bt-ink-2);font-size:14px;line-height:22px;text-align:center}
.bt-main-error{margin:8px 0;color:var(--bt-danger);font-size:13px;line-height:18px}
.bt-main-status{color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-main-system-fact{padding:10px 12px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-main-system-fact>span{display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;font-size:10px}.bt-main-system-fact p{margin:0;color:var(--bt-ink)}
.bt-main-work,.bt-main-source{max-width:800px;margin:0 auto;width:calc(100% - 32px);padding:12px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);box-sizing:border-box}
.bt-main-work:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-work-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;color:var(--bt-ink);font-size:14px;line-height:20px}
.bt-main-work-title{min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-main-work-source{color:var(--bt-ink-2);font-size:10px;line-height:14px;text-transform:uppercase;letter-spacing:.05em}
.bt-main-work-head strong{min-width:0;overflow-wrap:anywhere;font-weight:600}
.bt-main-work-status{flex:none;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-main-work-id,.bt-main-work-detail,.bt-main-work-artifact,.bt-main-source-label{margin:6px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-main-source-label{font-weight:600}
.bt-main-source-reference{display:block;margin:6px 0 0;overflow-wrap:anywhere;color:var(--bt-ink-2);font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace}
.bt-main-source-deliveries{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid var(--bt-line)}
.bt-main-source-deliveries p{margin:0}
.bt-main-work-followups{margin-top:8px;padding-top:8px;border-top:.5px solid var(--bt-line-2)}
.bt-main-work-followup{padding:6px 0;color:var(--bt-ink);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-main-work-followup+.bt-main-work-followup{border-top:.5px solid var(--bt-line-2)}
.bt-main-work-followup p{margin:0}
.bt-main-work-controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;padding-top:8px;border-top:.5px solid var(--bt-line-2)}
.bt-main-work-controls button{height:32px}
.bt-main-work-handoff{margin-top:10px;padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-main-work-handoff h3{margin:0 0 6px;font-size:13px;line-height:18px}
.bt-main-work-handoff p{margin:0 0 6px}.bt-main-work-handoff-copy p{margin:6px 0 0}
.bt-main-work-handoff ul{max-height:240px;overflow:auto;margin:8px 0 0;padding-left:20px}
.bt-main-work-handoff li{margin:4px 0}.bt-main-work-handoff-blockers{color:var(--bt-danger)}
.bt-main-work-handoff-actions{display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin-top:10px}
.bt-main-work-handoff-actions label{display:flex;flex-direction:column;gap:4px;min-width:220px;font-size:12px;color:var(--bt-ink-2)}
.bt-main-work-handoff-actions button{height:32px}
.bt-main-work-handoff button:focus-visible,.bt-main-work-handoff select:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-main-work-attention{margin-top:10px;padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-main-work-attention p{margin:0 0 8px}.bt-main-work-options{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.bt-main-work-answer label{display:block;margin-bottom:6px;font-size:12px;color:var(--bt-ink-2)}
.bt-main-work-answer textarea{display:block;width:100%;min-height:58px;box-sizing:border-box;resize:vertical;padding:8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit}
.bt-main-work-answer textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-work-answer>button{margin-top:8px}
.bt-main-work-result{margin-top:8px;padding-top:8px;border-top:.5px solid var(--bt-line-2);color:var(--bt-ink);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-main-work-result p{margin:0 0 6px}.bt-main-work-result p:last-child{margin-bottom:0}
.bt-main-work-artifact code{font:inherit;color:var(--bt-ink)}
.bt-main-work-evidence-actions{margin-top:10px}.bt-main-work-evidence-actions button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-evidence{grid-column:1/-1;padding:14px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-main-evidence-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.bt-main-evidence-head>div{min-width:0}
.bt-main-evidence-head strong{font-size:13px}.bt-main-evidence-head p{margin:3px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:18px}.bt-main-evidence-head>span{flex:none;color:var(--bt-ink-2);font-size:11px}
.bt-main-evidence pre{margin:10px 0;padding:10px;max-height:360px;overflow:auto;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-main-history-more{display:block;margin:0 auto 8px}
.bt-main-nav{padding:12px;display:flex;flex-direction:column;gap:6px}
.bt-main-nav>button,.bt-observation-nav-item{width:100%;display:flex;align-items:center;gap:10px;justify-content:flex-start;min-height:40px;text-align:left}
.bt-observation-search{margin:8px 0 4px;color:var(--bt-ink-2);font-size:12px}
.bt-observation-search label{display:block;margin:0 0 5px}
.bt-observation-search input{width:100%;height:36px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:0 9px;font:inherit;font-size:13px}
.bt-observation-search input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-observation-nav-head{display:flex;justify-content:space-between;gap:8px;margin:8px 2px 2px;color:var(--bt-ink-2);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-nav-item{align-items:flex-start;padding:8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--bt-ink)}
.bt-observation-nav-item:hover,.bt-observation-nav-item:focus-visible,.bt-observation-nav-item[aria-current=page]{border-color:var(--bt-line);background:var(--bt-card)}
.bt-observation-nav-item:focus-visible,.bt-observation-generation:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-observation-role{flex:none;padding:1px 6px;border:1px solid var(--bt-line);border-radius:999px;color:var(--bt-ink-2);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-nav-copy{min-width:0;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px}
.bt-observation-nav-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bt-observation-nav-copy>span{color:var(--bt-ink-2);font-size:11px}
.bt-observation-empty{margin:8px;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-observation-more{margin-top:8px}
.bt-observation{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-observation-header{min-height:56px;flex-shrink:0;display:flex;align-items:center;gap:12px;padding:8px 24px;border-bottom:.5px solid var(--bt-line-2);box-sizing:border-box}
.bt-observation-heading{min-width:0;flex:1;display:flex;align-items:center;gap:8px}
.bt-observation-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}
.bt-observation-readonly{flex:none;padding:2px 8px;border:1px solid var(--bt-line);border-radius:999px;color:var(--bt-ink-2);font-size:11px}
.bt-observation-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px}
.bt-observation-content{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.bt-observation-summary{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);font-size:14px;line-height:22px}
.bt-observation-summary>div:first-child{min-width:0}
.bt-observation-summary p{margin:0 0 6px;overflow-wrap:anywhere}.bt-observation-summary p:last-child{margin-bottom:0}
.bt-observation-status{font-size:12px;line-height:18px;color:var(--bt-ink-2);font-weight:600}
.bt-observation-actions{flex:none}
.bt-observation-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:0;overflow:hidden;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-line)}
.bt-observation-facts>div{min-width:0;padding:10px 12px;background:var(--bt-card)}
.bt-observation-facts dt{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-observation-facts dd{margin:2px 0 0;overflow-wrap:anywhere;font-size:12px;line-height:18px}
.bt-observation-detail-open{display:block;margin-top:8px}.bt-observation-detail-open:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-observation-detail{padding:12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card)}
.bt-observation-detail-head,.bt-observation-detail-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-observation-detail-head h2{margin:0;font-size:13px;line-height:20px}.bt-observation-detail-head span{color:var(--bt-ink-2);font-size:11px}
.bt-observation-detail pre{margin:10px 0;padding:10px;max-height:360px;overflow:auto;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-observation-detail-actions{justify-content:flex-end;flex-wrap:wrap}
.bt-observation-generations,.bt-observation-history{display:flex;flex-direction:column;gap:8px}
.bt-observation-generations h2,.bt-observation-history h2{margin:0;font-size:13px;line-height:20px}
.bt-observation-generation{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;padding:8px 10px;border:1px solid var(--bt-line);border-radius:8px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:11px;text-align:left;overflow-wrap:anywhere}
.bt-observation-generation:not(:disabled):hover,.bt-observation-generation:not(:disabled):focus-visible{border-color:var(--bt-accent);color:var(--bt-ink)}
.bt-observation-generation[aria-current=true]{border-color:var(--bt-accent);color:var(--bt-ink)}
.bt-observation-event{padding:10px 12px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-observation-event-head{display:flex;justify-content:space-between;gap:12px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-observation-event-head>span{font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.bt-observation-event p{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.bt-main-settings-select{max-width:min(100%,360px)}
.bt-main-settings-prompt{width:100%;min-height:120px;box-sizing:border-box;resize:vertical;border:1px solid var(--bt-line);border-radius:var(--bt-radius-input);background:var(--bt-main);color:var(--bt-ink);padding:9px;font:inherit;font-size:var(--bt-font-body);line-height:19px}
.bt-main-settings-prompt:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-settings-route{max-width:58%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:var(--bt-font-small)}
.bt-main-settings-save{justify-content:flex-end;gap:8px}
.bt-main-settings-conflict{margin:0;padding:10px 12px;border:1px solid var(--bt-danger);border-radius:var(--bt-radius-row);background:color-mix(in srgb,var(--bt-danger) 7%,transparent);font-size:var(--bt-font-body);line-height:19px}
.bt-main-settings-conflict p{margin:0 0 8px}
.bt-main-provider{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-main-provider+.bt-main-provider{border-top:.5px solid var(--bt-line)}
.bt-main-provider-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-main-provider-copy strong{font-size:var(--bt-font-body)}.bt-main-provider-copy span,.bt-main-provider-key>span{color:var(--bt-ink-2);font-size:var(--bt-font-caption);line-height:16px}
.bt-main-provider-key{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.bt-main-provider-key input{width:160px;height:32px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:var(--bt-radius-input);background:var(--bt-main);color:var(--bt-ink);padding:0 8px;font:inherit;font-size:var(--bt-font-small)}
.bt-main-settings-use{display:grid;grid-template-columns:auto auto minmax(0,1fr) minmax(80px,1.5fr) auto;align-items:center;gap:8px;padding:8px 12px;font-size:var(--bt-font-caption);line-height:16px;color:var(--bt-ink-2)}
.bt-main-settings-use+.bt-main-settings-use{border-top:.5px solid var(--bt-line)}
.bt-main-settings-use-session{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:640px){.bt-main-history,.bt-observation-body{padding:16px}.bt-main-header,.bt-observation-header{padding-left:16px;padding-right:16px}.bt-main-header{flex-wrap:wrap;height:auto;min-height:56px}.bt-main-health-detail{width:100%;margin-left:38px}.bt-main-health-warning{padding-left:16px;padding-right:16px}.bt-observation-header{align-items:flex-start;flex-wrap:wrap}.bt-observation-heading{order:3;width:100%}.bt-observation-summary{flex-direction:column}.bt-observation-facts{grid-template-columns:1fr}.bt-observation-generation{grid-template-columns:1fr}.bt-main-settings-dialog .bt-settings-nav{height:auto}.bt-main-settings-revision{padding:4px 8px}.bt-main-provider{align-items:stretch;flex-direction:column}.bt-main-provider-key{justify-content:flex-start}.bt-main-settings-use{grid-template-columns:auto auto minmax(0,1fr)}.bt-main-settings-use-session,.bt-main-settings-use time{grid-column:1/-1}.bt-main-settings-route{max-width:100%}}
`
