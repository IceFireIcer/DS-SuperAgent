// Adapted and modified by DS SuperAgent from DS Bot v0.3.8 (Apache-2.0),
// app/src/computer-indicator-preload.cjs.
// The floating computer-use indicator's only window API: send a button's
// action to the main process. The main process accepts the channel from this
// window alone.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('computerIndicator', {
  act: (kind, holderId) => ipcRenderer.send('ds-superagent:computer-indicator:act', kind, holderId),
})
