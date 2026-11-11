const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('codexFerry', {
  action: (name, value) => ipcRenderer.invoke('codex-action', name, value),
  state: () => ipcRenderer.invoke('codex-state'),
  onState: callback => ipcRenderer.on('codex-state', (_event, state) => callback(state)),
  onFeedback: callback => ipcRenderer.on('codex-feedback', (_event, value) => callback(value)),
});
