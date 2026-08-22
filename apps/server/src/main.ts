import { loadConfig } from "./config.js";
import { createOrchestratorServer } from "./runtime.js";

const config = loadConfig();
const app = await createOrchestratorServer({
  databasePath: config.databasePath,
  workspace: config.workspace,
  logger: true
});

const removeShutdownHandlers = installShutdownHandlers();
try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { workspace: config.workspace, database: config.databasePath },
    "orchestrator ready"
  );
} catch (error: unknown) {
  app.log.error(error);
  removeShutdownHandlers();
  await app.close().catch(() => undefined);
  process.exitCode = 1;
}

function installShutdownHandlers(): () => void {
  let stopping = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "orchestrator stopping");
    void app.close().catch((error: unknown) => {
      app.log.error(error, "graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  const onInterrupt = (): void => {
    shutdown("SIGINT");
  };
  const onTerminate = (): void => {
    shutdown("SIGTERM");
  };

  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const remove = (): void => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
  app.addHook("onClose", remove);
  return remove;
}
