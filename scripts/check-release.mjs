#!/usr/bin/env node

import { checkRelease, parseReleaseCommand } from "./release-versions.mjs";

const usage = "Usage: npm run release:check -- vMAJOR.MINOR.PATCH [--root PATH]";

try {
  const { root, value: tag } = parseReleaseCommand(process.argv.slice(2), usage);
  const version = await checkRelease(root, tag);
  console.info(`Release metadata is valid for v${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
