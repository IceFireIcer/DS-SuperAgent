import { Fragment, createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatRows } from './cells.js'
import { MainComposer } from './composer.js'
import { plainSpeech } from './voice.js'
import { readProductArtifact, readProductAttachment, uploadPayload, uploadWithRetry } from './product-attachments.js'
import { FeishuSourceStatus } from './product-feishu.js'
import { BrandMark } from './sidebar.js'
import { Card, Row } from './bot-settings.js'
import { ClockIcon, CloseIcon, GlobeIcon, MemoryIcon, SlidersIcon } from './icons.js'
import { SCHEDULE_CSS } from './schedules.js'
import { ProductScheduleSettings, PRODUCT_SCHEDULE_CSS } from './product-schedules.js'
import { ProductProactiveSettings, ProactiveReview, PRODUCT_PROACTIVE_CSS } from './product-proactive.js'
import { ProductPresetSettings, PRODUCT_PRESET_CSS } from './product-presets.js'
import { ProductCredentialSettings, PRODUCT_CREDENTIAL_CSS } from './product-credentials.js'
import { ProductMemorySettings, PRODUCT_MEMORY_CSS } from './product-memory.js'
import { LEARNING_CSS } from './learning-card.js'
import { ProductSupervisionSettings, PRODUCT_SUPERVISION_CSS } from './product-supervision.js'
import { FolderMenu, FOLDER_CSS } from './folder-menu.js'
import { MODEL_CSS } from './model-menu.js'
import { createSource } from './sources.js'
import { mergeMessages, mergeObservationItems, rebaseRoleDraft } from './product-state.js'
import { installLocale, t } from './i18n.js'
import { allThemes, themeCss } from './themes.js'
import { SHELL_CSS, CONVERSATION_CSS, installCompiledStyles, installStyles } from './styles.js'
import { ProductMcpSettings } from './product-mcp-settings.js'
import { ProductBrowserSettings, PRODUCT_BROWSER_CSS } from './product-browser-settings.js'
import { ProductExecutionSettings, PRODUCT_EXECUTION_CSS } from './product-execution.js'
import { ProductWorkView, WIDGET_CSS } from './widget-cell.js'

const clientBridge = () => window.dsBotApp?.productClient
let activeHost = 'local'

function offerDownload(data, name, mediaType = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type: mediaType }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function productCall(endpoint, payload = {}) {
  const bridge = clientBridge()
  if (activeHost === 'remote') {
    if (!bridge) throw new Error(t('The remote Host connection is unavailable.'))
    return bridge.call(endpoint, payload)
  }
  if (bridge && (await bridge.status()).connected) {
    activeHost = 'remote'
    return bridge.call(endpoint, payload)
  }
  const response = await fetch('api/product', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  let result
  try { result = await response.json() } catch { throw new Error(t('Could not reach Main. Check that the app is running.')) }
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? t('Main is unavailable.')), { code: result.error?.code })
  return result.value
}

export function applyProduct(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'superagent: interface copy')
  const view = createSource({
    binding: null,
    messages: [],
    works: [],
    activeTurn: null,
    health: null,
    sources: [],
    preparations: [],
    mainEvidence: null,
    mainEvidenceLoading: false,
    mainEvidenceError: null,
    error: null,
    mainDraft: '',
    messageBefore: null,
    messagesComplete: false,
    messagesLoading: false,
    route: 'main',
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
  let stopped = false
  let observationListRequest = 0
  let observationRequest = 0
  let observationDetailRequest = 0

  const refreshMain = async binding => {
    try {
      const page = await productCall('history', { instanceId: binding.instanceId, limit: 100 })
      if (!stopped) view.set(state => {
        return { ...state, binding, messages: mergeMessages(state.messages, page.messages),
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
      view.set(state => ({ ...state, mainEvidenceLoading: true, mainEvidenceError: null }))
      const page = await productCall('evidence', { instanceId: binding.instanceId, workItemId: work.brief.workItemId,
        ref: { kind: 'trigger' }, maxBytes: 4096, ...(append && same ? { after: current.pagination.cursor } : {}) })
      if (stopped) return
      view.set(state => ({ ...state,
        mainEvidence: { ...page, workItemId: work.brief.workItemId, goal: work.brief.goal,
          text: append && state.mainEvidence?.workItemId === work.brief.workItemId
            ? state.mainEvidence.text + page.text : page.text },
        mainEvidenceLoading: false, mainEvidenceError: null,
      }))
    } catch (error) {
      if (!stopped) view.set(state => ({ ...state, mainEvidenceLoading: false, mainEvidenceError: error.message }))
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

  const refresh = async () => {
    try {
      const bridge = clientBridge()
      const connection = bridge ? await bridge.status() : { connected: false }
      const previous = view.getSnapshot().connection
      if (previous && (previous.connected !== connection.connected
        || previous.connected && (previous.address !== connection.address || previous.instanceId !== connection.instanceId
          || previous.client.id !== connection.client.id))) { location.reload(); return }
      if (connection.connected) activeHost = 'remote'
      if (!stopped) view.set(state => ({ ...state, connection }))
      if (connection.connected) await bridge.events()
      const current = view.getSnapshot()
      const binding = current.binding ?? await productCall('open')
      if (current.route === 'main') await refreshMain(binding)
      if (!connection.connected && !view.getSnapshot().directoryOptions) await loadDirectories(binding)
      else if (connection.connected && !view.getSnapshot().directoryOptions?.execution) {
        const execution = await productCall('execution-options', { instanceId: binding.instanceId })
        if (!stopped) view.set(state => ({ ...state, directoryOptions: { ...state.directoryOptions, execution } }))
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

  const emptyRoster = { bots: [], byId: {}, roomsById: {}, prefs: {} }
  const statusCopy = status => ({ routing: t('Routing work'), pending: t('Pending work'), running: t('Running work'),
    waiting: t('Waiting for an answer'), blocked: t('Blocked work'), stopped: t('Stopped work'), success: t('Work complete'),
    failed: t('Work failed'), rejected: t('Work declined'), accepted: t('Accepted by Router'), ended: t('Generation ended'),
    unknown: t('Work result unknown') })[status] ?? status
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
  function MainWorkCard({ work, onEvidence }) {
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
        await loadObservation(state.binding, item, { reset: true })
      } catch (error) { setToolFactsError(error.message) }
      finally { setToolFactsBusy(false) }
    }
    const attention = control?.attention
    const answer = async event => {
      event.preventDefault()
      const text = attentionDraft.trim()
      if (!state.binding || !control || !assignment || !attention || attention.status !== 'waiting' || !text) return
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
        setControlBusy(null)
      }
    }
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
      stop ? h('p', { className: 'bt-main-work-detail' }, stop.pendingDeviceConfirmation
        ? t('Stopping · waiting for device cancellation confirmation.')
        : stop.state === 'stopping' ? t('Stopping · waiting for the current execution to become quiet.')
        : stop.cancellationConfirmedAt ? t('Stopped · execution cancellation confirmed.')
          : t('Stopped · cancellation confirmation is unavailable.')) : null,
      stop?.pendingDeviceConfirmation && canCommand ? h('button', { type: 'button', className: 'bt-soft',
        disabled: Boolean(controlBusy), onClick: () => runControl('work-reconcile-stop') },
      controlBusy === 'work-reconcile-stop' ? t('Checking device stop…') : t('Check device stop')) : null,
      attention?.view ? h('div', { className: 'bt-main-work-attention' },
        h('p', { className: 'bt-main-work-id' }, `${t('View version')} ${attention.version} · ${attention.status}`),
        h(ProductWorkView, { title: attention.view.title, view: attention.view.view,
          answer: attention.answerView ?? null, busy: controlBusy === 'work-answer-view',
          ...(attention.status === 'waiting' && canCommand && control.permissions.canAnswer && assignment
            ? { onSubmit: answerView } : {}) }),
        attention.status === 'waiting' ? h('p', { className: 'bt-main-work-detail' },
          t('Answer this view to continue the same work.'))
          : attention.status === 'answered' ? h('p', { className: 'bt-main-work-detail' },
            `${t('Answered by')} ${attention.answeredBy ?? control.permissions.actorId}`)
            : h('p', { className: 'bt-main-work-detail' }, t('This view is no longer active.'))) : attention ? h('div', { className: 'bt-main-work-attention' },
        h('p', { className: 'bt-main-work-id' }, `${t('Question version')} ${attention.version} · ${attention.status}`),
        h('p', null, attention.question),
        attention.status === 'waiting' && canCommand && control.permissions.canAnswer && assignment
          ? h('form', { className: 'bt-main-work-answer', onSubmit: answer },
            attention.options.length ? h('div', { className: 'bt-main-work-options' }, attention.options.map(option =>
              h('button', { key: option, type: 'button', className: 'bt-soft', onClick: () => setAttentionDraft(option) }, option))) : null,
            h('label', { htmlFor: `work-answer-${attention.id}` }, t('Answer this work question')),
            h('textarea', { id: `work-answer-${attention.id}`, value: attentionDraft, maxLength: 65536, rows: 2,
              placeholder: t('Type an answer…'), onChange: event => setAttentionDraft(event.currentTarget.value) }),
            h('button', { type: 'submit', className: 'bt-soft', disabled: Boolean(controlBusy) || !attentionDraft.trim() },
              controlBusy === 'work-answer' ? t('Sending answer…') : t('Send answer')))
          : h('p', { className: 'bt-main-work-detail' }, attention.status === 'answered'
            ? `${t('Answered by')} ${attention.answeredBy ?? control.permissions.actorId}${attention.answerText ? `: ${attention.answerText}` : ''}`
            : t('This question is no longer active.'))) : null,
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
          toolFactsBusy ? t('Loading…') : t('View tool facts'))) : null)
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
    return h('article', { className: 'bt-main-source', 'aria-label': t(scheduled ? 'Scheduled occurrence' : feishu ? 'Feishu source request' : 'GitHub source request') },
      h('div', { className: 'bt-main-work-head' }, h('strong', null, t(scheduled ? 'Scheduled occurrence' : feishu ? 'Feishu request' : 'GitHub request')),
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

  function MainConversation() {
    const state = useView()
    const canCommand = !state.connection?.connected || state.connection.capabilities.includes('command')
    const [sending, setSending] = useState(false)
    const [sendError, setSendError] = useState(null)
    const [attachments, setAttachments] = useState([])
    const [uploading, setUploading] = useState(false)
    const [speakingId, setSpeakingId] = useState(null)
    useEffect(() => () => window.speechSynthesis?.cancel(), [])
    const bottom = useRef(null)
    const pending = useRef(null)
    const scroll = useRef(null)
    const follow = useRef(true)
    const restoreHeight = useRef(null)
    const execution = state.directoryOptions?.execution
    const policyTarget = execution?.policy?.defaultTarget === 'remote-only' ? 'remote-only'
      : execution?.policy?.defaultTarget === 'auto' ? 'auto' : 'local-only'
    const executionTarget = state.executionTarget ?? policyTarget
    const localEnvironments = execution?.environments?.filter(environment => environment.kind === 'local') ?? []
    const remoteEnvironments = execution?.environments?.filter(environment => environment.kind === 'remote') ?? []
    const selectedRemoteEnvironment = remoteEnvironments.find(environment =>
      environment.id === state.remoteEnvironmentOverride) ?? remoteEnvironments[0]
    const selectedLocalEnvironmentId = state.directoryOverride ?? state.directoryOptions?.default?.environmentId
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
    const downloadAttachment = async attachment => {
      if (!state.binding) return
      try {
        const data = await readProductAttachment(productCall, state.binding.instanceId, attachment.id)
        offerDownload(data, attachment.name, attachment.mediaType)
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
      if (!state.binding) return false
      const attachmentIds = attachments.map(attachment => attachment.id)
      const environmentId = attachments[0]?.environmentId ?? selectedEnvironmentId
      if (executionTarget === 'local-only' && !environmentId || attachmentIds.length && !environmentId) {
        setSendError(t('Choose an authorized Environment for this execution target.')); return false
      }
      if (executionTarget === 'auto' && attachmentIds.length) {
        setSendError(t('Remove attached files before using automatic target selection.')); return false
      }
      const storageKey = `superagent:pending:${state.connection?.connected
        ? `${state.connection.address}:${state.connection.client.id}` : 'local'}:${state.binding.instanceId}`
      try {
        setSending(true); setSendError(null)
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
        await refreshMain(state.binding)
        setAttachments([])
        view.set(current => ({ ...current, directoryOverride: null, localEnvironmentOverride: null, remoteEnvironmentOverride: null }))
        if (result.status === 'failed') { setSendError(t('Main could not finish this reply. Your message is saved.')); return false }
        return true
      } catch (error) { setSendError(error.message); await refreshMain(state.binding); return false }
      finally { setSending(false) }
    }
    const busy = sending || Boolean(state.activeTurn) || state.messages.some(message => ['queued', 'running', 'stopping'].includes(message.status))
    const stopping = state.activeTurn?.status === 'stopping'
    const stop = async () => {
      if (!state.binding || !state.activeTurn) return
      const commandId = crypto.randomUUID()
      try {
        setSendError(null)
        await productCall('stop-main', { instanceId: state.binding.instanceId, commandId, messageId: state.activeTurn.messageId })
        await refreshMain(state.binding)
      } catch (error) {
        setSendError(error.message)
      }
    }
    const options = state.directoryOptions
    const override = options?.directories.find(directory => directory.id === state.directoryOverride)
    const chooseWorkDirectory = async path => {
      if (!state.binding) return
      if (attachments.length) { setSendError(t('Remove attached files before changing directories.')); return }
      view.set(current => ({ ...current, directoryBusy: true, directoryError: null }))
      try {
        const selected = path ? await registerDirectory(state.binding, path) : null
        await loadDirectories(state.binding)
        view.set(current => ({ ...current, directoryOverride: selected?.id ?? null }))
      } catch (error) { view.set(current => ({ ...current, directoryError: error.message })) }
      finally { view.set(current => ({ ...current, directoryBusy: false })) }
    }
    const chooseTarget = value => {
      if (attachments.length) { setSendError(t('Remove attached files before changing execution targets.')); return }
      view.set(current => ({ ...current, executionTarget: value, localEnvironmentOverride: null, remoteEnvironmentOverride: null }))
    }
    const targetControl = execution ? h('div', { className: 'bt-main-directory' },
      h('span', { className: 'bt-main-label' }, t('Execution target')),
      h('select', { className: 'bt-select', 'aria-label': t('Execution target'), value: executionTarget,
        onChange: event => chooseTarget(event.target.value), disabled: busy },
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
    return h('section', { className: 'bt-main-conversation', 'aria-label': 'Main' },
      h('header', { className: 'bt-main-header' }, h(BrandMark, { size: 28 }), h('span', null, 'Main'),
        h('span', { className: `bt-main-health bt-main-health-${state.health?.state ?? 'ready'}`, role: 'status' },
          mainHealthCopy(state.health)),
        state.health?.queuedInputs ? h('span', { className: 'bt-main-health-detail' },
          t('{count} inputs queued', { count: state.health.queuedInputs })) : null,
        state.connection?.connected ? h('span', { className: 'bt-main-remote', title: state.connection.address },
          `${t('Remote Host')} · ${state.connection.client.label}`) : null,
        clientBridge() ? h('button', { type: 'button', className: 'bt-soft', onClick: () => view.set(current => ({ ...current, connectOpen: true })) },
          state.connection?.connected ? t('Connection') : t('Connect to Host')) : null,
        !state.connection?.connected ? h('button', { type: 'button', className: 'bt-icon-btn bt-main-settings', title: t('Settings'),
          'aria-label': t('Settings'), onClick: () => view.set(current => ({ ...current, settingsOpen: true })) }, h(SlidersIcon)) : null),
      state.health?.state === 'degraded' ? h('p', { className: 'bt-main-health-warning', role: 'alert' },
        t('Main model failed. Durable work facts remain available.')) : null,
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
                      : `${t(message.source.kind === 'feishu' ? 'Feishu' : 'GitHub')} · @${message.source.authorId} · ${message.source.objectId}`) : null,
                h(ChatRows, { items: [{ kind: message.role === 'main' ? 'bot' : 'user', text: message.text, time: message.createdAt }],
                  sessionId: 'main', roster: emptyRoster, actions: {} }),
                message.role === 'main' && message.text && window.speechSynthesis
                  ? h('button', { type: 'button', className: 'bt-soft bt-main-read-aloud',
                    onClick: () => speakReply(message) }, t(speakingId === message.id ? 'Stop reading' : 'Read aloud')) : null,
                message.attachments?.length ? h('div', { className: 'bt-main-message-attachments', 'aria-label': t('Attached files') },
                  message.attachments.map(attachment => h('button', { key: attachment.id, type: 'button', className: 'bt-soft',
                    disabled: Boolean(state.connection?.connected), onClick: () => void downloadAttachment(attachment) },
                  `${t('Download')} ${attachment.name} · ${attachment.bytes} ${t('bytes')}`))) : null,
                message.status === 'failed' ? h('p', { className: 'bt-main-error', role: 'status' },
                  t('Main could not finish this reply. Your message is saved.')) : null))),
          !state.connection?.connected ? h(FeishuSourceStatus, { instanceId: state.binding?.instanceId, call: productCall }) : null,
          state.sources.map(source => h(MainSourceCard, { key: source.id, source, instanceId: state.binding?.instanceId,
            onRefresh: refresh, canCommand })),
          state.preparations.map(preparation => h(MainPreparationCard, { key: preparation.id, preparation })),
          state.works.map(work => h(MainWorkCard, { key: work.brief.workItemId ?? work.brief.id, work,
            onEvidence: selected => { if (state.binding) void loadMainEvidence(state.binding, selected) } })),
          state.mainEvidenceError && !state.mainEvidence
            ? h('p', { role: 'alert', className: 'bt-main-error' }, state.mainEvidenceError) : null,
          state.mainEvidence ? h('section', { className: 'bt-main-evidence', 'aria-label': t('Original request evidence') },
            h('div', { className: 'bt-main-evidence-head' }, h('div', null,
              h('strong', null, t('Original request evidence')), h('p', null, t(state.mainEvidence.goal))),
              h('span', null, t(state.mainEvidence.pagination.truncated ? 'Partial evidence' : 'Complete evidence'))),
            h('pre', null, redactObservationText(state.mainEvidence.text)),
            state.mainEvidenceError ? h('p', { role: 'alert', className: 'bt-main-error' }, state.mainEvidenceError) : null,
            state.mainEvidence.pagination.truncated ? h('button', { type: 'button', className: 'bt-soft',
              disabled: state.mainEvidenceLoading, onClick: () => { if (state.binding) void loadMainEvidence(state.binding,
                { brief: { workItemId: state.mainEvidence.workItemId, goal: state.mainEvidence.goal } }, { append: true }) } },
            state.mainEvidenceLoading ? t('Loading…') : t('Load more evidence')) : null) : null,
          stopping ? h('p', { className: 'bt-main-status', role: 'status' }, t('Stopping this Main reply…')) : busy
            ? h('p', { className: 'bt-main-status', role: 'status' }, t('Main is replying…')) : null,
          h('div', { ref: bottom }))),
      h(MainComposer, { onSend: send, onStop: canCommand && state.activeTurn ? stop : undefined, busy, stopping, readOnly: !canCommand,
        error: sendError ?? state.error,
        value: state.mainDraft, onValueChange: mainDraft => view.set(current => ({ ...current, mainDraft })),
        attachments, uploading, onRemoveAttachment: removeAttachment,
        speechRemote: () => ctx.get('remote.speech') ?? undefined,
        onFiles: !state.connection?.connected && executionTarget !== 'auto' && selectedEnvironmentId
          ? files => void uploadFiles(files) : undefined,
        directoryControl: execution ? h('div', { className: 'bt-main-directory' },
          targetControl,
          !state.connection?.connected && executionTarget === 'local-only' && options?.default ? h(Fragment, null,
            h('span', { className: 'bt-main-label' }, t('Work directory')),
            h(FolderMenu, { value: override?.root, label: t('Work directory'), fallbackLabel: t('Instance default'),
              actions: directoryActions(state.binding), run: promise => void Promise.resolve(promise).catch(error =>
                view.set(current => ({ ...current, directoryError: error.message }))), onPick: chooseWorkDirectory,
              disabled: busy || state.directoryBusy })) : null,
          state.directoryError ? h('p', { className: 'bt-main-error', role: 'alert' }, state.directoryError) : null) : null }))
  }

  function ObservationConversation() {
    const state = useView()
    const [copyState, setCopyState] = useState('idle')
    const [detailCopyState, setDetailCopyState] = useState('idle')
    const observation = state.observation
    const openDetail = (detailId, append = false) => {
      if (state.binding && state.selectedObservation) {
        void loadObservationDetail(state.binding, state.selectedObservation, detailId, { append })
      }
    }
    const backToMain = () => {
      view.set(current => ({ ...current, route: 'main', selectedObservation: null, observationGeneration: null,
        observation: null, observationError: null, observationDetail: null, observationDetailError: null }))
      void refresh()
      setTimeout(() => document.querySelector('#main-message, .bt-main-composer textarea')?.focus(), 0)
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
        h('button', { type: 'button', className: 'bt-soft', onClick: backToMain }, t('Back to Main')),
        h('div', { className: 'bt-observation-heading' },
          h('span', { className: 'bt-observation-role' }, observation?.role === 'router' ? 'Router' : 'Worker'),
          h('strong', null, observation?.title ?? state.selectedObservation?.title ?? '')),
        h('span', { className: 'bt-observation-readonly' }, t('Read-only')),
        !state.connection?.connected ? h('button', { type: 'button', className: 'bt-icon-btn', title: t('Settings'), 'aria-label': t('Settings'),
          onClick: () => view.set(current => ({ ...current, settingsOpen: true })) }, h(SlidersIcon)) : null),
      h('div', { className: 'bt-observation-body' },
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

  function MainNavigation() {
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
    return h('nav', { className: 'bt-main-nav', 'aria-label': t('Work navigation') },
      h('button', { type: 'button', className: 'bt-soft', 'aria-current': state.route === 'main' ? 'page' : undefined,
        onClick: () => {
          view.set(current => ({ ...current, route: 'main', selectedObservation: null, observationGeneration: null,
            observation: null, observationError: null, observationDetail: null, observationDetailError: null }))
          void refresh()
          setTimeout(() => document.querySelector('#main-message, .bt-main-composer textarea')?.focus(), 0)
        } }, h(BrandMark, { size: 24 }), 'Main'),
      clientBridge() ? h('button', { type: 'button', className: 'bt-soft',
        onClick: () => view.set(current => ({ ...current, connectOpen: true })) },
        state.connection?.connected ? `${t('Remote Host')} · ${state.connection.client.label}` : t('Connect to Host')) : null,
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

  function SettingsDialog({ binding, onClose }) {
    const [page, setPage] = useState('roles')
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
      setLoading(true)
      try {
        const value = await productCall('settings', { instanceId: binding.instanceId, limit: 50 })
        applySnapshot(value, preserve)
        setError(null)
      } catch (failure) { setError(failure.message) }
      finally { setLoading(false) }
    }
    useEffect(() => { void load() }, [binding.instanceId])
    useEffect(() => {
      const close = event => { if (event.key === 'Escape') onClose() }
      window.addEventListener('keydown', close)
      return () => window.removeEventListener('keydown', close)
    }, [onClose])
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
        const latest = await productCall('settings', { instanceId: binding.instanceId, limit: 50 })
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
        const latest = await productCall('settings', { instanceId: binding.instanceId, limit: 50 })
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
      const latest = await productCall('settings', { instanceId: binding.instanceId, limit: 50 })
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
    const close = h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: onClose }, h(CloseIcon))
    if (loading && !draft) return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: onClose }),
      h('div', { className: 'bt-settings bt-main-settings-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Super-agent settings') },
        h('div', { className: 'bt-settings-main' }, h('div', { className: 'bt-settings-head' }, h('h2', null, t('Super-agent settings'))),
          h('div', { className: 'bt-settings-scroll' }, h('p', { className: 'bt-main-status', role: 'status' }, t('Loading configuration…')))),
        close))
    if (!draft) return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: onClose }),
      h('div', { className: 'bt-settings bt-main-settings-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Super-agent settings') },
        h('div', { className: 'bt-settings-main' }, h('div', { className: 'bt-settings-head' }, h('h2', null, t('Super-agent settings'))),
          h('div', { className: 'bt-settings-scroll' }, h('p', { className: 'bt-main-error', role: 'alert' }, error ?? t('Configuration is unavailable.')))),
        close))
    const models = snapshot.providers.flatMap(provider => provider.models)
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
    return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: onClose }),
      h('div', { className: 'bt-settings bt-main-settings-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Super-agent settings') },
        h('nav', { className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'roles' ? 'page' : undefined, onClick: () => setPage('roles') }, h(SlidersIcon), t('Roles and providers')),
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'execution' ? 'page' : undefined, onClick: () => setPage('execution') }, h(GlobeIcon), t('Execution')),
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'schedules' ? 'page' : undefined, onClick: () => setPage('schedules') }, h(ClockIcon), t('Scheduled tasks')),
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'preparations' ? 'page' : undefined, onClick: () => setPage('preparations') }, h(ClockIcon), t('Proactive preparation')),
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'presets' ? 'page' : undefined, onClick: () => setPage('presets') }, h(SlidersIcon), t('Role presets')),
          h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'memory' ? 'page' : undefined, onClick: () => setPage('memory') }, h(MemoryIcon), t('Memory')),
          !viewState.connection?.connected ? h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'browser' ? 'page' : undefined, onClick: () => setPage('browser') }, h(GlobeIcon), t('Browser resources')) : null,
          !viewState.connection?.connected ? h('button', { type: 'button', className: 'bt-settings-item bt-main-settings-nav-item',
            'aria-current': page === 'supervision' ? 'page' : undefined, onClick: () => setPage('supervision') }, h(SlidersIcon), t('Supervision')) : null,
          h('span', { className: 'bt-main-settings-revision' }, `${t('Configuration')} v${snapshot.revision}`)),
        h('div', { className: 'bt-settings-main' },
          h('div', { className: 'bt-settings-head' }, h('h2', null, page === 'execution' ? t('Execution')
            : page === 'schedules' ? t('Scheduled tasks')
            : page === 'presets' ? t('Role presets') : page === 'preparations' ? t('Proactive preparation')
              : page === 'memory' ? t('Memory') : page === 'browser' ? t('Browser resources')
                : page === 'supervision' ? t('Supervision') : t('Super-agent settings'))),
          h('div', { className: 'bt-settings-scroll' },
            page === 'execution' ? h(ProductExecutionSettings, { binding, call: productCall,
              onChanged: () => { void loadDirectories(binding) } })
              : page === 'schedules' ? h(ProductScheduleSettings, { binding, works: view.getSnapshot().works, call: productCall,
              onViewWork: viewWork })
              : page === 'preparations' ? h(ProductProactiveSettings, { binding, call: productCall })
              : page === 'presets' ? h(ProductPresetSettings, { binding, call: productCall,
                settingsRevision: snapshot.revision, roleSettings: snapshot, onApplied: refreshAfterPreset, onReload: refreshAfterPreset })
                : page === 'memory' ? h(ProductMemorySettings, { key: binding.instanceId, binding, works: view.getSnapshot().works, call: productCall })
                : page === 'browser' ? h(ProductBrowserSettings, { binding, works: view.getSnapshot().works,
                  directoryOptions: viewState.directoryOptions, call: productCall, browserBridge: globalThis.dsBotApp?.browser })
                : page === 'supervision' ? h(ProductSupervisionSettings, { binding, call: productCall }) : h(Fragment, null,
            error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
            viewState.directoryError ? h('p', { className: 'bt-main-error', role: 'alert' }, viewState.directoryError) : null,
            conflict ? h('div', { className: 'bt-main-settings-conflict', role: 'status' },
              h('p', null, t('Newer settings exist. Rebase only your changed fields, then review and save.')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: saving, onClick: () => { void rebase() } }, t('Rebase my edits'))) : null,
            notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
            viewState.directoryOptions?.default ? h(Card, { title: t('Work directories') },
              h(Row, { label: t('Instance default directory'), hint: t('New work starts here unless you choose a work directory in Main.') },
                h(FolderMenu, { value: viewState.directoryOptions.default.root, team: true,
                  label: t('Instance default directory'), actions: directoryActions(binding),
                  run: promise => void Promise.resolve(promise).catch(failure =>
                    view.set(current => ({ ...current, directoryError: failure.message }))),
                  onPick: chooseDefaultDirectory, disabled: viewState.directoryBusy }))) : null,
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
                : h('p', { className: 'bt-main-status' }, t('No provider catalog is available. Configure providers in DSH settings.'))),
            h(ProductCredentialSettings, { binding, call: productCall }),
            h(ProductMcpSettings, { binding, call: productCall }),
            h(ClientSettings, { binding }),
            h(Card, { title: t('Recent configuration uses') },
              snapshot.uses.length ? snapshot.uses.slice(0, 20).map(use => h('div', { key: use.id, className: 'bt-main-settings-use' },
                h('span', { className: 'bt-observation-role' }, use.role),
                h('span', null, `${t('Configuration')} v${use.revision}`),
                h('span', null, refOf(use[use.role] ?? use.worker ?? use.router)),
                h('span', { className: 'bt-main-settings-use-session', title: use.sessionId }, use.sessionId),
                h('time', null, new Date(use.createdAt).toLocaleString()))) : h('p', { className: 'bt-main-status' }, t('No role turn has recorded a configuration version yet.'))),
            h('p', { className: 'bt-main-status' }, t('Configuration versions apply at request boundaries. A turn already running keeps the version it started with.')))),
          close)))
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
    return h(Fragment, null,
      state.route === 'observe' ? h(ObservationConversation) : h(MainConversation),
      state.settingsOpen && state.binding && !state.connection?.connected ? h(SettingsDialog, { binding: state.binding,
        onClose: () => view.set(current => ({ ...current, settingsOpen: false })) }) : null,
      state.connectOpen && clientBridge() ? h(ConnectionDialog, { connection: state.connection,
        onClose: () => view.set(current => ({ ...current, connectOpen: false })) }) : null)
  }
  const shadow = (name, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -200 }, component))
  ctx.effect(() => installCompiledStyles(SHELL_CSS + CONVERSATION_CSS + SCHEDULE_CSS + MODEL_CSS + FOLDER_CSS + PRODUCT_CSS + PRODUCT_SCHEDULE_CSS + PRODUCT_CREDENTIAL_CSS + PRODUCT_PRESET_CSS + PRODUCT_PROACTIVE_CSS + PRODUCT_SUPERVISION_CSS + PRODUCT_MEMORY_CSS + PRODUCT_BROWSER_CSS + PRODUCT_EXECUTION_CSS + WIDGET_CSS + LEARNING_CSS, 'main'), 'superagent: existing chat styles')
  ctx.effect(() => { const style = installStyles(themeCss(allThemes().deepseek), 'main-theme'); return () => style.remove() }, 'superagent: existing theme')
  shadow('main.conversation', ProductSurface)
  shadow('sidebar.workspaces', MainNavigation)
  shadow('sidebar.brand.name', () => h('span', null, 'DS-SuperAgent'))
  shadow('sidebar.brand.mark', BrandMark)
}

function redactObservationText(value) {
  return String(value).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\x2f-]+=*/giu, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
}

const PRODUCT_CSS = `
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
.bt-main-client-form{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;padding:10px 12px;font-size:12px}
.bt-main-client-form label{align-self:center;color:var(--bt-ink-2)}
.bt-main-client-form input{max-width:190px}.bt-main-client-form select{max-width:170px}
.bt-main-client-issued{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;border-top:1px solid var(--bt-line);font-size:12px}
.bt-main-client-issued p{width:100%;margin:0}.bt-main-client-issued input{max-width:300px;min-width:0;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:8px}
.bt-main-client-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-top:1px solid var(--bt-line);font-size:12px}
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
.bt-main-settings-revision{margin-top:auto;padding:12px 8px 4px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-main-settings-select{max-width:min(100%,360px)}
.bt-main-settings-prompt{width:100%;min-height:120px;box-sizing:border-box;resize:vertical;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);padding:9px;font:inherit;font-size:13px;line-height:19px}
.bt-main-settings-prompt:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-settings-route{max-width:58%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:12px}
.bt-main-settings-save{justify-content:flex-end;gap:8px}
.bt-main-settings-conflict{margin:0;padding:10px 12px;border:1px solid var(--bt-danger);border-radius:10px;background:color-mix(in srgb,var(--bt-danger) 7%,transparent);font-size:13px;line-height:19px}
.bt-main-settings-conflict p{margin:0 0 8px}
.bt-main-provider{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-main-provider+.bt-main-provider{border-top:.5px solid var(--bt-line)}
.bt-main-provider-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-main-provider-copy strong{font-size:13px}.bt-main-provider-copy span,.bt-main-provider-key>span{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-main-provider-key{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.bt-main-provider-key input{width:160px;height:32px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);padding:0 8px;font:inherit;font-size:12px}
.bt-main-settings-use{display:grid;grid-template-columns:auto auto minmax(0,1fr) minmax(80px,1.5fr) auto;align-items:center;gap:8px;padding:8px 12px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-main-settings-use+.bt-main-settings-use{border-top:.5px solid var(--bt-line)}
.bt-main-settings-use-session{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:640px){.bt-main-history,.bt-observation-body{padding:16px}.bt-main-header,.bt-observation-header{padding-left:16px;padding-right:16px}.bt-main-header{flex-wrap:wrap;height:auto;min-height:56px}.bt-main-health-detail{width:100%;margin-left:38px}.bt-main-health-warning{padding-left:16px;padding-right:16px}.bt-observation-header{align-items:flex-start;flex-wrap:wrap}.bt-observation-heading{order:3;width:100%}.bt-observation-summary{flex-direction:column}.bt-observation-facts{grid-template-columns:1fr}.bt-observation-generation{grid-template-columns:1fr}.bt-main-settings-dialog .bt-settings-nav{height:auto}.bt-main-settings-revision{padding:4px 8px}.bt-main-provider{align-items:stretch;flex-direction:column}.bt-main-provider-key{justify-content:flex-start}.bt-main-settings-use{grid-template-columns:auto auto minmax(0,1fr)}.bt-main-settings-use-session,.bt-main-settings-use time{grid-column:1/-1}.bt-main-settings-route{max-width:100%}}
`
