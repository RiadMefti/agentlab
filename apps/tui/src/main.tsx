import { assertSupportedTerminalRuntime, helpText, parseCliArguments } from "./cli.js";
import {
  nativeDiagnosticsRuntimeArguments,
  runWithNativeDiagnostics
} from "./bootstrap/native-diagnostics.js";
import { appVersion } from "./version.js";

async function main(): Promise<void> {
  const processArguments = process.argv.slice(2);
  const runtimeArguments = nativeDiagnosticsRuntimeArguments(processArguments);
  const action = parseCliArguments(runtimeArguments ?? processArguments);
  if (action.kind === "help") {
    process.stdout.write(helpText);
    return;
  }
  if (action.kind === "version") {
    process.stdout.write(`${appVersion}\n`);
    return;
  }

  assertSupportedTerminalRuntime(process.platform, process.env);
  if (runtimeArguments === null) {
    process.exitCode = await runWithNativeDiagnostics(processArguments);
    return;
  }
  const { runTerminalUi } = await import("./run-terminal-ui.js");
  await runTerminalUi();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected startup failure.";
  process.stderr.write(`agentlab: ${message}\n`);
  process.exitCode = 1;
});
