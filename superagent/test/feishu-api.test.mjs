import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as core from '../dist/index.js'

const json = body => ({ ok: true, status: 200, json: async () => body })
const message = (overrides = {}) => ({ message_id: 'om_1', chat_id: 'oc_group', msg_type: 'text',
  create_time: '1700000000000', update_time: '1700000000000', deleted: false, updated: false,
  sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user' }, body: { content: '{"text":"Please review"}' }, ...overrides })

test('the Feishu transport maps chats, messages, mentions, edits, recalls and pagination', async () => {
  const calls = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, query: parsed.searchParams, auth: init.headers?.Authorization })
    if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_group') return json({ code: 0, data: { chat_mode: 'group', name: 'Team' } })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_p2p') return json({ code: 0, data: { chat_mode: 'p2p' } })
    if (parsed.pathname === '/open-apis/im/v1/messages') {
      const chat = parsed.searchParams.get('container_id')
      if (chat === 'oc_group' && parsed.searchParams.get('page_token') === 'p2') return json({ code: 0, data: { items: [], has_more: false } })
      if (chat === 'oc_group') return json({ code: 0, data: { has_more: true, page_token: 'p2', items: [
        message({ message_id: 'om_1', mentions: [{ id: 'ou_bot', name: 'Bot' }] }),
        message({ message_id: 'om_2', msg_type: 'post', create_time: '1700000005000', update_time: '1700000005000', updated: true,
          body: { content: '{"zh_cn":{"title":"Report","content":[[{"tag":"text","text":"first line"}],[{"tag":"text","text":"second line"}]]}}' } }),
        message({ message_id: 'om_3', deleted: true, create_time: '1700000001000', update_time: '1700000001000', body: undefined }),
        message({ message_id: 'om_4', sender: undefined }),
      ] } })
      return json({ code: 0, data: { items: [message({ message_id: 'om_5', chat_id: 'oc_p2p' })], has_more: false } })
    }
    throw new Error(`Unexpected Feishu path ${parsed.pathname}`)
  }
  const transport = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', fetch, now: () => 1000 })
  const first = await transport.listEvents({ tenantKey: 'tenant', chatIds: ['oc_group', 'oc_p2p'], signal: new AbortController().signal })
  assert.equal(first.malformed, 1)
  const group = first.events.filter(event => event.chatId === 'oc_group')
  const p2p = first.events.filter(event => event.chatId === 'oc_p2p')
  assert.deepEqual(group.map(event => event.messageId), ['om_1', 'om_3', 'om_2'])
  assert.equal(group[0].text, 'Please review')
  assert.deepEqual(group[0].mentionIds, ['ou_bot'])
  assert.equal(group[0].chatType, 'group')
  assert.equal(group[2].text, 'Report\nfirst line\nsecond line')
  assert.equal(group[2].edited, true)
  assert.equal(group[1].deleted, true)
  assert.equal(group[1].text, undefined)
  assert.match(group[1].deletionEvidence, /recalled/u)
  assert.equal(p2p[0].chatType, 'p2p')
  const cursors = first.events.map(event => event.cursor)
  assert.deepEqual(cursors, cursors.slice().sort())

  const lastCursor = first.events.at(-1).cursor
  const second = await transport.listEvents({ tenantKey: 'tenant', chatIds: ['oc_group', 'oc_p2p'], cursor: lastCursor, signal: new AbortController().signal })
  assert.deepEqual(second.events.map(event => event.messageId), ['om_5'], 'a lookback replay is left to the source duplicate check')
  const groupRequest = calls.filter(call => call.path === '/open-apis/im/v1/messages' && call.query.get('container_id') === 'oc_group').at(-1)
  assert.equal(groupRequest.query.get('page_token'), 'p2')
  const p2pRequest = calls.filter(call => call.path === '/open-apis/im/v1/messages' && call.query.get('container_id') === 'oc_p2p').at(-1)
  assert.equal(p2pRequest.query.get('start_time'), String(Math.floor(Number(lastCursor.split(':')[0]) / 1000) - 600))
})

test('Feishu image and file messages expose bounded native resource identities without raw bytes', async () => {
  const fetch = async url => {
    const path = new URL(url).pathname
    if (path.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (path === '/open-apis/im/v1/chats/oc_group') return json({ code: 0, data: { chat_mode: 'group' } })
    if (path === '/open-apis/im/v1/messages') return json({ code: 0, data: { items: [
      message({ message_id: 'om_image', msg_type: 'image', body: { content: '{"image_key":"img_fixture"}' } }),
      message({ message_id: 'om_file', msg_type: 'file', body: { content: '{"file_key":"file_fixture","file_name":"report.txt"}' } }),
      message({ message_id: 'om_missing', msg_type: 'file', body: { content: '{"file_name":"unknown.txt"}' } }),
      message({ message_id: 'om_audio', msg_type: 'audio', body: { content: '{"file_key":"audio_fixture"}' } }),
      message({ message_id: 'om_rich', msg_type: 'post', body: { content: '{"zh_cn":{"content":[[{"tag":"img","image_key":"img_rich"}]]}}' } }),
    ], has_more: false } })
    throw new Error(`Unexpected fixture request: ${path}`)
  }
  const api = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'fixture-secret', fetch })
  const events = (await api.listEvents({ tenantKey: 'tenant', chatIds: ['oc_group'], signal: new AbortController().signal })).events
  assert.deepEqual(events.find(event => event.messageId === 'om_image').resource, { kind: 'image', key: 'img_fixture' })
  assert.deepEqual(events.find(event => event.messageId === 'om_file').resource,
    { kind: 'file', key: 'file_fixture', name: 'report.txt' })
  assert.equal(events.find(event => event.messageId === 'om_missing').resourceMissing, true)
  assert.equal(events.find(event => event.messageId === 'om_audio').resourceMissing, true)
  assert.equal(events.find(event => event.messageId === 'om_rich').resourceMissing, true)
  assert.equal(JSON.stringify(events).includes('fixture-secret'), false)
})

test('Feishu reads only bytes still belonging to the exact native message and bounds the response', async () => {
  const bytes = Buffer.from('the original document')
  const native = message({ message_id: 'om_file', msg_type: 'file', body: { content: '{"file_key":"file_fixture","file_name":"report.txt"}' } })
  let current = native
  let resourceCalls = 0
  let oversized = false
  let revoked = false
  let missing = false
  let changedDuringRead = false
  let streamingOverflow = false
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (path === '/open-apis/im/v1/messages/om_file') return json({ code: 0, data: { items: [current] } })
    if (path === '/open-apis/im/v1/messages/om_file/resources/file_fixture') {
      resourceCalls++
      assert.equal(new URL(url).searchParams.get('type'), 'file')
      assert.equal(init.headers.Authorization, 'Bearer fixture-token')
      if (revoked) return new Response('Forbidden', { status: 403 })
      if (missing) return new Response('Not Found', { status: 404 })
      if (changedDuringRead) current = { ...native, deleted: true }
      return new Response(streamingOverflow ? Buffer.alloc(8 * 1024 * 1024 + 1) : bytes, { headers: { 'Content-Type': 'application/octet-stream',
        ...(oversized ? { 'Content-Length': String(9 * 1024 * 1024) } : {}) } })
    }
    throw new Error(`Unexpected fixture request: ${path}`)
  }
  const api = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'fixture-secret', fetch })
  const request = { messageId: 'om_file', chatId: 'oc_group', senderId: 'ou_alice', updateTime: '1700000000000',
    resource: { kind: 'file', key: 'file_fixture', name: 'report.txt' }, signal: new AbortController().signal }
  assert.deepEqual(await api.downloadResource(request), bytes)
  current = { ...native, chat_id: 'oc_other' }
  await assert.rejects(api.downloadResource(request), { code: 'ATTACHMENT_UNAVAILABLE' })
  current = { ...native, body: { content: '{"file_key":"other_file","file_name":"report.txt"}' } }
  await assert.rejects(api.downloadResource(request), { code: 'ATTACHMENT_UNAVAILABLE' })
  assert.equal(resourceCalls, 1)
  current = native
  oversized = true
  await assert.rejects(api.downloadResource(request), { code: 'SOURCE_BUDGET' })
  oversized = false
  streamingOverflow = true
  await assert.rejects(api.downloadResource(request), { code: 'SOURCE_BUDGET' })
  streamingOverflow = false
  revoked = true
  await assert.rejects(api.downloadResource(request), { code: 'SOURCE_FAILED', httpStatus: 403 })
  revoked = false
  missing = true
  await assert.rejects(api.downloadResource(request), { code: 'SOURCE_FAILED', httpStatus: 404 })
  missing = false
  changedDuringRead = true
  await assert.rejects(api.downloadResource(request), { code: 'ATTACHMENT_UNAVAILABLE' })
})

test('Feishu binary reads refresh a rejected managed tenant token without exposing the credential', async () => {
  const native = message({ message_id: 'om_file', msg_type: 'file', body: { content: '{"file_key":"file_fixture","file_name":"report.json"}' } })
  let tokenCount = 0
  let resourceCalls = 0
  const purposes = []
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: `fixture-${++tokenCount}`, expire: 7200 })
    if (path === '/open-apis/im/v1/messages/om_file') return json({ code: 0, data: { items: [native] } })
    if (path.endsWith('/resources/file_fixture')) {
      resourceCalls++
      if (resourceCalls === 1) return new Response(JSON.stringify({ code: 99991663, msg: 'token expired' }),
        { headers: { 'Content-Type': 'application/json' } })
      assert.equal(init.headers.Authorization, 'Bearer fixture-2')
      return new Response('{"title":"valid JSON file"}', { headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`Unexpected fixture request: ${path}`)
  }
  const api = new core.FeishuOpenApi({ appId: 'cli_test', withCredential: async (purpose, consume) => {
    purposes.push(purpose)
    return consume('fictional-managed-secret')
  }, fetch })
  const result = await api.downloadResource({ messageId: 'om_file', chatId: 'oc_group', senderId: 'ou_alice',
    updateTime: '1700000000000', resource: { kind: 'file', key: 'file_fixture', name: 'report.json' },
    signal: new AbortController().signal })
  assert.equal(result.toString('utf8'), '{"title":"valid JSON file"}')
  assert.equal(resourceCalls, 2)
  assert.equal(tokenCount, 2)
  assert.deepEqual(purposes, ['source', 'source', 'source'])
})

test('a tenant token rejected mid-poll is refreshed once and the request is retried', async () => {
  let tokens = 0
  let messageCalls = 0
  const fetch = async url => {
    const parsed = new URL(url)
    if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      tokens++
      return json({ code: 0, tenant_access_token: `t-${tokens}`, expire: 7200 })
    }
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_group') return json({ code: 0, data: { chat_mode: 'group' } })
    if (parsed.pathname === '/open-apis/im/v1/messages') {
      messageCalls++
      if (messageCalls === 1) return json({ code: 99991663, msg: 'tenant token invalid' })
      return json({ code: 0, data: { items: [], has_more: false } })
    }
    throw new Error(`Unexpected Feishu path ${parsed.pathname}`)
  }
  const transport = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', fetch, now: () => 1000 })
  const page = await transport.listEvents({ tenantKey: 'tenant', chatIds: ['oc_group'], signal: new AbortController().signal })
  assert.deepEqual(page.events, [])
  assert.equal(tokens, 2)
  assert.equal(messageCalls, 2)
})

test('the Feishu transport pages members, deduplicates native identities and bounds the budget', async () => {
  let memberCalls = 0
  const fetch = async url => {
    const parsed = new URL(url)
    if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_group/members') {
      memberCalls++
      if (memberCalls === 1) return json({ code: 0, data: { has_more: true, page_token: 'm2', items: [
        { member_id: 'ou_a', name: 'Ada', member_id_type: 'open_id' },
        { member_id: 'ou_b', name: 'Bob', member_id_type: 'open_id' },
      ] } })
      return json({ code: 0, data: { has_more: false, items: [{ member_id: 'ou_a', name: 'Ada', member_id_type: 'open_id' }] } })
    }
    throw new Error(`Unexpected Feishu path ${parsed.pathname}`)
  }
  const transport = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', fetch, now: () => 1000 })
  const members = await transport.listMembers({ chatId: 'oc_group', signal: new AbortController().signal })
  assert.deepEqual(members.map(member => member.nativeActorId), ['ou_a', 'ou_b'])
  assert.equal(members[0].displayName, 'Ada')
  assert.ok(members.every(member => member.kind === 'human' && member.active))

  const bounded = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', now: () => 1000, maxMemberPages: 1,
    fetch: async url => {
      const parsed = new URL(url)
      if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
      return json({ code: 0, data: { has_more: true, page_token: 'more', items: [] } })
    } })
  await assert.rejects(bounded.listMembers({ chatId: 'oc_group', signal: new AbortController().signal }), { code: 'SOURCE_BUDGET' })
})

test('the Feishu setup check resolves the reachable chat types', async () => {
  const fetch = async url => {
    const parsed = new URL(url)
    if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (parsed.pathname === '/open-apis/im/v1/chats/oc_group') return json({ code: 0, data: { chat_mode: 'group', name: 'Team' } })
    throw new Error(`Unexpected Feishu path ${parsed.pathname}`)
  }
  const transport = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', fetch, now: () => 1000 })
  assert.deepEqual(await transport.check(['oc_group'], new AbortController().signal), [{ chatId: 'oc_group', chatType: 'group', name: 'Team' }])
})

test('the Feishu reply transport posts text in place with a bounded uuid', async () => {
  const calls = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, method: init.method, body: init.body, auth: init.headers?.Authorization })
    if (parsed.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
    if (parsed.pathname === '/open-apis/im/v1/messages/om_q/reply') return json({ code: 0, data: { message_id: 'om_reply' } })
    throw new Error(`Unexpected Feishu path ${parsed.pathname}`)
  }
  const transport = new core.FeishuOpenApi({ appId: 'cli_test', appSecret: 'secret', fetch, now: () => 1000 })
  const uuid = 'a'.repeat(32)
  assert.deepEqual(await transport.replyMessage({ messageId: 'om_q', text: 'Use blue.', uuid, signal: new AbortController().signal }),
    { messageId: 'om_reply' })
  const call = calls.at(-1)
  assert.equal(call.method, 'POST')
  assert.deepEqual(JSON.parse(call.body), { content: '{"text":"Use blue."}', msg_type: 'text', uuid })
  assert.equal(call.auth, 'Bearer t-1')
  await assert.rejects(transport.replyMessage({ messageId: 'om_q', text: '', uuid, signal: new AbortController().signal }), { code: 'INVALID_INPUT' })
  await assert.rejects(transport.replyMessage({ messageId: 'om_q', text: 'x', uuid: 'a'.repeat(51), signal: new AbortController().signal }), { code: 'INVALID_INPUT' })
})
