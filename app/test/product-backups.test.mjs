import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessions from '@deepseek-ai/dsh-session-persistence-jsonl'
import { backupBeforeProfileChange, completeProductRestore, createProductBackup, listProductBackups,
  recoverInterruptedProductRestore, restoreProductBackup, sessionInventory } from '../src/product-backups.mjs'

async function sessionStore(home, operation) {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessions, { root: join(home, 'sessions') })
    return await operation(ctx.get('sessionPersistence'))
  } finally { await ctx.fiber.dispose() }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ds-superagent-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const backupRoot = join(root, 'backups')
  const database = join(home, 'core', 'state.sqlite')
  await mkdir(join(home, 'core'), { recursive: true })
  {
    using db = new DatabaseSync(database)
    db.exec('CREATE TABLE records(instance_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(instance_id, kind, id)); PRAGMA user_version=2;')
  }
  function put(kind, id, body) {
    using db = new DatabaseSync(database)
    db.prepare('INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?)').run('personal', kind, id, JSON.stringify(body))
  }
  function get(kind, id) {
    using db = new DatabaseSync(database, { readOnly: true })
    return JSON.parse(db.prepare('SELECT body FROM records WHERE instance_id=? AND kind=? AND id=?').get('personal', kind, id).body)
  }
  put('main-state', 'main', { version: 1 })
  put('stop-state', 'work-a', { state: 'stopped', id: 'stop-a' })
  put('resource-credential', 'resource-a', { state: 'revoked' })
  await sessionStore(home, async persistence => {
    const handle = await persistence.create({ version: 4, id: 'main-session', createdAt: Date.now(), isSeeded: false, cwd: home })
    try {
      await handle.append([{ type: 'session/end-seed', seq: 0, time: Date.now(), data: {} }])
      await handle.flush()
    } finally { await handle.close() }
  })
  return { home, backupRoot, database, put, get }
}

test('restores a verified business and Session pair without rewinding stop, authorization or Host fencing', async t => {
  const { home, backupRoot, put, get } = await fixture(t)
  const project = join(home, '..', 'project')
  await mkdir(project)
  await writeFile(join(project, 'notes.txt'), 'keep project files')
  const expectedSessions = await sessionStore(home, sessionInventory)
  const saved = await createProductBackup({ home, backupRoot, expectedSessions })
  assert.equal(saved.business.schemaVersion, 2)
  assert.equal(saved.sessions.sessionCount, 1)
  assert.equal(saved.sessions.eventCount, 1)
  assert.deepEqual((await listProductBackups(backupRoot)).map(item => item.id), [saved.id])

  put('main-state', 'main', { version: 2 })
  put('host-lease', 'host-a', { epoch: 8 })
  await sessionStore(home, async persistence => {
    const handle = await persistence.open('main-session', 'write')
    try {
      await handle.append([{ type: 'session/end-seed', seq: 1, time: Date.now(), data: {} }])
      await handle.flush()
    } finally { await handle.close() }
  })
  await restoreProductBackup({ home, backupRoot, backupId: saved.id })
  assert.equal((await recoverInterruptedProductRestore({ home })).status, 'installed')
  assert.deepEqual(get('main-state', 'main'), { version: 1 })
  assert.deepEqual(get('stop-state', 'work-a'), { state: 'stopped', id: 'stop-a' })
  assert.deepEqual(get('resource-credential', 'resource-a'), { state: 'revoked' })
  assert.deepEqual(get('host-lease', 'host-a'), { epoch: 8 })
  assert.deepEqual(await sessionStore(home, sessionInventory), expectedSessions)
  assert.equal(await completeProductRestore({ home }), true)
  assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'keep project files')
})

test('restore refuses changed authorization and external effects without altering either store', async t => {
  const { home, backupRoot, put, get } = await fixture(t)
  const saved = await createProductBackup({ home, backupRoot })
  const before = await sessionStore(home, sessionInventory)
  put('stop-state', 'work-a', { state: 'stopped', id: 'stop-new' })
  await assert.rejects(restoreProductBackup({ home, backupRoot, backupId: saved.id }), { code: 'RESTORE_AUTHORITY_CONFLICT' })
  put('effect', 'external-action', { state: 'unknown' })
  await assert.rejects(restoreProductBackup({ home, backupRoot, backupId: saved.id }), { code: 'RESTORE_SIDE_EFFECT_RISK' })
  await assert.rejects(createProductBackup({ home, backupRoot, purpose: 'upgrade', requireRestorable: true }), { code: 'BACKUP_UNRESOLVED_WORK' })
  assert.deepEqual((await listProductBackups(backupRoot)).map(item => item.id), [saved.id])
  assert.equal(get('stop-state', 'work-a').id, 'stop-new')
  assert.equal(get('effect', 'external-action').state, 'unknown')
  assert.deepEqual(await sessionStore(home, sessionInventory), before)
})

test('a profile upgrade refuses an unsupported SQLite version without publishing a backup', async t => {
  const { home, backupRoot, database } = await fixture(t)
  { using db = new DatabaseSync(database); db.exec('PRAGMA user_version=99') }
  await assert.rejects(backupBeforeProfileChange({ home, backupRoot, version: '2' }), { code: 'UNSUPPORTED_SCHEMA' })
  assert.deepEqual(await listProductBackups(backupRoot), [])
})

test('a profile upgrade refuses to migrate when its product backup cannot be restored', async t => {
  const { home, backupRoot, put } = await fixture(t)
  await writeFile(join(home, 'core', 'profile-version.json'), JSON.stringify({ version: '1' }))
  put('effect', 'external-action', { state: 'pending' })
  await assert.rejects(backupBeforeProfileChange({ home, backupRoot, version: '2' }), { code: 'BACKUP_UNRESOLVED_WORK' })
  assert.deepEqual(await listProductBackups(backupRoot), [])
})

test('startup rolls back a restore interrupted after moving the live business file', async t => {
  const { home, backupRoot, database, get } = await fixture(t)
  const saved = await createProductBackup({ home, backupRoot })
  const id = randomUUID()
  await writeFile(join(home, 'core', 'product-restore-journal.json'), JSON.stringify({
    version: 1, id, backupId: saved.id, state: 'prepared', hadSessions: true,
  }))
  await rename(database, join(home, 'core', `.state.sqlite.previous-${id}`))
  assert.equal((await recoverInterruptedProductRestore({ home })).status, 'rolled-back')
  assert.deepEqual(get('main-state', 'main'), { version: 1 })
  assert.equal((await sessionStore(home, sessionInventory)).events, 1)
  assert.equal((await recoverInterruptedProductRestore({ home })).status, 'none')
})

test('a committed restore journal only retries cleanup and never rolls back the new snapshot', async t => {
  const { home, backupRoot, database } = await fixture(t)
  const saved = await createProductBackup({ home, backupRoot })
  putCurrentVersion(database)
  await restoreProductBackup({ home, backupRoot, backupId: saved.id })
  const journalPath = join(home, 'core', 'product-restore-journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  await writeFile(journalPath, JSON.stringify({ ...journal, state: 'committed' }))
  assert.equal((await recoverInterruptedProductRestore({ home, rollback: true })).status, 'none')
  assert.equal((await recoverInterruptedProductRestore({ home })).status, 'none')
  using db = new DatabaseSync(database, { readOnly: true })
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM records WHERE kind=?').get('main-state').body), { version: 1 })
})

function putCurrentVersion(database) {
  using db = new DatabaseSync(database)
  db.prepare('UPDATE records SET body=? WHERE kind=?').run('{"version":2}', 'main-state')
}
