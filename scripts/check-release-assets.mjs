#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stableVersionFromTag } from "./release-versions.mjs";

const MINIMUM_BINARY_SIZE = 50 * 1024 * 1024;
const CHECKSUM_FILE = "SHA256SUMS";

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} path
 */
async function verifyAppImage(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < MINIMUM_BINARY_SIZE) {
      throw new Error(`${path} is too small to be a packaged Electron AppImage.`);
    }

    const header = Buffer.alloc(11);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    const appImageMagic = Buffer.from([0x41, 0x49, 0x02]);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, elfMagic.length).equals(elfMagic) ||
      !header.subarray(8, 11).equals(appImageMagic)
    ) {
      throw new Error(`${path} does not have a valid type-2 AppImage header.`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} path
 */
async function verifyDmg(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < MINIMUM_BINARY_SIZE) {
      throw new Error(`${path} is too small to be a packaged Electron disk image.`);
    }

    const trailer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(
      trailer,
      0,
      trailer.length,
      metadata.size - trailer.length
    );
    if (bytesRead !== trailer.length || trailer.subarray(0, 4).toString("ascii") !== "koly") {
      throw new Error(`${path} does not have a valid UDIF disk-image trailer.`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} path
 * @param {string} version
 */
async function verifySbom(path, version) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON.`, { cause: error });
  }

  if (!isJsonObject(value) || value.bomFormat !== "CycloneDX" || value.specVersion !== "1.5") {
    throw new Error(`${path} must be a CycloneDX 1.5 document.`);
  }
  if (!isJsonObject(value.metadata) || !isJsonObject(value.metadata.component)) {
    throw new Error(`${path} is missing metadata.component.`);
  }
  if (
    value.metadata.component.name !== "agent-orchestrator" ||
    value.metadata.component.version !== version
  ) {
    throw new Error(`${path} component identity does not match agent-orchestrator@${version}.`);
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error(`${path} must describe the packaged production dependencies.`);
  }
}

/**
 * @param {string} path
 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error(`Could not hash binary file ${path}.`);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * @param {string} path
 * @param {string} directory
 * @param {string[]} assetNames
 */
async function verifyChecksums(path, directory, assetNames) {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > 8192 || !source.endsWith("\n")) {
    throw new Error(`${path} is not a canonical checksum manifest.`);
  }

  const lines = source.slice(0, -1).split("\n");
  const checksums = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || checksums.has(match[2])) {
      throw new Error(`${path} contains an invalid or duplicate checksum entry.`);
    }
    checksums.set(match[2], match[1]);
  }

  const checksumNames = [...checksums.keys()].sort();
  if (
    checksumNames.length !== assetNames.length ||
    checksumNames.some((name, index) => name !== assetNames[index])
  ) {
    throw new Error(`${path} does not describe the exact release asset set.`);
  }

  await Promise.all(
    assetNames.map(async (name) => {
      if ((await sha256(join(directory, name))) !== checksums.get(name)) {
        throw new Error(`${path} contains the wrong digest for ${name}.`);
      }
    })
  );
}

/**
 * @param {string} tag
 * @param {string} directoryPath
 * @param {boolean} [includeChecksums]
 * @returns {Promise<string[]>}
 */
export async function checkReleaseAssets(tag, directoryPath, includeChecksums = false) {
  const version = stableVersionFromTag(tag);
  const directory = resolve(directoryPath);
  const assetNames = [
    `Orchestrator-${version}.cdx.json`,
    "Orchestrator-linux-x64.AppImage",
    "Orchestrator-mac-arm64.dmg",
    "Orchestrator-mac-x64.dmg"
  ].sort();
  const expectedNames = includeChecksums ? [...assetNames, CHECKSUM_FILE].sort() : assetNames;
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();

  if (
    entries.some((entry) => !entry.isFile()) ||
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `Release asset set is invalid.\nExpected: ${expectedNames.join(", ")}\nActual: ${actualNames.join(", ")}`
    );
  }

  await Promise.all([
    verifyAppImage(join(directory, "Orchestrator-linux-x64.AppImage")),
    verifyDmg(join(directory, "Orchestrator-mac-arm64.dmg")),
    verifyDmg(join(directory, "Orchestrator-mac-x64.dmg")),
    verifySbom(join(directory, `Orchestrator-${version}.cdx.json`), version)
  ]);
  if (includeChecksums) {
    await verifyChecksums(join(directory, CHECKSUM_FILE), directory, assetNames);
  }
  return expectedNames;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [tag, directory, option, ...extraArguments] = process.argv.slice(2);
  const usage = "Usage: npm run release:assets:check -- vMAJOR.MINOR.PATCH DIRECTORY [--published]";

  try {
    if (
      !tag ||
      !directory ||
      (option !== undefined && option !== "--published") ||
      extraArguments.length > 0
    ) {
      throw new Error(usage);
    }
    const assets = await checkReleaseAssets(tag, directory, option === "--published");
    console.info(`Validated ${String(assets.length)} release assets for ${tag}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
