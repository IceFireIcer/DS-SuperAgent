import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const pixelRoundingTolerance = 2

async function packedPage(port) {
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  const page = context.pages().find(candidate => new URL(candidate.url()).hostname === '127.0.0.1' && candidate.url().startsWith('http:'))
  if (!page) {
    await browser.close()
    throw new Error('The isolated product page is unavailable.')
  }
  return { browser, context, page }
}

export async function checkPackedModelSetup(port) {
  const { browser, page } = await packedPage(port)
  const productReceipts = []
  page.on('response', async response => {
    if (!response.url().endsWith('/api/product') || response.request().method() !== 'POST') return
    const request = response.request().postDataJSON()
    if (!['settings-save', 'send', 'history', 'open'].includes(request?.endpoint)) return
    const body = await response.json().catch(() => ({}))
    productReceipts.push({ endpoint: request.endpoint, ok: body.ok, code: body.error?.code })
  })
  const modelDock = page.locator('.bt-superagent-model-dock')
  const composer = page.locator('#main-message')
  const fixtureDraft = 'Keep this Main draft before choosing a model.'
  try {
    const notice = page.getByRole('dialog').getByRole('button', { name: /^(Continue|继续)$/u })
    const choose = modelDock.getByRole('button', { name: /^(Choose a model|选择模型)$/u })
    await notice.or(choose).first().waitFor({ timeout: 10_000 })
    if (await notice.isVisible()) await notice.click()
    const opened = await page.evaluate(readMain)
    await composer.fill(fixtureDraft)
    const setup = modelDock.getByRole('button', { name: /^(Set up a model|配置模型)$/u })
    if (await setup.isVisible()) await setup.press('Enter')
    await choose.waitFor({ timeout: 10_000 })
    await choose.press('Enter')
    const settings = page.locator('.bt-superagent-settings')
    const model = page.getByRole('combobox', { name: /^(Main model|Main 模型)$/u })
    await model.waitFor({ timeout: 5000 })
    assert.ok(await model.evaluate(element => element === document.activeElement))
    const available = await model.locator('option:not([disabled])').evaluateAll(options => options
      .map(option => option.value).filter(value => value && value !== '' && !value.endsWith('/unconfigured')))
    assert.ok(available.length, 'the isolated profile exposes at least one authorized Main model')
    await model.selectOption(available[0])
    await page.getByRole('button', { name: /^(Save configuration|保存配置)$/u }).press('Enter')
    await Promise.race([modelDock.waitFor({ state: 'hidden', timeout: 10_000 }), settings.waitFor({ state: 'hidden', timeout: 10_000 })])
    console.log(`check-packed: model setup state ${JSON.stringify({ settingsVisible: await settings.isVisible(),
      dockVisible: await modelDock.isVisible(), productReceipts })}`)
    await modelDock.waitFor({ state: 'hidden', timeout: 10_000 })
    await settings.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(await composer.inputValue(), fixtureDraft)
    assert.ok(await composer.evaluate(element => element === document.activeElement))
    assert.equal((await page.evaluate(readMain)).mainSessionId, opened.mainSessionId)
    const send = page.locator('.bt-main-composer[data-main-input-ready] button[type="submit"]:enabled')
    await send.waitFor({ timeout: 8000 })
    const sent = page.waitForResponse(response => response.url().endsWith('/api/product') && response.request().method() === 'POST'
      && response.request().postDataJSON()?.endpoint === 'send', { timeout: 8000 })
    await send.click()
    const sendResponse = await sent
    const sendReceipt = await sendResponse.json()
    assert.equal(sendReceipt.ok, true, `Main rejected the fixture input: ${sendReceipt.error?.code ?? 'unknown error'}`)
    await page.waitForFunction(async ({ instanceId, fixtureDraft }) => {
      const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'history', payload: { instanceId, limit: 50 } }) })
      const { value } = await response.json()
      const input = value?.messages.find(message => message.role === 'user' && message.text === fixtureDraft)
      const reply = input && value.messages.find(message => message.id === `reply:${input.id}`)
      return input?.status === 'completed' && reply?.status === 'completed'
    }, { instanceId: opened.instanceId, fixtureDraft }, { timeout: 15_000 }).catch(async () => {
      const diagnostic = await page.evaluate(async ({ instanceId, fixtureDraft }) => {
        const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: 'history', payload: { instanceId, limit: 50 } }) })
        const { value } = await response.json()
        const input = value?.messages.find(message => message.role === 'user' && message.text === fixtureDraft)
        return { input: input?.status, reply: value?.messages.find(message => message.id === `reply:${input?.id}`)?.status,
          draftPresent: document.getElementById('main-message')?.value === fixtureDraft,
          inputError: Boolean(document.querySelector('.bt-main-composer [role="alert"]')),
          modelSetup: document.querySelector('.bt-superagent-model-dock')?.innerText,
          screen: document.body.innerText.slice(-600) }
      }, { instanceId: opened.instanceId, fixtureDraft })
      throw new Error(`The first Main reply was not visible. ${JSON.stringify(diagnostic)}`)
    })
    const receipt = await page.evaluate(async ({ instanceId, fixtureDraft }) => {
      const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'history', payload: { instanceId, limit: 50 } }) })
      const { value } = await response.json()
      const input = value?.messages.find(message => message.role === 'user' && message.text === fixtureDraft)
      const reply = input && value.messages.find(message => message.id === `reply:${input.id}`)
      return { input: input?.id, reply: reply?.id, inputStatus: input?.status, replyStatus: reply?.status }
    }, { instanceId: opened.instanceId, fixtureDraft })
    assert.ok(receipt.input && receipt.reply)
    console.log('check-packed: selected the first authorized Main model, preserved the original Main draft, and received a completed mock reply')
  } finally {
    await browser.close()
  }
}

async function readMain() {
  const response = await fetch('/api/product', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open', payload: {} }) })
  const { ok, value } = await response.json()
  if (!ok || !value?.mainSessionId) throw new Error('The product did not provide the Main Session.')
  return value
}

export async function checkPackedP0(port, windowState, output) {
  const { browser, context, page } = await packedPage(port)
  const cdp = await context.newCDPSession(page)
  const launcher = page.locator('button.bt-main-settings:visible').first()
  const dialog = page.locator('.bt-superagent-settings')
  const chooser = dialog.getByRole('button', { name: /^(Choose a page|选择设置页面)$/u })
  const search = dialog.getByRole('searchbox', { name: /^(Search settings|搜索设置)$/u })
  const status = dialog.getByRole('tab', { name: /^(Status|状态)$/u, selected: true })
  const result = dialog.getByRole('button', { name: /^(Usage › Status|用量 › 状态)$/u })
  const original = await windowState('({ size: win.getSize(), zoom: win.webContents.getZoomFactor(), minimum: win.getMinimumSize() })')
  const evidence = { minimum: original.minimum, language: await page.evaluate(() => navigator.language),
    baseDpr: await page.evaluate(() => devicePixelRatio) / original.zoom, cases: [] }
  await mkdir(output, { recursive: true })
  try {
    const cases = [[1320, 860, 1], [721, 600, 1], [719, 600, 1], [480, 440, 1],
      [508, 480, 1.25], [508, 480, 1.5], [508, 480, 2]]
    for (const [width, height, zoom] of cases) {
      const name = `${width}-${height}-${zoom}`
      const sample = { requested: [width, height], zoom }
      evidence.cases.push(sample)
      try {
        await windowState(`(win.setSize(${width}, ${height}), win.webContents.setZoomFactor(${zoom}))`)
        sample.native = await windowState('({ size: win.getSize(), content: win.getContentSize(), zoom: win.webContents.getZoomFactor() })')
        const [contentWidth] = sample.native.content
        await page.waitForFunction(expected => Math.abs(devicePixelRatio - expected.dpr) < 0.03
          && Math.abs(innerWidth - expected.width) <= 2,
        { width: contentWidth / zoom, dpr: evidence.baseDpr * zoom }, { timeout: 4000 })
        sample.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
          documentWidth: document.documentElement.scrollWidth }))
        if (width === 721 || width === 719) assert.equal(sample.viewport.width < 720, width === 719)
        await launcher.press('Enter', { timeout: 4000 })
        await dialog.waitFor({ timeout: 4000 })
        const compact = sample.viewport.width < 720
        assert.equal(await chooser.isVisible(), compact)
        if (compact) await chooser.press('Enter')
        sample.searchLabel = await search.getAttribute('aria-label')
        await search.fill(zoom === 1 ? 'backup' : '备份')
        await result.waitFor({ timeout: 4000 })
        await page.keyboard.press('Tab')
        await page.keyboard.press('Tab')
        assert.ok(await result.evaluate(element => element === document.activeElement && element.matches(':focus-visible')))
        await page.keyboard.press('Enter')
        await status.waitFor({ timeout: 4000 })
        sample.layout = await dialog.evaluate(element => {
          const rect = element.getBoundingClientRect()
          const body = element.querySelector('.bt-settings-scroll')
          const active = document.activeElement
          return { dialog: [rect.left, rect.top, rect.right, rect.bottom], contentWidth: body.clientWidth,
            contentScrollWidth: body.scrollWidth, contentHeight: body.clientHeight,
            focus: active.getAttribute('aria-label') ?? active.textContent.trim(), focusVisible: active.matches(':focus-visible') }
        })
        await page.screenshot({ path: join(output, `${name}-status.png`), timeout: 4000 })
        assert.ok(sample.layout.dialog[0] >= -pixelRoundingTolerance && sample.layout.dialog[1] >= -pixelRoundingTolerance
          && sample.layout.dialog[2] <= sample.viewport.width + pixelRoundingTolerance
          && sample.layout.dialog[3] <= sample.viewport.height + pixelRoundingTolerance
          && sample.layout.contentHeight > 0 && sample.layout.contentScrollWidth <= sample.layout.contentWidth + 1,
        'the dialog and its content fit the measured viewport')
        const { nodes } = await cdp.send('Accessibility.getFullAXTree')
        assert.ok(nodes.some(node => node.role?.value === 'tab' && /^(Status|状态)$/u.test(node.name?.value)
          && node.properties?.some(property => property.name === 'selected' && property.value?.value === true)))
        sample.status = 'passed'
      } catch (error) {
        sample.status = 'failed'
        sample.error = error.message
      } finally {
        try {
          if (await dialog.isVisible()) {
            await page.keyboard.press('Escape')
            if (await dialog.isVisible()) await page.keyboard.press('Escape')
            await dialog.waitFor({ state: 'hidden', timeout: 4000 })
          }
        } catch (error) {
          sample.status = 'failed'
          sample.error ??= error.message
          sample.cleanupError = error.message
        }
      }
    }
    await windowState(`(win.setSize(${original.size.join(', ')}), win.webContents.setZoomFactor(${original.zoom}))`)
    await launcher.press('Enter')
    const role = dialog.getByRole('button', { name: /^(Roles|角色)$/u })
    await role.press('Enter', { timeout: 4000 })
    const instructions = dialog.getByRole('textbox', { name: /^(Main instructions|Main 指令)$/u })
    await instructions.fill('Keep this isolated draft.')
    await search.fill('backup')
    await result.press('Enter')
    const confirmation = page.getByRole('alertdialog')
    const keep = confirmation.getByRole('button', { name: /^(Keep editing|继续编辑)$/u })
    const discard = confirmation.getByRole('button', { name: /^(Discard changes|放弃更改)$/u })
    await keep.waitFor({ timeout: 4000 })
    assert.ok(await keep.evaluate(element => element === document.activeElement))
    await page.keyboard.press('Shift+Tab')
    assert.ok(await discard.evaluate(element => element === document.activeElement))
    await page.keyboard.press('Escape')
    await confirmation.waitFor({ state: 'hidden' })
    assert.equal(await instructions.inputValue(), 'Keep this isolated draft.')
    await result.press('Enter')
    await discard.press('Enter')
    await status.waitFor({ timeout: 4000 })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.ok(await launcher.evaluate(element => element === document.activeElement))
    evidence.roleDraft = 'passed'
  } finally {
    try {
      await windowState(`(win.setSize(${original.size.join(', ')}), win.webContents.setZoomFactor(${original.zoom}))`)
    } finally {
      try {
        await writeFile(join(output, 'packed-p0.json'), `${JSON.stringify(evidence, null, 2)}\n`)
      } finally {
        try { await cdp.detach() } finally { await browser.close() }
      }
    }
  }
  assert.ok(evidence.cases.every(sample => sample.status === 'passed'), 'see packed-p0.json for failed viewport cases')
}
