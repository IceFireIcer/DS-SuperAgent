import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CoreError, Engine } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

const source = { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }
const request = { commandId: 'original', eventId: 'message', text: 'Preserve this request.' }

test('an unknown commit is reconciled on a fresh locked connection using the original command identity', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-reconcile-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  context.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  let loseReply = true
  const uncertain = {
    transaction: async (instanceId, operation) => {
      const result = await storage.transaction(instanceId, operation)
      if (loseReply) { loseReply = false; throw new CoreError('COMMIT_UNKNOWN', 'Commit response lost.') }
      return result
    },
    reconnect: () => storage.reconnect(),
    close: () => storage.close(),
  }
  const engine = new Engine(uncertain, 'private', source)
  const receipt = await engine.submit(request)
  assert.deepEqual(await engine.getReceipt('original'), receipt)
  assert.equal((await engine.listTickets()).items.length, 1)
  loseReply = true
  await assert.rejects(engine.submit({ ...request, text: 'Different scope.' }), { code: 'IDENTITY_CONFLICT' })
})

test('an unverified commit stays unknown when a fresh connection cannot acquire the write lock', async () => {
  const storage = {
    transaction: async () => { throw new CoreError('COMMIT_UNKNOWN', 'Commit response lost.') },
    reconnect: async () => ({
      transaction: async () => { throw new CoreError('LOCK_TIMEOUT', 'Original writer still holds the lock.') },
      close: async () => {},
    }),
    close: async () => {},
  }
  const engine = new Engine(storage, 'private', source)
  await assert.rejects(engine.submit(request), { code: 'COMMIT_UNKNOWN' })
})

test('rolled-back serialization failures retry the whole transaction with a finite budget', async () => {
  let attempts = 0
  const engine = new Engine({
    transaction: async () => { attempts++; throw new CoreError('SERIALIZATION_FAILURE', 'Rolled back.') },
    reconnect: async () => { throw new Error('A rollback must not require reconciliation.') },
    close: async () => {},
  }, 'private', source)
  await assert.rejects(engine.submit(request), { code: 'RETRY_EXHAUSTED' })
  assert.equal(attempts, 3)
})

test('an expired behavior-instruction lease cannot let the old interpreter overwrite the new result', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-superagent-behavior-lease-'))
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const engine = new Engine(storage, 'private', source)
  context.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }) })
  const rolesChange = (request, instruction) => ({
    target: 'roles', summary: 'Change the Worker prompt.',
    roles: {
      ...request.roles.roles,
      router: { ...request.roles.roles.router, instructions: '{{goal}}' },
      worker: { ...request.roles.roles.worker, instructions: `{{goal}} {{constraints}} ${instruction}` },
    },
  })
  const command = { commandId: 'behavior-lease', instruction: 'Change the Worker prompt.', expectedRoleRevision: 1 }
  let releaseFirst, firstBegan
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const firstStarted = new Promise(resolve => { firstBegan = resolve })
  const first = engine.updateBehaviorFromInstruction(command, async request => {
    firstBegan()
    await firstGate
    return rolesChange(request, 'Old instruction.')
  }).catch(error => error)
  await firstStarted
  const key = JSON.stringify(['behavior-instruction', command.commandId])
  await storage.transaction('private', async tx => {
    const record = await tx.get('behavior-instruction', key)
    await tx.replace('behavior-instruction', key, { ...record, leaseUntil: Date.now() - 1 })
  })
  let releaseSecond, secondBegan
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  const secondStarted = new Promise(resolve => { secondBegan = resolve })
  const second = engine.updateBehaviorFromInstruction(command, async request => {
    secondBegan()
    await secondGate
    return rolesChange(request, 'New instruction.')
  })
  await secondStarted
  releaseFirst()
  const stale = await first
  assert.equal(stale.code, 'INSTRUCTION_CHANGED')
  releaseSecond()
  const applied = await second
  assert.equal(applied.status, 'applied')
  assert.match((await engine.getRoleConfig()).roles.worker.instructions, /New instruction\./u)
  assert.doesNotMatch((await engine.getRoleConfig()).roles.worker.instructions, /Old instruction\./u)
})
