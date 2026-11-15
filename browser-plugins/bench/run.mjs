import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { benchConfig, completeBench } from './deepseek.js'
import { runToolLoop } from '../../ds-bot/src/host/browser/loop.js'
import * as refs from '../../ds-bot/src/host/browser/refs.js'
import * as script from '../../ds-bot/src/host/browser/script.js'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import * as task from '../../ds-bot/src/host/browser/task.js'
import { startFixture } from './fixture.mjs'
import { tasks } from './tasks.mjs'

const outDir = new URL('./out/', import.meta.url)
const playwrightUrl = new URL('../node_modules/playwright/index.js', import.meta.url).href
const plugins = { refs, script, task }

const REF = /\[ref=(e\d+)\]/
const refOf = (text, pattern) => text.split('\n')
  .find(line => REF.test(line) && pattern.test(line))
  ?.match(REF)?.[1]

async function drive(session, fixture) {
  const checks = []
  const record = (id, ok, detail) => checks.push({ id, ok, detail })

  await session.open(`${fixture.origin}/`)
  let text = await session.snapshotText()
  const field = refOf(text, /textbox .*search/i)
  const button = refOf(text, /button .*search/i)
  if (!field || !button) throw new Error('the fixture search form is missing from the snapshot')
  await session.fill(field, 'cedar lamp')
  await session.click(button)
  text = await session.snapshotText()
  await session.click(refOf(text, /cedar lamp/i))
  text = await session.snapshotText()
  record('shop', text.includes('1280'), text.includes('1280') ? 'item page shows 1280' : text.slice(0, 180))

  await session.open(`${fixture.origin}/orders`)
  text = await session.snapshotText()
  await session.click(refOf(text, /next/i))
  text = await session.snapshotText()
  record('orders', /88421/.test(text) && /packed/i.test(text), 'page 2 text checked')

  await session.open(`${fixture.origin}/widget`)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    text = await session.snapshotText()
    if (text.includes('WH-441') && text.includes('DK-19')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  record('shadow', text.includes('WH-441') && text.includes('DK-19'), 'snapshot includes shadow and frame text')
  record('canvas-hidden', !text.includes('CANVAS-73'), text.includes('CANVAS-73') ? 'canvas text leaked into the snapshot' : 'canvas code is not in the text')
  const picture = await session.shot()
  if (picture.image) {
    await mkdir(outDir, { recursive: true })
    await writeFile(new URL('./canvas.jpg', outDir), Buffer.from(picture.image, 'base64'))
  }
  record('canvas-shot', Boolean(picture.image), picture.image ? 'jpeg saved' : picture.text)

  await session.open(`${fixture.origin}/account`)
  session.handoff('login', 'Sign in, then tell me to resume.')
  let blocked = false
  try {
    text = await session.snapshotText()
    await session.fill(refOf(text, /password/i), 'guessed-secret')
  } catch (error) {
    blocked = /waiting for the user/i.test(error.message)
  }
  record('login-handoff', blocked && fixture.posted.length === 0 && session.hold?.reason === 'login', blocked ? 'actions blocked, no password posted' : 'handoff did not block')
  session.resume()
  return checks
}

function bind(plugin, session) {
  return plugin.toolDefs.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args) => tool.execute(args, { session, botId: session.botId, profileDir: session.userDataDir, complete: completeBench }),
  }))
}

async function judge(task, answer, pageText) {
  if (task.check) return { ok: false, detail: 'local tasks are judged in code' }
  try {
    const response = await completeBench({
      messages: [
        { role: 'system', content: 'Judge a web agent. Reply with JSON only: {"success":true|false,"reason":"..."}.' },
        { role: 'user', content: `Task: ${task.goal('')}\nAgent answer:\n${answer || '(empty)'}\nFinal page text:\n${pageText.slice(0, 4000)}` },
      ],
    })
    const text = response.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return { ok: parsed.success === true, detail: String(parsed.reason ?? '').slice(0, 300) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function runModelTask(plugin, task, session, fixture) {
  const goal = task.goal(fixture.origin)
  const started = Date.now()
  try {
    const result = await runToolLoop({
      tools: bind(plugin, session),
      complete: completeBench,
      goal,
      system: plugin.systemPrompt,
      maxSteps: task.maxSteps,
    })
    const pageText = await session.snapshotText().catch(() => '')
    const localOk = task.check ? task.check(result.answer, { handoff: session.hold?.reason, passwords: fixture.posted }) : null
    const judged = task.check ? null : await judge(task, result.answer, pageText)
    return {
      id: task.id,
      ok: task.check ? localOk === true : judged?.ok === true,
      steps: result.steps,
      stopped: result.stopped,
      vision: result.vision,
      ms: Date.now() - started,
      answer: (result.answer || '').slice(0, 800),
      judge: judged?.detail ?? '',
      trace: result.trace.map(step => step.name),
    }
  } catch (error) {
    return {
      id: task.id,
      ok: false,
      steps: 0,
      ms: Date.now() - started,
      answer: '',
      error: error instanceof Error ? error.message : String(error),
      trace: [],
    }
  }
}

async function isolate(playwrightUrl) {
  const fixture = await startFixture()
  const profileRoot = join(tmpdir(), `bot-browser-${Date.now()}`)
  const open = (botId) => openBotBrowser({ botId, profileRoot, headless: true, playwrightUrl })
  const sessions = []
  try {
    const alpha = await open('alpha')
    sessions.push(alpha)
    await alpha.open(`${fixture.origin}/set-cookie`)
    await alpha.open(`${fixture.origin}/who`)
    const alphaText = await alpha.snapshotText()
    await alpha.close()
    const beta = await open('beta')
    sessions.push(beta)
    await beta.open(`${fixture.origin}/who`)
    const betaText = await beta.snapshotText()
    await beta.close()
    const again = await open('alpha')
    sessions.push(again)
    await again.open(`${fixture.origin}/who`)
    const againText = await again.snapshotText()
    return {
      alphaSawCookie: alphaText.includes('bot=alpha'),
      betaSawCookie: betaText.includes('bot=alpha'),
      alphaKeptCookie: againText.includes('bot=alpha'),
    }
  } finally {
    await Promise.all(sessions.map(session => session.close().catch(() => {})))
    await fixture.close().catch(() => {})
  }
}

const onlyTasks = (process.env.BENCH_TASKS ?? '').split(',').map(item => item.trim()).filter(Boolean)
const onlyPlugins = (process.env.BENCH_PLUGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
const selectedTasks = onlyTasks.length ? tasks.filter(task => onlyTasks.includes(task.id)) : tasks
const selectedPlugins = onlyPlugins.length
  ? Object.fromEntries(Object.entries(plugins).filter(([name]) => onlyPlugins.includes(name)))
  : plugins

const fixture = await startFixture()
try {
  const profileRoot = join(tmpdir(), `bot-browser-bench-${Date.now()}`)
  const driverSession = await openBotBrowser({ botId: 'driver', profileRoot, headless: true, playwrightUrl })
  let driver
  try {
    driver = await drive(driverSession, fixture)
  } finally {
    await driverSession.close().catch(() => {})
  }

  const { baseUrl, model, apiKey } = benchConfig()
  const results = {
    model: model ?? '',
    endpoint: baseUrl ?? '',
    key: apiKey ? 'present' : 'missing',
    driver,
    isolation: await isolate(playwrightUrl),
    plugins: {},
  }

  if (!baseUrl || !model || !apiKey) {
    for (const name of Object.keys(selectedPlugins)) results.plugins[name] = { skipped: 'Set BENCH_BASE_URL, BENCH_MODEL, and BENCH_API_KEY to run model tasks.' }
  } else {
    for (const [name, plugin] of Object.entries(selectedPlugins)) {
      if (name === 'script') {
        results.plugins[name] = { skipped: 'browser_exec needs an isolated script runner, which this bench does not provide.' }
        continue
      }
      const rows = []
      for (const task of selectedTasks) {
        fixture.posted.length = 0
        const session = await openBotBrowser({ botId: `${name}-${task.id}`.replace(/[^a-z0-9-]/gi, '-'), profileRoot, headless: true, playwrightUrl })
        console.log(`run ${name} ${task.id}`)
        try {
          const row = await runModelTask(plugin, task, session, fixture)
          console.log(`  ${row.ok ? 'ok' : 'fail'} steps=${row.steps} ${row.error ?? row.answer.slice(0, 80)}`)
          rows.push(row)
        } finally {
          await session.close().catch(() => {})
        }
      }
      results.plugins[name] = { rows }
    }
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(new URL('./results.json', outDir), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ key: results.key, driver: results.driver, isolation: results.isolation }, null, 2))
} finally {
  await fixture.close().catch(() => {})
}
