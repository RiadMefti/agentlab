import { fileURLToPath } from "node:url";

import { inspectArchitecture } from "./architecture-rules.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const report = await inspectArchitecture(projectRoot);

if (report.violations.length > 0) {
  for (const violation of report.violations) process.stderr.write(violation.message + "\n");
  process.stderr.write(
    "Architecture check failed with " + String(report.violations.length) + " violation(s).\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Architecture check passed for " +
      String(report.moduleCount) +
      " modules and " +
      String(report.dependencyCount) +
      " dependencies.\n"
  );
}
