#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stableVersionFromTag } from "./release-versions.mjs";

const usage =
  "Usage: node scripts/prepare-npm-package.mjs vMAJOR.MINOR.PATCH ASSET_DIRECTORY OUTPUT_DIRECTORY";
const root = fileURLToPath(new URL("../", import.meta.url));

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{asset: string, sha256: string, size: number}} GeneratedTarget */

try {
  const [tag, assetInput, outputInput, extra] = process.argv.slice(2);
  if (
    tag === undefined ||
    assetInput === undefined ||
    outputInput === undefined ||
    extra !== undefined
  ) {
    throw new Error(usage);
  }
  const version = stableVersionFromTag(tag);
  const assetDirectory = resolve(assetInput);
  const outputDirectory = resolve(outputInput);
  assertSafeOutputDirectory(outputDirectory);

  const launcherDirectory = resolve(root, "packages", "launcher");
  /** @type {unknown} */
  const packageInput = JSON.parse(
    await readFile(resolve(launcherDirectory, "package.json"), "utf8")
  );
  const sourcePackage = parseObject(packageInput, "launcher package.json");
  if (sourcePackage.name !== "agentlab" || sourcePackage.version !== version) {
    throw new Error(`packages/launcher/package.json must describe agentlab@${version}.`);
  }

  const repository = parseRepository(sourcePackage.repository);
  /** @type {Record<string, GeneratedTarget>} */
  const targets = {};
  for (const key of ["linux-x64", "mac-arm64"]) {
    const asset = `agentlab-v${version}-${key}`;
    const path = resolve(assetDirectory, asset);
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0)
      throw new Error(`${path} must be a non-empty file.`);
    targets[key] = {
      asset,
      sha256: await sha256(path),
      size: details.size
    };
  }

  await mkdir(outputDirectory, { recursive: false });
  await cp(resolve(launcherDirectory, "dist"), resolve(outputDirectory, "dist"), {
    recursive: true
  });
  await copyFile(resolve(launcherDirectory, "README.md"), resolve(outputDirectory, "README.md"));
  await copyFile(resolve(launcherDirectory, "LICENSE"), resolve(outputDirectory, "LICENSE"));
  await chmod(resolve(outputDirectory, "dist", "agentlab.js"), 0o755);

  const packageJson = structuredClone(sourcePackage);
  packageJson.scripts = { prepack: "node dist/prepack.js" };
  await writeJson(resolve(outputDirectory, "package.json"), packageJson);
  await writeJson(resolve(outputDirectory, "release-manifest.json"), {
    repository,
    targets,
    version
  });
  process.stdout.write(`Prepared agentlab@${version} npm package in ${outputDirectory}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

/** @param {string} path */
function assertSafeOutputDirectory(path) {
  if (path === root || dirname(path) === path || basename(path).length === 0) {
    throw new Error("Refusing an unsafe npm package output directory.");
  }
}

/** @param {unknown} value @param {string} label @returns {JsonObject} */
function parseObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

/** @param {unknown} value @returns {string} */
function parseRepository(value) {
  const repository = parseObject(value, "launcher repository");
  const url = repository.url;
  if (url !== "git+https://github.com/RiadMefti/agentlab.git") {
    throw new Error("The launcher repository must be the public AgentLab repository.");
  }
  return "RiadMefti/agentlab";
}

/** @param {string} path @returns {Promise<string>} */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const rawChunk of createReadStream(path)) {
    /** @type {unknown} */
    const chunk = rawChunk;
    if (!(chunk instanceof Uint8Array)) throw new Error(`Could not hash ${path}.`);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** @param {string} path @param {unknown} value @returns {Promise<void>} */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
