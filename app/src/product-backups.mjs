import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync, backup } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessions from '@deepseek-ai/dsh-session-persistence-jsonl'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { real, within } from './copy-tree.mjs'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const backupId = new RegExp(`^\\d{13}-${uuid}$`, 'u')
const restoreId = new RegExp(`^${uuid}$`, 'u')
const sha256 = /^[a-f0-9]{64}$/u
const maxFiles = 100_000
const maxBytes = 20 * 1024 ** 3
const journalName = 'product-restore-journal.json'
const sqliteSidecars = ['-wal', '-shm', '-journal']
const externalFacts = new Set(['effect', 'effect-key', 'effect-receipt', 'effect-meta', 'delivery', 'delivery-history', 'delivery-meta',
  'main-source-reply', 'job', 'job-command', 'remote-job', 'worker-mcp-call', 'browser-operation'])
// Keep everything that could restore authority or make an old action runnable. Only chat
// history and its accounting can move back; Host epochs are kept from the current database.
const history = new Set(['main-state', 'main-message', 'main-command', 'main-message-command', 'main-health',
  'role-config-use', 'role-config-use-meta', 'role-config-use-recent', 'client-event', 'client-event-key', 'client-journal',
  'supervisor-run', 'supervisor-cursor-key', 'watchdog-state', 'host-lease', 'host-takeover'])
const monotonicRecords = ['client-event', 'client-event-key', 'client-journal', 'host-lease', 'host-takeover']

const fault = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => fault('BACKUP_INVALID', 'The selected backup failed verification.')
const sideEffectRisk = () => fault('RESTORE_SIDE_EFFECT_RISK', 'External work changed or still needs reconciliation. This backup cannot safely replace the current state.')

function roots({ home, backupRoot }) {
  if (typeof home !== 'string' || !isAbsolute(home) || backupRoot !== undefined && !isAbsolute(backupRoot)) throw invalid()
  const local = real(home)
  const saved = backupRoot === undefined ? undefined : real(backupRoot)
  if (saved !== undefined && (within(local, saved) || within(saved, local))) throw invalid()
  const personal = [join(homedir(), '.dsh'), join(homedir(), '.ds-bot'), process.env.DS_SUPERAGENT_USER_DSH_HOME].filter(Boolean).map(real)
  if ([local, saved].filter(Boolean).some(path => personal.some(root => within(path, root) || within(root, path)))) throw invalid()
  return { home: local, backupRoot: saved }
}

async function inspectPath(path) {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (info?.isSymbolicLink()) throw invalid()
  return info
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function readJson(path, limit = 24 * 1024 ** 2) {
  const info = await inspectPath(path)
  if (!info) return undefined
  if (!info.isFile() || info.size > limit) throw invalid()
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw invalid() }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

async function sqliteFile(path) {
  if (!(await inspectPath(path))?.isFile()) throw fault('BACKUP_BUSINESS_UNAVAILABLE', 'The local product business database is unavailable.')
  for (const suffix of sqliteSidecars) await inspectPath(`${path}${suffix}`)
}

function openBusiness(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = Number(db.prepare('PRAGMA user_version').get().user_version)
    const fields = db.prepare('PRAGMA table_info(records)').all().map(column => [column.name, column.pk])
    if (![1, 2].includes(schema) || JSON.stringify(fields) !== JSON.stringify([['instance_id', 1], ['kind', 2], ['id', 3], ['body', 0]])) {
      throw fault('UNSUPPORTED_SCHEMA', 'This product business schema is unsupported.')
    }
    if (db.prepare('PRAGMA integrity_check(1)').get().integrity_check !== 'ok') throw invalid()
    return { db, schema }
  } catch (error) { db.close(); throw error }
}

function businessFacts(path) {
  const { db, schema } = openBusiness(path)
  try {
    let records = 0
    const unresolved = new Map()
    const external = createHash('sha256')
    const authority = createHash('sha256')
    const identity = createHash('sha256')
    for (const row of db.prepare('SELECT instance_id, kind, id, body FROM records ORDER BY instance_id, kind, id').iterate()) {
      records++
      if (externalFacts.has(row.kind)) external.update(`${JSON.stringify(row)}\n`)
      else if (!history.has(row.kind)) authority.update(`${JSON.stringify(row)}\n`)
      const value = JSON.parse(row.body)
      if (row.kind === 'main-state') identity.update(`${JSON.stringify([row.instance_id, value.mainId ?? row.id])}\n`)
      if (row.kind === 'effect' && value.state !== 'failed'
        || row.kind === 'intent' && !['ready-report', 'stopped', 'waiting-human', 'environment-waiting', 'worker-not-enabled', 'worker-idle'].includes(value.reason)
        || row.kind === 'stop-state' && (value.state === 'stopping' || value.pendingDeviceConfirmation)
        || row.kind === 'host-takeover' && value.state === 'pending'
        || row.kind === 'main-active-command'
        || row.kind === 'main-command' && ['queued', 'running', 'stopping', 'interrupted'].includes(value.status)
        || row.kind === 'job' && ['starting', 'running', 'unknown', 'cancelling'].includes(value.state)
        || row.kind === 'worker-mcp-call' && ['invoking', 'pending', 'running', 'unknown'].includes(value.state)
        || row.kind === 'browser-operation' && ['running', 'pending', 'unknown'].includes(value.state)) {
        unresolved.set(row.kind, (unresolved.get(row.kind) ?? 0) + 1)
      }
    }
    return { schema, records, unresolved: [...unresolved.values()].reduce((total, count) => total + count, 0),
      blockers: Object.fromEntries(unresolved), external: external.digest('hex'), authority: authority.digest('hex'), identity: identity.digest('hex') }
  } finally { db.close() }
}

async function copyBusiness(source, destination) {
  await sqliteFile(source)
  const { db } = openBusiness(source)
  try { await backup(db, destination) } finally { db.close() }
  const { db: copy } = openBusiness(destination)
  copy.close()
}

// Treat the configured Session directory as opaque data. Verify that a fresh
// instance of the public persistence plugin can enumerate and read the copy.
export async function sessionInventory(persistence) {
  const items = [...await persistence.list()].sort((left, right) => String(left.header.id).localeCompare(String(right.header.id), 'en'))
  let events = 0
  const hash = createHash('sha256')
  for (const item of items) {
    if (item.formatStatus === 'migration-required') throw fault('UNSUPPORTED_SESSION_FORMAT', 'A Session needs a supported DSH format before backup or recovery.')
    const handle = await persistence.open(item.header.id, 'read')
    try {
      const stored = (await handle.read()).events
      hash.update(`${JSON.stringify([handle.header, handle.inheritedEventCount, stored])}\n`)
      events += stored.length
    } finally { await handle.close() }
  }
  return { count: items.length, events, digest: hash.digest('hex') }
}

async function verifySessions(root, tree) {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessions, { root, compression: tree.compression })
    const inventory = await sessionInventory(ctx.get('sessionPersistence'))
    if (inventory.count !== tree.logDirectories) throw invalid()
    return inventory
  } catch (error) {
    if (error.code === 'UNSUPPORTED_SESSION_FORMAT' || error.name === 'SessionFormatUnsupportedError') {
      throw fault('UNSUPPORTED_SESSION_FORMAT', 'A Session format is unsupported by this DSH build.')
    }
    throw fault('BACKUP_SESSIONS_UNREADABLE', 'The public DSH provider could not read the Session snapshot.')
  } finally { await ctx.fiber.dispose() }
}

async function sessionTree(source, destination) {
  const files = []
  const directories = new Set()
  const encodings = new Set()
  let bytes = 0
  const walk = async (path, prefix, output) => {
    const info = await inspectPath(path)
    if (!info?.isDirectory()) throw invalid()
    if (output) await mkdir(output, { mode: 0o700 })
    for (const entry of (await readdir(path)).sort()) {
      const from = join(path, entry)
      const target = output && join(output, entry)
      const name = prefix ? `${prefix}/${entry}` : entry
      const stat = await inspectPath(from)
      if (stat?.isDirectory()) { await walk(from, name, target); continue }
      if (!stat?.isFile() || files.length === maxFiles || (bytes += stat.size) > maxBytes) {
        throw fault('BACKUP_LIMIT', 'The Session directory contains an unreadable entry or exceeds the backup limit.')
      }
      if (target) await copyFile(from, target, constants.COPYFILE_EXCL)
      files.push([name, stat.size, await hashFile(target ?? from)])
      const compressed = entry.endsWith('.zstd')
      if (parseSessionFormatLogFilename(compressed ? entry.slice(0, -5) : entry) !== undefined) {
        directories.add(prefix)
        encodings.add(compressed ? 'zstd' : 'none')
      }
    }
  }
  if (await inspectPath(source)) await walk(source, '', destination)
  else if (destination) await mkdir(destination, { mode: 0o700 })
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (encodings.size > 1) throw invalid()
  return { fileCount: files.length, bytes, digest, logDirectories: directories.size, compression: [...encodings][0] ?? 'zstd' }
}

function publicBackup(manifest) {
  const { id, createdAt, purpose, business, sessions } = manifest
  return { id, createdAt, purpose, business: { schemaVersion: business.schema, recordCount: business.records, sizeBytes: business.bytes },
    sessions: { sessionCount: sessions.count, fileCount: sessions.fileCount, eventCount: sessions.events, totalBytes: sessions.bytes },
    restorable: business.unresolved === 0, blockers: business.blockers }
}

async function readBackup(root, id) {
  if (!backupId.test(id)) throw invalid()
  const folder = join(root, id)
  if (!(await inspectPath(folder))?.isDirectory()) throw invalid()
  const manifest = await readJson(join(folder, 'manifest.json'), 8192)
  if (manifest?.version !== 1 || manifest.id !== id || !Number.isSafeInteger(manifest.createdAt)
    || !manifest.business || !manifest.sessions || !sha256.test(manifest.business.digest) || !sha256.test(manifest.sessions.tree)) throw invalid()
  return { folder, manifest }
}

export async function listProductBackups(backupRoot) {
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const ids = entries.filter(entry => entry.isDirectory() && backupId.test(entry.name)).map(entry => entry.name).sort().reverse().slice(0, 20)
  const found = await Promise.all(ids.map(id => readBackup(backupRoot, id).then(value => publicBackup(value.manifest), () => null)))
  return found.filter(Boolean)
}

/** Call only after the desktop Host has stopped, under its data lock. */
export async function createProductBackup(options) {
  const { home, backupRoot } = roots(options)
  const core = join(home, 'core')
  if (!(await inspectPath(core))?.isDirectory()) throw fault('BACKUP_BUSINESS_UNAVAILABLE', 'The local product business database is unavailable.')
  const id = `${Date.now()}-${randomUUID()}`
  const staging = join(backupRoot, `.${id}.pending`)
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await mkdir(staging, { mode: 0o700 })
  try {
    const businessPath = join(staging, 'business.sqlite')
    await copyBusiness(join(core, 'state.sqlite'), businessPath)
    const business = { ...businessFacts(businessPath), bytes: (await lstat(businessPath)).size, digest: await hashFile(businessPath) }
    if (options.requireRestorable && business.unresolved) {
      throw fault('BACKUP_UNRESOLVED_WORK', 'Some work still needs to finish or be reconciled before installing the update.')
    }
    const sessionPath = join(staging, 'sessions')
    const tree = await sessionTree(join(home, 'sessions'), sessionPath)
    const inventory = await verifySessions(sessionPath, tree)
    if (options.expectedSessions && inventory.digest !== options.expectedSessions.digest) {
      throw fault('BACKUP_SESSION_STORE_MISMATCH', 'The running profile uses a different Session store. Use that store’s backup procedure.')
    }
    const manifest = { version: 1, id, createdAt: Date.now(), purpose: options.purpose ?? 'manual', business,
      sessions: { ...inventory, fileCount: tree.fileCount, bytes: tree.bytes, tree: tree.digest } }
    await writeJsonAtomic(join(staging, 'manifest.json'), manifest)
    await rename(staging, join(backupRoot, id))
    return publicBackup(manifest)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function restorePaths(home, id) {
  if (!restoreId.test(id)) throw invalid()
  const core = join(home, 'core')
  return { journal: join(core, journalName), business: join(core, 'state.sqlite'), sessions: join(home, 'sessions'),
    stagedBusiness: join(core, `.state.sqlite.restore-${id}`), priorBusiness: join(core, `.state.sqlite.previous-${id}`),
    stagedSessions: join(home, `.sessions.restore-${id}`), priorSessions: join(home, `.sessions.previous-${id}`) }
}

async function readRestore(home) {
  await inspectPath(join(home, 'core'))
  const journal = await readJson(join(home, 'core', journalName), 4096)
  if (!journal) return undefined
  if (journal.version !== 1 || !backupId.test(journal.backupId) || typeof journal.hadSessions !== 'boolean'
    || !['prepared', 'installed', 'committed'].includes(journal.state)) throw invalid()
  return { journal, paths: restorePaths(home, journal.id) }
}

function preserveCursors(live, staged) {
  const { db: reader } = openBusiness(live)
  try {
    using output = new DatabaseSync(staged)
    output.exec('BEGIN IMMEDIATE')
    const get = reader.prepare('SELECT instance_id, id, body FROM records WHERE kind=?')
    const remove = output.prepare('DELETE FROM records WHERE kind=?')
    const insert = output.prepare('INSERT INTO records(instance_id, kind, id, body) VALUES (?, ?, ?, ?)')
    for (const kind of monotonicRecords) {
      remove.run(kind)
      for (const row of get.iterate(kind)) insert.run(row.instance_id, kind, row.id, row.body)
    }
    output.exec('COMMIT')
  } finally { reader.close() }
}

async function settleBusinessJournal(path) {
  // A clean shutdown can leave a WAL on disk. SQLite must apply it before the
  // database file is moved, under the same offline maintenance lock.
  {
    using db = new DatabaseSync(path)
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint.busy !== 0 || db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
      throw fault('BACKUP_HOST_NOT_STOPPED', 'SQLite could not checkpoint the product database. Close its other connections before restoring.')
    }
  }
  for (const suffix of sqliteSidecars) if (await inspectPath(`${path}${suffix}`)) {
    throw fault('BACKUP_HOST_NOT_STOPPED', 'SQLite still has a journal. Close its other connections before restoring.')
  }
}

async function cleanCompletedRestore(paths) {
  await inspectPath(paths.priorSessions)
  await rm(paths.priorBusiness, { force: true })
  await rm(paths.priorSessions, { recursive: true, force: true })
  await rm(paths.journal)
}

/** Restore a verified pair while the Host is offline. The journal precedes the first live rename. */
export async function restoreProductBackup(options) {
  const { home, backupRoot } = roots(options)
  if (await readRestore(home)) throw fault('RESTORE_PENDING', 'Finish the previous restore before starting another.')
  const { folder, manifest } = await readBackup(backupRoot, options.backupId)
  const sourceBusiness = join(folder, 'business.sqlite')
  await sqliteFile(sourceBusiness)
  if (await hashFile(sourceBusiness) !== manifest.business.digest) throw invalid()
  const saved = businessFacts(sourceBusiness)
  const journal = { version: 1, id: randomUUID(), backupId: manifest.id, state: 'prepared', hadSessions: false }
  const paths = restorePaths(home, journal.id)
  await sqliteFile(paths.business)
  const live = businessFacts(paths.business)
  if (saved.unresolved || live.unresolved || saved.external !== live.external) throw sideEffectRisk()
  if (saved.authority !== live.authority || saved.identity !== live.identity) {
    throw fault('RESTORE_AUTHORITY_CONFLICT', 'Work, stop or authorization records changed after this backup.')
  }
  const sessions = await inspectPath(paths.sessions)
  if (sessions && !sessions.isDirectory()) throw invalid()
  journal.hadSessions = Boolean(sessions)
  let published = false
  try {
    await copyBusiness(sourceBusiness, paths.stagedBusiness)
    preserveCursors(paths.business, paths.stagedBusiness)
    const tree = await sessionTree(join(folder, 'sessions'), paths.stagedSessions)
    if (tree.digest !== manifest.sessions.tree || (await verifySessions(paths.stagedSessions, tree)).digest !== manifest.sessions.digest) throw invalid()
    if (options.expectedSessions && (await verifySessions(paths.sessions, await sessionTree(paths.sessions))).digest !== options.expectedSessions.digest) {
      throw fault('BACKUP_SESSION_STORE_MISMATCH', 'The running profile uses a different Session store.')
    }
    await settleBusinessJournal(paths.business)
    await writeJsonAtomic(paths.journal, journal)
    published = true
    await rename(paths.business, paths.priorBusiness)
    if (journal.hadSessions) await rename(paths.sessions, paths.priorSessions)
    await rename(paths.stagedBusiness, paths.business)
    await rename(paths.stagedSessions, paths.sessions)
    await writeJsonAtomic(paths.journal, { ...journal, state: 'installed' })
  } catch (error) {
    if (published) await recoverInterruptedProductRestore({ home })
    else {
      await rm(paths.stagedBusiness, { force: true })
      await rm(paths.stagedSessions, { recursive: true, force: true })
    }
    throw error
  }
  return { backupId: manifest.id, status: 'restored' }
}

export async function pendingProductRestore(options) {
  const { home } = roots(options)
  return (await readRestore(home))?.journal.state === 'installed'
}

export async function recoverInterruptedProductRestore(options) {
  const { home } = roots(options)
  const record = await readRestore(home)
  if (!record) return { status: 'none' }
  const { journal, paths } = record
  if (journal.state === 'committed') {
    await cleanCompletedRestore(paths)
    return { status: 'none' }
  }
  if (journal.state === 'installed') {
    if (!options.rollback) return { status: 'installed', backupId: journal.backupId }
    await sqliteFile(paths.business)
    await sqliteFile(paths.priorBusiness)
    const current = businessFacts(paths.business), prior = businessFacts(paths.priorBusiness)
    if (current.unresolved || prior.unresolved || current.external !== prior.external) throw sideEffectRisk()
    if (current.authority !== prior.authority || current.identity !== prior.identity) {
      throw fault('RESTORE_AUTHORITY_CONFLICT', 'Work or authorization changed after restoring. The previous files were kept.')
    }
    await settleBusinessJournal(paths.business)
    preserveCursors(paths.business, paths.priorBusiness)
    await writeJsonAtomic(paths.journal, { ...journal, state: 'prepared' })
  }
  if (await inspectPath(paths.priorBusiness)) {
    await rm(paths.business, { force: true })
    await rename(paths.priorBusiness, paths.business)
  }
  if (await inspectPath(paths.priorSessions)) {
    await rm(paths.sessions, { recursive: true, force: true })
    await rename(paths.priorSessions, paths.sessions)
  } else if (!journal.hadSessions && !await inspectPath(paths.stagedSessions)) {
    await rm(paths.sessions, { recursive: true, force: true })
  }
  await rm(paths.stagedBusiness, { force: true })
  await rm(paths.stagedSessions, { recursive: true, force: true })
  await rm(paths.journal)
  return { status: 'rolled-back', backupId: journal.backupId }
}

export async function completeProductRestore(options) {
  const { home } = roots(options)
  const record = await readRestore(home)
  if (record?.journal.state !== 'installed') return false
  const { journal, paths } = record
  await writeJsonAtomic(paths.journal, { ...journal, state: 'committed' })
  await cleanCompletedRestore(paths)
  return true
}

export async function backupBeforeProfileChange({ home, backupRoot, version, assertProfile }) {
  const { home: local } = roots({ home, backupRoot })
  const core = join(local, 'core')
  await inspectPath(core)
  const previous = await readJson(join(core, 'profile-version.json'), 4096)
  if (previous?.version === version || !await inspectPath(join(core, 'state.sqlite'))) return undefined
  await assertProfile?.()
  return createProductBackup({ home, backupRoot, purpose: 'upgrade', requireRestorable: true })
}

export function recordProfileVersion(home, version) {
  return writeJsonAtomic(join(home, 'core', 'profile-version.json'), { version })
}
