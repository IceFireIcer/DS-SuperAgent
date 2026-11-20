// Adapted and modified by DS SuperAgent from DS Bot v0.3.8 (Apache-2.0), app/src/window-frame.mjs.
// The frameless window: the system window controls overlay a band at the top of the page, as
// in DeepSeek Harness apps/desktop (windows-layout.ts and main.ts; see NOTICE). Linux keeps
// the system title bar.

/** Height of the caption band in device-independent pixels. */
export const CAPTION_HEIGHT = 40

/** The traffic lights, 14 px high, centred in the band. */
export const TRAFFIC_LIGHTS = { x: 16, y: (CAPTION_HEIGHT - 14) / 2 }

/** Whether the window draws the page under its own window controls. */
export const framelessOn = platform => platform === 'win32' || platform === 'darwin'

/** The material behind the page: Mica on Windows 11 22H2+, sidebar vibrancy on macOS. */
export function materialOf(platform, release) {
  if (platform === 'darwin') return 'vibrancy'
  return platform === 'win32' && Number(String(release).split('.')[2] ?? 0) >= 22621 ? 'mica' : undefined
}

/** Electron's Mica backdrop needs the system backdrop of Windows 11 22H2 (build 22621). */
export const micaAvailable = (platform, release) => materialOf(platform, release) === 'mica'

/** The BrowserWindow options of the frame; `caption` holds the Windows button colors. */
export function frameOptions(platform, material, caption) {
  if (platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { height: CAPTION_HEIGHT, ...caption },
      ...(material === 'mica' ? { backgroundMaterial: 'mica' } : {}) }
  }
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: 'sidebar', visualEffectState: 'active' }
  }
  return {}
}

/** Put macOS vibrancy back after hiding or minimizing, without painting the desktop first. */
export function keepVibrancy(win, fill) {
  const apply = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized() || !win.isVisible()) {
      win.setVibrancy(null)
      win.setBackgroundColor(fill())
    } else {
      win.setVibrancy('sidebar')
      win.setBackgroundColor('#00000000')
    }
  }
  for (const event of ['minimize', 'hide', 'restore', 'show']) win.on(event, apply)
}

const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu
/** Only plain CSS colors cross from the page to the caption buttons. */
export const cssColor = value => typeof value === 'string' && COLOR.test(value)

/** The theme sources that the native theme accepts; a theme id has no native counterpart. */
export const nativeThemeSource = value => (value === 'light' || value === 'dark' || value === 'system' ? value : undefined)
