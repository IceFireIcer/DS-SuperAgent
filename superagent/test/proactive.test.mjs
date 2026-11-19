import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

const rules = (overrides = {}) => [
  { id: 'observe-review', name: 'Observe review requests', mode: 'observe', match: { actorKinds: ['human'], addressing: ['direct'], textPattern: 'review' },
    communication: 'silent', budget: { maxRuns: 5, windowMs: 3600000 }, enabled: true },
  { id: 'auto-bug', name: 'Prepare bug reproductions', mode: 'auto', match: { actorKinds: ['human', 'bot'], addressing: ['direct'], textPattern: 'bug' },
    communication: 'notify', scope: 'Reproduce the reported failure in an isolated directory.', budget: { maxRuns: 1, windowMs: 3600000 }, enabled: true },
  { id: 'auto-silent', name: 'Silent investigation', mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'], textPattern: 'quiet' },
    communication: 'silent', budget: { maxRuns: 2, windowMs: 3600000 }, enabled: true },
  ...(overrides.extra ?? []),
]

async function fixture(t, prepare) {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-proactive-'))
  const root = join(directory, 'proactive-root')
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'],
    allowedThreadIds: ['room'], versionOrder: 'sequence' }, {}, undefined, [], {}, {}, {}, {}, { hostId: 'proactive-host', leaseMs: 30000 }, {
    rootDirectory: root,
    prepare,
  })
  return { directory, root, storage, engine }
}

async function record(engine, objectId, text, authorKind = 'human') {
  const authorId = authorKind === 'bot' ? 'bot-1' : 'user'
  const receipt = await engine.receiveSource({ commandId: `recv-${objectId}`, threadId: 'room', objectId, type: 'created', version: '1',
    text, authorId, authorKind, addressing: 'direct' })
  for (let attempt = 0; attempt < 200; attempt++) {
    const runs = (await engine.listProactiveRuns()).filter(run => run.eventId === receipt.eventId && run.state !== 'running')
    if (runs.length) return { receipt, runs, candidate: { sourceInstanceId: 'desktop', eventId: receipt.eventId, threadId: 'room',
      objectId, text, authorId, authorKind, addressing: 'direct' } }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`No proactive run settled for ${objectId}`)
}

test('observe never executes, auto prepares inside an isolated budget and never publishes', { timeout: 20000 }, async t => {
  let prepared = 0
  const { root, engine } = await fixture(t, async ({ isolatedDirectory, candidate }) => {
    prepared++
    if (candidate.text.includes('quiet')) return undefined
    await writeFile(join(isolatedDirectory, 'prepared.txt'), `Prepared ${candidate.text}`)
    return { summary: `Prepared ${candidate.text}` }
  })
  assert.equal((await engine.updateProactiveRules({ commandId: 'save-rules', expectedRevision: 1, rules: rules() })).revision, 2)

  const observed = await record(engine, 'm1', 'Please review this change.')
  assert.equal(observed.runs.find(run => run.ruleId === 'observe-review').state, 'observed')
  assert.equal(prepared, 0)

  const preparedRun = (await record(engine, 'm2', 'There is a bug in the module.')).runs.find(run => run.ruleId === 'auto-bug')
  assert.equal(preparedRun.state, 'prepared')
  assert.ok(preparedRun.isolatedDirectory.startsWith(root))
  assert.equal(await readFile(join(preparedRun.isolatedDirectory, 'prepared.txt'), 'utf8'), 'Prepared There is a bug in the module.')
  assert.equal(preparedRun.communication, 'notify')
  assert.equal(preparedRun.authorId, 'user')
  assert.deepEqual((await engine.effects.list()).items, [], 'preparation does not enqueue a delivery or publish action')

  assert.equal((await record(engine, 'm3', 'Another bug appears.')).runs.find(run => run.ruleId === 'auto-bug').state, 'budget-exhausted')
  assert.equal((await record(engine, 'm4', 'There is a bug in the module.', 'bot')).runs.find(run => run.ruleId === 'auto-bug').state, 'suppressed')
  assert.equal((await record(engine, 'm5', 'quiet investigation')).runs.find(run => run.ruleId === 'auto-silent').state, 'silent')

  const quiet = await engine.getSourceObject({ threadId: 'room', objectId: 'm5' })
  const replay = await engine.evaluateProactive({ sourceInstanceId: 'desktop', eventId: quiet.eventId, threadId: 'room', objectId: 'm5',
    text: 'quiet investigation', authorId: 'user', authorKind: 'human', addressing: 'direct' })
  assert.equal(replay.length, 1)
  assert.equal(replay[0].state, 'silent', 'a replay returns the settled run without running again')

  await engine.setProcessingPaused({ commandId: 'pause-proactive', paused: true })
  const paused = await engine.receiveSource({ commandId: 'recv-m6', threadId: 'room', objectId: 'm6', type: 'created', version: '1',
    text: 'bug while paused', authorId: 'user', authorKind: 'human', addressing: 'direct' })
  assert.equal((await engine.listProactiveRuns()).some(run => run.eventId === paused.eventId), false)
  await engine.setProcessingPaused({ commandId: 'resume-proactive', paused: false })
  const resumed = await engine.evaluateProactive({ sourceInstanceId: 'desktop', eventId: paused.eventId, threadId: 'room', objectId: 'm6',
    text: 'bug while paused', authorId: 'user', authorKind: 'human', addressing: 'direct' })
  assert.equal(resumed.find(run => run.ruleId === 'auto-bug').state, 'budget-exhausted')
  await assert.rejects(engine.evaluateProactive({ sourceInstanceId: 'desktop', eventId: 'fabricated', threadId: 'room', objectId: 'm7',
    text: 'bug without evidence', authorId: 'user', authorKind: 'human', addressing: 'direct' }), { code: 'SOURCE_NOT_CURRENT' })
  await assert.rejects(engine.updateProactiveRules({ commandId: 'invalid-rule', expectedRevision: 2,
    rules: [{ id: 'bad', name: 'Bad', mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'], textPattern: '(' },
      communication: 'silent', budget: { maxRuns: 1, windowMs: 1000 }, enabled: true }] }), { code: 'INVALID_CONFIG' })
  await assert.rejects(engine.updateProactiveRules({ commandId: 'escaping-rule', expectedRevision: 2,
    rules: [{ id: '../outside', name: 'Escape', mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'] },
      communication: 'silent', budget: { maxRuns: 1, windowMs: 1000 }, enabled: true }] }), { code: 'INVALID_CONFIG' })
  const history = await engine.listProactiveRuns()
  const createdAt = history.map(run => run.createdAt)
  assert.deepEqual(createdAt, createdAt.slice().sort((left, right) => left - right))
})

test('rule-scoped run scans never include another rule history', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-proactive-scope-'))
  const root = join(directory, 'proactive-root')
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const proactive = new core.Proactive(storage, 'private', { rootDirectory: root, prepare: async () => ({ summary: 'Prepared.' }) })
  const rule = id => ({ id, name: id, mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'], textPattern: id },
    communication: 'silent', budget: { maxRuns: 1, windowMs: 3600000 }, enabled: true })
  await storage.transaction('private', tx => proactive.setRules(tx, 1, [rule('alpha'), rule('beta')]))
  const foreignId = `${JSON.stringify(['proactive-run', 'beta'])}:${'0'.repeat(64)}`
  await storage.transaction('private', tx => tx.insert('proactive-run', foreignId, { id: foreignId, instanceId: 'private', ruleId: 'beta',
    ruleRevision: 2, eventId: 'beta-event', sourceInstanceId: 'desktop', mode: 'auto', state: 'prepared', text: 'alpha', authorId: 'user',
    authorKind: 'human', addressing: 'direct', communication: 'silent', createdAt: Date.now() }))
  const runs = await proactive.evaluate({ sourceInstanceId: 'desktop', eventId: 'alpha-event', threadId: 'room', objectId: 'alpha-object',
    text: 'alpha', authorId: 'user', authorKind: 'human', addressing: 'direct' })
  assert.equal(runs[0].state, 'prepared')
  assert.equal((await proactive.listRuns('alpha')).some(run => run.ruleId === 'beta'), false)
})

test('a rule budget counts its complete history beyond the first thousand records', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-proactive-history-'))
  const root = join(directory, 'proactive-root')
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const proactive = new core.Proactive(storage, 'private', { rootDirectory: root })
  await storage.transaction('private', tx => proactive.setRules(tx, 1, [{ id: 'deep', name: 'Deep', mode: 'auto',
    match: { actorKinds: ['human'], addressing: ['direct'], textPattern: 'deep' }, communication: 'silent',
    budget: { maxRuns: 1, windowMs: 3600000 }, enabled: true }]))
  const prefix = `${JSON.stringify(['proactive-run', 'deep'])}:`
  const now = Date.now()
  await storage.transaction('private', async tx => {
    for (let index = 0; index < 1000; index++) {
      const id = `${prefix}${index.toString(16).padStart(63, '0')}`
      await tx.insert('proactive-run', id, { id, instanceId: 'private', ruleId: 'deep', ruleRevision: 2, eventId: `old-${index}`,
        sourceInstanceId: 'desktop', mode: 'auto', state: 'observed', text: 'old', authorId: 'user', authorKind: 'human',
        addressing: 'direct', communication: 'silent', createdAt: now - 7200000 })
    }
    const id = `${prefix}${'f'.repeat(64)}`
    await tx.insert('proactive-run', id, { id, instanceId: 'private', ruleId: 'deep', ruleRevision: 2, eventId: 'prepared-event',
      sourceInstanceId: 'desktop', mode: 'auto', state: 'prepared', text: 'deep work', authorId: 'user', authorKind: 'human',
      addressing: 'direct', communication: 'silent', createdAt: now })
  })
  const runs = await proactive.evaluate({ sourceInstanceId: 'desktop', eventId: 'deep-event', threadId: 'room', objectId: 'deep-object',
    text: 'deep work', authorId: 'user', authorKind: 'human', addressing: 'direct' })
  assert.equal(runs[0].state, 'budget-exhausted')
})

test('prepared artifacts are verified inside the isolated directory', { timeout: 20000 }, async t => {
  let mode = 'valid'
  const content = 'x'.repeat(2048)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const { root, engine } = await fixture(t, async ({ isolatedDirectory }) => {
    await writeFile(join(isolatedDirectory, 'artifact.txt'), content)
    if (mode === 'escape') {
      await writeFile(join(isolatedDirectory, '..', 'escape.txt'), 'escaped')
      return { summary: 'Escaped.', artifacts: [{ path: '../escape.txt', bytes: 7, sha256: createHash('sha256').update('escaped').digest('hex') }] }
    }
    if (mode === 'size') return { summary: 'Wrong size.', artifacts: [{ path: 'artifact.txt', bytes: 1, sha256 }] }
    if (mode === 'digest') return { summary: 'Wrong digest.', artifacts: [{ path: 'artifact.txt', bytes: Buffer.byteLength(content), sha256: '0'.repeat(64) }] }
    if (mode === 'budget') return { summary: 'Too large.', artifacts: [{ path: 'artifact.txt', bytes: Buffer.byteLength(content), sha256 }] }
    return { summary: 'Verified.', artifacts: [{ path: 'artifact.txt', bytes: Buffer.byteLength(content), sha256 }] }
  })
  await engine.updateProactiveRules({ commandId: 'artifact-rules', expectedRevision: 1, rules: [{ id: 'artifact', name: 'Artifacts', mode: 'auto',
    match: { actorKinds: ['human'], addressing: ['direct'], textPattern: 'artifact' }, communication: 'silent',
    budget: { maxRuns: 10, windowMs: 3600000 }, enabled: true }] })
  const valid = (await record(engine, 'artifact-valid', 'artifact request')).runs.find(run => run.ruleId === 'artifact')
  assert.equal(valid.state, 'prepared')
  assert.deepEqual(valid.artifacts, [{ path: 'artifact.txt', bytes: Buffer.byteLength(content), sha256 }])
  for (const name of ['escape', 'size', 'digest']) {
    mode = name
    const run = (await record(engine, `artifact-${name}`, 'artifact request')).runs.find(item => item.ruleId === 'artifact')
    assert.equal(run.state, 'failed', name)
    assert.equal(run.reason, 'ARTIFACT_UNVERIFIED', name)
  }
  mode = 'budget'
  await engine.updateProactiveRules({ commandId: 'artifact-small-budget', expectedRevision: 2, rules: [{ id: 'artifact', name: 'Artifacts', mode: 'auto',
    match: { actorKinds: ['human'], addressing: ['direct'], textPattern: 'artifact' }, communication: 'silent',
    budget: { maxRuns: 10, windowMs: 3600000, maxArtifactBytes: 1024 }, enabled: true }] })
  const limited = (await record(engine, 'artifact-budget', 'artifact request')).runs.find(run => run.ruleId === 'artifact')
  assert.equal(limited.state, 'failed')
  assert.equal(limited.reason, 'ARTIFACT_BUDGET')
  assert.ok(valid.isolatedDirectory.startsWith(root))
})

test('a scheduled occurrence can trigger an authorized auto preparation', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-proactive-schedule-'))
  const root = join(directory, 'proactive-root')
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  let calls = 0
  const engine = new core.Engine(storage, 'private', { kind: 'schedule', sourceInstanceId: 'schedule:proactive', actorId: 'schedule',
    allowedActorIds: ['schedule'], allowedThreadPrefixes: ['schedule:'], versionOrder: 'sequence' }, {}, undefined, [], {}, {}, {}, {}, {}, {
      rootDirectory: root,
      prepare: async ({ candidate, isolatedDirectory }) => {
        calls++
        await writeFile(join(isolatedDirectory, 'plan.txt'), candidate.text)
        return { summary: `Prepared: ${candidate.text}` }
      },
    })
  await engine.updateProactiveRules({ commandId: 'schedule-rules', expectedRevision: 1, rules: [{ id: 'scheduled', name: 'Scheduled preparation',
    mode: 'auto', match: { actorKinds: ['system'], addressing: ['direct'] }, communication: 'silent',
    budget: { maxRuns: 2, windowMs: 3600000 }, enabled: true }] })
  const source = new core.ScheduleSource(storage, 'private', engine, { ruleId: 'proactive', timezone: 'UTC', intervalMs: 1000,
    text: 'Prepare the nightly review.' })
  await source.tick(10_000)
  let prepared = []
  for (let attempt = 0; attempt < 200 && prepared.length === 0; attempt++) {
    prepared = (await engine.listProactiveRuns()).filter(run => run.state === 'prepared')
    if (prepared.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(prepared.length, 1)
  assert.equal(calls, 1)
  assert.equal(prepared[0].summary, 'Prepared: Prepare the nightly review.')
})

test('a rule revision or explicit stop invalidates a late preparation result', { timeout: 20000 }, async t => {
  const releases = []
  const { engine } = await fixture(t, async () => new Promise(resolve => releases.push(resolve)))
  const rule = { id: 'guarded', name: 'Guarded', mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'] },
    communication: 'notify', budget: { maxRuns: 3, windowMs: 3600000 }, enabled: true }
  await engine.updateProactiveRules({ commandId: 'guard-rule', expectedRevision: 1, rules: [rule] })
  const running = async objectId => {
    const receipt = await engine.receiveSource({ commandId: `guard-${objectId}`, threadId: 'room', objectId,
      type: 'created', version: '1', text: 'Prepare a review.', authorId: 'user' })
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = (await engine.listProactiveRuns()).find(item => item.eventId === receipt.eventId)
      if (run?.state === 'running' && releases.length) return run
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('The preparation did not start.')
  }
  const first = await running('rule-change')
  await engine.updateProactiveRules({ commandId: 'revise-rule', expectedRevision: 2, rules: [rule] })
  releases.shift()({ summary: 'This must not become ready.' })
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await engine.getProactiveRun(first.id)).state === 'suppressed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await engine.getProactiveRun(first.id)).reason, 'RULE_CHANGED')
  const second = await running('manual-stop')
  assert.equal((await engine.stopProactiveRun({ commandId: 'stop-guarded', runId: second.id, reason: 'Stopped by user.' })).state, 'stopped')
  releases.shift()({ summary: 'This must not become ready either.' })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await engine.getProactiveRun(second.id)).state, 'stopped')
  assert.equal((await engine.stopProactiveRun({ commandId: 'stop-guarded', runId: second.id, reason: 'Stopped by user.' })).state, 'stopped')
  await assert.rejects(engine.stopProactiveRun({ commandId: 'stop-guarded', runId: second.id, reason: 'Different stop.' }), { code: 'IDENTITY_CONFLICT' })
  assert.deepEqual((await engine.effects.list()).items, [])
})

test('a persisted candidate is consumed once by a replacement Engine after reception', { timeout: 20000 }, async t => {
  let calls = 0
  const prepare = async () => { calls++; return { summary: 'Recovered preparation.', evidence: 'The original source event is current.' } }
  const { storage, root, engine } = await fixture(t, prepare)
  const receipt = await engine.receiveSource({ commandId: 'early-source', threadId: 'room', objectId: 'early',
    type: 'created', version: '1', text: 'Review the observation.', authorId: 'user' })
  const rule = { id: 'recovery', name: 'Recovery', mode: 'auto', match: { actorKinds: ['human'], addressing: ['direct'] },
    communication: 'notify', budget: { maxRuns: 2, windowMs: 3600000 }, enabled: true }
  await engine.updateProactiveRules({ commandId: 'enable-recovery', expectedRevision: 1, rules: [rule] })
  const candidate = { sourceInstanceId: 'desktop', eventId: receipt.eventId, threadId: 'room', objectId: 'early',
    text: 'Review the observation.', authorId: 'user', authorKind: 'human', addressing: 'direct' }
  const queue = new core.Proactive(storage, 'private', { rootDirectory: root })
  await storage.transaction('private', tx => queue.enqueue(tx, candidate))
  assert.equal((await queue.pending('desktop')).length, 1)
  await engine.shutdown()
  const replacement = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user',
    allowedActorIds: ['user'], allowedThreadIds: ['room'], versionOrder: 'sequence' }, {}, undefined, [], {}, {}, {}, {},
  { hostId: 'proactive-host', leaseMs: 30000 }, { rootDirectory: root, prepare })
  try {
    assert.equal(await replacement.reconcileProactiveCandidates(), 1)
    assert.equal(await replacement.reconcileProactiveCandidates(), 0)
    assert.equal(calls, 1)
    assert.equal((await replacement.getRecentProactiveNotices())[0].summary, 'Recovered preparation.')
    assert.deepEqual(await queue.pending('desktop'), [])
  } finally { await replacement.shutdown() }
})
