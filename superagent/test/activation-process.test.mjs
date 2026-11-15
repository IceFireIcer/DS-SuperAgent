import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Activation } from '../dist/index.js'
import { prepareLegacyArchive, publishLegacyArchive, verifyLegacyArchive } from '../dist/legacy-archive.js'
import { SqliteStorage } from '../dist/storage.js'

const receiverFixture = fileURLToPath(new URL('./fixtures/legacy-receiver.mjs', import.meta.url))
const entryFixture = fileURLToPath(new URL('./fixtures/legacy-entry.mjs', import.meta.url))
const activationFixture = fileURLToPath(new URL('./fixtures/activation-crash.mjs', import.meta.url))

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port }, () => { server.off('error', reject); resolve() })
})
const closeServer = server => new Promise(resolve => server.close(() => resolve()))
const freePort = async () => {
  const server = createServer()
  await listen(server, 0)
  const port = server.address().port
  await closeServer(server)
  return port
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const isRunning = child => Boolean(child) && child.exitCode === null && child.signalCode === null
const isPidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForExit(child, timeoutMs = 5000) {
  if (!isRunning(child)) return true
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(timeoutMs),
  ])
  return !isRunning(child)
}

function killPidTree(pid) {
  if (!isPidAlive(pid)) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    if (!result.error && result.status === 0) return
  } else {
    try { process.kill(-pid, 'SIGKILL'); return } catch { /* Fall back to the individual process. */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* The process already exited. */ }
}

function stopLegacy(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('legacy admin stop timed out')) })
    socket.on('error', reject)
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ command: 'stop' })}\n`))
  })
}

test('a real activation process exits after commit and external acceptance, leaving one current manifest and no replay', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-superagent-activation-process-'))
  let old
  let child
  let oldLines
  let storage
  let adminPort
  let receiverPid
  t.after(async () => {
    const errors = []
    if (old && isRunning(old) && adminPort && isPidAlive(receiverPid)) {
      try {
        const stopped = await stopLegacy(adminPort)
        if (!stopped?.stopped) throw new Error(stopped?.code ?? 'the old receiver did not stop')
      } catch (error) {
        if (isPidAlive(receiverPid)) errors.push(error)
      }
    }
    for (const processTree of [old, child]) {
      if (!processTree || !isRunning(processTree)) continue
      if (!await waitForExit(processTree, 5000)) {
        killPidTree(processTree.pid)
        try { processTree.kill('SIGKILL') } catch { /* The process already exited. */ }
        if (!await waitForExit(processTree, 2000)) errors.push(new Error(`process ${processTree.pid} did not exit`))
      }
    }
    if (isPidAlive(receiverPid)) {
      try { process.kill(receiverPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
    }
    oldLines?.close()
    try { await storage?.close() } catch (error) { errors.push(error) }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, 'activation process cleanup failed')
  })
  const source = join(root, 'legacy')
  const target = join(root, 'archive')
  mkdirSync(join(source, 'bot'), { recursive: true })
  writeFileSync(join(source, 'bot', 'state.json'), JSON.stringify({ version: 1, revision: 7, mainBotIds: [], bots: {}, rooms: {}, works: { old: { state: 'running' } }, requests: {}, questions: {}, agents: {} }))
  writeFileSync(join(source, 'bot', 'state.lock'), '{}')
  await prepareLegacyArchive({ source, target, batchId: 'batch-1', mapping: { roles: [], sharedMemory: [] } })
  await verifyLegacyArchive(target, 'batch-1')
  await publishLegacyArchive(target, 'batch-1')

  const intakePort = await freePort()
  adminPort = await freePort()
  const legacyEntry = join(root, 'legacy-entry.mjs')
  const statusFile = join(root, 'old-status.json')
  const receiptsFile = join(root, 'old-receipts.json')
  const marker = join(root, 'released.jsonl')
  const databasePath = join(root, 'core.sqlite')
  writeFileSync(legacyEntry, readFileSync(entryFixture, 'utf8'))
  const oldConfig = { home: source, intake: { host: '127.0.0.1', port: intakePort }, admin: { host: '127.0.0.1', port: adminPort },
    statusFile, receiptsFile, activeTurns: ['turn-1'], activeJobs: [], pendingOutbound: ['out-1'], receiver: receiverFixture }
  old = spawn(process.execPath, [legacyEntry, JSON.stringify(oldConfig)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const oldExited = new Promise(resolve => old.once('exit', (code, signal) => resolve({ code, signal })))
  oldLines = createInterface({ input: old.stdout })
  const oldErrors = []
  old.stderr.setEncoding('utf8')
  old.stderr.on('data', chunk => oldErrors.push(chunk))
  const oldReady = new Promise((resolve, reject) => {
    oldLines.once('line', line => resolve(JSON.parse(line)))
    old.once('exit', code => reject(new Error(`old receiver exited before ready (${code}): ${oldErrors.join('')}`)))
  })
  const oldReport = await oldReady
  assert.equal(oldReport.ready, true)
  receiverPid = oldReport.pid

  child = spawn(process.execPath, [activationFixture, JSON.stringify({ databasePath, batchId: 'batch-1', commandId: 'activate-crash',
    archiveTarget: target, oldHome: source, entry: { host: '127.0.0.1', port: intakePort }, admin: { host: '127.0.0.1', port: adminPort },
    statusFile, legacyEntry, marker })], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const childExitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const childErrors = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => childErrors.push(chunk))
  const childExit = await childExitPromise
  assert.equal(childExit.code, 0, childErrors.join(''))
  const oldExit = await oldExited
  assert.equal(oldExit.code, 0)
  receiverPid = undefined
  const firstMarker = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(firstMarker.length, 1)

  storage = await SqliteStorage.open(databasePath)
  const activation = new Activation(storage, 'private', {})
  const observed = await activation.status()
  assert.equal(observed.state, 'active')
  assert.equal(observed.releases[0].state, 'releasing')
  await assert.rejects(activation.releasePending('batch-1', { release: async () => ({}) }), { code: 'CORE_NOT_ACTIVE' })
  const finalMarker = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(finalMarker.length, 1)
  assert.equal(JSON.parse(finalMarker[0]).ticketId, 'crash-child-ticket')
})
