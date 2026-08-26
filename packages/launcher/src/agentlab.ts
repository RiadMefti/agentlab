#!/usr/bin/env node

import { runLauncher } from "./cli.js";

try {
  process.exitCode = await runLauncher(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected launcher failure.";
  process.stderr.write(`agentlab: ${message}\n`);
  process.exitCode = 1;
}
