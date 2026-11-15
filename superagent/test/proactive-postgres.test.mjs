import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine } from '../dist/index.js'
import { startPostgres } from './fixtures/postgres-harness.mjs'

test('PostgreSQL preserves rule, notice, pause and stop facts across Engine replacement', { timeout: 240000 }, async t => {
  const fixture = await startPostgres('r5-proactive-pg-')
  t.after(() => fixture.close())
  const { storage } = await fixture.newStorage()
  const source = { sourceInstanceId: 'proactive-pg', actorId: 'owner', allowedActorIds: ['owner'],
    allowedThreadIds: ['room'], versionOrder: 'sequence' }
  const options = { rootDirectory: join(fixture.directory, 'preparations'),
    prepare: async () => ({ summary: 'A reviewable PostgreSQL result.', evidence: 'Verified stored source event.', modelSteps: 2 }) }
  let engine = new Engine(storage, 'private', source, {}, undefined, [], {}, {}, {}, {}, {}, options)
  t.after(async () => engine.shutdown())
  const rule = { id: 'postgres-review', name: 'Review', mode: 'auto', enabled: true,
    match: { sourceInstanceIds: ['proactive-pg'], actorKinds: ['human'], addressing: ['direct'] },
    communication: 'notify', budget: { maxRuns: 2, windowMs: 3600000 } }
  assert.equal((await engine.updateProactiveRules({ commandId: 'save', expectedRevision: 1, rules: [rule] })).revision, 2)
  const receipt = await engine.receiveSource({ commandId: 'receive', threadId: 'room', objectId: 'one', type: 'created',
    version: '1', text: 'Prepare a review.', authorId: 'owner' })
  let ready
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = (await engine.listProactiveRuns()).find(run => run.eventId === receipt.eventId && run.state === 'prepared')
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(ready)
  assert.deepEqual((await engine.getRecentProactiveNotices()).map(run => run.id), [ready.id])
  assert.equal((await engine.setProactivePaused({ commandId: 'pause', paused: true })).paused, true)
  assert.equal((await engine.stopProactiveRun({ commandId: 'stop', runId: ready.id, reason: 'User stopped this result.' })).state, 'stopped')
  await engine.shutdown()
  engine = new Engine(storage, 'private', source, {}, undefined, [], {}, {}, {}, {}, {}, options)
  assert.equal((await engine.getProactiveControl()).paused, true)
  assert.equal((await engine.getProactiveRules()).revision, 2)
  assert.equal((await engine.getProactiveRun(ready.id)).state, 'stopped')
  assert.deepEqual(await engine.getRecentProactiveNotices(), [])
  assert.equal((await engine.updateProactiveRules({ commandId: 'save', expectedRevision: 1, rules: [rule] })).revision, 2)
})
