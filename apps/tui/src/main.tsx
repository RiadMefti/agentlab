import { assertSupportedTerminalRuntime, helpText, parseCliArguments } from "./cli.js";
import {
  consumeNativeDiagnosticsInvocation,
  runWithNativeDiagnostics,
  type NativeDiagnosticsRuntime
} from "./bootstrap/native-diagnostics.js";
import { appVersion } from "./version.js";

let rendererRuntime: NativeDiagnosticsRuntime | null = null;

async function main(): Promise<void> {
  const invocation = await consumeNativeDiagnosticsInvocation();
  if (invocation.kind === "invalid") {
    process.exitCode = 1;
    return;
  }
  rendererRuntime = invocation.kind === "runtime" ? invocation : null;
  const action = parseCliArguments(invocation.arguments);
  if (action.kind === "help") {
    process.stdout.write(helpText);
    return;
  }
  if (action.kind === "version") {
    process.stdout.write(`${appVersion}\n`);
    return;
  }
  if (action.kind === "factory-broker-preflight") {
    const { runFactoryBrokerPreflight } = await import("./run-factory-broker-preflight.js");
    process.exitCode = await runFactoryBrokerPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-worker-preflight") {
    const { runFactoryWorkerPreflight } = await import("./run-factory-worker-preflight.js");
    process.exitCode = await runFactoryWorkerPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-broker-open-draft") {
    const { runFactoryBrokerOpenDraft } = await import("./run-factory-broker-open-draft.js");
    process.exitCode = await runFactoryBrokerOpenDraft(
      action.configPath,
      action.taskId,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }

  assertSupportedTerminalRuntime(process.platform, process.env);
  if (invocation.kind === "direct") {
    process.exitCode = await runWithNativeDiagnostics(invocation.arguments);
    return;
  }
  const { runTerminalUi } = await import("./run-terminal-ui.js");
  await runTerminalUi(invocation.diagnostics);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected startup failure.";
  if (rendererRuntime !== null) rendererRuntime.diagnostics.write(`Renderer failure: ${message}`);
  else process.stderr.write(`agentlab: ${message}\n`);
  process.exitCode = 1;
});
