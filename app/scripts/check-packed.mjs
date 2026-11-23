// Check a packaged app: process an image with its sharp, then start Main on throwaway folders with the mock model,
// send a message, wait for the reply, then close the window the way a user does: the window hides
// and the app goes on. The window comes back when the app is started again, and the app ends the
// way the tray's Quit ends it. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable or AppImage] [screenshot.png | --coexistence | --controls | --classic | --upgrade-to next executable | --upgrade-with NSIS installer | --update-feed folder next-app.asar]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { connect, createServer } from 'node:net'
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { hostExecutable } from '../src/host-process.mjs'
import { PRODUCT_NAME, PRODUCT_SLUG } from '../src/product.mjs'
import { isNewer } from '../src/updates.mjs'
import { t55Question, t55Request, t55SlowReply } from '../../superagent/dsh/dev/t55-controls-model.mjs'
import { checkPackedVisuals } from './check-packed-visuals.mjs'
import { fileUpdateFeed } from './update-fixture-feed.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, option, nextExecutable, nextPayload] = process.argv.slice(2)
const installUpgrade = option === '--upgrade-with'
const updateFeed = option === '--update-feed'
const upgrade = option === '--upgrade-to' || installUpgrade || updateFeed
const controls = option === '--controls'
const classic = option === '--classic'
const coexistence = option === '--coexistence'
const shotFile = upgrade || controls || classic || coexistence ? undefined : option
const executable = given || packedExecutable()
const appImage = process.platform === 'linux' && executable.endsWith('.AppImage')
const mainPrompt = 'packaged app check'
const mainReply = `收到：${mainPrompt}`
const writableMainInput = '.bt-main-composer[data-main-input-ready] #main-message:enabled:not([readonly])'

if (coexistence && process.platform !== 'win32') throw new Error('The coexistence check targets the Windows unpacked app.')
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
if (updateFeed && (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !nextPayload || !existsSync(nextPayload))) {
  throw new Error('Run --update-feed with the installed Windows fixture, update feed and next app.asar on a GitHub Actions runner.')
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
function checkResources(executable) {
  const resources = process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
  const windows = process.platform === 'win32'
  const unpacked = process.platform === 'linux' ? 'app' : 'app.asar.unpacked'
  const cuaPlatform = windows ? `win32-${process.arch}-msvc` : process.platform === 'linux' ? `linux-${process.arch}-gnu` : `darwin-${process.arch}`
  const required = [
    'primary-runtime/runtime.json',
    join('primary-runtime', 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    join('primary-runtime', 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node'),
    join('office-skills', 'office', 'SKILL.md'),
    join(unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'),
    join(unpacked, 'node_modules', 'ds-superagent', 'dsh', 'office.js'),
    join('node_modules', '@trycua', 'cua-driver', 'dist', 'index.js'),
    join('node_modules', '@trycua', `cua-driver-${cuaPlatform}`, 'package.json'),
    join('node_modules', '@ubjs', 'node', 'package.json'),
  ]
  const missing = required.filter((entry) => !existsSync(join(resources, entry)))
  if (missing.length > 0) throw new Error(`missing from ${resources}:\n  ${missing.join('\n  ')}`)
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-superagent-packed-')))
const mockLog = join(work, 'mock.log')
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

function cleanup() {
  stopChildren()
  feed?.close()
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}

function operationCodes() {
  const log = join(work, 'shell', 'logs', 'operations.jsonl')
  let lines
  try { lines = readFileSync(log, 'utf8').split(/\r?\n/u) } catch { return [] }
  return lines.filter(Boolean).slice(-12).flatMap(line => {
    try {
      const { code } = JSON.parse(line)
      return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? [code] : []
    } catch { return [] }
  })
}

// An app that hangs, for example behind its error box, must not hold up CI.
const watchdog = setTimeout(() => {
  console.error('check-packed: FAILED: gave up after 8 minutes')
  try { cleanup() } finally { process.exit(1) }
}, 8 * 60_000).unref()

// Run from inside this checkout, the app would find a module that the build left out in the
// checkout's own node_modules, so the check runs a copy of the app from the throwaway folder.
function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  if (appImage) {
    const installed = join(mkdtempSync(join(work, 'program-')), basename(file))
    cpSync(file, installed)
    return installed
  }
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = mkdtempSync(join(work, 'program-'))
  const installed = join(copy, basename(appDir))
  cpSync(appDir, installed, { recursive: true, verbatimSymlinks: true })
  console.log('check-packed: copied the package outside the checkout')
  return join(installed, relative(appDir, file))
}

function appImageContents(app) {
  const result = spawnSync(app, ['--appimage-extract'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error('The AppImage could not extract its packaged payload.', { cause: result.error })
  return join(work, 'squashfs-root', PRODUCT_SLUG)
}

async function checkSharp(app, launched) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const linux = process.platform === 'linux'
  const script = `
    const assert = require('node:assert/strict')
    const { createHash } = require('node:crypto')
    const { createRequire } = require('node:module')
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    ${linux ? "assert.equal(process.versions.electron, undefined, 'Linux image processing must not run in Electron')" : ''}
    const appPath = ${JSON.stringify(join(resources, linux ? 'app' : 'app.asar'))}
    const appRequire = createRequire(join(appPath, 'package.json'))
    for (const asset of ['status-window.css', 'mica.css', 'fonts.css', 'preload.cjs']) {
      assert.ok(readFileSync(join(appPath, 'src', asset)).length > 0, 'packaged desktop asset: ' + asset)
    }
    const sharp = appRequire('sharp')
    ;(async () => {
      const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
      const { data, info } = await sharp(image).resize(2, 2).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 2)
      assert.equal(info.height, 2)
      assert.deepEqual([...data], Array.from({ length: 4 }, () => [255, 0, 0]).flat())
      const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
      console.log('check-packed: ' + JSON.stringify({ package: {
        version: appRequire('./package.json').version, platform: process.platform, arch: process.arch,
        clientSha256: sha256(readFileSync(appRequire.resolve('ds-superagent/client'))),
      }}))
      console.log('check-packed: sharp image processing passed (libvips ' + sharp.versions.vips + ')')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  // Use the Host's runtime and dependencies outside the checkout, not the CI runner's Node.
  const result = spawnSync(linux ? hostExecutable(resources) : app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8', timeout: 30_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged sharp failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}`)
  if (process.env.GITHUB_SHA) {
    const candidate = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    assert.equal(candidate.stdout?.trim(), process.env.GITHUB_SHA, 'the package probe must run from the candidate checkout')
    const client = spawnSync('git', ['show', 'HEAD:superagent/dsh/client.js'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
    assert.ifError(client.error)
    assert.equal(client.status, 0, 'read the candidate client bundle from Git')
    const expectedClient = createHash('sha256').update(client.stdout).digest('hex')
    const identity = result.stdout.split(/\r?\n/u).find(line => line.startsWith('check-packed: {"package":'))
    assert.equal(JSON.parse(identity?.slice('check-packed: '.length) ?? '{}').package?.clientSha256, expectedClient,
      'the package must contain the candidate client bundle')
  }
  console.log(result.stdout.trim())
  const payload = appImage ? launched : linux ? app : join(resources, 'app.asar')
  console.log(`check-packed: ${JSON.stringify({ candidate: process.env.GITHUB_SHA, payload: basename(payload), sha256: await fingerprint(payload) })}`)
}

async function fingerprint(payload) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(payload)) hash.update(chunk)
  return hash.digest('hex')
}

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'superagent', 'dsh', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: mockLog, MOCK_T55_CONTROLS: controls || classic ? '1' : '0',
      MOCK_CLASSIC_ROUND_TRIP: classic ? '1' : '0' },
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

async function appPage(port, deadline, main = false, child) {
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('The app exited before its window appeared.')
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(1000) })).json()
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

async function waitForDownloadedUpdate(cdp, version, feed) {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const result = await cdp.call('Runtime.evaluate', { expression: 'window.dsSuperagentApp.updates.state()',
      returnByValue: true, awaitPromise: true })
    const update = result.result?.value
    if (update?.phase === 'failed') throw new Error('The app reported a failed update download.')
    if (update?.phase === 'downloaded' && update.version === version) {
      assert.ok(feed.served.includes('latest.yml'), 'the update must come from the isolated feed')
      assert.ok(feed.served.includes(`DS-SuperAgent-${version}-win-x64.exe`), 'the installed app must download the fixture installer')
      console.log(`check-packed: ${JSON.stringify({ downloadedUpdate: version, files: feed.served })}`)
      return
    }
    await sleep(250)
  }
  throw new Error('The app did not download the update from the isolated feed.')
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
      const optionalFileManagerIcon = process.platform === 'linux' && entry.source === 'network'
        && entry.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
        && /^http:\/\/127\.0\.0\.1:\d+\/open-in-app\/icon\/filemanager$/u.test(entry.url ?? '')
      if (optionalFileManagerIcon) console.log('check-packed: DSH uses the generic Linux file manager icon')
      else if (!(entry.url?.includes('/api/session/') && entry.text.includes('403'))) problems.push(`log: ${entry.text} ${entry.url ?? ''}`)
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
  const call = (method, params = {}, timeout = 30_000) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, timeout)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

// mica.css styles DSH's own page, which can change with a DSH upgrade; every rule must still
// find an element, on every platform, so the change shows here and not as a broken window.
const micaCss = readFileSync(join(root, 'src', 'mica.css'), 'utf8')

async function checkCoexistence(cdp) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error('The isolated product page did not complete its coexistence check.')
    return result.result.value
  }
  const waitFor = async (expression, label) => {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(200)
    }
    throw new Error(`The product page did not show ${label}.`)
  }
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await waitFor("document.querySelector('#main-message')", 'the Main conversation')
  assert.equal(await evaluate(`(() => {
    if (window !== window.top || !location.origin.startsWith('http://127.0.0.1:')) return false;
    const keys = ['ds-bot:theme', 'ds-bot:appearance', 'ds-bot:prefs', 'ds-bot:notify'];
    const get = Storage.prototype.getItem;
    let accesses = 0;
    for (const area of [localStorage, sessionStorage]) for (const key of keys) area.setItem(key, 'coexistence-sentinel');
    for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (key, ...args) {
        if (method === 'clear' || typeof key === 'string' && key.startsWith('ds-bot:')) accesses++;
        return Reflect.apply(original, this, method === 'clear' ? [] : [key, ...args]);
      };
    }
    window.__coexistenceProbe = () => ({ accesses, unchanged: [localStorage, sessionStorage]
      .every(area => keys.every(key => get.call(area, key) === 'coexistence-sentinel')) });
    return true;
  })()`), true)
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  const settingsButton = `[...document.querySelectorAll('button[aria-label]')].find(button => !button.disabled
    && /^(Settings|设置)$/u.test(button.getAttribute('aria-label')) && button.getClientRects().length)`
  await waitFor(settingsButton, 'the Settings button')
  await evaluate(`${settingsButton}?.click()`)
  await waitFor("document.querySelector('.bt-superagent-settings[role=dialog]')", 'product Settings')
  for (const [label, selector] of [
    [/^(Memory|记忆)$/u, '.bt-product-memory'],
    [/^(Agent presets|智能体预设)$/u, '.bt-product-presets'],
    [/^(Proactive preparation|主动准备)$/u, '.bt-product-preparations'],
    [/^(Supervision|监督)$/u, '.bt-product-supervision'],
    [/^(Feedback|反馈)$/u, 'a[href$="/issues/new"]'],
  ]) {
    await evaluate(`[...document.querySelectorAll('.bt-superagent-settings nav button')].find(button => ${label}.test(button.textContent.trim()))?.click()`)
    await waitFor(`document.querySelector(${JSON.stringify('.bt-superagent-settings ' + selector)})`, label.source)
  }
  await evaluate(`[...document.querySelectorAll('.bt-superagent-settings nav button')]
    .find(button => /^(About|简介)$/u.test(button.textContent.trim()))?.click()`)
  await waitFor("document.querySelector('.bt-superagent-settings')?.innerText.includes('DS SuperAgent')", 'product branding in About')
  assert.deepEqual(await evaluate('window.__coexistenceProbe()'), { accesses: 0, unchanged: true })
  assert.equal(await evaluate(`typeof window.dsSuperagentApp?.dataLocation === 'function'
    && ['dsBotApp', 'dshDesktop', 'dshBot', 'dshBotQueue'].every(name => window[name] === undefined)`), true)
  await evaluate("document.querySelector('.bt-settings-close')?.click()")
  await waitFor("!document.querySelector('.bt-superagent-settings[role=dialog]')", 'Settings to close')
  console.log('check-packed: product Settings, desktop bridge and legacy renderer storage isolation passed')
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
  const instanceId = await waitForLocalEnvironment(cdp)
  const stale = await evaluate(`(() => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(${JSON.stringify(micaCss)})
    const selectors = rules => Array.from(rules).flatMap(rule => rule.selectorText ? [rule.selectorText] : selectors(rule.cssRules ?? []))
    return selectors(sheet.cssRules).filter(rule => !rule.split(',').some(selector =>
      document.querySelector(selector.trim().replace(/::(?:before|after)$/, '')) !== null))
  })()`)
  if (stale.length > 0) throw new Error(`src/mica.css no longer matches DSH's page: ${stale.join(' | ')}`)
  await dismissNotice()
  // Click the composer through the input pipeline. A bare focus() is not enough where no window
  // manager gives the window focus (xvfb in CI): the text and the Enter would go nowhere.
  const writableInput = JSON.stringify(writableMainInput)
  const box = `document.querySelector(${writableInput})`
  const focusCheck = `document.activeElement?.matches(${writableInput})`
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
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
      await dismissNotice()
      const point = await evaluate(probe)
      if (point) {
        await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        await sleep(300)
      } else await sleep(250)
    }
    if (!(await evaluate(`Boolean(${focusCheck})`))) throw new Error('timed out waiting for the writable, focused Main composer')
    await cdp.call('Input.insertText', { text: mainPrompt })
    await until(`${focusCheck} && ${box}?.value === ${JSON.stringify(mainPrompt)} &&
      document.querySelector('.bt-main-composer[data-main-input-ready] button[type="submit"]:enabled')`, 'a focused, sendable Main draft', 10_000)
    for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await until(text(mainReply), 'the visible Main reply')
    await sleep(1000)
  } finally {
    console.log(`check-packed: ${JSON.stringify({ mainSend: await mainSendEvidence(cdp, instanceId) })}`)
  }
}

async function mainSendEvidence(cdp, instanceId) {
  const result = await cdp.call('Runtime.evaluate', {
    expression: `(${inspectMainSend.toString()})(${JSON.stringify(instanceId)}, ${JSON.stringify(mainPrompt)}, ${JSON.stringify(mainReply)})`,
    returnByValue: true, awaitPromise: true,
  }, 4000).catch(() => undefined)
  let mockPrompt = 'unavailable'
  try {
    const records = readFileSync(mockLog, 'utf8').split(/\r?\n/u)
    mockPrompt = records.some(line => {
      try { return JSON.parse(line)?.reply?.startsWith(mainReply) === true } catch { return false }
    }) ? 'seen' : 'not-seen'
  } catch (error) {
    if (error.code === 'ENOENT') mockPrompt = 'not-seen'
  }
  return { mockPrompt, renderer: result?.result?.value?.renderer ?? 'unavailable', history: result?.result?.value?.history ?? 'unavailable' }
}

async function inspectMainSend(instanceId, prompt, reply) {
  const form = document.querySelector('.bt-main-composer')
  const field = form?.querySelector('#main-message')
  const flow = document.querySelector('[data-chat-flow]')
  const flowText = flow?.innerText ?? ''
  const renderer = {
    visibility: document.visibilityState, windowFocused: document.hasFocus(), composerFocused: Boolean(field && document.activeElement === field),
    composerReady: Boolean(form?.hasAttribute('data-main-input-ready')),
    composerWritable: Boolean(field && !field.disabled && !field.readOnly), fixtureDraft: field?.value === prompt,
    composerError: Boolean(form?.querySelector('[role="alert"]')), sendEnabled: Boolean(form?.querySelector('button[type="submit"]:enabled')),
    nativeHistoryPresent: Boolean(flow), nativeHistoryLoading: /^(?:Loading history…|载入历史…)$/mu.test(flowText),
    nativeHistoryError: /^(?:Failed to load history:|载入历史失败)/mu.test(flowText),
    fixtureInputInNativeHistory: flowText.split('\n').some(line => line.trim() === prompt),
    replyVisible: document.body.innerText.includes(reply),
  }
  let history = 'unavailable'
  try {
    if (!instanceId) return { renderer, history }
    const result = await fetch('/api/product', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2500),
      body: JSON.stringify({ endpoint: 'history', payload: { instanceId, limit: 20 } }),
    }).then(response => response.json())
    if (result.ok && Array.isArray(result.value?.messages)) {
      const page = result.value
      const statuses = ['queued', 'running', 'stopping', 'stopped', 'completed', 'interrupted', 'failed']
      const status = record => record ? (statuses.includes(record.status) ? record.status : 'unknown') : 'missing'
      const input = page.messages.find(record => record.role === 'user' && record.text === prompt)
      const answer = input && page.messages.find(record => record.role === 'main' && record.id === `reply:${input.id}`)
      const mode = ['native', 'product-history'].includes(page.mainSessionMode) ? page.mainSessionMode : 'unknown'
      history = { mode, input: status(input), reply: status(answer),
        active: Boolean(input && page.activeTurn?.messageId === input.id), expectedReply: Boolean(answer?.text.includes(reply)) }
    }
  } catch {}
  return { renderer, history }
}

async function waitForLocalEnvironment(cdp) {
  const expression = `(async () => {
    const call = async (endpoint, payload = {}) => {
      const request = await fetch('/api/product', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({endpoint,payload})});
      const result = await request.json();
      return result.ok ? result.value : null;
    };
    const binding = await call('open');
    if (!binding) return null;
    const payload = {instanceId:binding.instanceId};
    const [directories, execution] = await Promise.all([call('directory-options', payload), call('execution-options', payload)]);
    const selected = directories?.default;
    const environment = execution?.environments?.find(item => item.id === selected?.environmentId);
    return {
      instanceId: binding.instanceId,
      selected: selected?.environmentId, environment: environment?.id,
      matchesFixture: selected?.root === ${JSON.stringify(realpathSync.native(join(work, 'workspace')))},
      eligible: environment?.eligible === true && environment.kind === 'local',
      target: document.querySelector('.bt-main-composer select[aria-label="Execution target"], .bt-main-composer select[aria-label="执行目标"]')?.value,
      visible: Array.from(document.querySelectorAll('.bt-main-composer .bt-main-directory-note'))
        .some(note => /^(Eligible|符合条件|可用)(?:$| · )/u.test(note.textContent.trim())),
    };
  })()`
  let last
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    last = result.result?.value
    if (last?.eligible && last.matchesFixture && last.target === 'local-only' && last.visible) {
      console.log(`check-packed: ${JSON.stringify({ executionEnvironment: 'authorized fixture ready', environmentId: last.environment })}`)
      return last.instanceId
    }
    await sleep(250)
  }
  throw new Error(`the authorized local fixture Environment did not become ready: ${JSON.stringify(last ?? null)}`)
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
    return { binding, messages: history.messages.map(({ id, role, status, text }) => ({ id, role, status, text })), enabled: source.enabled,
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
  const activate = async (selector, label) => {
    await wait(() => evaluate(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item =>
        !item.disabled && item.getClientRects().length && ${label}.test(item.textContent.trim()));
      button?.focus();
      return Boolean(button && document.activeElement === button);
    })()`), `keyboard focus on ${selector}`)
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
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
  const visualDir = process.env.DESKTOP_CONTROLS_VISUAL_DIR
  if (visualDir) {
    mkdirSync(visualDir, { recursive: true })
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 580, height: 780, deviceScaleFactor: 1, mobile: false })
    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      await wait(() => evaluate(`(() => {
        const choice = [...document.querySelectorAll('.bt-q-opt:not(:disabled)')].find(button => button.textContent.trim() === 'Yes');
        choice?.focus({ focusVisible: true });
        const bounds = choice?.closest('.bt-q')?.getBoundingClientRect();
        return bounds && document.activeElement === choice && bounds.x >= 0 && bounds.right <= innerWidth && bounds.y >= 0 && bounds.bottom <= innerHeight;
      })()`), 'the focused question card inside the narrow window')
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate("document.activeElement.matches('.bt-q-opt:focus-visible') && document.activeElement.textContent.trim() === 'No'"), true)
      const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(visualDir, '580-question-reduced-motion.png'), Buffer.from(data, 'base64'))
      console.log('check-packed: the narrow question card fits and supports Tab with visible focus')
    } finally {
      await cdp.call('Emulation.setEmulatedMedia', { features: [] })
      await cdp.call('Emulation.clearDeviceMetricsOverride')
      await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false })
    }
  }
  await activate('.bt-q-dock .bt-q-opt, .bt-main-work-options button', '/^Yes$/u')
  await activate('.bt-q-dock .bt-q-submit, .bt-main-work-answer button[type=submit]', '/^(Send answer|提交回答)$/u')
  const answered = await wait(async () => {
    const alpha = card(await read(), 'alpha')
    return alpha?.status === 'success' && alpha
  }, 'the answered work result')
  assert.equal(answered.control.attention.sessionId, firstAlpha.sessionId)
  console.log('check-packed: the work question was answered by keyboard in its original Assignment')
  await send(t55SlowReply)
  await wait(() => click('button', '/^(Stop reply|停止本轮回复)$/u'), 'the Main stop control')
  const stoppedReply = await wait(async () => {
    const history = await read()
    return history.messages.some(message => message.text === t55SlowReply && message.status === 'stopped') && history
  }, 'only the Main turn to stop')
  assert.equal(card(stoppedReply, 'beta').control.assignment.generation, firstBeta.generation)
  assert.equal(card(stoppedReply, 'beta').control.stop, undefined)
  console.log('check-packed: stopping the Main reply preserved the other Work')
  const betaId = card(stoppedReply, 'beta').control.ticketId
  const betaButtons = `.bt-main-work[data-ticket-id="${betaId}"] .bt-main-work-controls button`
  await wait(() => click(betaButtons, '/^(Stop work|停止工作)$/u'), 'the beta work stop control')
  await wait(async () => {
    const beta = card(await read(), 'beta')
    return beta?.control?.stop?.state === 'stopped' && beta.control.stop.cancellationConfirmedAt !== undefined
  }, 'the original beta range to stop')
  console.log('check-packed: stopping Work confirmed cancellation of the selected range')
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

async function checkClassicRoundTrip(cdp) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (check, label) => {
    const deadline = Date.now() + 30_000
    do {
      const result = await check()
      if (result) return result
      await sleep(150)
    } while (Date.now() < deadline)
    const feedback = await evaluate(`JSON.stringify({
      focus: document.activeElement?.id || document.activeElement?.tagName,
      inputs: [...document.querySelectorAll('textarea, [role=textbox], [data-composer-card]')].map(node => ({
        tag: node.tagName, editable: node.getAttribute('contenteditable'), role: node.getAttribute('role'),
        phase: node.getAttribute('data-phase'), disabled: node.getAttribute('aria-disabled'),
      })),
      text: document.body.innerText.slice(-280),
      alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent.slice(0, 160)),
    })`)
    throw new Error(`Classic probe timed out waiting for ${label}${feedback ? `. ${feedback}` : '.'}`)
  }
  const key = async (key, windowsVirtualKeyCode, text) => {
    const fields = { key, code: key, windowsVirtualKeyCode }
    await cdp.call('Input.dispatchKeyEvent', text ? { type: 'keyDown', text, ...fields } : { type: 'rawKeyDown', ...fields })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...fields })
  }
  const clickByKeyboard = async (selector, label) => {
    await wait(() => evaluate(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getClientRects().length && !node.disabled);
      button?.focus(); return button === document.activeElement;
    })()`), label)
    await key('Enter', 13, '\r')
  }
  const history = async () => evaluate(`(async () => {
    const call = async (endpoint, payload) => {
      const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }) });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const { instanceId } = await call('open', {});
    return call('history', { instanceId });
  })()`)
  const send = async (selector, text) => {
    await wait(() => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)});
      input?.focus(); return input === document.activeElement })()`), `focus on ${selector}`)
    await cdp.call('Input.insertText', { text })
    await key('Enter', 13)
  }
  const initial = await history()
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('#main-message', t55Request)
  const work = await wait(async () => {
    const page = await history()
    const beta = page.works.find(item => item.brief.goal === 'T55 beta note' && item.control?.assignment?.state === 'running')
    const alpha = page.works.find(item => item.brief.goal === 'T55 alpha note')
    return alpha?.control?.attention?.question === t55Question && beta && { alpha, beta }
  }, 'the running Ticket')
  await wait(() => evaluate(`Boolean([...document.querySelectorAll('.bt-q-opt')].find(option => {
    if (option.textContent.trim() !== 'Yes') return false;
    option.click(); return true;
  }))`), 'the approved answer choice')
  await wait(() => evaluate(`Boolean([...document.querySelectorAll('.bt-q-submit:not(:disabled)')].find(button => {
    button.click(); return true;
  }))`), 'the question send button')
  await send('#main-message', t55SlowReply)
  const working = await wait(async () => {
    const page = await history()
    return page.messages.find(message => message.text === t55SlowReply && message.status === 'running')
  }, 'the active Main reply')
  const account = '.bt-product-side .bt-account[aria-haspopup=menu]'
  const activeMenu = '.bt-account-menu:not([data-leaving])'
  await clickByKeyboard(account, 'the product account button')
  await wait(() => evaluate(`document.activeElement?.matches('${activeMenu} [role=menuitem]')`), 'keyboard focus in the product account menu')
  await key('Escape', 27)
  await wait(() => evaluate(`document.activeElement?.matches('${account}') && !document.querySelector('${activeMenu}')`), 'Escape to restore Account focus')
  await key('Enter', 13, '\r')
  await wait(() => evaluate(`document.activeElement?.matches('${activeMenu} [role=menuitem]')`), 'the reopened product account menu')
  for (let index = 0; index < 7; index += 1) {
    if (await evaluate('/^(Classic Agent mode|经典 Agent 模式)$/u.test(document.activeElement?.textContent.trim())')) break
    await key('ArrowDown', 40)
  }
  assert.equal(await evaluate('/^(Classic Agent mode|经典 Agent 模式)$/u.test(document.activeElement?.textContent.trim())'), true)
  assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none'"), true)
  await key('Enter', 13, '\r')
  const back = 'button.bt-return'
  const nativeComposer = '[role=textbox][contenteditable=true]'
  await wait(() => evaluate(`Boolean(document.querySelector('${back}')) && !document.querySelector('#main-message, [role=menu]')
    && document.activeElement?.matches('${back}, ${nativeComposer}')`), 'Classic with focus in the new surface')
  console.log('check-packed: keyboard entered Classic with focus in the native surface')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${back}')).transitionDuration`), '0s')
  const during = await history()
  assert.equal(during.messages.find(message => message.id === working.id).status, 'running')
  assert.notEqual(during.works.find(item => item.receipt?.ticketId === work.alpha.receipt.ticketId).status, 'success')
  const nativeText = 'Classic fixture prompt'
  await send(nativeComposer, nativeText)
  await wait(() => evaluate(`document.body.innerText.includes(${JSON.stringify(`收到：${nativeText}`)})`), 'the native reply')
  await wait(async () => {
    const { messages } = await history()
    return messages.some(message => message.id === `reply:${working.id}` && message.status === 'completed'
      && message.text.includes(t55SlowReply))
  }, 'Main to finish in the background')
  const finished = await wait(async () => (await history()).works.find(item => item.receipt?.ticketId === work.alpha.receipt.ticketId
    && item.status === 'success'), 'the original alpha Ticket to finish in the background')
  assert.equal(finished.control.assignment.sessionId, work.alpha.control.assignment.sessionId)
  await clickByKeyboard(back, 'the sidebar return')
  await wait(() => evaluate("document.activeElement?.id === 'main-message'"), 'focus on the original Main')
  const result = await history()
  assert.equal(result.mainSessionId, initial.mainSessionId)
  assert.equal(result.messages.filter(message => message.text === t55SlowReply).length, 1)
  assert.equal(result.messages.find(message => message.text === t55SlowReply).id, working.id)
  assert.equal(result.messages.some(message => message.text.includes(nativeText)), false)
  assert.equal(result.works.find(item => item.receipt?.ticketId === work.beta.receipt.ticketId).control.assignment.sessionId, work.beta.control.assignment.sessionId)
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log('check-packed: Classic Agent round trip kept the original Main reply, receipt, and running Ticket')
}

async function checkOperations(cdp, facts) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const open = async (tab, verify) => {
    const panel = JSON.stringify(`[role="tabpanel"][id$="-panel-${tab}"]:not([hidden]) .bt-product-operations`)
    const tabButton = JSON.stringify(`button[role="tab"][id$="-tab-${tab}"]`)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const ready = await evaluate(`(() => {
        const settings = document.querySelector('.bt-superagent-settings');
        if (!settings) {
          document.querySelector('.bt-main-settings')?.click();
          return false;
        }
        const page = settings.querySelector(${panel});
        if (!page) {
          const button = settings.querySelector(${tabButton}) ?? [...settings.querySelectorAll('button.bt-settings-item')]
            .find(item => /^(Usage|用量)$/u.test(item.textContent.trim()));
          button?.click();
          return false;
        }
        return (${verify})(page);
      })()`)
      if (ready) return
      await sleep(150)
    }
    throw new Error(`Settings did not load the preserved data on the ${tab} tab.`)
  }
  await open('status', `page => {
    const events = page.querySelector('details');
    if (events && !events.open) events.querySelector('summary')?.click();
    return page.innerText.includes(${JSON.stringify(facts.version)}) && Boolean(events?.innerText.includes('HOST_READY'))
      && /Download diagnostic summary|下载诊断摘要|下載診斷摘要/u.test(page.innerText);
  }`)
  await open('usage-overview', `page => [...page.querySelectorAll('.bt-ps-stat')].some(stat =>
    /^(Main|主角色)$/u.test(stat.querySelector('dt')?.textContent.trim())
      && stat.querySelector('dd')?.textContent.trim() === (${JSON.stringify(facts.mainTokens)}).toLocaleString())`)
  console.log('check-packed: Windows Status and Usage show the preserved diagnostics and Main token count')
}

async function checkColdUpgrade(before, env) {
  let packedApp
  if (updateFeed) {
    packedApp = resolve(executable)
    const installed = join(dirname(packedApp), 'resources', 'app.asar')
    const expected = await fingerprint(nextPayload)
    let actual
    let installation
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      installation = windowsInstallation(nextVersion)
      if (!installation.installerRunning && installation.version === nextVersion) {
        actual = await fingerprint(installed).catch(error => {
          if (['ENOENT', 'EPERM', 'EBUSY'].includes(error.code)) return null
          throw error
        })
        if (actual === expected) break
      }
      await sleep(1000)
    }
    assert.deepEqual(installation, { version: nextVersion, installerRunning: false }, 'the current-user installer must finish before relaunch')
    assert.equal(actual, expected, 'the updater must replace app.asar with the next build')
    console.log(`check-packed: ${JSON.stringify({ installedUpdate: nextVersion, payload: 'app.asar', sha256: actual })}`)
  } else if (installUpgrade) {
    packedApp = resolve(executable)
    const setup = spawnSync(resolve(nextExecutable), ['/S', '--updated', '/no-desktop-shortcut', `/D=${dirname(packedApp)}`], {
      env, windowsHide: true, windowsVerbatimArguments: true, timeout: 300_000,
    })
    assert.ifError(setup.error)
    assert.equal(setup.status, 0, 'the native installer must finish replacing the program')
    console.log('check-packed: native installer completed')
  } else packedApp = outsideCheckout(resolve(nextExecutable))
  const port = await freePort()
  const reopenedEnv = { ...env }
  delete reopenedEnv.DS_SUPERAGENT_UPDATE_URL
  const app = spawn(packedApp, [`--remote-debugging-port=${port}`], { env: reopenedEnv, stdio: 'inherit' })
  children.push(app)
  const exited = new Promise(done => app.once('exit', done))
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, [])
  await cdp.opened
  try {
    await checkRestoredMain(cdp)
    const after = await productFacts(cdp)
    assert.ok(isNewer(after.version, before.version), 'the next packaged version must be newer')
    if (updateFeed) {
      assert.equal(after.version, nextVersion)
      assert.ok(after.events.includes('UPDATE_INSTALLED'), 'the reopened app confirms the downloaded update')
      assert.ok(after.events.includes('UPDATE_INSTALL_REQUESTED'), 'the old app launched the downloaded installer')
    }
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
  const exit = await Promise.race([exited, sleep(40_000).then(() => null)])
  assert.equal(exit, 0, 'the upgraded app must shut down normally')
  console.log(`check-packed: upgraded app exited (code ${exit})`)
}

async function checkRestoredMain(cdp) {
  const expression = `Boolean(document.querySelector(${JSON.stringify(writableMainInput)}) &&
    document.body.innerText.includes(${JSON.stringify(mainReply)}))`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true })
    if (result.result?.value) {
      console.log('check-packed: the upgraded window shows the original Main reply and a ready composer')
      return
    }
    await sleep(250)
  }
  throw new Error('the upgraded window did not show the original Main reply and a ready composer')
}

function windowsInstallation(version) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $entry = Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
      Where-Object { $_.DisplayName -like 'DS SuperAgent*' } |
      Select-Object -First 1
    $installer = Get-Process -Name 'DS-SuperAgent-${version}-win-x64' -ErrorAction SilentlyContinue
    @{ version = $entry.DisplayVersion; installerRunning = [bool]$installer } | ConvertTo-Json -Compress
  `
  const status = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  assert.ifError(status.error)
  assert.equal(status.status, 0, 'read the current-user installation result')
  return JSON.parse(status.stdout)
}

let failed = false
let feed
let nextVersion
const problems = []
try {
  const packedApp = outsideCheckout(resolve(executable))
  const resourceApp = appImage ? appImageContents(packedApp) : packedApp
  checkResources(resourceApp)
  await checkSharp(resourceApp, packedApp)
  mkdirSync(join(work, 'workspace'))
  const modelUrl = await startMock()
  const profileDir = join(work, 'home', 'superagent', 'profiles', 'ds-superagent')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: superagent',
    '  config:',
    '    main: { provider: deepseek-official, model: deepseek-flash }',
    '    router: { provider: deepseek-official, model: deepseek-flash }',
    '    worker: { provider: deepseek-official, model: deepseek-flash }',
    ...(classic ? ['- id: agent-default-model', '  config: { provider: deepseek-official, model: deepseek-flash }'] : []),
    '',
  ].join('\n'))
  const port = await freePort()
  const mainPort = await freePort()
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ELECTRON_RUN_AS_NODE$|DS_SUPERAGENT_|DS_BOT_|DSH_|DEEPSEEK_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)))
  Object.assign(env, {
    DS_SUPERAGENT_HOME: join(work, 'home'), DS_SUPERAGENT_SHELL_DATA: join(work, 'shell'),
    DS_SUPERAGENT_WORKSPACE: join(work, 'workspace'),
    DSH_HOME: join(work, 'personal-dsh'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  if (updateFeed) {
    nextVersion = /^version:[ \t]*(\d+\.\d+\.\d+)[ \t]*\r?$/mu.exec(readFileSync(join(nextExecutable, 'latest.yml'), 'utf8'))?.[1]
    assert.ok(nextVersion, 'the fixture feed must have a next version')
    feed = await fileUpdateFeed(nextExecutable)
    env.DS_SUPERAGENT_UPDATE_URL = feed.url
  }
  const former = join(work, 'former-product')
  const oldShell = join(former, 'shell')
  const oldSettings = join(oldShell, 'locations.json')
  const sentinel = '{"fixture":"former-product"}\n'
  if (coexistence) {
    mkdirSync(oldShell, { recursive: true })
    writeFileSync(oldSettings, sentinel)
    Object.assign(env, { DS_BOT_HOME: former, DS_BOT_SHELL_DATA: oldShell, DS_BOT_WORKSPACE: join(former, 'workspace') })
  }
  const app = spawn(packedApp, [`--remote-debugging-port=${String(port)}`, `--inspect=127.0.0.1:${String(mainPort)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000, false, app)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const main = devtools((await appPage(mainPort, Date.now() + 30_000, true, app)).webSocketDebuggerUrl, problems)
  await main.opened
  const windowState = async expression => {
    const answer = await main.call('Runtime.evaluate', {
      expression: `(() => { const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')); return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  const windowDeadline = Date.now() + 30_000
  let title
  do {
    title = await windowState('win?.getTitle() ?? null')
    if (title !== null) break
    await sleep(200)
  } while (Date.now() < windowDeadline)
  if (title === null) throw new Error('the product window did not finish navigating to the Host')
  if (title !== PRODUCT_NAME) throw new Error('the window has the wrong product name')
  if (!existsSync(join(work, 'home', 'superagent', 'core', 'state.sqlite'))) throw new Error('the product database did not open')
  if (existsSync(join(work, 'personal-dsh'))) throw new Error('the app wrote outside its own DSH home')
  let chatError
  if (coexistence) {
    assert.equal(await windowState("process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getPath('sessionData')"), env.DS_SUPERAGENT_SHELL_DATA)
    await checkCoexistence(cdp)
  }
  chatError = await chat(cdp).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  if (chatError) throw chatError
  if (process.env.DESKTOP_VISUAL_DIR) await checkPackedVisuals(cdp, process.env.DESKTOP_VISUAL_DIR)
  if (controls) await checkWorkControls(cdp)
  if (classic) await checkClassicRoundTrip(cdp)
  const before = upgrade ? await productFacts(cdp, true) : undefined
  if (before) {
    assert.ok(before.mainTokens > 0 && before.messages.length >= 2)
    assert.equal(before.enabled, false)
  }
  if (feed) await waitForDownloadedUpdate(cdp, nextVersion, feed)
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
  if (feed) {
    await windowState(`(() => {
      const { app } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      setTimeout(() => app.quit(), 100);
    })()`)
  }
  cdp.close()
  main.close()
  if (!feed) await browserClose(port)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (outcome === undefined) {
    const codes = operationCodes()
    throw new Error(`the app did not exit after the quit (${codes.join(', ') || 'no operations events'})`)
  }
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  if (coexistence) {
    assert.equal(readFileSync(oldSettings, 'utf8'), sentinel)
    assert.equal(existsSync(join(former, 'superagent')), false)
    assert.equal(existsSync(env.DS_BOT_WORKSPACE), false)
    console.log('check-packed: retained former data fixtures and ignored old environment overrides')
  }
  if (before) await checkColdUpgrade(before, env)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  const codes = operationCodes()
  if (codes.length > 0) console.error(`check-packed: app events ${codes.join(', ')}`)
} finally {
  clearTimeout(watchdog)
  cleanup()
}
process.exit(failed ? 1 : 0)
