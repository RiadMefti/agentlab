#!/usr/bin/env node

import { loadReleaseState, parseReleaseCommand, prepareRelease } from "./release-versions.mjs";

const usage =
  "Usage: npm run release:prepare -- (patch|minor|major|MAJOR.MINOR.PATCH) [--root PATH]";

try {
  const { root, value: request } = parseReleaseCommand(process.argv.slice(2), usage);
  const files = await prepareRelease(root, request);
  const state = await loadReleaseState(root);
  const version = state.manifests[0]?.version;
  if (!version) throw new Error("The prepared release version is missing.");
  console.info(`Prepared v${version} across ${String(files.length)} release metadata files.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
