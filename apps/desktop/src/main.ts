import { resolve } from "node:path";

import {
  createOrchestratorServer,
  loadConfig,
  type OrchestratorServerOptions
} from "@orchestrator/server/runtime";
import { app, BrowserWindow, dialog, Menu, nativeTheme, session } from "electron";

import { withDesktopDefaults } from "./desktop-environment.js";
import { synchronizeNativeWindowTheme } from "./initial-window-theme.js";
import { registerNativeThemeSynchronization } from "./native-theme-synchronizer.js";
import { isTrustedAppUrl } from "./navigation.js";
import { ShutdownGate } from "./shutdown-gate.js";
import { ensureDesktopWorkspace } from "./workspace-selection.js";

type OrchestratorServer = Awaited<ReturnType<typeof createOrchestratorServer>>;

let mainWindow: BrowserWindow | null = null;
let server: OrchestratorServer | null = null;
let serverUrl: string | null = null;
const shutdown = new ShutdownGate();
const appearanceCookieUrl = "http://127.0.0.1/";

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
  await synchronizeNativeWindowTheme(
    session.defaultSession.cookies,
    nativeTheme,
    appearanceCookieUrl
  );
  registerNativeThemeSynchronization(
    session.defaultSession.cookies,
    nativeTheme,
    BrowserWindow,
    appearanceCookieUrl,
    (error) => {
      console.error("Failed to synchronize the native appearance.", error);
    }
  );
  Menu.setApplicationMenu(null);

  const defaults = withDesktopDefaults(process.env, {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath("userData")
  });
  const environment = await ensureDesktopWorkspace(defaults, app.isPackaged, selectWorkspace);
  if (environment === null) {
    app.quit();
    return;
  }
  const config = loadConfig(environment, process.cwd());
  const serverOptions: OrchestratorServerOptions = {
    databasePath: config.databasePath,
    workspace: config.workspace,
    logger: !app.isPackaged,
    webRoot: resolve(app.getAppPath(), "apps/web/dist")
  };

  server = await createOrchestratorServer(serverOptions);
  serverUrl = await server.listen({ host: config.host, port: config.port });
  const initialWindowTheme = await synchronizeNativeWindowTheme(
    session.defaultSession.cookies,
    nativeTheme,
    serverUrl
  );
  mainWindow = createWindow(serverUrl, initialWindowTheme.backgroundColor);
  await mainWindow.loadURL(serverUrl);
  console.info(`Orchestrator desktop ready at ${serverUrl}`);
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Choose the agent workspace",
    properties: ["openDirectory"]
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function createWindow(url: string, backgroundColor: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: "Orchestrator",
    backgroundColor,
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
      const activeServerUrl = serverUrl;
      void synchronizeNativeWindowTheme(
        session.defaultSession.cookies,
        nativeTheme,
        activeServerUrl
      ).then((theme) => {
        if (mainWindow !== null) return;
        mainWindow = createWindow(activeServerUrl, theme.backgroundColor);
        void mainWindow.loadURL(activeServerUrl);
      });
    }
  });

  app.on("window-all-closed", () => {
    if (shutdown.shouldQuitAfterWindowsClose(process.platform)) app.quit();
  });

  app.on("before-quit", (event) => {
    if (server === null) return;
    event.preventDefault();
    if (!shutdown.begin()) return;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();

    const activeServer = server;
    void activeServer
      .close()
      .catch((error: unknown) => {
        console.error("Failed to stop the local server cleanly.", error);
      })
      .finally(() => {
        server = null;
        app.quit();
      });
  });
}
