// Adapted from DS Bot v0.3.8 (Apache-2.0), app/src/computer-cursor.mjs.
import { statusWindow } from './status-window.mjs'

const size = 34
const cursorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;overflow:hidden}svg{display:block}</style>
<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><path d="M4 3v23l6-6 4 9 5-2-5-9h10z" fill="#2257dc" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>`)}`

export function createComputerCursor({ BrowserWindow, screen, platform }) {
  let window
  let timer
  let revision = 0
  const clear = () => {
    ++revision
    clearTimeout(timer)
    const held = window
    window = undefined
    if (held && !held.isDestroyed()) held.destroy()
  }
  return { clear, async show(point) {
    if (platform !== 'win32' && platform !== 'darwin') return false
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isSafeInteger(point.pid) || point.pid <= 0) return false
    const coordinate = { x: Math.round(point.x), y: Math.round(point.y) }
    const { x, y } = platform === 'win32' ? screen.screenToDipPoint(coordinate) : coordinate
    if (!screen.getAllDisplays().some(({ bounds }) => x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height)) return false
    clear()
    const current = revision
    const win = window = statusWindow(BrowserWindow, { x: x - 4, y: y - 3, width: size, height: size, frame: false,
      transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false })
    win.setContentProtection(true)
    win.setIgnoreMouseEvents(true)
    try { await win.loadURL(cursorPage) } catch { if (revision === current) clear(); return false }
    if (revision !== current || win.isDestroyed()) return false
    win.showInactive()
    timer = setTimeout(clear, 2500)
    return true
  } }
}
