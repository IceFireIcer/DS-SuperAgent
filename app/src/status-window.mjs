import { readFileSync } from 'node:fs'
import { PRODUCT_NAME } from './product.mjs'

const stylesheet = readFileSync(new URL('./status-window.css', import.meta.url), 'utf8')
const escapeHtml = value => value.replace(/[&<>]/gu, character => `&#${character.codePointAt(0)};`)

export function statusPage(message, { loading = true, lang = 'en', image = '' } = {}) {
  const markup = `<!doctype html><html lang="${lang === 'zh' ? 'zh' : 'en'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${PRODUCT_NAME}</title><style>${stylesheet}</style>
<body data-loading="${String(loading)}"><main role="status">
${image ? `<img src="data:image/png;base64,${image}" alt="" width="48" height="48">` : ''}
<span id="status-label">${escapeHtml(message)}</span>${loading ? '<progress aria-labelledby="status-label"></progress>' : ''}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`
}

export function statusWindow(BrowserWindow, options) {
  const window = new BrowserWindow({ ...options, show: false, resizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  return window
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
