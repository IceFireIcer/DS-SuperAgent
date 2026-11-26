import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const themes = {
  deepseek: { light: '#fcfcfc', dark: '#141414' },
  mono: { light: '#ffffff', dark: '#0f0f0f' },
  paper: { light: '#faf9f5', dark: '#1f1e1b' },
  moonlight: { light: '#f7f9fc', dark: '#0b1020' },
}

const settings = 'button.bt-main-settings'
const dialog = '.bt-superagent-settings'
const folder = '.bt-main-composer .bt-folder-trigger'
const account = '.bt-product-side .bt-account[aria-haspopup="menu"]'
const accountConnectors = '.bt-leftcol-foot button.bt-account:not([aria-haspopup])'
const activeMenu = '.bt-menu[role="menu"]:not([data-leaving])'
const choice = `${activeMenu} :is([role="menuitem"],[role="menuitemradio"])`
const voiceStart = '.bt-main-voice-toggle:enabled'
const voiceStage = '.bt-main-voice .bt-voice-stage'
const voiceEnd = '.bt-main-voice .bt-voice-end'
const visibleFocus = "document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'"

export async function captureInitialMainScreenshot(cdp, output) {
  await mkdir(output, { recursive: true })
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const viewport = await evaluate(`({ width: innerWidth, height: innerHeight, devicePixelRatio,
    visualScale: visualViewport?.scale ?? 1 })`)
  const file = '01-main-chat-default.png'
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(output, file), Buffer.from(data, 'base64'))
  return { viewport, screenshots: [{ file, section: 'main-chat', page: 'Main', state: 'default empty conversation' }] }
}

export async function captureApplicationScreenshots(cdp, output, initialCapture) {
  await mkdir(output, { recursive: true })
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (expression, label) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await sleep(100)
    }
    throw new Error(`The application screenshot did not show ${label}.`)
  }
  const settle = async () => {
    await evaluate(`Promise.all(Array.from(document.querySelector('.bt-settings-scroll > .bt-settings-pane:not([hidden])')?.getAnimations() ?? [])
      .filter(animation => /^bt-page-/.test(animation.animationName))
      .map(animation => animation.finished.catch(() => undefined)))`)
    await sleep(200)
  }
  const capture = async (file, section, page, tab) => {
    await settle()
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(output, file), Buffer.from(data, 'base64'))
    return { file, section, ...(page ? { page } : {}), ...(tab ? { tab } : {}) }
  }

  const screenshots = [...(initialCapture?.screenshots ?? [])]
  let index = screenshots.length
  const captureNext = async (section, page, tab) => {
    index++
    const name = [section, page, tab].filter(Boolean).join('-').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')
    const file = `${String(index).padStart(2, '0')}-${name}.png`
    screenshots.push(await capture(file, section, page, tab))
  }
  const visibleTabs = () => `Array.from(document.querySelectorAll('[role="tab"]')).filter(button => button.getClientRects().length)
    .map(button => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-selected') === 'true' }))`
  const clickTab = async patterns => {
    const candidates = await evaluate(visibleTabs())
    const candidate = candidates.find(({ label }) => patterns.some(pattern => pattern.test(label)))
    if (!candidate || candidate.selected) return candidate ?? null
    await evaluate(`(() => [...document.querySelectorAll('[role="tab"]')].find(button => button.getClientRects().length
      && button.textContent.trim() === ${JSON.stringify(candidate.label)})?.click())()`)
    await wait(`Array.from(document.querySelectorAll('[role="tab"]')).some(button => button.getClientRects().length
      && button.textContent.trim() === ${JSON.stringify(candidate.label)} && button.getAttribute('aria-selected') === 'true')`, candidate.label)
    await sleep(250)
    return candidate
  }

  const mainViews = [{ label: 'Main chat', view: 'chat', selected: true }]
  const mainTabs = await evaluate(visibleTabs())
  const mainPageTabs = mainTabs.filter(({ label }) => /^(Activity|活跃度|活動|Work|工作|Trace|轨迹|軌跡)$/iu.test(label))
  for (const tab of mainPageTabs) {
    if (tab.selected) continue
    const selected = await clickTab([new RegExp(`^${tab.label}$`, 'u')])
    if (!selected) continue
    const section = /^Activity|活跃度|活動$/iu.test(tab.label) ? 'main-activity'
      : /^Work|工作$/iu.test(tab.label) ? 'main-work' : 'main-trace'
    await captureNext(section, tab.label)
    mainViews.push({ label: tab.label, view: tab.label, selected: true })
  }
  const chatTab = await clickTab([/^(Chat|Conversation|对话|對話|聊天)$/iu])
  if (chatTab) await sleep(100)
  const boardButton = await evaluate(`Array.from(document.querySelectorAll('.bt-main-header button')).find(button =>
    button.getClientRects().length && /^(Work|工作)$/iu.test(button.textContent.trim()))?.textContent.trim() ?? null`)
  if (boardButton) {
    await evaluate(`Array.from(document.querySelectorAll('.bt-main-header button')).find(button =>
      button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(boardButton)})?.click()`)
    await wait(`Boolean(document.querySelector('.bt-work-board'))`, 'the full Work board')
    await captureNext('work-board', 'Work board')
    const returnButton = await evaluate(`Array.from(document.querySelectorAll('.bt-main-header button')).find(button =>
      button.getClientRects().length && /^(Main|主对话|主對話)$/iu.test(button.textContent.trim()))?.textContent.trim() ?? null`)
    if (returnButton) {
      await evaluate(`Array.from(document.querySelectorAll('.bt-main-header button')).find(button =>
        button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(returnButton)})?.click()`)
      await wait(`Boolean(document.querySelector('.bt-main-conversation'))`, 'Main chat after Work')
    }
  }

  await evaluate(`document.querySelector(${JSON.stringify(settings)})?.click()`)
  await wait(`Boolean(document.querySelector(${JSON.stringify(dialog)}))`, 'the settings dialog')
  const pages = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${dialog} .bt-settings-nav .bt-settings-item`)}), button => ({
    label: button.textContent.trim(),
  }))`)
  if (!pages.length) throw new Error('No settings navigation pages were found.')
  const viewport = initialCapture?.viewport ?? await evaluate(`({ width: innerWidth, height: innerHeight, devicePixelRatio,
    visualScale: visualViewport?.scale ?? 1 })`)
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]
    await evaluate(`document.querySelectorAll(${JSON.stringify(`${dialog} .bt-settings-nav .bt-settings-item`)})[${pageIndex}]?.click()`)
    await wait(`document.querySelectorAll(${JSON.stringify(`${dialog} .bt-settings-nav .bt-settings-item`)})[${pageIndex}]?.getAttribute('aria-current') === 'page' &&
      Boolean(document.querySelector('.bt-settings-scroll > .bt-settings-pane:not([hidden])'))`, page.label)
    const tabs = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${dialog} .bt-settings-tabs [role=tab]`)}), button => ({
      label: button.textContent.trim(),
    }))`)
    if (tabs.length) {
      for (let tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
        const tabSelector = `${dialog} .bt-settings-tabs [role=tab]`
        await evaluate(`document.querySelectorAll(${JSON.stringify(tabSelector)})[${tabIndex}]?.click()`)
        await wait(`document.querySelectorAll(${JSON.stringify(tabSelector)})[${tabIndex}]?.getAttribute('aria-selected') === 'true' &&
          Boolean(document.querySelector('.bt-settings-scroll > .bt-settings-pane:not([hidden])'))`, tabs[tabIndex].label)
        await captureNext('settings', page.label, tabs[tabIndex].label)
      }
    } else {
      await captureNext('settings', page.label)
    }
  }
  await evaluate(`document.querySelector(${JSON.stringify(`${dialog} .bt-settings-close`)})?.click()`)
  await wait(`!document.querySelector(${JSON.stringify(dialog)})`, 'Settings to close after capture')
  await clickTab([/^(Chat|Conversation|对话|對話|聊天)$/iu])
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ source: 'Windows x64 unpacked package',
    data: 'isolated mock-model profile', viewport, pageZoomChanged: false,
    captureArea: 'full application window', mainViews, screenshots }, null, 2)}\n`)
  console.log(`check-packed: captured ${screenshots.length} full-application views at ${viewport.width}x${viewport.height} (scale ${viewport.visualScale})`)
}

export async function checkPackedVisuals(cdp, output) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (expression, label) => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      const result = await evaluate(expression)
      if (result) return result
      await sleep(100)
    }
    throw new Error(`The packaged visual check did not show ${label}.`)
  }
  const query = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getClientRects().length)`
  const focus = async selector => {
    await evaluate(`${query(selector)}?.focus()`)
    await wait(active(selector), `focus on ${selector}`)
  }
  const click = async selector => evaluate(`${query(selector)}?.click()`)
  const active = selector => `document.activeElement?.matches(${JSON.stringify(selector)}) === true`
  const key = async (name, code) => {
    const binding = { key: name, code: name, windowsVirtualKeyCode: code }
    await cdp.call('Input.dispatchKeyEvent', { ...binding, ...(name === 'Enter' ? { type: 'keyDown', text: '\r' } : { type: 'rawKeyDown' }) })
    await cdp.call('Input.dispatchKeyEvent', { ...binding, type: 'keyUp' })
  }
  const layout = async (selector, elementExpression = query(selector)) => {
    const bounds = await evaluate(`(() => {
      const element = ${elementExpression};
      if (!element) return null;
      const {x,y,width,height,right,bottom} = element.getBoundingClientRect();
      return {x,y,width,height,right,bottom, viewport: [innerWidth, innerHeight]};
    })()`)
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= -1 && bounds.y >= -1
      && bounds.right <= bounds.viewport[0] + 1 && bounds.bottom <= bounds.viewport[1] + 1,
    `the ${selector} fits inside the viewport: ${JSON.stringify(bounds)}`)
  }
  const screenshot = async name => {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    if (output) await writeFile(join(output, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const openModels = async name => {
    assert.match(await evaluate('document.activeElement.textContent.trim()'), /^(Models and API keys|模型与 API Key)$/u)
    await key('Enter', 13)
    const providers = `${dialog} .bt-main-provider`
    await wait(`Boolean(${query(providers)})`, 'the selected Models settings page')
    await layout(dialog)
    await layout(providers)
    await key('Tab', 9)
    await wait(`document.activeElement.matches('${dialog} button.bt-settings-item') && ${visibleFocus}`, 'keyboard focus in Models settings')
    await screenshot(`${name}-models`)
    await key('Escape', 27)
    await wait(`!${query(dialog)} && ${active(account)}`, 'focus to return to the account button')
  }
  const checkVoice = async (name, reducedMotion) => {
    await evaluate(`(${installDeniedMicrophone.toString()})()`)
    try {
      await focus(voiceStart)
      await click(voiceStart)
      const status = `${voiceStage} [role="status"]`
      await wait(`Boolean(${query(`${voiceStage}[data-phase="paused"] [role="alert"]`)}?.textContent.trim())`, 'paused voice and a readable capture error')
      await layout(status)
      await layout(`${voiceStage} [role="alert"]`)
      await key('Tab', 9)
      await wait(`${active(voiceEnd)} && ${visibleFocus}`, 'Tab focus on End voice chat')
      if (reducedMotion) {
        assert.equal(await evaluate(`getComputedStyle(${query(`${voiceStage} .bt-voice-ring`)}).animationName`), 'none')
      }
      await screenshot(`${name}-voice`)
      await key('Escape', 27)
      await wait(`!${query(voiceStage)} && ${active(voiceStart)}`, 'focus to return to the Main voice button')
    } finally { await evaluate('window.__packedRestoreMicrophone()') }
  }
  const checkRoles = async name => {
    const statuses = '.bt-work-members [data-role-status]'
    await wait(`document.querySelectorAll(${JSON.stringify(statuses)}).length >= 2`, 'Main and Router role status')
    const labels = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(statuses)}), node => node.textContent.trim())`)
    assert.match(labels[0], /^(Ready|就绪)$/u)
    assert.match(labels[1], /^(Ready|就绪)$/u)
    await layout('.bt-work-members')
    await screenshot(`${name}-roles`)
  }
  const openConversationTab = label => evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(node => node.getClientRects().length && ${label}.test(node.textContent.trim()));
    if (!tab) return false;
    tab.click();
    return true;
  })()`)
  const checkEmptyWork = async name => {
    assert.equal(await openConversationTab('/^(Work|工作)$/u'), true, 'the Work view is reachable from Main')
    await wait(`Boolean(${query('.bt-work-board .bt-work-group .bt-empty')}?.textContent.trim())`, 'the empty Work view')
    const filter = '.bt-work-board .bt-work-filter'
    await evaluate(`${query(filter)}?.scrollIntoView({ block: 'start', behavior: 'instant' })`)
    await focus(`${filter} select`)
    await layout(filter)
    await layout('.bt-work-board .bt-work-group .bt-empty')
    await screenshot(`${name}-work`)
    assert.equal(await openConversationTab('/^(Chat|Conversation|对话)$/u'), true, 'the conversation tab returns to Main')
    await wait(`Boolean(${query('#main-message')})`, 'the Main input after closing Work')
  }

  const checkSettingsMotion = async reducedMotion => {
    await focus(settings)
    await click(settings)
    await wait(`Boolean(${query(`${dialog} .bt-appearance select`)})`, 'Appearance settings')
    const results = await evaluate(`(${settingsMotionCases.toString()})()`)
    for (const { label, animation, delta, active, display, box } of results) {
      assert.notEqual(display, 'contents', `${label} settings pane needs a layout box`)
      assert.ok(box.width > 0 && box.height > 0, `${label} settings pane has no visible box`)
      if (reducedMotion) assert.equal(animation, null, `${label} must not slide with reduced motion`)
      else {
        assert.ok(animation?.startsWith('bt-page-'), `${label} has no settings page animation`)
        assert.equal(active, true, `${label} page animation was not playing after navigation`)
        assert.ok(delta >= 2, `${label} did not visibly move during natural playback (${JSON.stringify({ animation, delta, box })})`)
      }
    }
    await key('Escape', 27)
    await wait(`!${query(dialog)} && ${active(settings)}`, 'focus to return from Settings')
    return results.map(({ label, animation, delta }) => ({ label, animation, delta }))
  }

  if (output) await mkdir(output, { recursive: true })
  const cases = []
  const settingsMotion = {}
  try {
    for (const width of [580, 1120]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 1, mobile: false })
      for (const [theme, modes] of Object.entries(themes)) {
        for (const [mode, background] of Object.entries(modes)) {
          const reducedMotion = mode === 'dark'
          const trigger = width < 640 || theme === 'deepseek' || theme === 'paper' ? folder : account
          const features = [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }]
          await cdp.call('Emulation.setEmulatedMedia', { features })
          if (theme === 'deepseek') {
            const results = await checkSettingsMotion(reducedMotion)
            settingsMotion[`${width}-${mode}`] = { count: results.length,
              browser: results.find(({ label }) => label === 'page:Browser'),
              browserTabs: results.filter(({ label }) => label.startsWith('Browser tab:')),
              pages: results.filter(({ label }) => label.startsWith('page:')),
              tabs: results.filter(({ label }) => label.startsWith('tab:')) }
          }
          await focus(settings)
          await click(settings)
          await wait(`Boolean(${query(`${dialog} .bt-appearance select`)})`, 'Appearance settings')
          await click(`${dialog} .bt-appearance [data-choice="${mode}"]`)
          await evaluate(`(() => {
            const select = ${query(`${dialog} .bt-appearance select`)};
            select.value = ${JSON.stringify(theme)};
            select.dispatchEvent(new Event('change', { bubbles: true }));
          })()`)
          await wait(`getComputedStyle(document.documentElement).getPropertyValue('--bt-main').trim() === ${JSON.stringify(background)}`, `${theme} ${mode} palette`)
          await key('Escape', 27)
          await wait(`!${query(dialog)} && ${active(settings)}`, 'focus to return from Settings')
          await layout('#main-message')

          await focus(trigger)
          if (trigger === folder) await key('ArrowDown', 40)
          else await click(trigger)
          await wait(`Boolean(${query(activeMenu)})`, 'the menu to open')
          await key('Home', 36)
          await wait(active(choice), 'keyboard focus in the menu')
          const first = await evaluate('document.activeElement.textContent.trim()')
          await key('ArrowDown', 40)
          assert.notEqual(await evaluate('document.activeElement.textContent.trim()'), first)
          await wait(visibleFocus, 'a visible keyboard focus ring')
          await sleep(reducedMotion ? 0 : 300)
          await layout(activeMenu)
          await layout('the focused menu item', 'document.activeElement')
          if (reducedMotion) {
            assert.equal(await evaluate(`getComputedStyle(${query(activeMenu)}).animationName`), 'none')
          }
          const name = `${width}-${theme}-${mode}`
          const paths = [trigger === folder ? 'work directory' : 'account']
          await screenshot(name)
          if (trigger === account && theme === 'mono') {
            await openModels(name)
            paths.push('models settings')
          } else {
            await key('Escape', 27)
            await wait(`!${query(activeMenu)} && ${active(trigger)}`, 'Escape and menu focus restoration')
          }
          if (theme === 'paper') {
            await checkVoice(name, reducedMotion)
            paths.push('voice activation feedback and focus return')
          }
          if (theme === 'moonlight') {
            await checkRoles(name)
            paths.push('Main and Router ready')
            if (reducedMotion === (width < 640)) {
              await checkEmptyWork(name)
              paths.push('empty Work view')
            }
          }
          cases.push({ width, theme, mode, reducedMotion, paths })
        }
      }
    }
    await click(account)
    await wait(`Boolean(${query(activeMenu)})`, 'the account menu to reopen')
    await evaluate('document.body.click()')
    await wait(`!${query(activeMenu)} && ${active(account)}`, 'outside click and account focus restoration')
    await click(account)
    await wait(active(choice), 'keyboard focus in the reopened account menu')
    await key('Tab', 9)
    await wait(`!${query(activeMenu)} && ${active(accountConnectors)} && ${visibleFocus}`, 'Tab to leave Account for Connectors')
    await screenshot('1120-moonlight-dark-account-tab')

    await focus(settings)
    await click(settings)
    const defaultDirectory = `${dialog} .bt-folder-trigger`
    await wait(`Boolean(${query(defaultDirectory)})`, 'the default directory setting')
    await focus(defaultDirectory)
    await key('ArrowDown', 40)
    await wait(`Boolean(${query(activeMenu)})`, 'the nested Settings directory menu')
    await key('ArrowDown', 40)
    await key('Escape', 27)
    await wait(`!${query(activeMenu)} && Boolean(${query(dialog)}) && ${active(defaultDirectory)}`, 'one Escape to close only the menu')
    await key('Escape', 27)
    await wait(`!${query(dialog)} && ${active(settings)}`, 'the next Escape to close Settings')
  } finally {
    await cdp.call('Emulation.setEmulatedMedia', { features: [] })
    await cdp.call('Emulation.clearDeviceMetricsOverride')
  }
  if (output) await writeFile(join(output, 'visual-cases.json'), `${JSON.stringify(cases, null, 2)}\n`)
  console.log(`check-packed: ${JSON.stringify({ visuals: cases, settingsMotion, nestedEscape: 'passed', focus: 'passed', accountTab: 'passed', outsideClick: 'passed' })}`)
}

async function settingsMotionCases() {
  const dialog = document.querySelector('.bt-superagent-settings')
  const scroll = dialog.querySelector('.bt-settings-scroll')
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const results = []
  async function select(button, kind) {
    if (button.getAttribute('aria-current') === 'page' || button.getAttribute('aria-selected') === 'true') return
    button.click()
    await frames()
    const pane = [...scroll.children].find(node => !node.hidden)
    if (!pane) throw new Error(`${button.textContent.trim()} did not select a settings content pane`)
    const box = pane.getBoundingClientRect()
    const movement = pane.getAnimations().find(animation => /^bt-page-(up|in|out)$/.test(animation.animationName))
    const start = pane.getBoundingClientRect()
    const startTime = movement?.currentTime
    await new Promise(resolve => setTimeout(resolve, 100))
    const end = pane.getBoundingClientRect()
    const endTime = movement?.currentTime
    const delta = Math.abs(start.top - end.top)
    const label = kind === 'Browser page' ? 'page:Browser' : `${kind}:${button.textContent.trim()}`
    results.push({ label, animation: movement?.animationName ?? null,
      active: movement?.playState === 'running' && typeof startTime === 'number' && typeof endTime === 'number' && endTime > startTime,
      delta, display: getComputedStyle(pane).display,
      box: { width: box.width, height: box.height } })
  }
  const pages = [...dialog.querySelectorAll('.bt-settings-nav .bt-settings-item')]
  const browser = pages.find(button => /^(?:Browser|浏览器|瀏覽器)$/u.test(button.textContent.trim()))
  if (!browser) throw new Error('The Browser settings navigation item is missing')
  await select(browser, 'Browser page')
  const browserTabs = [...dialog.querySelectorAll('.bt-settings-tabs [role=tab]')]
  if (browserTabs.length < 2) throw new Error('Browser settings must expose both child pages')
  await select(browserTabs[1], 'Browser tab')
  await select(browserTabs[0], 'Browser tab')
  for (const page of pages) {
    if (page === browser) continue
    await select(page, 'page')
    const tabs = [...dialog.querySelectorAll('.bt-settings-tabs [role=tab]')]
    if (tabs.length > 1) {
      await select(tabs[1], 'tab')
      await select(tabs[0], 'tab')
    }
  }
  return results
}

function installDeniedMicrophone() {
  const restore = []
  const replace = (target, key, value) => {
    const previous = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, value })
    restore.push(() => {
      if (previous) Object.defineProperty(target, key, previous)
      else delete target[key]
    })
  }
  replace(window, 'SpeechRecognition', class {
    start() { queueMicrotask(() => this.onerror?.({ error: 'not-allowed' })) }
    abort() {}
  })
  if (navigator.mediaDevices) {
    replace(navigator.mediaDevices, 'getUserMedia', async () => { throw new DOMException('Fixture microphone is unavailable.', 'NotAllowedError') })
  }
  window.__packedRestoreMicrophone = () => {
    for (const undo of restore.reverse()) undo()
    delete window.__packedRestoreMicrophone
  }
}
