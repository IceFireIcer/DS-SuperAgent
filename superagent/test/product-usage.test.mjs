import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProductUsage } from '../dist/product-usage.js'

const usage = totalTokens => ({ calls: Number(totalTokens > 0), reportedCalls: Number(totalTokens > 0), inputTokens: totalTokens, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens })

function storage(records) {
  return {
    async transaction(instanceId, operation) {
      return operation({
        instanceId,
        async get(kind, id) { return records.get(`${instanceId}:${kind}:${id}`) },
        async scan(kind, { limit, after } = {}) {
          const items = [...records]
            .filter(([key]) => key.startsWith(`${instanceId}:${kind}:`))
            .map(([key, value]) => ({ id: key.slice(`${instanceId}:${kind}:`.length), value }))
            .filter(item => after === undefined || item.id > after)
            .sort((left, right) => left.id.localeCompare(right.id))
          const page = items.slice(0, limit)
          return { items: page, ...(items.length > limit ? { cursor: page.at(-1).id } : {}) }
        },
      })
    },
  }
}

test('usage is grouped by role and the exact Router and Worker Session ranges for each work item', async () => {
  const records = new Map()
  const put = (kind, id, value) => records.set(`private:${kind}:${id}`, { instanceId: 'private', ...value })
  put('role-config-use-meta', JSON.stringify(['role-config-use-meta']), { sequence: 3 })
  const useKey = sequence => `${JSON.stringify(['role-config-use-recent'])}:${String(sequence).padStart(16, '0')}`
  put('role-config-use-recent', useKey(1), { sessionId: 'main-session', role: 'main', createdAt: 1 })
  put('role-config-use-recent', useKey(2), { sessionId: 'router-session', role: 'router', createdAt: 2 })
  put('role-config-use-recent', useKey(3), { sessionId: 'worker-session', role: 'worker', createdAt: 3 })
  put('work-brief', 'brief-1', { id: 'brief-1', mainId: 'main-1',
    routerSessionId: 'router-session', goal: 'Fix the parser.' })
  put('work-router-turn', 'turn-1', { id: 'turn-1', workBriefId: 'brief-1', sessionId: 'router-session',
    startSeq: 10, endSeq: 12, phase: 'route', status: 'completed', createdAt: 2 })
  put('work-item', 'item-1', { id: 'item-1', workBriefId: 'brief-1', goal: 'Fix the parser.' })
  put('work-ticket', 'ticket-1', { ticketId: 'ticket-1', workBriefId: 'brief-1', workItemId: 'item-1' })
  put('assignment', 'ticket-1', { id: 'assignment-1', ticketId: 'ticket-1', sessionId: 'worker-session',
    state: 'ended', generation: 'generation-1', sessionStartSeq: 5, sessionEndSeq: 8, createdAt: 3 })
  const sessions = {
    async readUsageSnapshot(sessionId, { ranges }) {
      const points = sessionId === 'main-session' ? [[1, 5]]
        : sessionId === 'router-session' ? [[9, 2], [10, 3], [12, 4], [13, 7]]
          : [[4, 1], [5, 2], [8, 4], [9, 8]]
      const inRange = new Map(ranges.map(range => [range.id, usage(0)]))
      const total = usage(0)
      for (const [seq, tokens] of points) {
        for (const key of ['calls', 'reportedCalls']) total[key]++
        for (const key of ['inputTokens', 'totalTokens']) total[key] += tokens
        const matching = ranges.filter(range => seq >= range.startSeq && seq <= range.endSeq)
        if (matching.length === 1) {
          const target = inRange.get(matching[0].id)
          for (const key of ['calls', 'reportedCalls']) target[key]++
          for (const key of ['inputTokens', 'totalTokens']) target[key] += tokens
        }
      }
      return { status: 'available', eventCount: points.length, usage: total,
        ranges: [...inRange].map(([id, value]) => ({ id, usage: value })) }
    },
  }

  const report = await new ProductUsage(storage(records), 'private', sessions).read()
  assert.deepEqual(Object.fromEntries(Object.entries(report.roles).map(([role, value]) => [role, value.totalTokens])),
    { main: 5, router: 16, worker: 15 })
  assert.equal(report.works.find(item => item.id === 'item:item-1').total.totalTokens, 6)
  assert.equal(report.planning.find(item => item.id === 'brief:brief-1').total.totalTokens, 7)
  assert.equal(report.unattributed.totalTokens, 23)
  assert.equal(report.coverage.status, 'available')
})

test('usage reports omitted Sessions and source scan budgets instead of treating partial totals as complete', async () => {
  const records = new Map()
  records.set(`private:role-config-use-meta:${JSON.stringify(['role-config-use-meta'])}`, { sequence: 3 })
  for (let index = 1; index <= 3; index++) records.set(`private:role-config-use-recent:${JSON.stringify(['role-config-use-recent'])}:${String(index).padStart(16, '0')}`, {
    instanceId: 'private', sessionId: `session-${index - 1}`, role: index === 1 ? 'main' : 'worker', createdAt: index,
  })
  let readCount = 0
  const sessions = { async readUsageSnapshot(sessionId) {
    readCount++
    return sessionId === 'session-2' ? { status: 'over-budget', eventCount: 50001 }
      : { status: 'available', eventCount: 1, usage: usage(2), ranges: [] }
  } }
  const report = await new ProductUsage(storage(records), 'private', sessions,
    { maxSessions: 1, maxRoleUses: 2 }).read()
  assert.equal(readCount, 1)
  assert.equal(report.coverage.status, 'unavailable')
  assert.equal(report.coverage.includedSessions, 0)
  assert.equal(report.coverage.omittedSessions, 2)
  assert.equal(report.coverage.omittedRoleUses, 1)
  assert.equal(report.coverage.overBudgetSessions, 1)
  assert.equal(report.roles.worker.status, 'unavailable')
})
