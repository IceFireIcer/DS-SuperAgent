import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'
import { createProductBackup, restoreProductBackup } from '../src/product-backups.mjs'

await installHooks()

test('a failed restore boot can undo the swap under the data lock and load the previous Host state', async t => {
  let database
  const backupRoot = join(paths.userData, 'backups')
  hostState.fail = true
  state.dialogAnswer = options => {
    const rollback = options.buttons?.indexOf('Undo unfinished restore')
    if (!(rollback >= 0)) return { response: 1 }
    hostState.fail = false
    return { response: rollback }
  }
  await startApp({ packaged: false, async prepare(home) {
    await mkdir(join(home, 'core'))
    database = join(home, 'core', 'state.sqlite')
    {
      using db = new DatabaseSync(database)
      db.exec(`CREATE TABLE records(instance_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(instance_id, kind, id)); PRAGMA user_version=2;`)
      db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run('local', 'main-state', 'main', '{"version":1}')
    }
    const saved = await createProductBackup({ home, backupRoot })
    { using db = new DatabaseSync(database); db.prepare('UPDATE records SET body=?').run('{"version":2}') }
    await restoreProductBackup({ home, backupRoot, backupId: saved.id })
  } })
  t.after(() => app.quit())
  hostState.release()
  await waitFor(() => hostState.starts === 2 && window().loaded.some(url => url.includes('token=')), 'load the previous Host state')
  using db = new DatabaseSync(database, { readOnly: true })
  assert.equal(JSON.parse(db.prepare('SELECT body FROM records').get().body).version, 2)
  const log = await readFile(join(paths.userData, 'logs', 'operations.jsonl'), 'utf8')
  assert.match(log, /RESTORE_ROLLED_BACK/u)
})
