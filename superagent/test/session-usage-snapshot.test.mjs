import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NativeSessions } from '../dist/index.js'
import { nativeContext, textResponse } from '../dev/native-mock.mjs'

test('usage snapshots preserve provider reports, exact sequence attribution and per-Session event budgets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-usage-session-'))
  let native
  let sessions
  t.after(async () => {
    await sessions?.close()
    await native?.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  native = await nativeContext(join(directory, 'sessions'), function* () {
    yield* textResponse('A verified mock response.', { inputTokens: 11, outputTokens: 3, totalTokens: 14 })
  })
  sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  await sessions.run({ sessionId: 'usage-main', role: 'main', text: 'Summarize usage.', tools: [] })
  const history = await sessions.readSession('usage-main', { limit: 100 })
  const usageEvent = history.events.find(event => event.type === 'assistant/message'
    && event.data?.usage?.inputTokens === 11)
  assert.ok(usageEvent, JSON.stringify(history.events.map(event => event.type)))

  const range = { id: 'work-turn', startSeq: Number(usageEvent.seq), endSeq: Number(usageEvent.seq) }
  const complete = await sessions.readUsageSnapshot('usage-main', { ranges: [range] })
  assert.equal(complete.status, 'available')
  assert.equal(complete.usage.reportedCalls, 1)
  assert.equal(complete.usage.totalTokens, 14)
  assert.equal(complete.ranges[0].usage.totalTokens, 14)
  assert.equal(complete.ranges[0].usage.calls, 1)

  const bounded = await sessions.readUsageSnapshot('usage-main', { maxEvents: 1, ranges: [range] })
  assert.equal(bounded.status, 'over-budget')
  assert.equal(bounded.usage.calls, 0)
  assert.equal(bounded.eventCount > 1, true)
})
