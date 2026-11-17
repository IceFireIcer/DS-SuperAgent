import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  apply as applyProfile, feishuProfileConfig, githubProfileConfig, postgresProfileConfig, profilePaths,
} from '../dist/profile.js'
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

test('the managed profile reads PostgreSQL and Host lease settings from trusted process environment', () => {
  assert.equal(postgresProfileConfig({}), undefined)
  const value = { host: '127.0.0.1', port: 5432, user: 'fixture', password: 'fixture-password', database: 'product', ssl: false }
  assert.deepEqual(postgresProfileConfig({ DS_SUPERAGENT_POSTGRES: JSON.stringify(value) }), value)
  assert.throws(() => postgresProfileConfig({ DS_SUPERAGENT_POSTGRES: '{' }), { code: 'INVALID_CONFIG' })
  assert.throws(() => postgresProfileConfig({ DS_SUPERAGENT_POSTGRES: '[]' }), { code: 'INVALID_CONFIG' })
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

test('GitHub profile opt-in requires a bounded repository and explicit Main requester scope', () => {
  assert.equal(githubProfileConfig({}), undefined)
  assert.throws(() => githubProfileConfig({ DS_SUPERAGENT_GITHUB_OWNER: 'acme' }), { code: 'INVALID_CONFIG' })
  assert.throws(() => githubProfileConfig({ DS_SUPERAGENT_GITHUB_OWNER: 'acme', DS_SUPERAGENT_GITHUB_REPO: '../other',
    DS_SUPERAGENT_GITHUB_ALLOWED_REQUESTER_IDS: 'alice' }), { code: 'INVALID_CONFIG' })
  assert.throws(() => githubProfileConfig({ DS_SUPERAGENT_GITHUB_OWNER: 'acme', DS_SUPERAGENT_GITHUB_REPO: 'repo',
    DS_SUPERAGENT_GITHUB_ALLOWED_REQUESTER_IDS: 'alice,alice' }), { code: 'INVALID_CONFIG' })
  const config = githubProfileConfig({ DS_SUPERAGENT_GITHUB_OWNER: 'acme', DS_SUPERAGENT_GITHUB_REPO: 'repo',
    DS_SUPERAGENT_GITHUB_ALLOWED_REQUESTER_IDS: 'alice,bob', DS_SUPERAGENT_GITHUB_SELF_ACTOR_IDS: 'own-bot' })
  assert.equal(config.actorId, 'github-receiver')
  assert.deepEqual(config.intake.allowedRequesterIds, ['alice', 'bob'])
  assert.deepEqual(config.selfActorIds, ['own-bot'])
  assert.equal('api' in config, false, 'source configuration must not imply posting credentials')
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
  assert.match(patch, /name: ds-superagent\/session-persistence-postgres/u)
  assert.match(patch, /id: session-persistence-jsonl[\s\S]*?disabled: !!js/u)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./profile'].default, './dist/profile.js')
})
