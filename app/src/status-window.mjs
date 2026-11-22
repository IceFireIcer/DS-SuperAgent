import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PRODUCT_NAME } from './product.mjs'

const stylesheet = readFileSync(new URL('./status-window.css', import.meta.url), 'utf8')
const startupPreload = fileURLToPath(new URL('./startup-preload.cjs', import.meta.url))
const escapeHtml = value => value.replace(/[&<>]/gu, character => `&#${character.codePointAt(0)};`)

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

export function statusWindow(BrowserWindow, options, preload) {
  const window = new BrowserWindow({ ...options, show: false, resizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, ...(preload ? { preload } : {}) } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  return window
}

export function createStartupScreen({ BrowserWindow, ipcMain, icon, image, lang, quitting, quit }) {
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
        const active = statusWindow(BrowserWindow, { title: PRODUCT_NAME, icon, width: 424, height: 254, autoHideMenuBar: true }, startupPreload)
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
      const page = { actions, answer: Promise.withResolvers(), url: statusPage(message, { loading: detail === undefined, detail, actions, lang: lang(), image: image() }) }
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
