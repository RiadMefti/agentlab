import { resolve } from "node:path";

import {
  createOrchestratorServer,
  loadConfig,
  type OrchestratorServerOptions
} from "@orchestrator/server/runtime";
import { app, BrowserWindow, Menu } from "electron";

import { withDesktopDefaults } from "./desktop-environment.js";
import { isTrustedAppUrl } from "./navigation.js";

type OrchestratorServer = Awaited<ReturnType<typeof createOrchestratorServer>>;

let mainWindow: BrowserWindow | null = null;
let server: OrchestratorServer | null = null;
let serverUrl: string | null = null;
let shutdownStarted = false;

app.enableSandbox();

void startDesktop().catch(async (error: unknown) => {
  console.error("Failed to start Orchestrator.", error);
  await server?.close().catch(() => undefined);
  server = null;
  app.exit(1);
});

async function startDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  registerLifecycleHandlers();
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const environment = withDesktopDefaults(process.env, {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath("userData")
  });
  const config = loadConfig(environment, process.cwd());
  const serverOptions: OrchestratorServerOptions = {
    databasePath: config.databasePath,
    workspace: config.workspace,
    logger: !app.isPackaged,
    webRoot: resolve(app.getAppPath(), "apps/web/dist")
  };

  server = await createOrchestratorServer(serverOptions);
  serverUrl = await server.listen({ host: config.host, port: config.port });
  mainWindow = createWindow(serverUrl);
  await mainWindow.loadURL(serverUrl);
  console.info(`Orchestrator desktop ready at ${serverUrl}`);
}

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: "Orchestrator",
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: true,
      contextIsolation: true,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false
    }
  });

  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedAppUrl(destination, url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, destination) => {
    if (!isTrustedAppUrl(destination, url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function registerLifecycleHandlers(): void {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (mainWindow === null && serverUrl !== null) {
      mainWindow = createWindow(serverUrl);
      void mainWindow.loadURL(serverUrl);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (server === null || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();

    const activeServer = server;
    server = null;
    void activeServer
      .close()
      .catch((error: unknown) => {
        console.error("Failed to stop the local server cleanly.", error);
      })
      .finally(() => {
        app.quit();
      });
  });
}
