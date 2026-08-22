#!/usr/bin/env node

import { parseReleaseCommand, prepareRelease } from "./release-versions.mjs";

const usage = "Usage: npm run release:prepare -- MAJOR.MINOR.PATCH [--root PATH]";

try {
  const { root, value: version } = parseReleaseCommand(process.argv.slice(2), usage);
  const files = await prepareRelease(root, version);
  console.info(`Prepared v${version} across ${String(files.length)} release metadata files.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
