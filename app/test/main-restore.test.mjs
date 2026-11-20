import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { START_ACT } from '../src/start-window.mjs'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startWindows, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'
import { createProductBackup, restoreProductBackup } from '../src/product-backups.mjs'

await installHooks()

test('a failed restore boot can undo the swap under the data lock and load the previous Host state', async t => {
  let database
  const backupRoot = join(paths.userData, 'backups')
  hostState.fail = true
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
  await waitFor(() => startWindows().length === 1, 'open the startup window')
  const start = startWindows()[0]
  await waitFor(() => start.webContents.sent.some(([channel, snapshot]) =>
    channel === 'ds-superagent:start-state' && snapshot.view === 'failed'
    && snapshot.failure?.restoreRollback === true), 'offer the unfinished restore rollback')
  hostState.fail = false
  const event = { sender: start.webContents, senderFrame: start.webContents.mainFrame }
  assert.equal(await state.ipc.get(START_ACT)(event, 'rollback'), true)
  await waitFor(() => hostState.starts === 2 && window()?.loaded.some(url => url.includes('token=')) === true,
    'load the previous Host state')
  using db = new DatabaseSync(database, { readOnly: true })
  assert.equal(JSON.parse(db.prepare('SELECT body FROM records').get().body).version, 2)
  const log = await readFile(join(paths.userData, 'logs', 'operations.jsonl'), 'utf8')
  assert.match(log, /RESTORE_ROLLED_BACK/u)
})
