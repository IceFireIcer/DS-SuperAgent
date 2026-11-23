import { setTimeout as sleep } from 'node:timers/promises'

const MAIN_VIEW_TIMEOUT_MS = 20_000
const CROSSFADE = { duration: 220, step: 16 }

function inspectMain(focus) {
  const rendered = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
  const find = selector => Array.from(document.querySelectorAll(selector)).find(rendered)
  const composer = find('.bt-main-composer[data-main-input-ready] #main-message')
  const questions = '.bt-q-dock, [data-main-question]'
  const question = find(`${questions}, .bt-native-main-actions[data-native-main-question]`)
  const modal = find('[aria-modal="true"], dialog[open]')
  const input = composer && !composer.disabled ? composer : find(`:is(${questions}) :is(textarea, input, select, button):enabled`)
  const neutralFocus = !document.activeElement || [document.body, document.documentElement].includes(document.activeElement)
  if (focus && input && !modal && neutralFocus) {
    input.focus({ preventScroll: true, focusVisible: true })
  }
  return {
    ready: Boolean(composer || question),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches || document.body?.dataset.btMotion === 'quiet',
  }
}

export async function waitForMainView(contents) {
  const state = await Promise.race([
    contents.executeJavaScript(`(${awaitMainView.toString()})(${inspectMain.toString()}, ${MAIN_VIEW_TIMEOUT_MS})`),
    sleep(MAIN_VIEW_TIMEOUT_MS + 250, undefined, { ref: false }),
  ])
  if (!state?.ready) throw new Error('Main did not become ready. Try again to reopen the product window.')
  return state
}

function awaitMainView(inspect, timeout) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      observer.disconnect()
      resolve(inspect(false))
    }
    const ready = () => {
      const state = inspect(false)
      if (state.ready) finish()
    }
    const observer = new MutationObserver(ready)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'data-main-input-ready', 'data-main-question', 'data-native-main-question'] })
    const timer = setTimeout(finish, timeout)
    ready()
  })
}

function fadeIn(duration) {
  return document.documentElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-in-out' }).finished.then(() => {})
}

export async function handoffMain(main, start, reducedMotion, current) {
  const minimized = start.isMinimized()
  const focused = !start.isVisible() || start.isFocused()
  if (!reducedMotion && !minimized && start.isVisible()) {
    if (process.platform === 'linux') {
      const animation = main.webContents.executeJavaScript(`(${fadeIn.toString()})(${CROSSFADE.duration})`).catch(() => {})
      main.showInactive()
      await Promise.race([animation, sleep(CROSSFADE.duration + 250, undefined, { ref: false })])
    } else {
      main.setOpacity(0)
      main.showInactive()
      if (focused) start.moveTop()
      const began = performance.now()
      while (current() && !start.isDestroyed() && !start.isMinimized()) {
        const time = Math.min(1, (performance.now() - began) / CROSSFADE.duration)
        const eased = time * time * (3 - 2 * time)
        main.setOpacity(eased)
        start.setOpacity(1 - eased)
        if (time === 1) break
        await sleep(CROSSFADE.step)
      }
      if (!main.isDestroyed()) main.setOpacity(1)
      if (!start.isDestroyed()) start.setOpacity(1)
    }
  }
  if (!current()) return
  if (minimized || start.isMinimized()) {
    if (!main.isVisible()) main.showInactive()
    main.minimize()
  } else if (focused && (!start.isVisible() || start.isFocused())) {
    main.show()
    main.focus()
    main.webContents.focus()
  } else if (!main.isVisible()) {
    main.showInactive()
  }
  if (!main.isMinimized()) await main.webContents.executeJavaScript(`(${inspectMain.toString()})(true)`).catch(() => {})
}
