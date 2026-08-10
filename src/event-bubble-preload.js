const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eventBubbleApi', {
  showMainWindow: () => ipcRenderer.invoke('event-bubble:show-main-window'),
  hide: () => ipcRenderer.invoke('event-bubble:hide'),
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('event-bubble:update', listener);
    return () => ipcRenderer.removeListener('event-bubble:update', listener);
  }
});
