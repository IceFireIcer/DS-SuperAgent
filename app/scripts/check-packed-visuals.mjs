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
const activeMenu = '.bt-menu[role="menu"]:not([data-leaving])'
const choice = `${activeMenu} :is([role="menuitem"],[role="menuitemradio"])`

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
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.call('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
    }
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

  if (output) await mkdir(output, { recursive: true })
  const cases = []
  try {
    for (const width of [580, 1120]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 1, mobile: false })
      for (const [theme, modes] of Object.entries(themes)) {
        for (const [mode, background] of Object.entries(modes)) {
          const reducedMotion = mode === 'dark'
          const trigger = width < 640 || theme === 'deepseek' || theme === 'paper' ? folder : account
          const features = [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }]
          await cdp.call('Emulation.setEmulatedMedia', { features })
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
          await wait(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`,
            'a visible keyboard focus ring')
          await sleep(reducedMotion ? 0 : 300)
          await layout(activeMenu)
          await layout('the focused menu item', 'document.activeElement')
          if (reducedMotion) {
            assert.equal(await evaluate(`getComputedStyle(${query(activeMenu)}).animationName`), 'none')
          }
          await screenshot(`${width}-${theme}-${mode}`)
          await key('Escape', 27)
          await wait(`!${query(activeMenu)} && ${active(trigger)}`, 'Escape and menu focus restoration')
          cases.push({ width, theme, mode, reducedMotion, path: trigger === folder ? 'work directory' : 'account' })
        }
      }
    }
    await click(account)
    await wait(`Boolean(${query(activeMenu)})`, 'the account menu to reopen')
    await evaluate('document.body.click()')
    await wait(`!${query(activeMenu)} && ${active(account)}`, 'outside click and account focus restoration')

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
  console.log(`check-packed: ${JSON.stringify({ visuals: cases, nestedEscape: 'passed', focus: 'passed', outsideClick: 'passed' })}`)
}
