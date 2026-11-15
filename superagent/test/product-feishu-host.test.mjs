import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the product Host exposes Feishu health, stop and reconnection without disclosing credentials', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-product-feishu-'))
  let host, native
  t.after(async () => {
    await host?.close()
    await native?.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Main received the request.') })
  const workspaceRoot = join(directory, 'workspace')
  await mkdir(join(directory, 'data'))
  await mkdir(workspaceRoot)
  const json = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) })
  const fetch = async url => {
    const path = new URL(url).pathname
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }) }
    }
    if (path === '/open-apis/tenant/v2/tenant/query') return json({ tenant: { tenant_key: 'tenant' } })
    if (path === '/open-apis/im/v1/chats/group') return json({ chat_mode: 'group' })
    if (path === '/open-apis/im/v1/chats/group/members') return json({ items: [{ member_id: 'alice', member_id_type: 'open_id' }], has_more: false })
    if (path === '/open-apis/im/v1/messages') return json({ items: [{ message_id: 'om_host', chat_id: 'group', msg_type: 'text',
      create_time: '1700000000000', update_time: '1700000000000', sender: { id: 'alice', id_type: 'open_id', sender_type: 'user' },
      mentions: [{ id: 'ou_bot' }], body: { content: '{"text":"Please read this."}' } }], has_more: false })
    throw new Error(`Unexpected Feishu fixture request: ${path}`)
  }
  host = await core.createProductHost(native, { databasePath: join(directory, 'data', 'state.sqlite'), workspaceRoot,
    instanceId: 'private', actorId: 'desktop-owner', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    feishu: { tenantKey: 'tenant', chatIds: ['group'], actorId: 'receiver', selfActorIds: ['ou_bot'],
      allowedActorIds: ['receiver'], intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000,
        allowedRequesterIds: ['alice'], allowedBotActorIds: [], rules: [] },
      api: { appId: 'cli_test', appSecret: 'fixture-secret', fetch }, intervalMs: 1000 } })
  const read = async () => host.dispatch('feishu-status', { instanceId: 'private' })
  const directories = await host.dispatch('directory-options', { instanceId: 'private' })
  const canonicalWorkspace = await realpath(workspaceRoot)
  assert.equal(directories.default.root, canonicalWorkspace)
  assert.deepEqual(directories.directories.map(item => item.root), [canonicalWorkspace])
  assert.equal((await host.dispatch('schedule-source-read', { instanceId: 'private' })).enabled, true)
  const schedule = await host.dispatch('schedule-create', { instanceId: 'private', commandId: 'feishu-host-schedule',
    title: 'Check work', text: 'Check the authorized work.', timezone: 'UTC',
    when: { kind: 'at', at: Date.now() + 60_000 }, target: { kind: 'main' } })
  assert.deepEqual((await host.dispatch('schedule-list', { instanceId: 'private' })).items.map(item => item.ruleId), [schedule.ruleId])
  for (let attempt = 0; attempt < 40 && (await host.dispatch('history', { instanceId: 'private' })).sources.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal((await host.dispatch('history', { instanceId: 'private' })).sources.length, 1)
  assert.equal((await read()).state, 'polling')
  assert.doesNotMatch(JSON.stringify(await read()), /fixture-secret|fixture-token/u)
  await assert.rejects(host.dispatch('feishu-status', { instanceId: 'another' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  await host.dispatch('feishu-stop', { instanceId: 'private' })
  assert.equal((await read()).state, 'stopped')
  await host.dispatch('feishu-start', { instanceId: 'private' })
  for (let attempt = 0; attempt < 40 && (await read()).passes === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await host.dispatch('history', { instanceId: 'private' })).sources.length, 1)
  assert.equal((await read()).state, 'polling')
})
