import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applyProfile, feishuProfileConfig, profilePaths } from '../dist/profile.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('the ds-superagent profile keeps its business store under the profile home', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-superagent-profile-'))
  try {
    assert.deepEqual(profilePaths({ DSH_HOME: home }), {
      root: join(home, 'core'),
      databasePath: join(home, 'core', 'state.sqlite'),
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the ds-superagent profile fails closed without a DSH home', () => {
  assert.throws(() => profilePaths({}), /DSH_HOME/u)
})

test('Feishu profile opt-in needs explicit tenant, chats, identities and a requester allowlist', () => {
  assert.equal(feishuProfileConfig({}), undefined)
  assert.throws(() => feishuProfileConfig({ DS_SUPERAGENT_FEISHU_APP_ID: 'cli_fixture' }), { code: 'INVALID_CONFIG' })
  const config = feishuProfileConfig({
    DS_SUPERAGENT_FEISHU_APP_ID: 'cli_fixture', DS_SUPERAGENT_FEISHU_APP_SECRET: 'fixture-value',
    DS_SUPERAGENT_FEISHU_TENANT_KEY: 'tenant', DS_SUPERAGENT_FEISHU_CHAT_IDS: 'chat-a, chat-b',
    DS_SUPERAGENT_FEISHU_SELF_ACTOR_IDS: 'bot-1', DS_SUPERAGENT_FEISHU_ALLOWED_REQUESTER_IDS: 'alice,bob',
  })
  assert.equal(config.tenantKey, 'tenant')
  assert.deepEqual(config.chatIds, ['chat-a', 'chat-b'])
  assert.deepEqual(config.selfActorIds, ['bot-1'])
  assert.deepEqual(config.intake.allowedRequesterIds, ['alice', 'bob'])
  assert.equal(config.actorId, 'feishu-receiver')
  assert.equal(config.api.appId, 'cli_fixture')
  assert.equal(config.api.appSecret, 'fixture-value')
  const { DS_SUPERAGENT_FEISHU_APP_SECRET: _legacy, ...managedEnv } = {
    DS_SUPERAGENT_FEISHU_APP_ID: 'cli_fixture', DS_SUPERAGENT_FEISHU_APP_SECRET: 'fixture-value',
    DS_SUPERAGENT_FEISHU_TENANT_KEY: 'tenant', DS_SUPERAGENT_FEISHU_CHAT_IDS: 'chat-a',
    DS_SUPERAGENT_FEISHU_SELF_ACTOR_IDS: 'bot-1', DS_SUPERAGENT_FEISHU_ALLOWED_REQUESTER_IDS: 'alice',
  }
  assert.equal(feishuProfileConfig(managedEnv).api.appSecret, undefined, 'the managed source only needs non-secret Host identity')
  assert.throws(() => feishuProfileConfig({ ...managedEnv, DS_SUPERAGENT_FEISHU_APP_SECRET: '' }), { code: 'INVALID_CONFIG' })
  assert.throws(() => feishuProfileConfig({
    DS_SUPERAGENT_FEISHU_APP_ID: 'cli_fixture', DS_SUPERAGENT_FEISHU_APP_SECRET: 'fixture-value',
    DS_SUPERAGENT_FEISHU_TENANT_KEY: 'tenant', DS_SUPERAGENT_FEISHU_CHAT_IDS: 'chat-a',
    DS_SUPERAGENT_FEISHU_SELF_ACTOR_IDS: 'bot-1', DS_SUPERAGENT_FEISHU_ALLOWED_REQUESTER_IDS: ' ',
  }), { code: 'INVALID_CONFIG' })
  assert.throws(() => feishuProfileConfig({
    DS_SUPERAGENT_FEISHU_APP_ID: 'invalid app', DS_SUPERAGENT_FEISHU_APP_SECRET: 'fixture-value',
    DS_SUPERAGENT_FEISHU_TENANT_KEY: 'tenant', DS_SUPERAGENT_FEISHU_CHAT_IDS: 'chat-a',
    DS_SUPERAGENT_FEISHU_SELF_ACTOR_IDS: 'bot-1', DS_SUPERAGENT_FEISHU_ALLOWED_REQUESTER_IDS: 'alice',
  }), { code: 'INVALID_CONFIG' })
})

test('an incomplete Feishu opt-in leaves Main running and shows a bounded source error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-profile-feishu-'))
  const keys = ['APP_ID', 'APP_SECRET', 'TENANT_KEY', 'CHAT_IDS', 'SELF_ACTOR_IDS', 'ALLOWED_REQUESTER_IDS']
    .map(key => `DS_SUPERAGENT_FEISHU_${key}`)
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const previousHome = process.env.DSH_HOME
  let native, host
  t.after(async () => {
    await host?.close(); await native?.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })
  for (const key of keys) delete process.env[key]
  process.env.DSH_HOME = directory
  process.env.DS_SUPERAGENT_FEISHU_APP_ID = 'cli_fixture'
  native = await nativeContext(join(directory, 'sessions'), function* () { yield* textResponse('Main is available.') })
  await applyProfile(native, { workspaceRoot: join(directory, 'workspace'),
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  host = native.get('superagentProduct')
  assert.equal((await host.dispatch('open')).instanceId, 'personal')
  assert.deepEqual(await host.dispatch('feishu-status', { instanceId: 'personal' }),
    { configured: false, state: 'failed', lastError: 'INVALID_CONFIG' })
  await assert.rejects(host.dispatch('feishu-start', { instanceId: 'personal' }), { code: 'INVALID_CONFIG' })
})

test('the package mounts the profile host as a DSH bundle', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: ds-superagent\/profile/u)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./profile'].default, './dist/profile.js')
})
