import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createLocalAgentLab, loadLocalConfig } from "@agentlab/runtime";

import { App } from "./app.js";
import { writeNativeDiagnostic } from "./bootstrap/native-diagnostics.js";
import { installSignalExitStatusHandlers } from "./bootstrap/signal-exit.js";
import {
  createTerminalSuspendHandlers,
  renderWithTerminalCleanup
} from "./bootstrap/terminal-suspension.js";
import { RuntimeContext } from "./runtime-context.js";
import { palette } from "./theme.js";

export async function runTerminalUi(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("AgentLab must run in an interactive terminal.");
  }

  const config = loadLocalConfig();
  const runtime = createLocalAgentLab(config);
  let closePromise: Promise<void> | null = null;
  const closeRuntime = (): Promise<void> => {
    closePromise ??= runtime.close();
    return closePromise;
  };
  const removeExitStatusHandlers = installSignalExitStatusHandlers();
  let removeSuspendHandlers: () => void = () => undefined;
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;

  try {
    renderer = await createCliRenderer({
      backgroundColor: palette.background,
      clearOnShutdown: true,
      exitOnCtrlC: false,
      maxFps: 60,
      targetFps: 30,
      useKittyKeyboard: {
        alternateKeys: true,
        disambiguate: true
      },
      useThread: true,
      onDestroy: () => {
        void closeRuntime().catch((error: unknown) => {
          writeNativeDiagnostic(`Shutdown failed: ${String(error)}`);
        });
      }
    });
    const activeRenderer = renderer;
    const suspendHandlers = createTerminalSuspendHandlers(
      activeRenderer,
      () => process.kill(process.pid, "SIGSTOP"),
      (message) => {
        writeNativeDiagnostic(message);
      }
    );
    removeSuspendHandlers = (): void => {
      process.off("SIGTSTP", suspendHandlers.onSuspend);
      process.off("SIGCONT", suspendHandlers.onContinue);
    };
    const removeProcessHandlers = (): void => {
      removeSuspendHandlers();
      removeExitStatusHandlers();
    };
    process.on("SIGTSTP", suspendHandlers.onSuspend);
    process.on("SIGCONT", suspendHandlers.onContinue);
    activeRenderer.once(CliRenderEvents.DESTROY, removeProcessHandlers);
    renderWithTerminalCleanup(
      () => {
        createRoot(activeRenderer).render(
          <RuntimeContext value={runtime}>
            <App />
          </RuntimeContext>
        );
      },
      removeProcessHandlers,
      () => {
        activeRenderer.destroy();
      }
    );
  } catch (error: unknown) {
    removeSuspendHandlers();
    removeExitStatusHandlers();
    const cleanupErrors: unknown[] = [];
    if (renderer !== null && !renderer.isDestroyed) {
      try {
        renderer.destroy();
      } catch (destroyError: unknown) {
        cleanupErrors.push(destroyError);
      }
    }
    try {
      await closeRuntime();
    } catch (closeError: unknown) {
      cleanupErrors.push(closeError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Startup and runtime cleanup both failed."
      );
    }
    throw error;
  }
}
