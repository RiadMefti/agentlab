import { assertSupportedTerminalRuntime, helpText, parseCliArguments } from "./cli.js";
import { appVersion } from "./version.js";

async function main(): Promise<void> {
  const action = parseCliArguments(process.argv.slice(2));
  if (action.kind === "help") {
    process.stdout.write(helpText);
    return;
  }
  if (action.kind === "version") {
    process.stdout.write(`${appVersion}\n`);
    return;
  }

  assertSupportedTerminalRuntime(process.platform, process.env);
  const { runTerminalUi } = await import("./run-terminal-ui.js");
  await runTerminalUi();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected startup failure.";
  process.stderr.write(`orchestrator: ${message}\n`);
  process.exitCode = 1;
});
