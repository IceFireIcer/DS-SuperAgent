import assert from 'node:assert/strict'
import { chromium } from 'playwright'

async function checkAccountOnboarding(page, settings, composer) {
  const account = page.locator('.bt-product-side').getByRole('button', { name: /^(Account|账户|账号)$/u })
  const menu = page.getByRole('menu', { name: /^(Account|账户|账号)$/u })
  const connectors = page.locator('.bt-product-side').getByRole('button', { name: /^(Connectors|连接器)$/u })
  await account.press('Enter', { timeout: 5000 }).catch(async () => {
    const available = await page.locator('aside, nav').evaluateAll(elements => elements.map(element => ({
      label: element.getAttribute('aria-label'),
      buttons: [...element.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? button.textContent),
    })))
    throw new Error(`Account trigger did not mount. ${JSON.stringify(available)}`)
  })
  await menu.getByRole('menuitem').first().waitFor()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await settings.getByRole('tab', { name: /^(Scheduled tasks|定时任务)$/u, selected: true }).waitFor()
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  await account.evaluate(element => { if (document.activeElement !== element) throw new Error('Account focus was not restored.') })
  await connectors.click()
  await settings.locator('[aria-current="page"]').getByText(/^(Connectors|连接器)$/u).waitFor()
  await page.locator('.bt-settings-layer .bt-scrim').click({ position: { x: 3, y: 3 } })
  await settings.waitFor({ state: 'hidden' })

  let saved = false
  const setupRoute = async route => {
    const { endpoint, payload } = route.request().postDataJSON()
    if (endpoint === 'provider-key') {
      assert.ok(payload.provider === 'deepseek-official' && payload.value === 'fixture-provider-value')
      saved = true
      return route.fulfill({ json: { ok: true, value: { provider: payload.provider, configured: true } } })
    }
    if (endpoint !== 'settings') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    if (body.ok) {
      const provider = 'deepseek-official'
      const model = 'fixture-model'
      body.value.roles.main.model = { provider, model }
      body.value.providers = [{ id: provider, name: 'DeepSeek', key: { configured: saved, writable: true },
        models: [{ provider, model, ref: `${provider}/${model}`, name: 'Fixture model' }] }, ...body.value.providers]
    }
    return route.fulfill({ response, json: body })
  }
  await page.route('**/api/product', setupRoute)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await page.reload()
    const keyAction = page.getByRole('button', { name: /^(Enter a DeepSeek API key|填入 DeepSeek API key)$/u })
    await keyAction.waitFor()
    const login = page.locator('.bt-superagent-model-dock').getByRole('button', { name: /^(Sign in to DeepSeek|登录 DeepSeek 账号)$/u })
    await login.waitFor({ timeout: 5000 })
    await login.press('Enter')
    const signInDialog = page.getByRole('dialog')
    await signInDialog.waitFor({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await signInDialog.waitFor({ state: 'hidden' })
    assert.equal(await login.evaluate(element => document.activeElement === element), true)
    const draft = 'Keep the draft across model setup.'
    await composer.fill(draft)
    await keyAction.press('Enter')
    const keyField = page.locator('.bt-main-model-key input')
    assert.equal(await keyField.evaluate(element => getComputedStyle(element.form).animationName), 'none')
    await keyField.press('Escape')
    await keyField.waitFor({ state: 'hidden' })
    assert.equal(await keyAction.evaluate(element => document.activeElement === element), true)
    await keyAction.press('Enter')
    await keyField.fill('fixture-provider-value')
    await keyField.press('Enter')
    await keyAction.waitFor({ state: 'hidden' })
    assert.equal(saved, true)
    assert.equal(await composer.inputValue(), draft)
    assert.equal(await composer.evaluate(element => document.activeElement === element), true)
  } finally {
    await page.unroute('**/api/product', setupRoute)
  }
}

export async function checkProductUi(ctx) {
  const channel = process.env.PLAYWRIGHT_CHANNEL
  const browser = await chromium.launch(channel ? { channel } : {})
  try {
    const page = await browser.newPage()
    const errors = []
    const requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      const text = message.text()
      if (message.type() === 'error' && /superagent|plugin|slot/iu.test(text)) errors.push(text)
    })
    page.on('request', request => requests.push(new URL(request.url()).pathname))
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)
    await page.goto(url).catch(() => { throw new Error('Could not load the isolated DSH profile in Chromium.') })
    const main = page.locator('.bt-native-main-input')
    const transcript = page.locator('[data-chat-flow]').first()
    await main.locator('.bt-main-composer textarea').waitFor({ timeout: 12000 }).catch(async () => {
      const diagnostic = JSON.stringify({ errors, requests: [...new Set(requests)],
        screen: (await page.locator('body').innerText()).slice(0, 800) }).replace(/([?&]token=)[^\s"]+/gu, '$1[redacted]')
      throw new Error(`Product Main did not mount in Chromium. ${diagnostic}`)
    })
    await transcript.locator('.bt-native-turn-cards .bt-main-work').first().waitFor()
    await transcript.locator('[data-chat-flow-kind="tool-call"]').first().waitFor()
    const opened = await ctx.superagentProduct.dispatch('open')
    assert.equal(Boolean(ctx.agents.get(opened.mainSessionId)), false, 'Opening Main in the browser does not activate its Agent')
    assert.equal(await page.locator('.bt-main-composer textarea:visible').count(), 1)
    const members = main.getByRole('group', { name: /^(Work members|工作成员)$/u })
    await members.getByText(/^(Main|主角色)$/u).waitFor()
    await members.getByText(/^(Router|路由角色)$/u).waitFor()
    const work = transcript.locator('.bt-native-turn-cards .bt-main-work').first()
    await work.getByRole('button', { name: /View original request|查看原始请求/u }).click()
    await work.locator('.bt-main-evidence pre').getByText('Create and verify two local notes independently.').waitFor()
    await work.getByRole('button', { name: /View tool facts|查看工具事实/u }).click()
    await page.locator('.bt-observation-event').first().waitFor()
    await page.locator('.bt-observation-header button').first().click()
    await transcript.waitFor()
    const message = 'Hello from the browser check.'
    const composer = main.locator('.bt-main-composer textarea')
    await composer.fill(message)
    await composer.press('Enter')
    await transcript.getByText(message, { exact: true }).waitFor({ timeout: 12000 }).catch(async error => {
      const binding = await ctx.superagentProduct.dispatch('open')
      const history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId, limit: 25 })
      const diagnostic = JSON.stringify({ status: history.messages.find(item => item.text === message)?.status,
        inputErrors: await main.locator('[role="alert"]').allTextContents(), errors, requests: [...new Set(requests)] })
        .replace(/([?&]token=)[^\s"]+/gu, '$1[redacted]')
      throw new Error(`Main input did not render. ${diagnostic}`, { cause: error })
    })
    await transcript.getByText('Main answered the browser check.', { exact: true }).waitFor()
    const reply = transcript.getByText('Main answered the browser check.', { exact: true })
    const turn = reply.locator('xpath=ancestor::*[@data-chat-flow-kind="assistant-step"]/preceding-sibling::*[@data-step-process][1]')
    if (await turn.count()) {
      const group = turn.locator('button[aria-expanded="false"]').first()
      if (await group.isVisible()) await group.click()
    }
    await transcript.locator('[data-variant="think"]').getByRole('button').last().click()
    await transcript.locator('.bt-think-text').getByText('Consider the browser fixture.', { exact: true }).waitFor()
    await page.reload()
    await transcript.getByText(message, { exact: true }).waitFor()
    const slowMessage = 'Wait for the browser to stop this reply.'
    await composer.fill(slowMessage)
    await composer.press('Enter')
    const stop = main.locator('[data-action="stop-main"]')
    await stop.click()
    await transcript.getByText(slowMessage, { exact: true }).waitFor()
    await stop.waitFor({ state: 'hidden' })
    const binding = await ctx.superagentProduct.dispatch('open')
    const history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId, limit: 25 })
    assert.equal(history.messages.find(item => item.text === slowMessage)?.status, 'stopped')
    const original = history.messages.find(item => item.text === message)
    assert.ok(original)
    await page.route('**/api/product', async route => {
      if (route.request().postDataJSON().endpoint !== 'history') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      if (!body.ok) return route.fulfill({ response })
      body.value.sources.push({ id: 'fixture-handoff', sourceInstanceId: 'github:fixture', sourceEventId: 'fixture-event',
        mainMessageId: original.id, conditions: [], state: 'presented', text: 'Fixture source evidence', reference: 'fixture',
        objectId: 'fixture-issue', authorId: 'fixture-author' })
      body.value.preparations.push({ id: 'fixture-preparation', sourceInstanceId: 'github:fixture', eventId: 'fixture-event',
        ruleId: 'fixture-rule', summary: 'Fixture preparation evidence' })
      return route.fulfill({ response, json: body })
    })
    const anchored = transcript.locator('.bt-native-turn-cards').filter({ hasText: 'Fixture source evidence' })
    await anchored.getByText('Fixture preparation evidence').waitFor()
    assert.equal(await anchored.count(), 1)
    await page.unroute('**/api/product')
    assert.ok(requests.includes('/api/product'))
    assert.ok(requests.every(path => !path.endsWith('/api/bot')))
    await page.locator('.bt-native-main-actions .bt-main-settings').click()
    const settings = page.locator('.bt-superagent-settings')
    await settings.locator('.bt-appearance').waitFor()
    const theme = settings.locator('.bt-appearance select')
    const palettes = [
      { theme: 'deepseek', light: '#fcfcfc', dark: '#141414' },
      { theme: 'mono', light: '#ffffff', dark: '#0f0f0f' },
      { theme: 'paper', light: '#faf9f5', dark: '#1f1e1b' },
      { theme: 'moonlight', light: '#f7f9fc', dark: '#0b1020' },
    ]
    for (const palette of palettes) {
      await theme.selectOption(palette.theme)
      for (const mode of ['light', 'dark']) {
        await settings.locator(`.bt-appearance button[data-choice="${mode}"]`).click()
        await page.waitForFunction(color => getComputedStyle(document.documentElement).getPropertyValue('--bt-main').trim() === color, palette[mode])
      }
    }
    assert.equal(await settings.locator('.bt-settings-group').count(), 5)
    assert.equal(await settings.locator('.bt-settings-item').count(), 21)
    await settings.getByRole('button', { name: /Built-in plugins|内置插件/u }).click()
    await settings.locator('.bt-settings-page').getByText('ds-superagent', { exact: true }).waitFor()
    await settings.getByRole('button', { name: /^(Connectors|连接器)$/u }).click()
    await settings.locator('.bt-settings-page').getByText('GitHub', { exact: true }).waitFor()
    await settings.getByRole('button', { name: /^(IM|即时通信)$/u }).click()
    await settings.locator('.bt-settings-page option[value="telegram"]').waitFor({ state: 'attached', timeout: 5000 }).catch(async error => {
      const pageText = await settings.locator('.bt-settings-page').innerText()
      throw new Error(`IM settings did not list platform options. ${pageText}`, { cause: error })
    })
    await settings.getByRole('button', { name: /^(Capability library|能力库)$/u }).click()
    await settings.locator('.bt-settings-page').getByRole('button', { name: /^(Save capability|保存能力)$/u }).waitFor()
    const groups = settings.locator('.bt-settings-item')
    for (let index = 0; index < await groups.count(); index++) {
      await groups.nth(index).click()
      await settings.locator('.bt-settings-page').waitFor()
      const tabs = settings.getByRole('tab')
      if (await tabs.count()) {
        assert.equal(await tabs.count(), 2)
        await tabs.last().click()
        assert.equal(await tabs.last().getAttribute('aria-selected'), 'true')
      }
    }
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: /^(Work|工作)$/u }).click()
    const board = page.locator('.bt-work-board')
    await board.getByRole('heading', { name: /profile-alpha\.txt/u }).waitFor()
    assert.equal(await board.getByRole('region').count(), 5)
    await page.reload()
    const workTab = page.getByRole('tab', { name: /^(Work|工作)$/u })
    await workTab.waitFor()
    if (await workTab.getAttribute('aria-selected') === 'false') await workTab.click()
    await board.getByRole('heading', { name: /profile-beta\.txt/u }).waitFor()
    await page.getByRole('tab', { name: /^(Activity|活跃度)$/u }).click()
    await page.locator('.bt-observation').waitFor()
    await page.locator('.bt-observation-header button').first().click()
    await transcript.waitFor()
    await composer.fill('Preserve this unsent Main draft.')
    await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'browser-question', text: 'Ask a browser fixture question.' })
    const answer = main.locator('.bt-q textarea')
    await answer.waitFor()
    assert.equal(await composer.count(), 0)
    assert.equal(await page.locator('textarea:visible').count(), 1)
    await answer.fill('Blue')
    await main.locator('.bt-q button[type="submit"]').click()
    await composer.waitFor()
    assert.equal(await composer.inputValue(), 'Preserve this unsent Main draft.')
    await composer.fill('Fail this browser fixture turn.')
    await composer.press('Enter')
    await transcript.locator('[data-chat-flow-kind="turn-error"] .bt-main-system-fact').first().waitFor()
    await checkAccountOnboarding(page, settings, composer)
    assert.deepEqual(errors.filter(error => !error.startsWith(
      '[session-controller] control stream failed: RemoteError: typert gateway: session/control: active Service "sessionController" is unavailable')), [])
    console.log('Product UI passed in Chromium.')
  } finally {
    await browser.close()
  }
}
