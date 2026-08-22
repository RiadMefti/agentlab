const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "orchestratorUpdates",
  Object.freeze({
    checkForUpdate: () => ipcRenderer.invoke("orchestrator:updates:check"),
    openLatestRelease: () => ipcRenderer.invoke("orchestrator:updates:open-latest")
  })
);
