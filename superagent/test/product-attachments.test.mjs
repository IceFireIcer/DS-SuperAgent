import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { ProductAttachments, createProductHost, LocalEnvironment } from '../dist/index.js'
import { NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

test('a product upload keeps its original bytes and rejects foreign or revoked references', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-attachments-'))
  const work = join(root, 'work')
  await mkdir(work)
  const native = await nativeContext(join(root, 'sessions'), () => textResponse('No model turn.'))
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'harness-home') })
  const storage = await SqliteStorage.open(join(root, 'state.sqlite'))
  const environment = await LocalEnvironment.open({ id: 'work-one', instanceId: 'personal', root: work,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'search'], commands: {}, assetsPath: join(root, 'assets') })
  t.after(async () => { await storage.close(); await environment.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const resources = new ProductAttachments(storage, 'personal', native.attachments, id => id === environment.config.id ? environment : undefined)
  const data = Buffer.from('an original file longer than one page\n')
  const request = { instanceId: 'personal', actorId: 'alice', clientId: 'desktop-one', commandId: 'upload-one',
    environmentId: 'work-one', kind: 'file', name: 'note.txt', data: data.toString('base64') }
  const uploaded = await resources.upload(request)
  assert.deepEqual(await resources.upload(request), uploaded)
  assert.equal(uploaded.state, 'active')
  assert.equal(uploaded.bytes, data.length)
  assert.equal(JSON.stringify(uploaded).includes(root), false)
  await assert.rejects(resources.upload({ ...request, data: Buffer.from('different').toString('base64') }), { code: 'IDENTITY_CONFLICT' })
  const scope = { instanceId: 'personal', actorId: 'alice', clientId: 'desktop-one', environmentId: 'work-one', ids: [uploaded.id] }
  const accepted = await storage.transaction('personal', tx => resources.resolve(tx, scope))
  assert.equal(accepted.content[0].type, 'file')
  assert.equal(accepted.assets[0].environmentId, 'work-one')
  await assert.rejects(storage.transaction('personal', tx => resources.resolve(tx, { ...scope, clientId: 'desktop-two' })), { code: 'NOT_FOUND' })
  await assert.rejects(storage.transaction('personal', tx => resources.resolve(tx, { ...scope, environmentId: 'other-work' })), { code: 'ENVIRONMENT_DENIED' })
  const first = await resources.read({ ...scope, id: uploaded.id, offset: 0, maxBytes: 8 })
  const second = await resources.read({ ...scope, id: uploaded.id, offset: first.nextOffset, maxBytes: data.length })
  assert.equal(first.text + second.text, data.toString('utf8'))
  const large = Buffer.alloc(128 * 1024, 0x61)
  const larger = await resources.upload({ ...request, commandId: 'upload-large', name: 'large.txt', data: large.toString('base64') })
  const largePage = await resources.read({ ...scope, id: larger.id, offset: 0, maxBytes: 8192 })
  assert.equal(largePage.nextOffset, 8192)
  assert.equal(largePage.totalBytes, large.length)
  await writeFile(join(work, 'large-output.bin'), large)
  const bound = await environment.prepare({ instanceId: 'personal', actorId: 'alice' })
  const artifact = await bound.artifact('large-output.bin')
  assert.equal(artifact.bytes, large.length)
  assert.equal((await bound.readProductAsset(artifact.reference, { maxBytes: 8192 })).nextOffset, 8192)
  const originalText = `The named directory is ${bound.cwd}.\n`
  const pathUpload = await resources.upload({ ...request, commandId: 'upload-path-example', name: 'path.txt',
    data: Buffer.from(originalText).toString('base64') })
  const rawPage = await resources.read({ ...scope, id: pathUpload.id })
  assert.equal(rawPage.text, originalText)
  const pathRecord = await storage.transaction('personal', tx => resources.resolve(tx, { ...scope, ids: [pathUpload.id] }))
  const safePage = await bound.readAsset(pathRecord.assets[0])
  assert.notEqual(safePage.text, originalText, 'Worker evidence still uses its sanitized text projection')
  const pixel = (await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 0, g: 170, b: 220, alpha: 1 } } }).png().toBuffer()).toString('base64')
  const image = await resources.upload({ ...request, commandId: 'upload-image', kind: 'image', name: 'pixel.png',
    mediaType: 'image/png', data: pixel })
  const imageContent = await storage.transaction('personal', tx => resources.resolve(tx, { ...scope, ids: [image.id] }))
  assert.equal(imageContent.content[0].type, 'image')
  assert.equal(imageContent.assets[0].environmentId, 'work-one')
  assert.equal((await resources.revoke({ ...scope, id: uploaded.id })).state, 'revoked')
  await assert.rejects(resources.read({ ...scope, id: uploaded.id }), { code: 'ATTACHMENT_REVOKED' })
  await assert.rejects(storage.transaction('personal', tx => resources.resolve(tx, scope)), { code: 'ATTACHMENT_REVOKED' })
  await assert.rejects(resources.upload({ ...request, instanceId: 'other' }), { code: 'SOURCE_NOT_AUTHORIZED' })
})

test('Main passes admitted resources to one Worker and serves only its recorded artifact', { timeout: 25000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-main-attachment-'))
  const work = join(root, 'work')
  const core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  let readText = ''
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    if (!options.tools?.length) { yield* textResponse('A work session.'); return }
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('The verified result is available.'); return }
      if (!lastUserText(options).trim()) { yield* textResponse('The image was accepted.'); return }
      if (count === 0 && lastUserText(options).startsWith('Split attached work.')) yield* toolResponse('delegate_work', { items: [
        { goal: 'Read the note.', constraints: 'One resource.', acceptanceCriteria: 'Check the note.' },
        { goal: 'Read the image.', constraints: 'One resource.', acceptanceCriteria: 'Check the image.' },
      ] })
      else if (count === 0) yield* toolResponse('delegate_work', { goal: 'Read the attached note and create derived.txt.',
        constraints: 'Read only the resource attached to this work.', acceptanceCriteria: 'Verify the derived file.' })
      else yield* textResponse('The work was delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (count === 0) {
      const matched = /Attached resources for this work[^\n]*\n(\[[^\n]+\])/u.exec(lastUserText(options))
      assert.ok(matched, 'the Worker needs the original Environment resource reference')
      const reference = JSON.parse(matched[1]).find(item => item.name === 'note.txt')
      assert.ok(reference)
      yield* toolResponse('read_asset', { kind: reference.kind, id: reference.id, sha256: reference.sha256,
        attachmentId: reference.attachmentId, bytes: String(reference.bytes), path: '', offset: '0', maxBytes: '1024' }, 'read-attached')
    } else if (count === 1) {
      readText = JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content)
      yield* toolResponse('write_file', { path: 'derived.txt', text: 'verified from attachment\n' }, 'write-derived')
    } else if (count === 2) yield* toolResponse('run_shell', { command: `node -e "if(require('fs').readFileSync('derived.txt','utf8').trim() !== 'verified from attachment') process.exit(1)"` }, 'verify-derived')
    else if (count === 3) yield* toolResponse('report_ready', { result: 'Produced the derived file.',
      evidence: 'Read the original attached note and verified the derived file.', artifacts: 'derived.txt' }, 'report-derived')
    else yield* textResponse('No further work.')
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'harness-home') })
  let host, reader
  t.after(async () => { await reader?.close(); await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(core, 'state.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const instanceId = 'personal'
  const directory = await host.dispatch('directory-options', { instanceId })
  const upload = await host.dispatch('attachment-upload', { instanceId, commandId: 'upload-note',
    environmentId: directory.default.environmentId, kind: 'file', name: 'note.txt',
    data: Buffer.from('Bound to this product.\n').toString('base64') })
  const imageData = (await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 0, g: 170, b: 220, alpha: 1 } } }).png().toBuffer()).toString('base64')
  const image = await host.dispatch('attachment-upload', { instanceId, commandId: 'upload-picture',
    environmentId: directory.default.environmentId, kind: 'image', name: 'picture.png', mediaType: 'image/png', data: imageData })
  const remoteClient = { id: 'read-only-client', label: 'Reader', grants: [{ instanceId, capabilities: ['read'] }], createdAt: 1 }
  for (const [endpoint, payload] of [
    ['attachment-upload', { instanceId, commandId: 'remote-upload', environmentId: directory.default.environmentId,
      kind: 'file', name: 'remote.txt', data: Buffer.from('remote').toString('base64') }],
    ['attachment-read', { instanceId, id: upload.id }], ['attachment-revoke', { instanceId, id: upload.id }],
    ['artifact-read', { instanceId, workItemId: 'guessed', path: 'note.txt' }],
  ]) await assert.rejects(host.dispatch(endpoint, payload, remoteClient), { code: 'SOURCE_NOT_AUTHORIZED' })
  await host.dispatch('send', { instanceId, commandId: 'send-note', text: 'Read this note and image.', attachments: [upload.id, image.id] })
  const history = await host.dispatch('history', { instanceId })
  const user = history.messages.find(message => message.role === 'user')
  assert.deepEqual(user.attachments.map(({ id, name, state }) => ({ id, name, state })),
    [{ id: upload.id, name: 'note.txt', state: 'active' }, { id: image.id, name: 'picture.png', state: 'active' }])
  reader = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const session = await reader.readSession(history.mainSessionId, { limit: 100 })
  assert.equal(session.events.some(event => event.type === 'user/message'
    && event.data?.content?.some(block => block.type === 'file') && event.data.content.some(block => block.type === 'image')), true)
  let workItem
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await host.dispatch('history', { instanceId })
    workItem = page.works.find(work => work.outcome?.status === 'success')
    if (workItem) break
    await sleep(50)
  }
  assert.ok(workItem, 'the Worker must complete the artifact after reading the attached resource')
  assert.match(readText, /Bound to this product\./u)
  const workerSession = await reader.readSession(workItem.control.assignment.sessionId, { limit: 100 })
  assert.equal(workerSession.events.some(event => event.type === 'user/message'
    && event.data?.content?.some(block => block.type === 'image')), true,
  'the authorized Worker Session must retain the original native image block')
  const artifact = await host.dispatch('artifact-read', { instanceId, workItemId: workItem.brief.workItemId, path: 'derived.txt' })
  assert.equal(artifact.text, 'verified from attachment\n')
  await assert.rejects(host.dispatch('artifact-read', { instanceId, workItemId: workItem.brief.workItemId, path: '../note.txt' }), { code: 'NOT_FOUND' })
  await host.dispatch('send', { instanceId, commandId: 'no-shared-resources', text: 'Split attached work.', attachments: [upload.id, image.id] })
  const afterSplit = await host.dispatch('history', { instanceId })
  assert.equal(afterSplit.works.length, 1,
    `a split must not share resources with two Workers: ${JSON.stringify(afterSplit.works.map(work => work.brief.goal))}`)
  await host.dispatch('send', { instanceId, commandId: 'image-only', text: '', attachments: [image.id] })
  assert.equal((await host.dispatch('history', { instanceId })).messages.some(message => message.role === 'user'
    && message.text === '' && message.attachments?.[0]?.id === image.id), true)
  await host.dispatch('attachment-revoke', { instanceId, id: upload.id })
  await assert.rejects(host.dispatch('attachment-read', { instanceId, id: upload.id }), { code: 'ATTACHMENT_REVOKED' })
  await assert.rejects(host.dispatch('send', { instanceId, commandId: 'send-revoked', text: 'Again.', attachments: [upload.id] }),
    { code: 'ATTACHMENT_REVOKED' })
})

test('a revoked attachment is not delivered by a queued Main input', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-queued-attachment-'))
  const work = join(root, 'work')
  const core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const native = await nativeContext(join(root, 'sessions'), async function* (options) {
    if (lastUserText(options) === 'Hold the Main turn.') { entered(); await gate }
    yield* textResponse('The turn finished.')
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'harness-home') })
  let host, reader
  t.after(async () => { release(); await reader?.close(); await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(core, 'state.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const instanceId = 'personal'
  const binding = await host.dispatch('open')
  const directory = await host.dispatch('directory-options', { instanceId })
  const upload = await host.dispatch('attachment-upload', { instanceId, commandId: 'queued-upload',
    environmentId: directory.default.environmentId, kind: 'file', name: 'queued.txt', data: Buffer.from('queued').toString('base64') })
  const holding = host.dispatch('send', { instanceId, commandId: 'holding', text: 'Hold the Main turn.' })
  await started
  const waiting = host.dispatch('send', { instanceId, commandId: 'queued-input', text: 'Queued attached.', attachments: [upload.id] })
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await host.dispatch('history', { instanceId })).messages.some(message => message.text === 'Queued attached.')) break
    await sleep(20)
  }
  await host.dispatch('attachment-revoke', { instanceId, id: upload.id })
  release()
  await holding
  await assert.rejects(waiting, { code: 'ATTACHMENT_REVOKED' })
  reader = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const session = await reader.readSession(binding.mainSessionId, { limit: 100 })
  assert.equal(session.events.some(event => event.type === 'user/message'
    && event.data?.content?.some(block => block.type === 'file')), false)
})

test('one attached request grants two Workers only their own file or native image', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-item-attachments-'))
  const work = join(root, 'work')
  const core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  let fileA, imageA, fileB, imageB, duplicateB, fileReference, deniedRead = '', ownReads = []
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    const count = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('Both items are complete.'); return }
      if (count === 0) yield* toolResponse('delegate_work', { items: [
        { goal: 'Read file A.', constraints: 'Use only A resources.', acceptanceCriteria: 'Verify A.', attachmentIds: [fileA.id, imageA.id] },
        { goal: 'Read image B.', constraints: 'Use only B resources.', acceptanceCriteria: 'Verify B.', attachmentIds: [fileB.id, imageB.id, duplicateB.id] },
      ] })
      else yield* textResponse('Both items were delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    const isB = lastUserText(options).includes('Goal:\nRead image B.')
    assert.match(lastUserText(options), /Original Main request:\nRead A and B independently\./u)
    const matched = /Attached resources for this work[^\n]*\n(\[[^\n]+\])/u.exec(lastUserText(options))
    assert.ok(matched)
    const references = JSON.parse(matched[1])
    assert.deepEqual(references.map(reference => reference.name).sort(), isB ? ['B.png', 'B.txt', 'duplicate.txt'] : ['A.png', 'A.txt'])
    const ownReference = references.find(reference => reference.name === (isB ? 'B.txt' : 'A.txt'))
    assert.ok(ownReference)
    const read = reference => ({ kind: reference.kind, id: reference.id, sha256: reference.sha256, attachmentId: reference.attachmentId,
      bytes: String(reference.bytes), path: '', offset: '0', maxBytes: '1024' })
    if (count === 0) yield* toolResponse('read_asset', read(isB ? fileReference : ownReference), isB ? 'foreign' : 'own-a')
    else if (isB && count === 1) {
      deniedRead = JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content)
      yield* toolResponse('read_asset', read(ownReference), 'own-b')
    } else if (count === (isB ? 2 : 1)) {
      ownReads.push(JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content))
      yield* toolResponse('write_file', { path: isB ? 'derived-b.txt' : 'derived-a.txt', text: isB ? 'B verified\n' : 'A verified\n' }, 'write')
    } else if (count === (isB ? 3 : 2)) yield* toolResponse('run_shell', {
      command: `node -e "if(require('fs').readFileSync('${isB ? 'derived-b.txt' : 'derived-a.txt'}','utf8').trim() !== '${isB ? 'B' : 'A'} verified') process.exit(1)"`,
    }, 'verify')
    else if (count === (isB ? 4 : 3)) yield* toolResponse('report_ready', { result: isB ? 'Image B processed.' : 'File A processed.',
      evidence: 'Read the authorized resource and checked the derived file.', artifacts: isB ? 'derived-b.txt' : 'derived-a.txt' }, 'report')
    else yield* textResponse('Finished.')
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'harness-home') })
  let host, reader
  t.after(async () => { await reader?.close(); await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(core, 'state.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const instanceId = 'personal'
  const directory = await host.dispatch('directory-options', { instanceId })
  fileA = await host.dispatch('attachment-upload', { instanceId, commandId: 'item-file-a',
    environmentId: directory.default.environmentId, kind: 'file', name: 'A.txt', data: Buffer.from('Only A may read this.').toString('base64') })
  fileB = await host.dispatch('attachment-upload', { instanceId, commandId: 'item-file-b',
    environmentId: directory.default.environmentId, kind: 'file', name: 'B.txt', data: Buffer.from('Only B may read this.').toString('base64') })
  duplicateB = await host.dispatch('attachment-upload', { instanceId, commandId: 'item-file-duplicate',
    environmentId: directory.default.environmentId, kind: 'file', name: 'duplicate.txt', data: Buffer.from('Only A may read this.').toString('base64') })
  imageA = await host.dispatch('attachment-upload', { instanceId, commandId: 'item-image-a',
    environmentId: directory.default.environmentId, kind: 'image', name: 'A.png', mediaType: 'image/png',
    data: (await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 0, g: 170, b: 220, alpha: 1 } } }).png().toBuffer()).toString('base64') })
  imageB = await host.dispatch('attachment-upload', { instanceId, commandId: 'item-image-b',
    environmentId: directory.default.environmentId, kind: 'image', name: 'B.png', mediaType: 'image/png',
    data: (await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 180, g: 30, b: 10, alpha: 1 } } }).png().toBuffer()).toString('base64') })
  const original = await host.dispatch('attachment-read', { instanceId, id: fileA.id })
  assert.equal(original.text, 'Only A may read this.')
  fileReference = { ...original.reference, attachmentId: fileA.id }
  assert.equal((await host.dispatch('attachment-read', { instanceId, id: duplicateB.id })).sha256, fileReference.sha256)
  const request = { instanceId, commandId: 'two-items', text: 'Read A and B independently.', attachments: [fileA.id, imageA.id, fileB.id, imageB.id, duplicateB.id] }
  await host.dispatch('send', request)
  await host.dispatch('send', request)
  let history
  for (let attempt = 0; attempt < 100; attempt++) {
    history = await host.dispatch('history', { instanceId })
    if (history.works.length === 2 && history.works.every(item => item.receipt.ticketId)) break
    await sleep(50)
  }
  assert.equal(history.messages.filter(message => message.role === 'user' && message.text === 'Read A and B independently.').length, 1)
  assert.equal(history.works.length, 2)
  const a = history.works.find(item => item.brief.goal === 'Read file A.')
  const b = history.works.find(item => item.brief.goal === 'Read image B.')
  assert.ok(a?.receipt.ticketId && b?.receipt.ticketId,
    `both item tickets must be established: ${JSON.stringify(history.works.map(item => ({ brief: item.brief, receipt: item.receipt })))}`)
  assert.notEqual(a.receipt.ticketId, b.receipt.ticketId)
  assert.equal(a.brief.sourceEventId, b.brief.sourceEventId)
  assert.deepEqual(a.brief.attachmentIds, [fileA.id, imageA.id].sort())
  assert.deepEqual(b.brief.attachmentIds, [fileB.id, imageB.id, duplicateB.id].sort())
  assert.ok(fileReference)
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await host.dispatch('history', { instanceId })
    if (page.works.every(item => item.outcome?.status === 'success')) break
    await sleep(50)
  }
  const completed = await host.dispatch('history', { instanceId })
  assert.equal(completed.works.filter(item => item.outcome?.status === 'success').length, 2)
  assert.match(deniedRead, /Error: The bound Environment operation failed/u)
  assert.equal(deniedRead.includes('Only A may read this.'), false)
  assert.equal(ownReads.some(read => read.includes('Only A may read this.')), true)
  assert.equal(ownReads.some(read => read.includes('Only B may read this.')), true)
  assert.equal(ownReads.length, 2)
  const observation = (await host.dispatch('observe-list', { instanceId, query: 'Read image B.' })).items
    .find(item => item.role === 'worker' && item.ticketId === b.receipt.ticketId)
  assert.ok(observation)
  const detail = await host.dispatch('observe-read', { instanceId, observationId: observation.id, generation: observation.generation })
  assert.equal(detail.facts.some(fact => fact.label === 'Tool fact 1: read_asset'
    && fact.value.includes('RESOURCE_NOT_AUTHORIZED')), true, 'the server records the cross-work rejection')
  assert.equal(JSON.stringify(detail).includes('Only A may read this.'), false)
  reader = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const aSession = await reader.readSession(completed.works.find(item => item.brief.goal === 'Read file A.').control.assignment.sessionId, { limit: 100 })
  const bSession = await reader.readSession(completed.works.find(item => item.brief.goal === 'Read image B.').control.assignment.sessionId, { limit: 100 })
  const nativeImages = session => session.events.filter(event => event.type === 'user/message')
    .flatMap(event => event.data?.content?.filter(block => block.type === 'image').map(block => block.attachment.attachmentId) ?? [])
  assert.equal(nativeImages(aSession).length, 1)
  assert.equal(nativeImages(bSession).length, 1)
  assert.notDeepEqual(nativeImages(aSession), nativeImages(bSession))
  assert.equal((await host.dispatch('artifact-read', { instanceId, workItemId: b.brief.workItemId, path: 'derived-b.txt' })).text, 'B verified\n')
})
