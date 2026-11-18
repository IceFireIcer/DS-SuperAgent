import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createProductHost } from '../dist/index.js'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { completedToolCount, lastUserText } from './input-support.mjs'

test('the product sends a Main result only with a current GitHub outbound grant and reconciles a lost receipt', { timeout: 45000 }, async t => {
  const temp = resolve(tmpdir())
  const directory = await mkdtemp(join(temp, 'r5-github-delivery-'))
  const workspaceRoot = join(directory, 'workspace')
  const databasePath = join(directory, 'data', 'state.sqlite')
  let native, host
  t.after(async () => {
    try { await host?.close() }
    finally {
      await native?.fiber.dispose()
      assert.equal(dirname(directory), temp)
      await rm(directory, { recursive: true, force: true })
    }
  })
  await mkdir(workspaceRoot)
  await mkdir(dirname(databasePath))
  native = await nativeContext(join(directory, 'sessions'), function* (request) {
    const calls = completedToolCount(request)
    if (request.model === 'router') { yield* routerResponse(request); return }
    if (request.model === 'main') {
      const text = lastUserText(request)
      if (text.includes('[GitHub request]') && calls === 0) {
        yield* toolResponse('delegate_work', { goal: 'Verify the note.', constraints: 'Use the isolated workspace only.', acceptanceCriteria: 'Read the note and report the result.' })
      } else if (text.startsWith('[Work update]')) yield* textResponse('The note was verified.')
      else yield* textResponse('Checking the note.')
      return
    }
    if (calls === 0) yield* toolResponse('write_file', { path: 'note.txt', text: 'Valid note' })
    else if (calls === 1) yield* toolResponse('read_file', { path: 'note.txt' })
    else if (calls === 2 && request.tools?.some(tool => tool.name === 'run_shell')) {
      yield* toolResponse('run_shell', { command: 'node -e "if (require(\'node:fs\').readFileSync(\'note.txt\',\'utf8\') !== \'Valid note\') process.exit(1)"' })
    } else if (calls === 2 || calls === 3) yield* toolResponse('report_ready', { result: 'The note was verified.', evidence: 'Checked note.txt.', artifacts: 'note.txt' })
    else yield* textResponse('Recorded.')
  })
  await native.plugin(LocalCredentials, { path: join(directory, 'credentials.yaml'), watch: false })

  const repo = 'repos/acme/repo'
  const sourceInstanceId = 'github:acme/repo'
  const issues = []
  const comments = new Map()
  const posts = []
  let outboundQueries = 0
  let acknowledgementActivity
  let beforeOutboundScan
  let tick = Date.parse('2026-01-03T00:00:00Z')
  const timestamp = () => new Date(tick += 1000).toISOString()
  const runner = async (path, request = {}) => {
    request.signal?.throwIfAborted()
    if (path.startsWith(`${repo}/issues?`)) return issues
    if (path === 'user') { outboundQueries++; return { login: 'maintainer' } }
    if (path.includes('/timeline?')) return []
    const [, number, isComment] = new RegExp(`^${repo}/issues/(\\d+)(/comments)?`, 'u').exec(path) ?? []
    if (!number) throw new Error('Unexpected GitHub fixture route.')
    if (!isComment) return { number: Number(number), html_url: `https://github.com/acme/repo/issues/${number}` }
    const existing = comments.get(number) ?? []
    if (request.method !== 'POST') {
      if (request.host === 'github.com') await beforeOutboundScan?.(number)
      return existing
    }
    const id = 9001 + posts.length
    const at = timestamp()
    const item = { id, body: request.body.body, user: { login: 'maintainer', type: 'User' },
      html_url: `https://github.com/acme/repo/issues/${number}#issuecomment-${id}`,
      created_at: at, updated_at: at }
    posts.push({ number, item })
    comments.set(number, [...existing, item])
    if (item.body.startsWith('The note was verified.')) throw new Error('The fixture lost the POST response after storing the result.')
    issues.find(issue => issue.number === Number(number)).updated_at = at
    acknowledgementActivity = item
    const cursor = `${at}#issue#${number.padStart(12, '0')}`
    for (let attempt = 0; attempt < 80; attempt++) {
      const health = await host.dispatch('github-status', { instanceId })
      if (health.cursor >= cursor) return item
      await sleep(25)
    }
    assert.fail('The receiver did not observe comment activity before the result was sent.')
  }
  const routes = Object.fromEntries(['main', 'router', 'worker'].map(role => [role, { provider: 'mock', model: role }]))
  const instanceId = 'private'
  host = await createProductHost(native, { ...routes, instanceId, actorId: 'alice', databasePath, workspaceRoot,
    github: { owner: 'acme', repo: 'repo', actorId: 'receiver', allowedActorIds: ['receiver'], postingActorId: 'maintainer',
      intake: { mode: 'auto', maxBatchSize: 5, maxAttempts: 1, timeoutMs: 5000, allowedRequesterIds: ['alice', 'maintainer'], allowedBotActorIds: [], rules: [] },
      cli: { runner }, intervalMs: 100 } })
  const call = (endpoint, payload = {}) => host.dispatch(endpoint, { instanceId, ...payload })
  await host.dispatch('open')
  const resource = await call('resource-create', { commandId: 'create', label: 'GitHub', value: 'fixture-github-credential' })
  let revision = resource.revision
  const grant = async (id, role, purpose, scope) => {
    const changed = await call('resource-grant', { commandId: id, resourceId: resource.id, expectedRevision: revision,
      scope: { role, sourceInstanceId: scope }, purposes: [purpose] })
    revision = changed.revision
    return changed.grants.find(item => item.scope.role === role && item.scope.sourceInstanceId === scope).id
  }
  await grant('source', 'main', 'source', sourceInstanceId)
  await grant('other-repo', 'router', 'outbound', 'github:acme/other')
  await call('resource-select-github', { commandId: 'select', resourceId: resource.id })

  async function resultFor(number) {
    const at = timestamp()
    issues.push({ id: number, number, state: 'open', title: 'Verify the note.', body: 'Verify this fixture note.',
      user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at })
    for (let attempt = 0; attempt < 140; attempt++) {
      const history = await call('history')
      const source = history.sources.find(item => item.objectId === `issue:${number}`)
      const delivery = source?.deliveries.find(item => item.purpose === 'result' && ['sent', 'dropped'].includes(item.state))
      if (delivery) return delivery
      await sleep(100)
    }
    assert.fail(`No final result delivery for GitHub issue ${number}.`)
  }

  const ungranted = await resultFor(12)
  assert.equal(ungranted.state, 'dropped')
  assert.equal(ungranted.reason, 'GRANT_DENIED')
  assert.equal(outboundQueries, 0, 'source and other-repo grants cannot authorize outbound API calls')
  const outboundGrant = await grant('outbound', 'router', 'outbound', sourceInstanceId)
  const granted = await resultFor(13)
  assert.equal(granted.state, 'sent')
  const results = posts.filter(post => post.item.body.startsWith('The note was verified.'))
  assert.equal(results.length, 1)
  assert.equal(results[0].number, '13')
  assert.match(results[0].item.body, /<!-- ds-superagent:[a-f0-9]{64} -->$/u)
  assert.ok(acknowledgementActivity, 'the parent timestamp advanced between acknowledgement and result')
  assert.deepEqual(granted.platformReceipt, { messageId: String(results[0].item.id), url: results[0].item.html_url })
  let interruptedCalls = 0
  beforeOutboundScan = async number => {
    if (number !== '14') return
    interruptedCalls++
    if (interruptedCalls === 1) {
      const rotated = await call('resource-rotate', { commandId: 'rotate-before-post', resourceId: resource.id,
        expectedRevision: revision, value: 'different-fixture-credential' })
      assert.equal(rotated.status, 'committed')
      revision = rotated.resource.revision
    } else if (interruptedCalls === 2) {
      const revoked = await call('resource-revoke', { commandId: 'revoke-before-post', resourceId: resource.id,
        grantId: outboundGrant, expectedRevision: revision })
      revision = revoked.revision
    }
  }
  const revoked = await resultFor(14)
  assert.equal(revoked.state, 'dropped')
  assert.equal(revoked.reason, 'GRANT_DENIED')
  const finalHistory = await call('history')
  const rotated = finalHistory.sources.find(item => item.objectId === 'issue:14').deliveries.find(item => item.purpose === 'acknowledgement')
  assert.deepEqual([rotated.state, rotated.reason], ['dropped', 'RESOURCE_STALE'])
  assert.equal(interruptedCalls, 2)
  assert.ok(posts.every(post => post.number === '13'))
  assert.equal(finalHistory.sources.length, 3, 'outbound receipts from the posting actor do not create new requests')
})
