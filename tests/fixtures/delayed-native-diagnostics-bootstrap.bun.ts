import {
  consumeNativeDiagnosticsInvocation,
  runWithNativeDiagnostics
} from "../../apps/tui/src/bootstrap/native-diagnostics.js";

const invocation = await consumeNativeDiagnosticsInvocation();
if (invocation.kind === "invalid") {
  process.exitCode = 1;
} else if (invocation.kind === "direct") {
  const renderer = runWithNativeDiagnostics([]);
  const stalledUntil = Date.now() + 250;
  while (Date.now() < stalledUntil) {
    // Deliberately stall the bootstrap after spawning its renderer.
  }
  process.exitCode = await renderer;
} else {
  process.stdout.write(String(invocation.diagnostics.write("delayed genuine bootstrap")));
}
