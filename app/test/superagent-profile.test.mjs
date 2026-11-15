import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const probeTimeoutMs = 55_000
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function terminate(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* The process group already exited. */ }
  }
  try { child.kill('SIGKILL') } catch { /* The process already exited. */ }
}

async function waitForClose(closed, timeoutMs = 5000) {
  return Promise.race([
    closed.then(() => true, () => true),
    sleep(timeoutMs).then(() => false),
  ])
}

test('the real ds-superagent profile boots Main and verifies delegated local work', { timeout: 60000 }, async t => {
  const child = spawn(process.execPath, ['scripts/check-superagent-profile.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let timedOut = false
  const onAbort = () => {
    timedOut = true
    terminate(child)
  }
  const timer = setTimeout(onAbort, probeTimeoutMs)
  t.signal?.addEventListener('abort', onAbort, { once: true })
  t.after(async () => {
    clearTimeout(timer)
    t.signal?.removeEventListener('abort', onAbort)
    terminate(child)
    if (!await waitForClose(closed)) throw new Error(`profile probe process ${child.pid} did not close after termination`)
  })
  let result
  try {
    result = await closed
  } finally {
    clearTimeout(timer)
    t.signal?.removeEventListener('abort', onAbort)
  }
  if (timedOut) throw new Error(`the profile probe did not finish within ${probeTimeoutMs} ms and was terminated`)
  assert.equal(result.code, 0, stderr)
  const report = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
  assert.equal(report.profile, 'ds-superagent')
  assert.equal(report.messages, 4)
  assert.equal(report.localWorkStatus, 'success')
  assert.equal(report.localWorkItems, 2)
  assert.equal(report.nativeSessionAccessDenied, true)
  for (const service of ['superagentProduct', 'webServer', 'connection', 'sessionPersistence']) {
    assert.ok(report.services.includes(service), `${service} is mounted`)
  }
})
