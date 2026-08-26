import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseManifest } from "./manifest.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageInput: unknown = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8")
);
if (typeof packageInput !== "object" || packageInput === null || Array.isArray(packageInput)) {
  throw new Error("package.json must be an object.");
}
const packageJson = packageInput as Record<string, unknown>;
const manifestInput: unknown = JSON.parse(
  await readFile(resolve(packageDirectory, "release-manifest.json"), "utf8")
);
const manifest = parseReleaseManifest(manifestInput);

if (packageJson.name !== "agentlab" || packageJson.version !== manifest.version) {
  throw new Error("The AgentLab package and release manifest identities do not match.");
}
if (packageJson.private === true) throw new Error("The generated AgentLab package must be public.");
await access(resolve(packageDirectory, "dist", "agentlab.js"), constants.R_OK);
process.stdout.write(`Validated agentlab@${manifest.version} npm package.\n`);
