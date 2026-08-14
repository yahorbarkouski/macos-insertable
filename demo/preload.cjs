const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('island', {
  onState: (fn) => ipcRenderer.on('state', (_event, state) => fn(state)),
  onLog: (fn) => ipcRenderer.on('log', (_event, entry) => fn(entry)),
  onActing: (fn) => ipcRenderer.on('acting', (_event, kind) => fn(kind)),
  act: (kind) => ipcRenderer.send('act', kind)
})
