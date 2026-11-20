// Check a packaged app: process an image with its sharp, then start Main on throwaway folders with the mock model,
// send a message, wait for the reply, then close the window the way a user does: the window hides
// and the app goes on. The window comes back when the app is started again, and the app ends the
// way the tray's Quit ends it. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable] [screenshot.png | --controls | --upgrade-to next executable | --upgrade-with NSIS installer]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { hostExecutable } from '../src/host-process.mjs'
import { PRODUCT_NAME, PRODUCT_SLUG } from '../src/product.mjs'
import { isNewer } from '../src/updates.mjs'
import { t55Question, t55Request, t55SlowReply } from '../../superagent/dsh/dev/t55-controls-model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, option, nextExecutable] = process.argv.slice(2)
const installUpgrade = option === '--upgrade-with'
const upgrade = option === '--upgrade-to' || installUpgrade
const controls = option === '--controls'
const shotFile = upgrade || controls ? undefined : option
const executable = given || packedExecutable()

if (upgrade && (!nextExecutable || !existsSync(nextExecutable))) {
  console.error('check-packed: the next build is missing')
  process.exit(2)
}
if (installUpgrade) {
  const installed = realpathSync.native(dirname(resolve(executable)))
  const root = dirname(installed)
  if (process.platform !== 'win32' || basename(installed) !== 'program' || !basename(root).startsWith('ds-superagent-t55-install-')
    || dirname(root) !== realpathSync.native(tmpdir())) {
    throw new Error('Run --upgrade-with only on the temporary Windows installation prepared for T55.')
  }
}

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', `${PRODUCT_NAME}.exe`)
  // executableName in electron-builder.yml.
  if (process.platform === 'linux') return join(out, 'linux-unpacked', PRODUCT_SLUG)
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, `${PRODUCT_NAME}.app`, 'Contents', 'MacOS', PRODUCT_NAME)
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

// The Office payload sits next to the asar as extraResources, and the LibreOffice Kit CLI is a
// plain file in the unpacked tree; without them the app's Office skills and tools cannot run.
{
  const resources = process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
  const windows = process.platform === 'win32'
  const unpacked = process.platform === 'linux' ? 'app' : 'app.asar.unpacked'
  const required = [
    'primary-runtime/runtime.json',
    join('primary-runtime', 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    join('primary-runtime', 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node'),
    join('office-skills', 'office', 'SKILL.md'),
    join(unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'),
    join(unpacked, 'node_modules', 'ds-superagent', 'dsh', 'office.js'),
  ]
  const missing = required.filter((entry) => !existsSync(join(resources, entry)))
  if (missing.length > 0) {
    console.error(`check-packed: FAILED: missing from ${resources}:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-superagent-packed-')))
mkdirSync(join(work, 'home'))
mkdirSync(join(work, 'shell'))
// CDP cannot answer the native first-close dialog. The notice has its own tests; this check
// exercises hiding and reopening a window after the user has acknowledged it.
writeFileSync(join(work, 'shell', 'tray-close-acknowledged'), '')
const children = []

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    // On Windows a plain kill ends only the main process; /T takes the Host and Electron's helpers along.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
  }
}

// An app that hangs, for example behind its error box, must not hold up CI.
setTimeout(() => {
  console.error('check-packed: FAILED: gave up after 8 minutes')
  stopChildren()
  process.exit(1)
}, 8 * 60_000).unref()

// Run from inside this checkout, the app would find a module that the build left out in the
// checkout's own node_modules, so the check runs a copy of the app from the throwaway folder.
function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = mkdtempSync(join(work, 'program-'))
  const installed = join(copy, basename(appDir))
  cpSync(appDir, installed, { recursive: true, verbatimSymlinks: true })
  console.log('check-packed: copied the package outside the checkout')
  return join(installed, relative(appDir, file))
}

function checkSharp(app) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const linux = process.platform === 'linux'
  const script = `
    const assert = require('node:assert/strict')
    const { createRequire } = require('node:module')
    ${linux ? "assert.equal(process.versions.electron, undefined, 'Linux image processing must not run in Electron')" : ''}
    const appRequire = createRequire(${JSON.stringify(join(resources, linux ? 'app' : 'app.asar', 'package.json'))})
    const sharp = appRequire('sharp')
    ;(async () => {
      const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
      const { data, info } = await sharp(image).resize(2, 2).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 2)
      assert.equal(info.height, 2)
      assert.deepEqual([...data], Array.from({ length: 4 }, () => [255, 0, 0]).flat())
      console.log('check-packed: sharp image processing passed (libvips ' + sharp.versions.vips + ')')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  // Use the Host's runtime and dependencies outside the checkout, not the CI runner's Node.
  const result = spawnSync(linux ? hostExecutable(resources) : app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8', timeout: 30_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged sharp failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}`)
  console.log(result.stdout.trim())
}

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'superagent', 'dsh', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log'), MOCK_T55_CONTROLS: controls ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', (code) => { reject(new Error(`check-packed: the mock model stopped (exit ${String(code)})`)) })
  })
}

// Let the OS avoid occupied and reserved ports instead of guessing a fixed range.
async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()) })
  return port
}

async function appPage(port, deadline, main = false) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => main ? target.type === 'node' : target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

// The Host goes on while the window is hidden: its port answers.
async function hostAlive() {
  const { port } = JSON.parse(readFileSync(join(work, 'shell', 'host-port.json'), 'utf8'))
  await new Promise((done, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); done() })
    socket.once('error', reject)
  })
}

// The tray's Quit ends the app. The check cannot click the tray icon, so it asks the browser
// target of the debugging port to close, which ends the app gracefully.
async function browserClose(port) {
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  socket.close()
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map(arg => arg.value ?? arg.description).join(' ')
      if (!text.includes('active Service "sessionController" is unavailable')) problems.push(`console.error: ${text}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry
      if (!(entry.url?.includes('/api/session/') && entry.text.includes('403'))) problems.push(`log: ${entry.text} ${entry.url ?? ''}`)
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, 30_000)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

// mica.css styles DSH's own page, which can change with a DSH upgrade; every rule must still
// find an element, on every platform, so the change shows here and not as a broken window.
function micaRules() {
  const css = readFileSync(join(root, 'src', 'mica.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  return [...css.matchAll(/([^{}]+)\{/gu)].map(([, selectors]) => selectors.split(',')
    .map(selector => selector.trim().replace(/::(?:before|after)$/u, ''))
    .filter(selector => selector !== '' && selector !== 'body'))
    .filter(rule => rule.length > 0)
}

async function chat(cdp) {
  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  // DSH shows a preview notice once per profile; it would keep the focus away from the composer.
  const dismissNotice = () => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  const text = needle => `document.body.innerText.includes(${JSON.stringify(needle)})`
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await until("document.querySelector('#main-message')", 'the Main conversation')
  const stale = await evaluate(`${JSON.stringify(micaRules())}.filter(rule => !rule.some(selector => document.querySelector(selector) !== null)).map(rule => rule.join(', '))`)
  if (stale.length > 0) throw new Error(`src/mica.css no longer matches DSH's page: ${stale.join(' | ')}`)
  await dismissNotice()
  // Click the composer through the input pipeline. A bare focus() is not enough where no window
  // manager gives the window focus (xvfb in CI): the text and the Enter would go nowhere.
  const box = "document.querySelector('#main-message')"
  const focusCheck = "document.activeElement?.id === 'main-message'"
  // Notices and renders can cover the field between round trips; click only where it is on top.
  const probe = `(() => {
    const el = ${box}
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    for (const part of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { x: rect.x + rect.width * part, y: rect.y + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      if (hit === el || (hit !== null && el.contains(hit))) return { x: point.x, y: point.y }
    }
    return null
  })()`
  let shot = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
    // The preview notice can mount after Main is ready, so dismiss it when it appears.
    await dismissNotice()
    const point = await evaluate(probe)
    if (point !== null && point !== undefined) {
      shot = point
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(300)
    } else await sleep(250)
  }
  if (!(await evaluate(`Boolean(${focusCheck})`))) {
    // Say what was under the cursor, what held the focus and how large the window was.
    const state = await evaluate(`(() => {
      const el = ${box}
      const rect = el === null ? null : el.getBoundingClientRect().toJSON()
      const point = rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      const hit = point === null ? null : document.elementFromPoint(point.x, point.y)
      const cover = hit?.closest?.('[role=dialog],[aria-modal=true],[data-slot]')
      const brief = node => (node === null || node === undefined ? null : { tag: node.tagName ?? null, class: String(node.getAttribute?.('class') ?? '').slice(0, 160) })
      return JSON.stringify({
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio, focused: document.hasFocus(),
        click: ${JSON.stringify(shot)}, probe: point, box: rect,
        hit: brief(hit),
        cover: cover === null || cover === undefined ? null : { tag: cover.tagName, slot: cover.getAttribute('data-slot'), role: cover.getAttribute('role'), modal: cover.getAttribute('aria-modal') },
        active: brief(document.activeElement),
      })
    })()`)
    throw new Error(`timed out waiting for the focused composer; page state: ${state}`)
  }
  await cdp.call('Input.insertText', { text: 'packaged app check' })
  await until("document.querySelector('#main-message')?.value === 'packaged app check'", 'the typed message', 10_000)
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  // The mock model starts its reply with 收到： and the message.
  try {
    await until(text('收到：packaged app check'), 'the reply')
  } catch (error) {
    const state = await evaluate("JSON.stringify({ active: document.activeElement?.tagName ?? null, editable: document.activeElement?.isContentEditable ?? null, tail: document.body.innerText.slice(-300) })")
    throw new Error(`${error.message}; page state: ${state}`)
  }
  await sleep(1000)
  console.log(`check-packed: chat ${JSON.stringify(await evaluate('document.body.innerText.slice(-200)'))}`)
}

async function productFacts(cdp, prepare = false) {
  const result = await cdp.call('Runtime.evaluate', { expression: `(async () => {
    const call = async (endpoint, payload = {}) => {
      const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }) });
      const result = await response.json();
      if (!result.ok) throw new Error('Product request failed: ' + endpoint + ' (' + response.status + ')');
      return result.value;
    };
    const binding = await call('open');
    const { instanceId } = binding;
    if (${prepare}) await call('schedule-source-set', { instanceId, commandId: 't55-disable-schedule', enabled: false });
    const [history, source, usage, diagnostics, backups] = await Promise.all([
      call('history', { instanceId }), call('schedule-source-read', { instanceId }), call('product-usage', { instanceId }),
      window.dsSuperagentApp.diagnostics(), window.dsSuperagentApp.backups.list(),
    ]);
    return { binding, messages: history.messages.map(message => ({ id: message.id, role: message.role })), enabled: source.enabled,
      mainTokens: usage.roles.main.totalTokens, version: diagnostics.appVersion,
      upgradeBackups: backups.filter(backup => backup.purpose === 'upgrade'), events: diagnostics.events.map(event => event.code) };
  })()`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function checkWorkControls(cdp) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (check, label) => {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      const result = await check()
      if (result) return result
      await sleep(150)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const read = () => evaluate(`(async () => {
    const call = async (endpoint, payload = {}) => (await (await fetch('/api/product', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload })
    })).json()).value;
    const { instanceId } = await call('open');
    return call('history', { instanceId });
  })()`)
  const card = (history, name) => history.works.find(work => work.brief.goal === `T55 ${name} note`)
  const click = (selector, label) => evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => !item.disabled && ${label}.test(item.textContent.trim()));
    button?.click();
    return Boolean(button);
  })()`)
  const send = async text => {
    await evaluate("document.querySelector('#main-message').focus()")
    await cdp.call('Input.insertText', { text })
    await wait(() => evaluate(`document.querySelector('#main-message').value === ${JSON.stringify(text)}`), 'the typed Main request')
    await wait(() => click('button[type=submit]', '/^(Send|发送)$/u'), 'the Main Send button')
  }

  await send(t55Request)
  const working = await wait(async () => {
    const history = await read()
    const alpha = card(history, 'alpha'), beta = card(history, 'beta')
    return alpha?.control?.attention?.question === t55Question && beta?.control?.assignment?.state === 'running' && history
  }, 'one question while the other work executes')
  const firstAlpha = card(working, 'alpha').control.assignment
  const firstBeta = card(working, 'beta').control.assignment
  await wait(() => click('.bt-main-work-options button', '/^Yes$/u'), 'the approved answer choice')
  await wait(() => click('.bt-main-work-answer button[type=submit]', '/^(Send answer|提交回答)$/u'), 'the question send button')
  const answered = await wait(async () => {
    const alpha = card(await read(), 'alpha')
    return alpha?.status === 'success' && alpha
  }, 'the answered work result')
  assert.equal(answered.control.attention.sessionId, firstAlpha.sessionId)
  await send(t55SlowReply)
  await wait(() => click('button', '/^(Stop reply|停止本轮回复)$/u'), 'the Main stop control')
  const stoppedReply = await wait(async () => {
    const history = await read()
    return history.messages.some(message => message.text === t55SlowReply && message.status === 'stopped') && history
  }, 'only the Main turn to stop')
  assert.equal(card(stoppedReply, 'beta').control.assignment.generation, firstBeta.generation)
  assert.equal(card(stoppedReply, 'beta').control.stop, undefined)
  const betaId = card(stoppedReply, 'beta').control.ticketId
  const betaButtons = `.bt-main-work[data-ticket-id="${betaId}"] .bt-main-work-controls button`
  await wait(() => click(betaButtons, '/^(Stop work|停止工作)$/u'), 'the beta work stop control')
  await wait(async () => {
    const beta = card(await read(), 'beta')
    return beta?.control?.stop?.state === 'stopped' && beta.control.stop.cancellationConfirmedAt !== undefined
  }, 'the original beta range to stop')
  await wait(() => click(betaButtons, '/^(Resume work|恢复工作)$/u'), 'the beta resume control')
  const resumed = await wait(async () => {
    const beta = card(await read(), 'beta')
    return beta?.status === 'success' && beta
  }, 'the resumed beta work result')
  assert.equal(resumed.control.ticketId, betaId)
  assert.notEqual(resumed.control.assignment.generation, firstBeta.generation)
  assert.equal(resumed.control.assignment.sessionId, firstBeta.sessionId)
  console.log(`check-packed: ${JSON.stringify({ controls: 'passed', alphaTicketId: answered.control.ticketId, betaTicketId: betaId,
    alphaSessionId: firstAlpha.sessionId, betaSessionId: firstBeta.sessionId })}`)
}

async function checkOperations(cdp, facts) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const ready = await evaluate(`(() => {
      const page = document.querySelector('.bt-product-operations');
      if (!page) {
        const button = [...document.querySelectorAll('button')].find(item => /^(Status and usage|状态与用量)$/u.test(item.textContent.trim()));
        if (button) button.click();
        else if (!document.querySelector('.bt-settings-close')) document.querySelector('.bt-main-settings')?.click();
        return false;
      }
      const text = page.textContent;
      return text.includes(${JSON.stringify(facts.version)}) && text.includes('HOST_READY')
        && /Token usage by role|各角色 Token 用量/u.test(text)
        && /Download diagnostic summary|下载诊断摘要/u.test(text);
    })()`)
    if (ready) {
      console.log('check-packed: Windows Status and usage loaded tokens and diagnostics')
      return
    }
    await sleep(150)
  }
  throw new Error('Settings did not show product usage and diagnostic history.')
}

async function checkColdUpgrade(before, env) {
  let packedApp
  if (installUpgrade) {
    packedApp = resolve(executable)
    const setup = spawnSync(resolve(nextExecutable), ['/S', '--updated', '/no-desktop-shortcut', `/D=${dirname(packedApp)}`], {
      env, windowsHide: true, windowsVerbatimArguments: true, timeout: 300_000,
    })
    assert.ifError(setup.error)
    assert.equal(setup.status, 0, 'the native installer must finish replacing the program')
    console.log('check-packed: native installer completed')
  } else packedApp = outsideCheckout(resolve(nextExecutable))
  const port = await freePort()
  const app = spawn(packedApp, [`--remote-debugging-port=${port}`], { env, stdio: 'inherit' })
  children.push(app)
  const exited = new Promise(done => app.once('exit', done))
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, [])
  await cdp.opened
  try {
    const after = await productFacts(cdp)
    assert.ok(isNewer(after.version, before.version), 'the next packaged version must be newer')
    assert.deepEqual(after.binding, before.binding)
    assert.deepEqual(after.messages, before.messages)
    assert.equal(after.enabled, false)
    assert.equal(after.mainTokens, before.mainTokens)
    assert.ok(after.events.includes('UPGRADE_BACKUP_CREATED'))
    assert.ok(after.upgradeBackups.some(backup => backup.restorable && backup.business.recordCount > 0 && backup.sessions.sessionCount > 0))
    await checkOperations(cdp, after)
    console.log(`check-packed: ${JSON.stringify({ coldUpgrade: [before.version, after.version],
      mainId: after.binding.mainId, messages: after.messages.length, mainTokens: after.mainTokens, scheduleEnabled: after.enabled,
      businessRecords: after.upgradeBackups[0].business.recordCount, sessions: after.upgradeBackups[0].sessions.sessionCount })}`)
  } finally { cdp.close() }
  await browserClose(port)
  assert.equal(await Promise.race([exited, sleep(40_000).then(() => null)]), 0, 'the upgraded app must shut down normally')
}

let failed = false
const problems = []
try {
  const packedApp = outsideCheckout(resolve(executable))
  checkSharp(packedApp)
  const modelUrl = await startMock()
  const profileDir = join(work, 'home', 'superagent', 'profiles', 'ds-superagent')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: superagent',
    '  config:',
    '    main: { provider: deepseek-official, model: deepseek-flash }',
    '    router: { provider: deepseek-official, model: deepseek-flash }',
    '    worker: { provider: deepseek-official, model: deepseek-flash }',
    '',
  ].join('\n'))
  const port = await freePort()
  const mainPort = await freePort()
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    DS_SUPERAGENT_HOME: join(work, 'home'), DS_SUPERAGENT_SHELL_DATA: join(work, 'shell'),
    DS_SUPERAGENT_WORKSPACE: join(work, 'workspace'),
    DSH_HOME: join(work, 'personal-dsh'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(packedApp, [`--remote-debugging-port=${String(port)}`, `--inspect=127.0.0.1:${String(mainPort)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const main = devtools((await appPage(mainPort, Date.now() + 30_000, true)).webSocketDebuggerUrl, problems)
  await main.opened
  const windowState = async expression => {
    const answer = await main.call('Runtime.evaluate', {
      expression: `(() => { const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const win = BrowserWindow.getAllWindows()[0]; return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  if (await windowState('win.getTitle()') !== PRODUCT_NAME) throw new Error('the window has the wrong product name')
  if (!existsSync(join(work, 'home', 'superagent', 'core', 'state.sqlite'))) throw new Error('the product database did not open')
  if (existsSync(join(work, 'personal-dsh'))) throw new Error('the app wrote outside its own DSH home')
  const chatError = await chat(cdp).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  if (chatError) throw chatError
  if (controls) await checkWorkControls(cdp)
  const before = upgrade ? await productFacts(cdp, true) : undefined
  if (before) {
    assert.ok(before.mainTokens > 0 && before.messages.length >= 2)
    assert.equal(before.enabled, false)
  }
  // Close the native window: a renderer-initiated close can stop page CDP evaluations even
  // when Electron prevents the close. Read visibility from the main process as well.
  await windowState('win.close()')
  await sleep(4000)
  if (app.exitCode !== null) throw new Error('the app ended with its window')
  if (await windowState('win !== undefined && !win.isDestroyed() && !win.isVisible()') !== true) throw new Error('the window is not hidden')
  await hostAlive()
  console.log('check-packed: the window is hidden and the Host goes on')
  // Starting the app again brings the window back; the second copy ends at once, because the
  // first one holds the lock.
  const second = spawn(packedApp, [`--remote-debugging-port=${String(await freePort())}`], { stdio: 'ignore', env })
  children.push(second)
  const secondExit = await Promise.race([new Promise((done) => { second.once('exit', (code) => { done(code) }) }), sleep(30_000).then(() => undefined)])
  if (secondExit === undefined) throw new Error('the second copy of the app did not end')
  if (app.exitCode !== null) throw new Error('the app ended when it was started again')
  if (await windowState('win !== undefined && !win.isDestroyed() && win.isVisible()') !== true) throw new Error('the window did not come back')
  if (before) {
    const reopened = await productFacts(cdp)
    assert.deepEqual(reopened.binding, before.binding)
    assert.deepEqual(reopened.messages, before.messages)
  }
  console.log('check-packed: the window came back when the app was started again')
  // The tray's Quit is the way out; the check cannot click the tray, so it asks the browser
  // target to close, which ends the app gracefully.
  // Stopping the Host closes its event stream; that expected shutdown is not a page failure.
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  cdp.close()
  main.close()
  await browserClose(port)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (outcome === undefined) throw new Error('the app did not exit after the quit')
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  if (before) await checkColdUpgrade(before, env)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
}
stopChildren()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
