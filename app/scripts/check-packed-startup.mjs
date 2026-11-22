import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const [program, output, motion] = process.argv.slice(2)
assert.ok(program && output && (motion === undefined || motion === '--reduce-motion'),
  'Usage: node app/scripts/check-packed-startup.mjs <packaged executable> <screenshot directory> [--reduce-motion]')
const executable = await realpath(program)
const pictures = resolve(output)
const fixture = await mkdtemp(join(await realpath(tmpdir()), 'ds-superagent-startup-'))
const profile = join(fixture, 'home', 'superagent')
const lock = join(profile, 'host.lock')
const children = []
const sockets = []

function start(file, args, options) {
  const child = spawn(file, args, options)
  child.on('error', () => {})
  children.push(child)
  return child
}

async function until(label, check, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  return port
}

async function connect(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 5000 })
  sockets.push(socket)
  await new Promise((done, reject) => {
    socket.once('open', done)
    socket.on('error', reject)
  })
  let nextId = 0
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId
    const finish = (action, result) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      action(result)
    }
    const onMessage = message => {
      const reply = JSON.parse(String(message))
      if (reply.id !== id) return
      if (reply.error) finish(reject, new Error(reply.error.message))
      else finish(done, reply.result)
    }
    const timer = setTimeout(() => finish(reject, new Error(`The window did not answer ${method}.`)), 5000)
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error) finish(reject, error)
    })
  })
  const evaluate = async expression => {
    const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (exceptionDetails) throw new Error(exceptionDetails.text)
    return result.value
  }
  const key = async (name, windowsVirtualKeyCode, modifiers = 0) => {
    const params = { key: name, code: name, windowsVirtualKeyCode, modifiers }
    await call('Input.dispatchKeyEvent', name === 'Enter' ? { ...params, type: 'keyDown', text: '\r' } : { ...params, type: 'rawKeyDown' })
    await call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
  }
  const screenshot = async name => {
    const { data } = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(pictures, `${name}.png`), Buffer.from(data, 'base64'))
  }
  return { evaluate, call, key, screenshot, socket }
}

let imageApp
let debugPort
let appExit
try {
  const config = join(profile, 'profiles', 'ds-superagent')
  await Promise.all([mkdir(pictures, { recursive: true }), mkdir(config, { recursive: true }), mkdir(join(fixture, 'workspace'))])
  await writeFile(lock, JSON.stringify({ pid: process.pid }))
  await writeFile(join(config, 'cordis.patch.yml'), ['- id: superagent', '  config:',
    ...['main', 'router', 'worker'].map(role => `    ${role}: { provider: deepseek-official, model: deepseek-flash }`), ''].join('\n'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ELECTRON_RUN_AS_NODE$|DS_SUPERAGENT_|DS_BOT_|DSH_|DEEPSEEK_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)))
  const mockScript = fileURLToPath(new URL('../../superagent/dsh/dev/mock-llm.mjs', import.meta.url))
  const mock = start(process.execPath, [mockScript], { env: { ...env, MOCK_PORT: '0', MOCK_LOG: join(fixture, 'mock.log') },
    stdio: ['ignore', 'pipe', 'ignore'] })
  let mockOutput = ''
  mock.stdout.setEncoding('utf8').on('data', data => { mockOutput += data })
  const model = await until('the mock model', () => /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(mockOutput)?.[0], 10_000)
  debugPort = await freePort()
  const args = [`--remote-debugging-port=${debugPort}`]
  if (motion) args.push('--force-prefers-reduced-motion')
  imageApp = start(executable, args, { stdio: 'ignore', env: {
    ...env,
    DS_SUPERAGENT_HOME: join(fixture, 'home'), DS_SUPERAGENT_SHELL_DATA: join(fixture, 'shell'),
    DS_SUPERAGENT_WORKSPACE: join(fixture, 'workspace'), DSH_HOME: join(fixture, 'personal-dsh'),
    DEEPSEEK_BASE_URL: model, DEEPSEEK_API_KEY: 'mock-key',
  } })
  appExit = new Promise(done => imageApp.once('exit', (code, signal) => done({ code, signal })))
  const debuggerJson = async path => (await fetch(`http://127.0.0.1:${debugPort}/json/${path}`, { signal: AbortSignal.timeout(1000) })).json()
  const pages = () => debuggerJson('list').catch(() => [])
  const failure = await until('the packed startup error page', async () => (await pages()).find(page =>
    page.type === 'page' && page.url.startsWith('data:text/html;') && page.url.includes(encodeURIComponent('data-status="failure"'))))
  const startScreen = await connect(failure.webSocketDebuggerUrl)
  const retry = 'document.activeElement?.dataset.startupAction'
  await startScreen.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('the Retry button to receive initial focus', async () => (await startScreen.evaluate(retry)) === 'retry', 5000)
  assert.match(await startScreen.evaluate('document.querySelector(".status-detail").textContent'), new RegExp(`still running on this data.*${process.pid}`, 'u'))
  await startScreen.key('Tab', 9)
  assert.equal(await startScreen.evaluate(retry), 'quit')
  await startScreen.key('Tab', 9, 8)
  assert.equal(await startScreen.evaluate(retry), 'retry')
  assert.equal(await startScreen.evaluate("document.activeElement.matches(':focus-visible')"), true)
  await startScreen.screenshot('startup-retry')
  await rm(lock)
  await startScreen.key('Enter', 13)
  const loading = await until('Retry to return the existing startup page to loading', async () => (await pages()).find(page =>
    page.id === failure.id && page.url.includes(encodeURIComponent('data-status="loading"'))), 5000)
  const duringRetry = await connect(loading.webSocketDebuggerUrl)
  await duringRetry.screenshot('startup-retrying')
  const ready = await until('the product Main page', async () => (await pages()).find(page =>
    page.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(page.url)))
  const main = await connect(ready.webSocketDebuggerUrl)
  await until('the startup surface to close', async () => !(await pages()).some(page => page.id === failure.id))
  await until('the Main composer to become ready', () => main.evaluate('!!document.querySelector(".bt-main-composer[data-main-input-ready] #main-message:enabled")'))
  await main.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => /^(Continue|继续)$/u.test(button.textContent.trim()))?.click()`)
  await until('focused Main input after the startup handoff', () => main.evaluate('document.activeElement?.id === "main-message"'))
  if (motion) assert.equal(await main.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true)
  await main.call('Input.insertText', { text: 'packaged startup retry check' })
  await main.key('Enter', 13)
  await until('a Main reply after retry', () => main.evaluate('document.body.innerText.includes("收到：packaged startup retry check")'))
  await main.screenshot('startup-main-ready')
  const browser = await connect((await debuggerJson('version')).webSocketDebuggerUrl)
  browser.socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  const exit = await Promise.race([appExit, sleep(40_000, null, { ref: false })])
  assert.deepEqual(exit, { code: 0, signal: null })
  console.log(JSON.stringify({ startupRetry: 'passed', reducedMotion: Boolean(motion), appExit: exit.code, pictures }))
} finally {
  for (const socket of sockets) socket.terminate()
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (child === imageApp && debugPort) {
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).json()
        const browser = await connect(webSocketDebuggerUrl)
        browser.socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        await Promise.race([appExit, sleep(5000, null)])
        browser.socket.terminate()
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
