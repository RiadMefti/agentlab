import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createLocalAgentLab, loadLocalConfig } from "@agentlab/runtime";

import { App } from "./app.js";
import { writeNativeDiagnostic } from "./bootstrap/native-diagnostics.js";
import { createTerminalSuspendHandlers } from "./bootstrap/terminal-suspension.js";
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

  try {
    const renderer = await createCliRenderer({
      backgroundColor: palette.background,
      clearOnShutdown: true,
      exitSignals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"],
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
    const suspendHandlers = createTerminalSuspendHandlers(
      renderer,
      () => process.kill(process.pid, "SIGSTOP"),
      (message) => {
        writeNativeDiagnostic(message);
      }
    );
    const removeSuspendHandlers = (): void => {
      process.off("SIGTSTP", suspendHandlers.onSuspend);
      process.off("SIGCONT", suspendHandlers.onContinue);
    };
    process.on("SIGTSTP", suspendHandlers.onSuspend);
    process.on("SIGCONT", suspendHandlers.onContinue);
    renderer.once(CliRenderEvents.DESTROY, removeSuspendHandlers);
    createRoot(renderer).render(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>
    );
  } catch (error: unknown) {
    try {
      await closeRuntime();
    } catch (closeError: unknown) {
      throw new AggregateError([error, closeError], "Startup and runtime cleanup both failed.");
    }
    throw error;
  }
}
