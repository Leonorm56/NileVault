const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nilevault", {
  checkConnectivity: () => ipcRenderer.invoke("check-connectivity"),
  getVersion: () => ipcRenderer.invoke("get-version"),

  // Generic key-value storage (backs the renderer storage adapter).
  kvGet: (key) => ipcRenderer.invoke("kv-get", key),
  kvSet: (key, value) => ipcRenderer.invoke("kv-set", { key, value }),
  kvRemove: (key) => ipcRenderer.invoke("kv-remove", key),
  kvGetAll: () => ipcRenderer.invoke("kv-get-all"),

  // Native file dialogs for vault backup / restore.
  saveBackupFile: (opts) => ipcRenderer.invoke("save-backup-file", opts),
  openBackupFile: () => ipcRenderer.invoke("open-backup-file"),
});
