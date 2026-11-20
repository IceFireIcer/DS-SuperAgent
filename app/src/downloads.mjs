// A file the main window downloads asks where it should go first. Downloads from
// any other contents (the sign-in child, a browser resource guest) keep their own
// session's rules.
import { join } from 'node:path'

export function downloadSaver({ window, dialog, downloads, report = () => {} }) {
  return (event, item, source) => {
    // The window is asked for at the moment of the download: the app may build a new one.
    const owner = typeof window === 'function' ? window() : window
    if (owner === undefined || owner === null || source !== owner.webContents) return
    const name = item.getFilename().split(/[/\\]/u).at(-1).replace(/[\u0000-\u001f\u007f:]/gu, '_').replace(/[. ]+$/u, '')
    const filename = !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ? 'download' : name
    try {
      const file = dialog.showSaveDialogSync(owner, { defaultPath: join(downloads, filename) })
      if (file === undefined) { event.preventDefault(); return }
      item.setSavePath(file)
      item.once?.('done', (_event, state) => {
        if (state === 'completed') report('DOWNLOAD_COMPLETED')
        if (state === 'interrupted') report('DOWNLOAD_INTERRUPTED')
      })
    } catch {
      event.preventDefault()
      report('DOWNLOAD_SAVE_FAILED')
    }
  }
}
