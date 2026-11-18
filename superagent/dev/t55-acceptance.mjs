import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url))
const outputRoot = join(repository, '.dsh-test-t55')
const output = join(outputRoot, `run-${randomUUID()}`)
const testEnvironment = /^(APPDATA|CommonProgramFiles(?:\(x86\))?|ComSpec|DISPLAY|HOME|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|LOCALAPPDATA|NUMBER_OF_PROCESSORS|OS|PATH|PATHEXT|ProgramData|ProgramFiles(?:\(x86\))?|SystemDrive|SystemRoot|USER|USERNAME|USERPROFILE|WINDIR|XAUTHORITY|XDG_DISPLAY)$/iu
let activeChild
let interrupted
let report
const stops = []
const onInterrupt = () => { interrupted = 'SIGINT'; if (activeChild) stopTree(activeChild) }
const onTerminate = () => { interrupted = 'SIGTERM'; if (activeChild) stopTree(activeChild) }

const phases = [
  { id: 'packaged-desktop', script: 'app/scripts/check-packed.mjs', timeoutMs: 540_000,
    scope: 'Packaged Main conversation, close and reopen on the same Host, and a cold upgrade when the next build is supplied.' },
  { id: 'continuous', files: ['main-delegation', 'main-parallel-delegation', 'main-followup', 'main-github-intake', 'work-observations'],
    scope: 'Main delegation, concurrent work, targeted direction, delivery, GitHub fixture and read-only observations.' },
  { id: 'local-control', files: ['main-controls', 'product-views', 'product-shell-stop', 'concurrency'],
    scope: 'Questions, answer authorization, Main and work stop, explicit resume, local jobs and slot budgets.' },
  { id: 'proactive-supervision', files: ['product-github-proactive', 'product-watchdog', 'watchdog-process'],
    scope: 'Proactive preparation with synthetic GitHub events, semantic proposals, budget and local Watchdog process recovery.' },
  { id: 'host-client-recovery', files: ['main-continuity', 'host-takeover', 'product-client-gateway', 'effects'],
    scope: 'Durable Main queue, Host epochs, waiting and stopped work, client catch-up and revocation, external effect reconciliation.' },
  { id: 'profile-recovery', script: 'app/scripts/check-superagent-profile.mjs', args: ['--check-upgrade'],
    scope: 'Public DSH product profile, local work and independent SQLite and Session backup/restore.' },
  { id: 'operations', package: 'app', files: ['product-backups', 'main-update', 'main-restore', 'operations-log'],
    scope: 'Update and restore failure paths through the desktop test doubles and real isolated backup stores.' },
]
const unaccepted = [
  'Current real model judgment and an authorized live GitHub product scenario',
  'Native installer replacement and upgrade on a populated isolated Windows profile',
]
const plan = { version: 2, model: 'mock', phaseTimeoutMs: 300_000, testFileConcurrency: 1, phases, unaccepted,
  deferred: ['Real Feishu tenant'], outOfScope: ['Hosted server and cross-machine PostgreSQL/TLS/SSH', 'Physical second device and cross-machine handoff'] }
const args = process.argv.slice(2)
const appArguments = (args.length === 4 || args.length === 6 && args[4] === '--upgrade-to') && args[0] === '--app' && args[2] === '--installer'
if (args.length && !(args.length === 1 && args[0] === '--plan') && !appArguments) {
  throw new Error('Usage: node dev/t55-acceptance.mjs --app <Windows packaged executable> --installer <NSIS executable> [--upgrade-to <next executable>] | --plan')
}
if (args[0] === '--plan') {
  console.log(JSON.stringify(plan, null, 2))
} else {
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try { await main() } catch (error) {
    report ??= { version: plan.version, acceptanceStatus: 'not-accepted' }
    report.automatedStatus = interrupted ? 'aborted' : 'failed'
    report.error = { name: error.name, code: error.code ?? 'ACCEPTANCE_FAILED' }
    report.finishedAt = new Date().toISOString()
    await save()
    console.error(`Acceptance attempt ${report.automatedStatus}: ${report.error.code}.`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}

async function main() {
  await mkdir(output, { recursive: true })
  report = { ...plan, startedAt: new Date().toISOString(), attempt: output.slice(outputRoot.length + 1),
    automatedStatus: 'preflight', acceptanceStatus: 'not-accepted', results: [] }
  await save()
  const evidence = []
  for (let number = 1; number <= 36; number++) {
    const ticket = `r5-${String(number).padStart(2, '0')}`
    evidence.push(await fingerprint(`docs/superagent/implementation/${ticket}.md`))
  }
  if (!appArguments) {
    throw Object.assign(new Error('The Windows executable and installer are needed for this acceptance run.'), { code: 'WINDOWS_ARTIFACTS_REQUIRED' })
  }
  if (process.versions.node.split('.')[0] !== '24') throw Object.assign(new Error('Run this check with Node 24.'), { code: 'NODE_VERSION' })
  const app = resolve(args[1])
  const installer = resolve(args[3])
  const next = args[5] ? resolve(args[5]) : undefined
  const packagedArgs = next ? [app, '--upgrade-to', next] : [app]
  const inputs = await Promise.all([
    'docs/superagent/issues/T55.md', 'docs/superagent/issues/T58.md', 'superagent/dsh/dev/mock-llm.mjs',
    ...phases.flatMap(phase => phase.script ? [phase.script]
      : phase.files.map(name => `${phase.package ?? 'superagent'}/test/${name}.test.mjs`)),
  ].map(fingerprint))
  const packages = await Promise.all([app, ...(next ? [next] : [])].map(async file => ({ name: basename(file),
    sha256: await digest(file), asarSha256: await digest(join(dirname(file), 'resources', 'app.asar')) })))
  const changes = execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'app', 'superagent'], { cwd: repository, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  Object.assign(report, {
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim(),
    sourceDiffSha256: createHash('sha256').update(changes).digest('hex'),
    environment: { platform: process.platform, release: release(), arch: process.arch, node: process.version, model: 'mock' },
    evidenceIndex: { path: 'docs/superagent/implementation/README.md', sha256: await digest(join(repository, 'docs/superagent/implementation/README.md')) },
    runnerSha256: await digest(fileURLToPath(import.meta.url)),
    evidence, inputs, packages, installer: { name: basename(installer), sha256: await digest(installer) }, automatedStatus: 'running',
  })
  await save()
  const build = await run('build', ['scripts/build.mjs'], { cwd: root })
  report.build = build
  await save()
  for (const phase of build.status === 'passed' ? phases : []) {
    console.log(`Running ${phase.id}: ${phase.scope}`)
    const result = phase.script
      ? await run(phase.id, ['--expose-internals', join(repository, phase.script), ...(phase.id === 'packaged-desktop' ? packagedArgs : phase.args)],
        { cwd: join(repository, 'app'), timeoutMs: phase.timeoutMs })
      : await run(phase.id, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...phase.files.map(name => `test/${name}.test.mjs`)],
        { cwd: join(repository, phase.package ?? 'superagent'), tap: true })
    report.results.push(result)
    await save()
    console.log(`${phase.id}: ${result.status}${result.counts ? ` (${result.counts.pass} pass, ${result.counts.fail} fail, ${result.counts.skipped} skipped)` : ''}`)
  }
  report.automatedStatus = interrupted ? 'aborted' : build.status === 'passed' && report.results.length === phases.length && report.results.every(result => result.status === 'passed') ? 'passed' : 'failed'
  report.finishedAt = new Date().toISOString()
  await save()
  console.log(`Automated rehearsal: ${report.automatedStatus}. Full product acceptance: ${report.acceptanceStatus}.`)
  console.log('Report and local diagnostic logs: .dsh-test-t55/ (logs must not be published).')
  // An incomplete acceptance is a distinct non-success outcome even when every mock check passes.
  process.exitCode = report.automatedStatus === 'passed' ? 2 : 1
}

async function save() {
  const json = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(join(output, 'report.json'), json)
  await writeFile(join(outputRoot, 'report.json'), json)
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function fingerprint(path) {
  return { path, sha256: await digest(join(repository, path)) }
}

async function run(id, args, { cwd, tap = false, timeoutMs = plan.phaseTimeoutMs }) {
  if (interrupted) throw new Error('Acceptance interrupted.')
  const started = performance.now()
  // Windows backup and Electron cache paths can reach MAX_PATH below the report directory.
  const temp = await realpath(tmpdir())
  const scratch = await mkdtemp(join(temp, 't55-'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => testEnvironment.test(name))),
    TEMP: scratch, TMP: scratch, TMPDIR: scratch, DSH_HOME: join(scratch, 'isolated-dsh') }
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  activeChild = child
  const chunks = []
  let size = 0
  let timedOut = false
  let overflow = false
  let startFailed = false
  const capture = data => {
    size += data.length
    if (size <= 8 * 1024 * 1024) chunks.push(data)
    else if (!overflow) { overflow = true; stopTree(child) }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const timer = setTimeout(() => { timedOut = true; stopTree(child) }, timeoutMs)
  const code = await new Promise(resolve => {
    child.once('error', () => { startFailed = true; resolve(null) })
    child.once('close', resolve)
  })
  clearTimeout(timer)
  await Promise.all(stops)
  activeChild = undefined
  const cleaned = dirname(scratch) === temp && basename(scratch).startsWith('t55-')
    && await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).then(() => true, () => false)
  const log = Buffer.concat(chunks).toString('utf8')
  await writeFile(join(output, `${id}.log`), log)
  const counts = !tap ? undefined : Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const match = log.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))
    return [key, match ? Number(match[1]) : null]
  }))
  const verified = !counts || (counts.tests > 0 && counts.pass > 0 && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0)
  return { id, status: code === 0 && !timedOut && !overflow && !startFailed && !interrupted && verified && cleaned ? 'passed' : 'failed', exitCode: code,
    timedOut, overflow, startFailed, cleaned, durationMs: Math.round(performance.now() - started), ...(counts ? { counts } : {}) }
}

function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const stop = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    stops.push(new Promise(resolve => {
      stop.once('error', () => { child.kill(); resolve() })
      stop.once('close', code => { if (code !== 0) child.kill(); resolve() })
    }))
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() }
  }
}
