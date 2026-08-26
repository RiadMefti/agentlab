import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createLocalAgentLab, loadLocalConfig } from "@agentlab/runtime";

import { App } from "./app.js";
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
          process.stderr.write(`Shutdown failed: ${String(error)}\n`);
        });
      }
    });
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
