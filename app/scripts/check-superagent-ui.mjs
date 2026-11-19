import assert from 'node:assert/strict'
import { chromium } from 'playwright'

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
    const main = page.locator('.bt-main-conversation')
    const transcript = main.locator('.bt-main-messages')
    await main.locator('.bt-main-composer textarea').waitFor().catch(() => {
      const diagnostic = errors.join('\n').replace(/([?&]token=)[^\s]+/gu, '$1[redacted]')
      throw new Error(`Product Main did not mount in Chromium. ${diagnostic}`)
    })
    await main.locator('.bt-main-work').first().waitFor()
    assert.equal(await page.locator('.bt-main-composer textarea').count(), 1)
    const message = 'Hello from the browser check.'
    const composer = main.locator('.bt-main-composer textarea')
    await composer.fill(message)
    await composer.press('Enter')
    await transcript.getByText(message, { exact: true }).waitFor()
    await transcript.getByText('Main answered the browser check.', { exact: true }).waitFor()
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
    assert.ok(requests.includes('/api/product'))
    assert.ok(requests.every(path => !path.endsWith('/api/bot')))
    await main.locator('.bt-main-settings').click()
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
    await main.locator('.bt-product-head button').click()
    await page.locator('.bt-observation').waitFor()
    await page.locator('.bt-observation .bt-product-head button').click()
    await main.waitFor()
    assert.deepEqual(errors.filter(error => !error.startsWith(
      '[session-controller] control stream failed: RemoteError: typert gateway: session/control: active Service "sessionController" is unavailable')), [])
    console.log('Product UI passed in Chromium.')
  } finally {
    await browser.close()
  }
}
