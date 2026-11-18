import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createOperationsLog } from '../src/operations-log.mjs'

test('operational diagnostics persist bounded event codes without free-form messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-superagent-operations-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let at = 10
  const first = createOperationsLog(join(root, 'logs', 'operations.jsonl'), { now: () => at++ })
  await first.record('host', 'HOST_READY')
  await first.record('update', 'UPDATE_FAILED', '0.2.5')
  assert.equal(await first.record('host', 'token=secret'), false)
  const second = createOperationsLog(join(root, 'logs', 'operations.jsonl'))
  assert.deepEqual((await second.read()).map(({ area, code, version }) => [area, code, version]), [
    ['host', 'HOST_READY', undefined], ['update', 'UPDATE_FAILED', '0.2.5'],
  ])
})
