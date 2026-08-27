import {
  consumeNativeDiagnosticsInvocation,
  runWithNativeDiagnostics
} from "../../apps/tui/src/bootstrap/native-diagnostics.js";

if (process.env.AGENTLAB_TUI_RUNTIME !== undefined) await Bun.sleep(250);

const invocation = await consumeNativeDiagnosticsInvocation();
if (invocation.kind === "invalid") {
  process.exitCode = 1;
} else if (invocation.kind === "direct") {
  process.exitCode = await runWithNativeDiagnostics([]);
} else {
  process.stdout.write(String(invocation.diagnostics.write("delayed genuine bootstrap")));
}
