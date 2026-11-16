import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('The browser Worker did not settle.')
    await sleep(25)
  }
}

test('the product Host grants an isolated browser to its current Worker and records its operation', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-browser-'))
  const work = join(root, 'work'), core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  await writeFile(join(work, 'evidence.txt'), 'Verified in the local Environment.\n')
  let workerStarted, releaseWorker
  const started = new Promise(resolve => { workerStarted = resolve })
  const held = new Promise(resolve => { releaseWorker = resolve })
  let secondWorkerStarted, releaseSecondWorker, browserStarted, releaseBrowser
  const secondStarted = new Promise(resolve => { secondWorkerStarted = resolve })
  const secondHeld = new Promise(resolve => { releaseSecondWorker = resolve })
  const browserCalled = new Promise(resolve => { browserStarted = resolve })
  const browserHeld = new Promise(resolve => { releaseBrowser = resolve })
  const mainTools = [], routerTools = [], workerTools = []
  const calls = []
  const native = await nativeContext(join(root, 'sessions'), async function* (options) {
    const text = lastUserText(options)
    const count = completedToolCount(options)
    if (options.model === 'main') {
      mainTools.push(...options.tools.map(tool => tool.name))
      if (text.startsWith('[Work update]')) { yield* textResponse('The work result was received.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { goal: text, constraints: 'Use only this work.',
        acceptanceCriteria: 'Read a browser page and verify the local evidence.' })
      else yield* textResponse('Worker started.')
    } else if (options.model === 'router') {
      routerTools.push(...options.tools.map(tool => tool.name))
      yield* routerResponse(options)
    } else {
      workerTools.push(...options.tools.map(tool => tool.name))
      if (count === 0) {
        if (text.includes('Stop browser')) { secondWorkerStarted(); await secondHeld }
        else { workerStarted(); await held }
        yield* toolResponse('browser_resources', {})
      }
      else if (count === 1) yield* toolResponse('browser_use', { resourceId: resource.id,
        action: 'open', url: 'https://example.test/page' })
      else if (count === 2) yield* toolResponse('run_shell', { command: process.platform === 'win32' ? 'Write-Output verified' : 'printf verified' })
      else if (count === 3) yield* toolResponse('report_ready', { result: 'Read the approved browser page.',
        evidence: 'The isolated browser returned its bounded page and the local command succeeded.', artifacts: 'evidence.txt' })
      else yield* textResponse('The work is complete.')
    }
  })
  const config = { instanceId: 'personal', actorId: 'alice', databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    browserAdapter: { async execute(request, signal) { signal.throwIfAborted(); calls.push(request)
      if (calls.length === 2) { browserStarted(); await browserHeld; signal.throwIfAborted() }
      return 'Browser page (untrusted content). Origin: https://example.test\nTitle: Example\nMock content' } } }
  let host, resource
  t.after(async () => { releaseWorker(); releaseSecondWorker(); releaseBrowser(); await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, config)
  const directory = (await host.dispatch('directory-options', { instanceId: 'personal' })).directories[0]
  resource = await host.dispatch('browser-create', { instanceId: 'personal', commandId: 'register', environmentId: directory.id,
    label: 'Research browser' })
  await assert.rejects(host.dispatch('browser-list', { instanceId: 'personal' }, { id: 'remote-client' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await host.dispatch('send', { instanceId: 'personal', commandId: 'work', text: 'Read the approved browser page.' })
  await started
  let workCard
  await until(async () => {
    workCard = (await host.dispatch('history', { instanceId: 'personal' })).works.find(item => item.brief?.goal === 'Read the approved browser page.')
    return Boolean(workCard?.receipt?.ticketId)
  })
  const grant = await host.dispatch('browser-grant', { instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    workItemId: workCard.brief.workItemId, expectedRevision: resource.revision, active: true })
  assert.equal(grant.active, true)
  releaseWorker()
  await until(async () => (await host.dispatch('history', { instanceId: 'personal' })).works
    .some(item => item.brief?.workItemId === workCard.brief.workItemId && item.outcome?.status === 'success'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'open')
  assert.match(calls[0].profileKey, /^session-[\da-f-]{36}$/u)
  const raw = await SqliteStorage.open(config.databasePath)
  const report = await raw.transaction('personal', tx => tx.get('report', workCard.receipt.ticketId))
  await raw.close()
  assert.equal(report.toolFacts.filter(fact => fact.tool === 'browser_use' && fact.outcome === 'success').length, 1)
  const browser = await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })
  assert.equal(browser.state, 'available', 'a completed Assignment no longer holds the lease')
  assert.equal(browser.operations.at(-1).state, 'succeeded')
  assert.equal(browser.grants.some(item => item.workItemId === workCard.brief.workItemId && item.active), true)
  assert.equal(browser.grantsTruncated, false)
  assert.equal(JSON.stringify(browser).includes('Mock content'), false, 'page data stays out of product resource projections')
  assert.ok(workerTools.some(name => name === 'browser_use'))
  assert.ok(mainTools.every(name => !name.startsWith('browser_')))
  assert.ok(routerTools.every(name => !name.startsWith('browser_')))

  await host.dispatch('send', { instanceId: 'personal', commandId: 'stop-work', text: 'Stop browser request.' })
  await secondStarted
  let stopWork
  await until(async () => {
    stopWork = (await host.dispatch('history', { instanceId: 'personal' })).works.find(item => item.brief?.goal === 'Stop browser request.')
    return Boolean(stopWork?.receipt?.ticketId && stopWork.control?.assignment)
  })
  await host.dispatch('browser-grant', { instanceId: 'personal', commandId: 'grant-stop', resourceId: resource.id,
    workItemId: stopWork.brief.workItemId, expectedRevision: grant.revision, active: true })
  releaseSecondWorker()
  await browserCalled
  await host.dispatch('work-stop', { instanceId: 'personal', commandId: 'stop-browser',
    workItemId: stopWork.brief.workItemId, ticketId: stopWork.receipt.ticketId,
    expectedGeneration: stopWork.control.assignment.generation, expectedTicketVersion: stopWork.control.ticketVersion,
    reason: 'Stop while the browser response is pending.' })
  releaseBrowser()
  let unknown
  await until(async () => {
    unknown = (await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })).operations.at(-1)
    return unknown?.state === 'unknown'
  })
  const stopping = (await host.dispatch('history', { instanceId: 'personal' })).works.find(item => item.brief?.workItemId === stopWork.brief.workItemId)
  assert.equal(stopping.control.stop.state, 'stopping')
  assert.equal(stopping.control.stop.cancellationConfirmedAt, undefined)
  await host.dispatch('browser-resolve', { instanceId: 'personal', commandId: 'resolve-stop', resourceId: resource.id,
    operationId: unknown.id, reason: 'INSPECTED' })
  await until(async () => (await host.dispatch('history', { instanceId: 'personal' })).works
    .some(item => item.brief?.workItemId === stopWork.brief.workItemId && item.control?.stop?.cancellationConfirmedAt))
  const settled = await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })
  await assert.rejects(host.dispatch('browser-grant', { instanceId: 'personal', commandId: 'stale-grant',
    resourceId: resource.id, workItemId: stopWork.brief.workItemId, expectedRevision: settled.revision - 1, active: false }),
  { code: 'RESOURCE_STALE' })
  const revokedGrant = await host.dispatch('browser-grant', { instanceId: 'personal', commandId: 'revoke-grant',
    resourceId: resource.id, workItemId: stopWork.brief.workItemId, expectedRevision: settled.revision, active: false })
  assert.equal(revokedGrant.active, false)
  const projected = await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })
  assert.equal(projected.grants.some(grant => grant.workItemId === stopWork.brief.workItemId && grant.active),
    false)
  assert.equal(JSON.stringify(projected).includes('profileKey'), false)
  assert.equal(JSON.stringify(projected).includes('Mock content'), false)
  const grantStore = await SqliteStorage.open(config.databasePath)
  await grantStore.transaction('personal', async tx => {
    for (let index = 0; index < 50; index++) {
      const resourceId = 'other-resource-a'
      await tx.insert('browser-grant', JSON.stringify([resourceId, `dummy-${index}`]),
        { resourceId, workItemId: `dummy-${index}`, active: true })
    }
    for (let index = 50; index < 101; index++) {
      const resourceId = 'other-resource-b'
      await tx.insert('browser-grant', JSON.stringify([resourceId, `dummy-${index}`]),
        { resourceId, workItemId: `dummy-${index}`, active: true })
    }
  })
  const isolated = await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })
  assert.equal(isolated.grantsTruncated, false, 'a different resource cannot exhaust this resource projection')
  await grantStore.transaction('personal', async tx => {
    await tx.insert('work-brief', 'full-brief', { id: 'full-brief', instanceId: 'personal', environmentId: resource.environmentId })
    await tx.insert('work-item', 'full-work', { id: 'full-work', workBriefId: 'full-brief' })
    await tx.insert('work-item-ticket', 'full-work', { ticketId: 'full-ticket' })
    for (let index = 0; index < 100; index++) {
      const workItemId = `full-${index}`
      await tx.insert('browser-grant', JSON.stringify([resource.id, workItemId]),
        { resourceId: resource.id, workItemId, active: false })
    }
  })
  await grantStore.close()
  const truncated = await host.dispatch('browser-read', { instanceId: 'personal', resourceId: resource.id })
  assert.equal(truncated.grants.length, 100)
  assert.equal(truncated.grantsTruncated, true)
  await assert.rejects(host.dispatch('browser-grant', { instanceId: 'personal', commandId: 'over-limit',
    resourceId: resource.id, workItemId: 'full-work', expectedRevision: truncated.revision, active: true }),
  { code: 'RESOURCE_LIMIT' })
})
