import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { createProductHost, NativeSessions } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the product Feishu receiver admits native file and image bytes into Main without exposing platform keys', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-feishu-resource-'))
  const workspace = join(root, 'work')
  await Promise.all([mkdir(workspace), mkdir(join(root, 'core'))])
  const file = Buffer.from('An original platform file with exact bytes.\n')
  const image = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 40, g: 110, b: 160, alpha: 1 } } }).png().toBuffer()
  const message = (id, type, content) => ({ message_id: id, chat_id: 'oc_private', msg_type: type,
    create_time: id === 'om_file' ? '1700000000000' : id === 'om_image' ? '1700000001000' : '1700000002000',
    update_time: id === 'om_file' ? '1700000000000' : id === 'om_image' ? '1700000001000' : '1700000002000',
    sender: { id: 'ou_author', id_type: 'open_id', sender_type: 'user' }, body: { content } })
  const messages = [message('om_file', 'file', '{"file_key":"file_fixture","file_name":"brief.txt"}'),
    message('om_image', 'image', '{"image_key":"img_fixture"}')]
  const calls = []
  const json = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'Content-Type': 'application/json' } })
  const fetch = async url => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/tenant_access_token/internal')) return new Response(JSON.stringify({ code: 0,
      tenant_access_token: 'fixture-token', expire: 7200 }), { headers: { 'Content-Type': 'application/json' } })
    if (parsed.pathname === '/open-apis/tenant/v2/tenant/query') return json({ tenant: { tenant_key: 'tenant' } })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_private') return json({ chat_mode: 'p2p' })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_private/members') return json({ items: [{ member_id: 'ou_author', member_id_type: 'open_id' }], has_more: false })
    if (parsed.pathname === '/open-apis/im/v1/messages') return json({ items: messages, has_more: false })
    if (parsed.pathname === '/open-apis/im/v1/messages/om_file') return json({ items: [messages[0]] })
    if (parsed.pathname === '/open-apis/im/v1/messages/om_image') return json({ items: [messages[1]] })
    if (parsed.pathname === '/open-apis/im/v1/messages/om_stale') return json({ items: [
      { ...messages.find(item => item.message_id === 'om_stale'), sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' } },
    ] })
    if (parsed.pathname.endsWith('/resources/file_fixture')) return new Response(file, { headers: { 'Content-Type': 'application/octet-stream' } })
    if (parsed.pathname.endsWith('/resources/img_fixture')) return new Response(image, { headers: { 'Content-Type': 'application/octet-stream' } })
    throw new Error(`Unexpected fixture request: ${parsed.pathname}`)
  }
  const native = await nativeContext(join(root, 'sessions'), function* () { yield* textResponse('I received the platform resources.') })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'isolated-attachments') })
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(root, 'core', 'state.sqlite'), workspaceRoot: workspace,
    instanceId: 'personal', actorId: 'owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    feishu: { tenantKey: 'tenant', chatIds: ['oc_private'], actorId: 'receiver', selfActorIds: ['ou_bot'],
      allowedActorIds: ['receiver'], intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
        allowedRequesterIds: ['ou_author'], allowedBotActorIds: [], rules: [] },
      api: { appId: 'cli_fixture', appSecret: 'fictional-secret', fetch }, intervalMs: 1000 } })
  await host.dispatch('feishu-start', { instanceId: 'personal' })
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = await host.dispatch('history', { instanceId: 'personal' })
    if (page.messages.filter(item => item.source?.kind === 'feishu').length === 2) break
    await sleep(40)
  }
  const admitted = page.messages.filter(item => item.source?.kind === 'feishu')
  assert.equal(admitted.length, 2)
  assert.deepEqual(admitted.map(item => item.attachments[0].kind).sort(), ['file', 'image'])
  assert.equal(admitted.find(item => item.attachments[0].kind === 'file').attachments[0].bytes, file.length)
  assert.equal(admitted.find(item => item.attachments[0].kind === 'image').attachments[0].bytes, image.length)
  const directory = await host.dispatch('directory-options', { instanceId: 'personal' })
  assert.deepEqual(admitted.map(item => item.attachments[0].environmentId),
    [directory.default.environmentId, directory.default.environmentId])
  assert.equal(JSON.stringify(page).includes('file_fixture'), false)
  assert.equal(JSON.stringify(page).includes('img_fixture'), false)
  assert.equal(JSON.stringify(page).includes('fictional-secret'), false)
  assert.equal(JSON.stringify(page).includes(root), false)
  assert.equal(JSON.stringify(page).includes(file.toString('utf8')), false)
  assert.ok(calls.includes('/open-apis/im/v1/messages/om_file/resources/file_fixture'))
  assert.ok(calls.includes('/open-apis/im/v1/messages/om_image/resources/img_fixture'))
  const reader = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  try {
    let session
    for (let attempt = 0; attempt < 100; attempt++) {
      session = await reader.readSession(page.mainSessionId, { limit: 100 })
      if (session.events.some(event => event.type === 'user/message' && event.data?.content?.some(block => block.type === 'file'))
        && session.events.some(event => event.type === 'user/message' && event.data?.content?.some(block => block.type === 'image'))) break
      await sleep(40)
    }
    assert.equal(session.events.some(event => event.type === 'user/message'
      && event.data?.content?.some(block => block.type === 'file')), true)
    assert.equal(session.events.some(event => event.type === 'user/message'
      && event.data?.content?.some(block => block.type === 'image')), true)
  } finally { await reader.close() }
  await assert.rejects(host.dispatch('history', { instanceId: 'other' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  const resourceCalls = calls.filter(path => path.includes('/resources/')).length
  await host.dispatch('feishu-stop', { instanceId: 'personal' })
  await host.dispatch('feishu-start', { instanceId: 'personal' })
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await host.dispatch('feishu-status', { instanceId: 'personal' })).passes >= 1) break
    await sleep(20)
  }
  assert.equal(calls.filter(path => path.includes('/resources/')).length, resourceCalls,
    'replaying received native messages does not fetch their binary again')
  assert.equal((await host.dispatch('history', { instanceId: 'personal' })).messages.filter(item => item.source?.kind === 'feishu').length, 2)
  const before = await host.dispatch('feishu-status', { instanceId: 'personal' })
  messages.push(message('om_stale', 'file', '{"file_key":"file_stale","file_name":"stale.txt"}'))
  let failed
  for (let attempt = 0; attempt < 100; attempt++) {
    failed = await host.dispatch('feishu-status', { instanceId: 'personal' })
    if (failed.state === 'failed') break
    await sleep(40)
  }
  assert.equal(failed.lastError, 'SOURCE_FAILED')
  assert.equal(failed.cursor, before.cursor, 'a stale native resource cannot advance the source cursor')
  assert.equal(calls.some(path => path.endsWith('/resources/file_stale')), false)
  await host.dispatch('feishu-stop', { instanceId: 'personal' })
  messages.pop()
  await host.dispatch('feishu-start', { instanceId: 'personal' })
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await host.dispatch('feishu-status', { instanceId: 'personal' })).passes >= 1) break
    await sleep(20)
  }
  messages.push(message('om_missing', 'file', '{"file_name":"unavailable.txt"}'))
  for (let attempt = 0; attempt < 100; attempt++) {
    failed = await host.dispatch('feishu-status', { instanceId: 'personal' })
    if (failed.state === 'failed') break
    await sleep(40)
  }
  assert.equal(failed.lastError, 'SOURCE_FAILED')
  assert.equal(failed.cursor, before.cursor, 'an unadmitted resource cannot advance the native source cursor')
  const unchanged = await host.dispatch('history', { instanceId: 'personal' })
  assert.equal(unchanged.messages.filter(item => item.source?.kind === 'feishu').length, 2)
  assert.equal(JSON.stringify(unchanged).includes('om_missing'), false)
})
