const { ipcRenderer } = require('electron')

if (process.isMainFrame && location.protocol === 'data:') {
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelector('button[autofocus]')?.focus()
  }, { once: true })
  window.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-startup-action]')
    if (!button || !event.isTrusted) return
    ipcRenderer.send('ds-superagent:startup-action', button.dataset.startupAction)
  })
}
