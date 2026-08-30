import { fileURLToPath } from "node:url";

import { bunTestArguments, discoverBunTests } from "./bun-test-discovery.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tests = await discoverBunTests(projectRoot);
if (tests.length === 0) throw new Error("No Bun tests were discovered.");

const child = Bun.spawn([process.execPath, "test", ...bunTestArguments(tests)], {
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit"
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exitCode = exitCode;
