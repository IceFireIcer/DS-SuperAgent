import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const clientDir = join(plugin, 'src/client')
const requireHarness = createRequire(join(plugin, 'dev/harness/package.json'))

let cached
async function boardModule() {
  if (cached) return cached
  const { outputFiles } = await build({
    stdin: {
      contents: readFileSync(join(clientDir, 'product-board.js'), 'utf8'),
      resolveDir: clientDir,
      sourcefile: 'product-board.js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    write: false,
    logLevel: 'silent',
  })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', outputFiles[0].text)(
    module,
    module.exports,
    requireHarness,
  )
  cached = module.exports
  return cached
}

const binding = {
  instanceId: 'instance-board',
  mainSessionId: 'main-session-board',
  routerSessionId: 'router-session-board',
}

function makeWork(id, status, options = {}) {
  const ticketId = options.ticketId ?? `ticket-${id}`
  const assignment = options.assignmentState === undefined ? undefined : {
    id: `assignment-${id}`,
    generation: `generation-${id}`,
    sessionId: options.sessionId ?? `worker-${id}`,
    state: options.assignmentState,
  }
  const control = options.control === false ? undefined : {
    workItemId: id,
    ticketId,
    ticketVersion: options.ticketVersion ?? 7,
    permissions: {
      actorId: 'user',
      canStop: options.canStop ?? !['stopped', 'success'].includes(status),
      canResume: false,
      canRetry: false,
      canAnswer: false,
      canHandoff: false,
    },
    ...(assignment ? { assignment } : {}),
    ...(options.attention ? { attention: options.attention } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
  }
  return {
    brief: {
      id: `brief-${id}`,
      workItemId: id,
      goal: options.goal ?? `Goal ${id}`,
      constraints: '',
      acceptanceCriteria: '',
      target: 'local-only',
      createdAt: options.createdAt ?? 1,
    },
    receipt: {
      version: 1,
      workBriefId: `brief-${id}`,
      workItemId: id,
      status: options.receiptStatus ?? 'accepted',
      ...(options.includeTicket === false ? {} : { ticketId }),
      nextStep: 'Wait for the next durable update.',
      createdAt: 1,
    },
    status,
    ...(control ? { control } : {}),
    ...(options.update ? { update: options.update } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
  }
}

test('members keep Main and Router fixed and deduplicate active Worker Sessions', async () => {
  const { projectProductBoard } = await boardModule()
  const works = [
    makeWork('worker-a-1', 'running', { assignmentState: 'running', sessionId: 'worker-a' }),
    makeWork('worker-a-2', 'running', { assignmentState: 'running', sessionId: 'worker-a' }),
    makeWork('idle-worker', 'running', { assignmentState: 'ended', sessionId: 'worker-idle' }),
    makeWork('waiting-worker', 'waiting', { assignmentState: 'ended', sessionId: 'worker-waiting',
      attention: { status: 'waiting', question: 'Choose one.', sessionId: 'worker-waiting' } }),
    makeWork('routing-work', 'pending', { receiptStatus: 'routing', control: false }),
  ]
  const observations = [
    { id: 'obs-a', role: 'worker', sessionId: 'worker-a', current: true, status: 'running', summary: 'Editing files.' },
    { id: 'obs-extra', role: 'worker', sessionId: 'worker-extra', current: true, status: 'running', summary: 'Running tests.' },
    { id: 'obs-idle', role: 'worker', sessionId: 'worker-idle', workItemId: 'idle-worker', current: false,
      status: 'running', summary: 'Stale observation.' },
    { id: 'obs-waiting', role: 'worker', sessionId: 'worker-question', current: true,
      status: 'waiting', summary: 'Waiting for the answer.' },
    { id: 'obs-ended', role: 'worker', sessionId: 'worker-ended', current: true, status: 'success' },
    { id: 'obs-no-current', role: 'worker', sessionId: 'worker-no-current', status: 'running' },
  ]
  const board = projectProductBoard({ binding, works, observations, activeTurn: { status: 'running' } })
  assert.deepEqual(board.members.map(member => member.role), ['main', 'router', 'worker', 'worker', 'worker', 'worker'])
  assert.deepEqual(board.members.map(member => member.sessionId), [
    'main-session-board', 'router-session-board', 'worker-a', 'worker-waiting', 'worker-extra', 'worker-question',
  ])
  assert.equal(board.workerCount, 4)
  assert.equal(board.members.find(member => member.id === 'main').state, 'running')
  assert.equal(board.members.find(member => member.id === 'router').state, 'routing')
  assert.equal(board.members.find(member => member.sessionId === 'worker-waiting').state, 'waiting')
  assert.equal(board.members.find(member => member.sessionId === 'worker-question').state, 'waiting')
  assert.equal(board.members.some(member => member.sessionId === 'worker-idle'), false)
  assert.equal(board.members.some(member => member.sessionId === 'worker-no-current'), false)
  assert.equal(board.members.find(member => member.sessionId === 'worker-a').detail, 'Editing files.')
  assert.deepEqual(projectProductBoard({ works: [], observations: [] }).members.map(member => member.role), ['main', 'router'])
  const stoppedMain = projectProductBoard({ binding, activeTurn: { status: 'stopped' } }).members[0]
  assert.equal(stoppedMain.state, 'ready')
  assert.equal(stoppedMain.detail, 'Ready for the next request.')
})

test('members mark a Worker with a pending stop as stopping', async () => {
  const { projectProductBoard } = await boardModule()
  const work = makeWork('stop-pending', 'running', {
    assignmentState: 'running',
    sessionId: 'worker-stopping',
    stop: { id: 'stop-pending', state: 'stopping', requestedAt: 4, requestedBy: 'user',
      reason: 'User stop.', pendingDeviceConfirmation: false },
  })
  const board = projectProductBoard({ binding, works: [work], observations: [] })
  assert.equal(board.members.find(member => member.sessionId === 'worker-stopping').state, 'stopping')
})

test('the Work board aggregates every Work Item into the five fixed groups', async () => {
  const { projectProductBoard, WORK_BOARD_GROUPS } = await boardModule()
  const success = (id, options = {}) => makeWork(id, 'success', {
    canStop: false,
    outcome: { status: 'success', summary: `Result ${id}` },
    ...options,
  })
  const works = [
    makeWork('routing', 'pending', { receiptStatus: 'routing', control: false }),
    makeWork('follow-up-running', 'running', {
      assignmentState: 'running',
      outcome: { status: 'success', summary: 'An earlier report, not the current direction.' },
    }),
    success('local-delivered'),
    success('source-pending', { ticketId: 'ticket-source-pending' }),
    success('source-sent', { ticketId: 'ticket-source-sent' }),
    success('source-latest-pending', { ticketId: 'ticket-source-latest' }),
    makeWork('waiting', 'waiting', { attention: { status: 'waiting', question: 'Pick a layout.' } }),
    makeWork('blocked', 'blocked'),
    makeWork('unknown', 'unknown'),
    makeWork('failed', 'failed', { receiptStatus: 'rejected' }),
    makeWork('stopped', 'stopped', {
      stop: { id: 'stop-stopped', state: 'stopped', requestedAt: 2, requestedBy: 'user', reason: 'User stop.',
        pendingDeviceConfirmation: false, cancellationConfirmedAt: 3 },
    }),
    makeWork('stopping', 'running', {
      assignmentState: 'stopping',
      stop: { id: 'stop-stopping', state: 'stopping', requestedAt: 4, requestedBy: 'user', reason: 'User stop.',
        pendingDeviceConfirmation: false },
    }),
  ]
  const sources = [
    { id: 'source-pending', ticketIds: ['ticket-source-pending'],
      deliveries: [{ ticketId: 'ticket-source-pending', purpose: 'result', state: 'pending' }] },
    { id: 'source-sent', ticketIds: ['ticket-source-sent'],
      deliveries: [{ ticketId: 'ticket-source-sent', purpose: 'result', state: 'sent' }] },
    { id: 'source-latest', ticketIds: ['ticket-source-latest'],
      deliveries: [{ ticketId: 'ticket-source-latest', purpose: 'result', state: 'sent', sequence: 1, createdAt: 1 },
        { ticketId: 'ticket-source-latest', purpose: 'result', state: 'pending', sequence: 2, createdAt: 2 },
        { ticketId: 'ticket-sibling', purpose: 'result', state: 'sent', sequence: 3, createdAt: 3 }] },
  ]
  const board = projectProductBoard({ binding, works, sources })
  assert.deepEqual(board.groups.map(group => group.id), WORK_BOARD_GROUPS.map(group => group.id))
  assert.deepEqual(board.counts, {
    total: works.length,
    running: 2,
    'waiting-delivery': 2,
    'waiting-human': 4,
    delivered: 2,
    stopped: 2,
  })
  assert.deepEqual(board.groups.flatMap(group => group.items.map(item => item.id)).sort(),
    works.map(work => work.brief.workItemId).sort())
  assert.deepEqual(board.groups.find(group => group.id === 'waiting-delivery').items.map(item => item.id),
    ['source-pending', 'source-latest-pending'])
  const sourceItem = board.groups.find(group => group.id === 'waiting-delivery').items
    .find(item => item.ticketId === 'ticket-source-latest')
  assert.deepEqual(sourceItem.delivery.receipts.map(receipt => receipt.ticketId), [
    'ticket-source-latest', 'ticket-source-latest',
  ], 'delivery receipts for a sibling Ticket never satisfy this work item')
  assert.equal(board.groups.find(group => group.id === 'running').items.some(item => item.id === 'follow-up-running'), true)
  assert.equal(board.groups.find(group => group.id === 'delivered').items.some(item => item.id === 'source-sent'), true)
  assert.equal(board.groups.find(group => group.id === 'delivered').items.some(item => item.id === 'local-delivered'), true)
})

test('board actions call work-stop with exact facts and expose user-follow-up helpers', async () => {
  const {
    createProductBoardController,
    createProductBoardActions,
    createProductFollowUp,
  } = await boardModule()
  const calls = []
  const notes = []
  const refreshStatuses = []
  let refreshed = 0
  let command = 0
  const works = [makeWork('action-work', 'running', { assignmentState: 'running', sessionId: 'worker-action' })]
  const controller = createProductBoardController({
    binding,
    works,
    productCall: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      return { status: 'running' }
    },
    refresh: async () => { refreshed += 1 },
    followUp: async (item, text) => {
      notes.push([item, text])
      return { queued: true }
    },
    makeCommandId: () => `board-command-${++command}`,
  })
  const item = controller.board.items[0]
  await controller.stopWork(item, {
    onRefreshStatus: (status, error) => refreshStatuses.push([status, error?.message]),
  })
  assert.deepEqual(calls, [['work-stop', {
    instanceId: 'instance-board',
    commandId: 'board-command-1',
    workItemId: 'action-work',
    ticketId: 'ticket-action-work',
    expectedTicketVersion: 7,
    reason: 'Stopped from the Work view.',
    expectedGeneration: 'generation-action-work',
  }]])
  await controller.addNote(item, 'Please keep the current layout.', {
    onRefreshStatus: (status, error) => refreshStatuses.push([status, error?.message]),
  })
  assert.deepEqual(notes, [[item, 'Please keep the current layout.']])
  assert.equal(refreshed, 2)
  assert.deepEqual(refreshStatuses, [
    ['refreshing', undefined],
    ['refreshed', undefined],
    ['refreshing', undefined],
    ['refreshed', undefined],
  ])

  const followCalls = []
  const originalNote = '  Use the compact layout.\nKeep the heading unchanged.  '
  const followUp = createProductFollowUp({
    binding,
    productCall: async (endpoint, payload) => { followCalls.push([endpoint, payload]); return { status: 'failed' } },
    makeCommandId: () => 'follow-command',
  })
  const followResult = await followUp(item, originalNote)
  assert.equal(followCalls[0][0], 'send')
  assert.deepEqual(followCalls[0][1], {
    instanceId: 'instance-board',
    commandId: 'follow-command',
    text: originalNote,
    followUp: { workItemId: 'action-work', ticketId: 'ticket-action-work' },
  })
  assert.equal(followResult.status, 'failed', 'a failed Main reply does not undo the persisted send')
  const oversizedChinese = '好'.repeat(11_000)
  await assert.rejects(followUp(item, oversizedChinese), { code: 'BOARD_NOTE_TOO_LONG' },
    'the client limit uses the same UTF-8 byte budget as the Main command')
  let noteRefreshes = 0
  const savedNoteResult = await createProductBoardActions({
    binding,
    followUp,
    refresh: async () => { noteRefreshes += 1 },
  }).addNote(item, originalNote)
  assert.equal(savedNoteResult.status, 'failed')
  assert.equal(followCalls[1][1].text, originalNote, 'follow-up preserves the exact user text')
  assert.equal(noteRefreshes, 1, 'the durable Main history is refreshed after send')

  const refreshStates = []
  let completeRefresh
  const refreshGate = new Promise(resolve => { completeRefresh = resolve })
  const refreshingActions = createProductBoardActions({
    binding,
    productCall: async () => ({ accepted: true }),
    refresh: async () => refreshGate,
  })
  const stop = refreshingActions.stopWork(item, {
    onRefreshStatus: (status, error) => refreshStates.push([status, error?.message]),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(refreshStates, [['refreshing', undefined]])
  completeRefresh()
  await stop

  const failedRefreshStates = []
  const failedRefreshActions = createProductBoardActions({
    binding,
    productCall: async () => ({ accepted: true }),
    refresh: async () => { throw new Error('history is temporarily unavailable') },
  })
  await failedRefreshActions.stopWork(item, {
    onRefreshStatus: (status, error) => failedRefreshStates.push([status, error?.message]),
  })
  assert.deepEqual(failedRefreshStates, [
    ['refreshing', undefined],
    ['failed', 'history is temporarily unavailable'],
  ])
  const unavailableRefresh = createProductBoardActions({ binding, productCall: async () => ({ accepted: true }) })
  const unavailableStates = []
  await unavailableRefresh.stopWork(item, {
    onRefreshStatus: (status, error) => unavailableStates.push([status, error?.code]),
  })
  assert.deepEqual(unavailableStates, [
    ['unavailable', 'BOARD_REFRESH_UNAVAILABLE'],
  ])

  const unavailable = createProductBoardActions({ binding })
  await assert.rejects(unavailable.addNote(item, 'This cannot be sent.'),
    { code: 'BOARD_FOLLOW_UP_UNAVAILABLE' })
  await assert.rejects(unavailable.stopWork(item), { code: 'BOARD_STOP_UNAVAILABLE' })
  const notAllowed = createProductBoardActions({ binding, productCall: async () => ({}) })
  await assert.rejects(notAllowed.stopWork(createProductBoardController({ binding, works: [
    makeWork('complete-work', 'success', { canStop: false, outcome: { status: 'success', summary: 'Done.' } }),
  ] }).board.items[0]), { code: 'BOARD_STOP_NOT_ALLOWED' })
})

test('dock and board keep transient UI state while polling, confirm stop, and fail notes closed', async () => {
  const {
    ProductMemberDock,
    ProductWorkBoard,
    projectProductBoard,
  } = await boardModule()
  const React = requireHarness('react')
  const { createRoot } = requireHarness('react-dom/client')
  const { JSDOM } = requireHarness('jsdom')
  const { Fragment } = React
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let root
  try {
    const works = [
      makeWork('stop-me', 'running', { assignmentState: 'running', sessionId: 'worker-live', goal: 'Stop the active work.' }),
      makeWork('note-me', 'waiting', {
        canStop: false,
        attention: { status: 'waiting', question: 'Choose a layout.' },
        goal: 'Collect a reviewed note.',
      }),
      makeWork('done-me', 'success', {
        canStop: false,
        outcome: { status: 'success', summary: 'Already delivered.' },
      }),
    ]
    const observations = [
      { id: 'worker-live-observation', role: 'worker', sessionId: 'worker-live', current: true,
        status: 'running', summary: 'Running the requested checks.' },
    ]
    let completeStopRefresh
    const stopRefreshGate = new Promise(resolve => { completeStopRefresh = resolve })
    const actions = {
      stopWork: async (item, options) => {
        actions.stopped.push(item.id)
        options.onRefreshStatus('refreshing')
        await stopRefreshGate
        options.onRefreshStatus('failed', new Error('history refresh failed'))
      },
      addNote: async (item, text, options) => {
        actions.notes.push([item.id, text])
        options.onRefreshStatus('refreshing')
        options.onRefreshStatus('refreshed')
      },
      stopped: [],
      notes: [],
    }
    let nextBoard = projectProductBoard({ binding, works, observations })
    root = createRoot(dom.window.document.querySelector('#root'))
    const render = async (board, nextActions = actions) => {
      await React.act(async () => {
        root.render(React.createElement(Fragment, null,
          React.createElement(ProductMemberDock, { board, actions: nextActions }),
          React.createElement(ProductWorkBoard, { board, actions: nextActions })))
      })
    }
    await render(nextBoard)
    const document = dom.window.document
    assert.equal(document.querySelectorAll('[data-member-role="main"]').length, 1)
    assert.equal(document.querySelectorAll('[data-member-role="router"]').length, 1)
    assert.equal(document.querySelectorAll('[data-member-role="worker"]').length, 1)
    assert.deepEqual([...document.querySelectorAll('section[data-board-group] > header h3')]
      .map(heading => heading.textContent), ['Running', 'Waiting for delivery', 'Waiting for a person', 'Delivered', 'Stopped'])
    assert.match(document.body.textContent, /3 work items/u)

    const dockStop = document.querySelector('[data-member-role="worker"] .bt-product-board-stop')
    assert.ok(dockStop)
    await React.act(async () => dockStop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(actions.stopped, [], 'the first click only asks for confirmation')
    assert.equal(dockStop.textContent, 'Confirm stop')
    await React.act(async () => dockStop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(actions.stopped, ['stop-me'])
    assert.equal(dockStop.textContent, 'Refreshing work state…')
    await React.act(async () => {
      completeStopRefresh()
      await stopRefreshGate
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    assert.match(document.querySelector('.bt-product-board-stop-wrap [role="status"]').textContent,
      /history refresh failed/u)

    let noteItem = document.querySelector('[data-work-item-id="note-me"]')
    const openNote = noteItem.querySelector('.bt-product-board-note-open')
    await React.act(async () => openNote.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    let textarea = noteItem.querySelector('textarea')
    assert.ok(textarea, 'the note composer uses a user-follow-up field')
    await React.act(async () => setValue(dom, textarea, 'Please use the compact layout.'))
    await React.act(async () => noteItem.querySelector('.bt-product-board-note-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(actions.notes, [['note-me', 'Please use the compact layout.']])
    assert.match(noteItem.textContent, /Follow-up saved in Main\./u)

    noteItem = document.querySelector('[data-work-item-id="note-me"]')
    await React.act(async () => noteItem.querySelector('.bt-product-board-note-open')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    textarea = noteItem.querySelector('textarea')
    await React.act(async () => setValue(dom, textarea, 'Keep this draft while polling.'))
    const updatedWorks = works.map(work => work.brief.workItemId === 'note-me'
      ? makeWork('note-me', 'running', {
        canStop: false,
        assignmentState: 'running',
        sessionId: 'worker-note',
        goal: 'Collect a reviewed note.',
        update: { summary: 'Polling refreshed the work fact.' },
      })
      : work)
    nextBoard = projectProductBoard({ binding, works: updatedWorks, observations })
    await render(nextBoard)
    noteItem = document.querySelector('[data-work-item-id="note-me"]')
    assert.equal(noteItem.querySelector('textarea').value, 'Keep this draft while polling.')
    assert.match(noteItem.textContent, /Polling refreshed the work fact\./u)
    assert.equal(noteItem.closest('section[data-board-group]').dataset.boardGroup, 'running')

    const endedWorks = updatedWorks.map(work => ['stop-me', 'note-me'].includes(work.brief.workItemId)
      ? makeWork(work.brief.workItemId, 'running', { assignmentState: 'ended',
        sessionId: work.brief.workItemId === 'stop-me' ? 'worker-live' : 'worker-note',
        goal: work.brief.goal })
      : work)
    const endedObservations = observations.map(observation => ({ ...observation, status: 'success' }))
    await render(projectProductBoard({ binding, works: endedWorks, observations: endedObservations }))
    assert.equal(document.querySelectorAll('[data-member-role="worker"]').length, 0,
      'an idle Worker Session leaves the dock on the next history poll')

  } finally {
    if (root) await React.act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

test('a missing follow-up adapter leaves the note action visible and fails closed', async () => {
  const { ProductWorkBoard, projectProductBoard } = await boardModule()
  const React = requireHarness('react')
  const { createRoot } = requireHarness('react-dom/client')
  const { JSDOM } = requireHarness('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let root
  try {
    const work = makeWork('note-only', 'waiting', {
      attention: { status: 'waiting', question: 'Choose a layout.' },
      goal: 'Keep the note action visible.',
    })
    const board = projectProductBoard({ binding, works: [work], observations: [] })
    root = createRoot(dom.window.document.querySelector('#root'))
    await React.act(async () => root.render(React.createElement(ProductWorkBoard, { board, actions: {} })))
    const item = dom.window.document.querySelector('[data-work-item-id="note-only"]')
    const noteButton = item.querySelector('.bt-product-board-note-open')
    assert.equal(noteButton.textContent, 'Add note')
    await React.act(async () => noteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(item.textContent, /User follow-up is unavailable\. The note was not sent\./u)
    assert.equal(item.querySelector('textarea'), null, 'a missing follow-up does not open a fake note store')
  } finally {
    if (root) await React.act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

function setValue(dom, element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
