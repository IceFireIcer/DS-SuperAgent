import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserResources, createProductHost } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

const allowHost = async () => {}
const preview = {
  source: { kind: 'file', label: 'fictional-cookies.json' },
  format: 'cookie-editor', flavor: null, entries: 2, cookies: 2,
  sourceDigest: 'a'.repeat(64),
  sites: [{ site: 'example.test', cookies: 2, session: 1, httpOnly: 1, skipped: 0 }],
  warnings: [], skipped: [], notes: ['session-cookies'],
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'r5-browser-import-'))
  const storage = await SqliteStorage.open(join(root, 'business.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const environment = { kind: 'local', config: { id: 'local', instanceId: 'personal', root: join(root, 'work'),
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search', 'command'], commands: {} } }
  await storage.transaction('personal', async tx => {
    await tx.insert('work-brief', 'brief', { id: 'brief', instanceId: 'personal', environmentId: 'local' })
    await tx.insert('work-item', 'item', { id: 'item', workBriefId: 'brief' })
    await tx.insert('work-item-ticket', 'item', { ticketId: 'ticket' })
    await tx.insert('ticket', 'ticket', { state: 'open' })
    await tx.insert('assignment', 'ticket', { id: 'assignment', generation: 'generation', state: 'running',
      environment: { id: 'local', kind: 'local', root: environment.config.root } })
  })
  return { root, storage, environment }
}

test('a browser import is preview-only until applied, then becomes one granted isolated resource', async t => {
  const { storage, environment } = await fixture(t)
  const calls = []
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const adapter = {
    execute: async () => 'page',
    importProfile: async request => {
      calls.push(request)
      await waiting
      return { stored: 2, dropped: [], failed: [], flushed: true }
    },
  }
  const browsers = new BrowserResources(storage, 'personal', 'alice', [environment], adapter, allowHost)
  const input = { instanceId: 'personal', commandId: 'import-command',
    sourceRef: '10000000-0000-4000-8000-000000000001',
    pendingId: 'pending-import-one',
    preview, environmentId: 'local', label: 'Imported research' }
  const importing = browsers.importData(input)
  for (let index = 0; index < 100 && calls.length === 0; index++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(calls.length, 1)
  assert.match(calls[0].profileKey, /^session-[\da-f-]{36}$/u)
  assert.equal(calls[0].pendingImportId, 'pending-import-one')
  assert.equal(JSON.stringify(calls[0]).includes('cookie-value'), false, 'only the pending reference crosses the adapter seam')
  const before = await browsers.listImports({ instanceId: 'personal' })
  assert.equal(before.items[0].status, 'pending')
  const resource = (await browsers.list({ instanceId: 'personal' }))[0]
  assert.equal(resource.state, 'importing')
  await assert.rejects(browsers.grant({ instanceId: 'personal', commandId: 'too-early-grant',
    resourceId: resource.id, workItemId: 'item', expectedRevision: 1, active: true }), { code: 'RESOURCE_STALE' })
  await assert.rejects(browsers.use({ instanceId: 'personal', ticketId: 'ticket', workItemId: 'item',
    assignmentId: 'assignment', generation: 'generation', environmentId: 'local' },
  { resourceId: resource.id, action: 'snapshot' }, new AbortController().signal), { code: 'BROWSER_DENIED' })
  const concurrent = browsers.importData({ ...input, commandId: 'import-concurrent' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 1, 'concurrent retries share the current dispatch')
  release()
  const [applied, sameFlight] = await Promise.all([importing, concurrent])
  assert.equal(applied.status, 'applied')
  assert.equal(sameFlight.resourceId, resource.id)
  assert.equal(applied.report.stored, 2)
  assert.equal(applied.resourceId, resource.id)
  assert.equal((await browsers.list({ instanceId: 'personal' }))[0].state, 'available')
  const replayed = await browsers.importData({ ...input, commandId: 'import-command-retry' })
  assert.equal(replayed.resourceId, resource.id)
  assert.equal(calls.length, 1, 'the already applied import is not dispatched again')
  const second = await browsers.importData({ ...input, commandId: 'import-second-source',
    sourceRef: '10000000-0000-4000-8000-000000000002',
    pendingId: 'pending-import-second', label: 'Second private browser' })
  assert.notEqual(second.resourceId, resource.id)
  assert.notEqual(calls[1].profileKey, calls[0].profileKey, 'separate imports never share browser storage')
  await assert.rejects(browsers.importData({ ...input, commandId: 'different-preview',
    preview: { ...preview, sourceDigest: 'b'.repeat(64) } }), { code: 'IDENTITY_CONFLICT' })
  await browsers.grant({ instanceId: 'personal', commandId: 'grant', resourceId: resource.id,
    workItemId: 'item', expectedRevision: 1, active: true })
  assert.equal((await browsers.use({ instanceId: 'personal', ticketId: 'ticket', workItemId: 'item',
    assignmentId: 'assignment', generation: 'generation', environmentId: 'local' },
  { resourceId: resource.id, action: 'snapshot' }, new AbortController().signal)).text, 'page')
})

test('browser import failures stay retryable and cancellation freezes the resource before the original file changes', async t => {
  const { storage, environment } = await fixture(t)
  let attempts = 0
  let releaseThird
  const thirdHeld = new Promise(resolve => { releaseThird = resolve })
  const adapter = {
    execute: async () => 'page',
    importProfile: async () => {
      attempts++
      if (attempts === 1) throw new Error('The desktop browser import response was lost.')
      if (attempts === 3) await thirdHeld
      return { stored: 2, dropped: [{ name: 'stale', domain: 'example.test', path: '/', code: 'STALE',
        reason: 'cookie-value=must-not-persist' }],
        failed: [], flushed: false }
    },
  }
  const browsers = new BrowserResources(storage, 'personal', 'alice', [environment], adapter, allowHost)
  const input = { instanceId: 'personal', commandId: 'failed-import',
    sourceRef: '10000000-0000-4000-8000-000000000003',
    pendingId: 'pending-import-two',
    preview, environmentId: 'local', label: 'Retry import' }
  await assert.rejects(browsers.importData(input), { code: 'BROWSER_IMPORT_UNKNOWN' })
  const unknown = (await browsers.listImports({ instanceId: 'personal' })).items[0]
  assert.equal(unknown.status, 'unknown')
  const retried = await browsers.importData({ ...input, commandId: 'retry-new-pending',
    pendingId: 'pending-import-two-reselected' })
  assert.equal(retried.status, 'applied')
  assert.equal(retried.report.dropped.length, 1)
  assert.equal(JSON.stringify(retried.report).includes('cookie-value'), false)
  assert.equal(attempts, 2)

  const cancelling = browsers.importData({ instanceId: 'personal', commandId: 'cancel-import',
    sourceRef: '10000000-0000-4000-8000-000000000004',
    pendingId: 'pending-import-three', preview: { ...preview, source: { kind: 'firefox', label: 'Fictional Firefox' } },
    environmentId: 'local', label: 'Cancel import' })
  for (let index = 0; index < 100 && attempts < 3; index++) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = (await browsers.listImports({ instanceId: 'personal' })).items.find(item => item.label === 'Cancel import')
  const cancelled = await browsers.cancelImport({ instanceId: 'personal', commandId: 'cancel-browser-import',
    importId: pending.id })
  assert.equal(cancelled.status, 'cancelled')
  releaseThird()
  await assert.rejects(cancelling, { code: 'BROWSER_IMPORT_CANCELLED' })
  assert.equal((await browsers.list({ instanceId: 'personal' })).find(resource => resource.id === pending.resourceId).state, 'revoked')
  await assert.rejects(browsers.importData({ instanceId: 'personal', commandId: 'cancelled-restart',
    sourceRef: '10000000-0000-4000-8000-000000000004',
    pendingId: 'pending-import-three', preview: { ...preview, source: { kind: 'firefox', label: 'Fictional Firefox' } },
    environmentId: 'local', label: 'Cancel import' }), { code: 'BROWSER_IMPORT_CANCELLED' })
})

test('the local product Host exposes value-free browser import commands and rejects remote clients', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-browser-import-'))
  const work = join(root, 'work'), core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('Ready.'))
  let host
  t.after(async () => { await host?.close().catch(() => {}); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { instanceId: 'personal', actorId: 'alice',
    databasePath: join(core, 'business.sqlite'), workspaceRoot: work,
    browserAdapter: { execute: async () => 'page', importProfile: async () =>
      ({ stored: 2, dropped: [], failed: [], flushed: true }) } })
  const directory = (await host.dispatch('directory-options', { instanceId: 'personal' })).directories[0]
  const unsafe = { ...preview, cookieValues: ['cookie-value'] }
  const imported = await host.dispatch('browser-import', { instanceId: 'personal', commandId: 'product-import',
    sourceRef: '10000000-0000-4000-8000-000000000005',
    pendingId: 'pending-product-browser', preview: unsafe, environmentId: directory.id, label: 'Imported browser' })
  assert.equal(imported.status, 'applied')
  assert.equal(JSON.stringify(imported).includes('profileKey'), false)
  assert.equal((await host.dispatch('browser-import-read', { instanceId: 'personal', importId: imported.id })).report.stored, 2)
  assert.equal((await host.dispatch('browser-import-list', { instanceId: 'personal' })).items[0].id, imported.id)
  assert.equal((await host.dispatch('browser-read', { instanceId: 'personal', resourceId: imported.resourceId })).state, 'available')
  const remote = { id: 'remote', label: 'Reader', grants: [{ instanceId: 'personal', capabilities: ['read'] }] }
  await assert.rejects(host.dispatch('browser-import-list', { instanceId: 'personal' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  await assert.rejects(host.dispatch('browser-import', { instanceId: 'personal', commandId: 'remote-import',
    sourceRef: '10000000-0000-4000-8000-000000000006',
    pendingId: 'pending-remote', preview, environmentId: directory.id, label: 'Remote' }, remote), { code: 'SOURCE_NOT_AUTHORIZED' })
  const inspection = await SqliteStorage.open(join(core, 'business.sqlite'))
  try {
    const records = JSON.stringify(await inspection.transaction('personal', tx => tx.scan('browser-import', { limit: 10 })))
    assert.equal(records.includes('cookie-value'), false)
    assert.equal(records.includes('pending-product-browser'), false)
  } finally { await inspection.close() }
})
