import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PRODUCT_NAME } from './product.mjs'

const stylesheet = readFileSync(new URL('./status-window.css', import.meta.url), 'utf8')
const startupStylesheet = readFileSync(new URL('./startup-window.css', import.meta.url), 'utf8')
const startupTemplate = readFileSync(new URL('./startup-window.html', import.meta.url), 'utf8')
const startupLogo = readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8')
const startupPreload = fileURLToPath(new URL('./startup-preload.cjs', import.meta.url))
const escapeHtml = value => value.replace(/[&<>]/gu, character => `&#${character.codePointAt(0)};`)
const logoMarkup = `<svg class="whale-svg" viewBox="0 0 1600 945" aria-hidden="true" focusable="false">${
  startupLogo.replace(/^<svg[^>]*>\s*/u, '').replace(/<\/svg>\s*$/u, '')
}</svg>`
export const STARTUP_SIZE = { width: 720, height: 540 }
export const SHORT_STARTUP_SIZE = { width: 720, height: 500 }
const SHORT_WORK_AREA = 588

export function statusPage(message, { loading = true, lang = 'en', image = '', detail, actions = [] } = {}) {
  const failure = detail !== undefined
  const markup = `<!doctype html><html lang="${lang === 'zh' ? 'zh' : 'en'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${PRODUCT_NAME}</title><style>${stylesheet}</style>
<body data-status="${failure ? 'failure' : loading ? 'loading' : 'notice'}"><main${failure ? '' : ' role="status"'}>
${image && !failure ? `<img src="data:image/png;base64,${image}" alt="" width="48" height="48">` : ''}
<span id="status-label"${failure ? ' role="alert"' : ''}>${escapeHtml(message)}</span>
${failure ? `<p class="status-detail">${escapeHtml(detail)}</p>` : ''}
${loading ? '<progress aria-labelledby="status-label"></progress>' : ''}
${actions.length ? `<div class="status-actions">${actions.map(({ action, label }, index) => `<button type="button" data-startup-action="${action}"${index === 0 ? ' autofocus' : ''}>${escapeHtml(label)}</button>`).join('')}</div>` : ''}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`
}

export function startupWindowBounds(area) {
  const size = area.height < SHORT_WORK_AREA ? SHORT_STARTUP_SIZE : STARTUP_SIZE
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

export function startupPage(message, { loading = true, lang = 'en', detail, actions = [] } = {}) {
  const failure = detail !== undefined
  const kind = failure ? 'failure' : loading ? 'loading' : 'notice'
  const buttons = actions.map(({ action, label }, index) =>
    `<button type="button" data-startup-action="${escapeHtml(action)}"${index === 0 ? ' autofocus' : ''}>${escapeHtml(label)}</button>`).join('')
  const status = loading && !failure
    ? `<p class="sr" role="status">${escapeHtml(message)}</p>
<section class="status-panel" role="alert" hidden></section>`
    : `<section class="status-panel" role="${failure ? 'alert' : 'status'}">
<p class="status-message">${escapeHtml(message)}</p>
${failure ? `<p class="status-detail">${escapeHtml(detail)}</p>` : ''}
${buttons ? `<div class="status-actions">${buttons}</div>` : ''}
</section>`
  const markup = startupTemplate
    .replace('__LANG__', lang === 'zh' ? 'zh' : 'en')
    .replace('__TITLE__', escapeHtml(PRODUCT_NAME))
    .replace('__STYLE__', startupStylesheet)
    .replace('__STATUS__', kind)
    .replace('__LOGO__', logoMarkup)
    .replace('__STATUS_PANEL__', status)
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`
}

export function statusWindow(BrowserWindow, options, preload) {
  const window = new BrowserWindow({ ...options, show: false, resizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, ...(preload ? { preload } : {}) } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  return window
}

function startupWindowOptions({ icon, screen, nativeTheme, mica }) {
  const area = screen?.getPrimaryDisplay?.().workArea ?? { x: 0, y: 0, ...STARTUP_SIZE }
  const dark = nativeTheme?.shouldUseDarkColors === true
  const color = dark ? '#141414' : '#fcfcfc'
  const ink = dark ? '#f2f2f2' : '#141414'
  const frame = process.platform === 'win32' ? {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 40, color: mica ? '#00000000' : color, symbolColor: ink },
    ...(mica ? { backgroundMaterial: 'mica' } : {}),
  } : {}
  return {
    title: PRODUCT_NAME,
    icon,
    ...startupWindowBounds(area),
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: mica ? '#00000000' : color,
    ...frame,
  }
}

export function createStartupScreen({ BrowserWindow, ipcMain, icon, lang, quitting, quit, screen, nativeTheme, mica }) {
  let window
  let currentPage
  let loading = Promise.resolve()

  ipcMain.on('ds-superagent:startup-action', (event, action) => {
    const contents = window?.webContents
    const page = currentPage
    if (!contents || !page || event.sender !== contents || event.senderFrame !== contents.mainFrame
      || event.senderFrame?.url !== page.url || !page.actions.some(choice => choice.action === action)) return
    page.answer.resolve(action)
  })

  const clearPage = () => {
    currentPage?.answer.resolve(undefined)
    currentPage = undefined
  }
  const close = () => {
    const active = window
    window = undefined
    clearPage()
    if (active && !active.isDestroyed()) active.destroy()
  }

  return {
    close,
    window: () => window,
    async show(message, { detail, actions = [] } = {}) {
      if (quitting()) return undefined
      if (!window) {
        const active = statusWindow(BrowserWindow, startupWindowOptions({ icon, screen, nativeTheme, mica }), startupPreload)
        window = active
        active.on('close', event => {
          if (quitting()) return
          event.preventDefault()
          quit()
        })
        active.once('closed', () => { if (window === active) close() })
      }
      const active = window
      clearPage()
      const page = { actions, answer: Promise.withResolvers(), url: startupPage(message, { loading: detail === undefined, detail, actions, lang: lang() }) }
      currentPage = page
      loading = loading.then(async () => {
        if (currentPage !== page || active.isDestroyed() || quitting()) return
        try { await active.loadURL(page.url) }
        catch { if (currentPage === page) close() }
      })
      await loading
      if (currentPage !== page || active.isDestroyed() || quitting()) return undefined
      if (!active.isVisible()) active.show()
      return actions.length ? page.answer.promise : undefined
    },
  }
}

export function createComputerIndicator({ BrowserWindow, screen, icon, message, lang }) {
  let window
  const hide = () => {
    const active = window
    window = undefined
    if (active && !active.isDestroyed()) active.destroy()
  }
  return {
    hide,
    async show() {
      if (window) return window.isVisible()
      const work = screen.getPrimaryDisplay().workArea
      const width = Math.min(320, work.width)
      const height = 54
      const overlay = statusWindow(BrowserWindow, { title: PRODUCT_NAME, icon, width, height,
        x: work.x + Math.round((work.width - width) / 2), y: work.y + 12, frame: false, focusable: false,
        hasShadow: true, skipTaskbar: true, alwaysOnTop: true, roundedCorners: true })
      window = overlay
      overlay.once('closed', () => { if (window === overlay) window = undefined })
      overlay.setIgnoreMouseEvents(true)
      overlay.setContentProtection?.(true)
      try {
        await overlay.loadURL(statusPage(message(), { loading: false, lang: lang() }))
        if (window !== overlay || overlay.isDestroyed()) return false
        overlay.showInactive()
        return overlay.isVisible()
      } catch { if (window === overlay) hide(); return false }
    },
  }
}
