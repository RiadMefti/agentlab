const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "orchestratorUpdates",
  Object.freeze({
    checkForUpdate: () => ipcRenderer.invoke("orchestrator:updates:check"),
    downloadUpdate: () => ipcRenderer.invoke("orchestrator:updates:download"),
    openLatestRelease: () => ipcRenderer.invoke("orchestrator:updates:open-latest"),
    restartToUpdate: () => ipcRenderer.invoke("orchestrator:updates:restart")
  })
);
