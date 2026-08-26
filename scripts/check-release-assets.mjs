#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAnthropicSdkVersionInBinary } from "./binary-prebundle-scan.mjs";
import { stableVersionFromTag } from "./release-versions.mjs";

const MINIMUM_BINARY_SIZE = 20 * 1024 * 1024;
const CHECKSUM_FILE = "SHA256SUMS";
const RUNTIME_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "embedded-runtime"
};
const BUNDLED_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "bundled"
};
const PREBUNDLED_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "prebundled"
};
const PREBUNDLE_PROVENANCE_PROPERTY_NAME = "agentlab:component:provenance";
const PREBUNDLE_PROVENANCE_METHODS = new Set([
  "anthropic-stainless-runtime-marker",
  "bun-module-marker"
]);
const TARGET_PROPERTY_NAME = "agentlab:binary:target";
const NATIVE_PACKAGE_BY_TARGET = {
  "linux-x64": "@opentui/core-linux-x64",
  "mac-arm64": "@opentui/core-darwin-arm64"
};
const OPEN_TUI_NATIVE_PACKAGES = new Set([
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64"
]);

/** @typedef {Record<string, unknown>} JsonObject */

/** @param {unknown} value @returns {value is JsonObject} */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} path @param {"linux-x64" | "mac-arm64"} target */
async function verifyBinary(path, target) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < MINIMUM_BINARY_SIZE) {
      throw new Error(`${path} is too small to contain the compiled terminal application.`);
    }

    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error(`${path} has a truncated executable header.`);

    if (target === "linux-x64") {
      const valid =
        header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === 0x3e;
      if (!valid) throw new Error(`${path} is not a 64-bit x86 Linux ELF executable.`);
      return;
    }

    const valid =
      header.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) &&
      header.readUInt32LE(4) === 0x0100000c;
    if (!valid) throw new Error(`${path} is not a 64-bit Apple silicon Mach-O executable.`);
  } finally {
    await handle.close();
  }
}

/** @param {string} path @param {string} version @param {"linux-x64" | "mac-arm64"} target */
async function verifySbom(path, version, target) {
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
  const application = value.metadata.component;
  if (application.name !== "agentlab" || application.version !== version) {
    throw new Error(`${path} component identity does not match agentlab@${version}.`);
  }
  if (typeof application["bom-ref"] !== "string") {
    throw new Error(`${path} application component is missing its bom-ref.`);
  }
  const applicationRef = application["bom-ref"];
  const validTarget =
    Array.isArray(application.properties) &&
    application.properties.some(
      (property) =>
        isJsonObject(property) &&
        property.name === TARGET_PROPERTY_NAME &&
        property.value === target
    );
  if (!validTarget) throw new Error(`${path} does not identify the ${target} binary graph.`);
  if (!Array.isArray(value.components) || !Array.isArray(value.dependencies)) {
    throw new Error(`${path} must describe production components and their dependency graph.`);
  }

  const components = /** @type {unknown[]} */ (value.components);
  if (components.some((component) => isJsonObject(component) && component.name === "electron")) {
    throw new Error(`${path} must not describe the removed Electron runtime.`);
  }
  const bun = components.find((component) => isJsonObject(component) && component.name === "bun");
  const validRuntimeProperty =
    isJsonObject(bun) &&
    Array.isArray(bun.properties) &&
    bun.properties.some(
      (property) =>
        isJsonObject(property) &&
        property.name === RUNTIME_PROPERTY.name &&
        property.value === RUNTIME_PROPERTY.value
    );
  if (
    !isJsonObject(bun) ||
    bun.type !== "framework" ||
    bun.scope !== "required" ||
    typeof bun.version !== "string" ||
    bun["bom-ref"] !== `bun@${bun.version}` ||
    bun.purl !== `pkg:github/oven-sh/bun@${bun.version}` ||
    !validRuntimeProperty
  ) {
    throw new Error(`${path} must describe Bun as the embedded runtime.`);
  }

  const bundled = /** @type {JsonObject[]} */ (
    components.filter((component) => isJsonObject(component) && component.name !== "bun")
  );
  if (
    bundled.length === 0 ||
    bundled.some(
      (component) =>
        typeof component["bom-ref"] !== "string" ||
        component.type !== "library" ||
        typeof component.name !== "string" ||
        typeof component.version !== "string" ||
        component.scope !== "required" ||
        typeof component.purl !== "string" ||
        (!hasComponentProperty(component, BUNDLED_PROPERTY) &&
          !hasComponentProperty(component, PREBUNDLED_PROPERTY)) ||
        (hasComponentProperty(component, PREBUNDLED_PROPERTY) && !hasPrebundleEvidence(component))
    )
  ) {
    throw new Error(`${path} contains a component without valid Bun bundle provenance.`);
  }

  const expectedNativePackage = NATIVE_PACKAGE_BY_TARGET[target];
  /** @type {string[]} */
  const nativePackages = [];
  for (const component of bundled) {
    if (typeof component.name === "string" && OPEN_TUI_NATIVE_PACKAGES.has(component.name)) {
      nativePackages.push(component.name);
    }
  }
  if (nativePackages.length !== 1 || nativePackages[0] !== expectedNativePackage) {
    throw new Error(`${path} does not contain exactly the native package for ${target}.`);
  }

  const applicationDependency = /** @type {unknown[]} */ (value.dependencies).find(
    (dependency) => isJsonObject(dependency) && dependency.ref === applicationRef
  );
  if (
    !isJsonObject(applicationDependency) ||
    !Array.isArray(applicationDependency.dependsOn) ||
    !applicationDependency.dependsOn.includes(bun["bom-ref"])
  ) {
    throw new Error(`${path} must link the embedded Bun runtime to the application.`);
  }

  /** @type {Set<string>} */
  const componentRefs = new Set();
  for (const component of components) {
    if (isJsonObject(component) && typeof component["bom-ref"] === "string") {
      componentRefs.add(component["bom-ref"]);
    }
  }
  if (componentRefs.size !== components.length) {
    throw new Error(`${path} contains missing or duplicate component references.`);
  }
  const knownRefs = new Set([applicationRef, ...componentRefs]);
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const dependency of /** @type {unknown[]} */ (value.dependencies)) {
    if (
      !isJsonObject(dependency) ||
      typeof dependency.ref !== "string" ||
      !Array.isArray(dependency.dependsOn) ||
      graph.has(dependency.ref) ||
      !knownRefs.has(dependency.ref)
    ) {
      throw new Error(`${path} contains an invalid dependency graph.`);
    }
    /** @type {string[]} */
    const dependencyRefs = [];
    for (const ref of /** @type {unknown[]} */ (dependency.dependsOn)) {
      if (typeof ref !== "string" || !knownRefs.has(ref)) {
        throw new Error(`${path} contains an invalid dependency graph.`);
      }
      dependencyRefs.push(ref);
    }
    if (new Set(dependencyRefs).size !== dependencyRefs.length) {
      throw new Error(`${path} contains an invalid dependency graph.`);
    }
    graph.set(dependency.ref, dependencyRefs);
  }
  if (graph.size !== knownRefs.size) {
    throw new Error(`${path} does not describe every component in its dependency graph.`);
  }
  /** @type {Set<string>} */
  const reached = new Set();
  const pending = [applicationRef];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (typeof ref !== "string" || reached.has(ref)) continue;
    reached.add(ref);
    for (const dependency of graph.get(ref) ?? []) pending.push(dependency);
  }
  if (knownRefs.size !== reached.size) {
    throw new Error(`${path} contains components disconnected from the application.`);
  }

  const anthropicComponents = bundled.filter((component) => component.name === "@anthropic-ai/sdk");
  const claudeComponents = bundled.filter(
    (component) => component.name === "@anthropic-ai/claude-agent-sdk"
  );
  const anthropic = anthropicComponents[0];
  const claude = claudeComponents[0];
  if (
    anthropicComponents.length !== 1 ||
    claudeComponents.length !== 1 ||
    !isJsonObject(anthropic) ||
    !isJsonObject(claude) ||
    typeof anthropic.version !== "string" ||
    typeof anthropic["bom-ref"] !== "string" ||
    typeof claude["bom-ref"] !== "string" ||
    !hasComponentProperty(anthropic, {
      name: PREBUNDLE_PROVENANCE_PROPERTY_NAME,
      value: "anthropic-stainless-runtime-marker"
    }) ||
    !graph.get(claude["bom-ref"])?.includes(anthropic["bom-ref"])
  ) {
    throw new Error(`${path} does not inventory Claude's embedded Anthropic SDK.`);
  }
  return { anthropicSdkVersion: anthropic.version };
}

/** @param {JsonObject} component @param {{name: string, value: string}} expected */
function hasComponentProperty(component, expected) {
  if (!Array.isArray(component.properties)) return false;
  return /** @type {unknown[]} */ (component.properties).some(
    (property) =>
      isJsonObject(property) && property.name === expected.name && property.value === expected.value
  );
}

/** @param {JsonObject} component */
function hasPrebundleEvidence(component) {
  if (!Array.isArray(component.properties)) return false;
  const provenance = /** @type {unknown[]} */ (component.properties)
    .filter(
      (property) => isJsonObject(property) && property.name === PREBUNDLE_PROVENANCE_PROPERTY_NAME
    )
    .map((property) => (isJsonObject(property) ? property.value : undefined));
  if (
    provenance.length === 0 ||
    provenance.some(
      (method) => typeof method !== "string" || !PREBUNDLE_PROVENANCE_METHODS.has(method)
    )
  ) {
    return false;
  }
  if (!isJsonObject(component.evidence) || !Array.isArray(component.evidence.occurrences)) {
    return false;
  }
  const occurrences = /** @type {unknown[]} */ (component.evidence.occurrences);
  return (
    occurrences.length > 0 &&
    occurrences.every(
      (occurrence) =>
        isJsonObject(occurrence) &&
        typeof occurrence.location === "string" &&
        occurrence.location.length > 0 &&
        occurrence.location.length <= 4_096
    )
  );
}

/**
 * @param {string} binaryPath
 * @param {string} sbomPath
 * @param {string} version
 * @param {"linux-x64" | "mac-arm64"} target
 */
async function verifyTargetAssets(binaryPath, sbomPath, version, target) {
  await verifyBinary(binaryPath, target);
  const { anthropicSdkVersion } = await verifySbom(sbomPath, version, target);
  const binarySdkVersion = await discoverAnthropicSdkVersionInBinary(binaryPath);
  if (binarySdkVersion !== anthropicSdkVersion) {
    throw new Error(
      `${binaryPath} embeds Anthropic SDK ${binarySdkVersion}, but ${sbomPath} inventories ${anthropicSdkVersion}.`
    );
  }
}

/** @param {string} path */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error(`Could not hash binary file ${path}.`);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** @param {string} path @param {string} directory @param {string[]} assetNames */
async function verifyChecksums(path, directory, assetNames) {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > 8192 || !source.endsWith("\n")) {
    throw new Error(`${path} is not a canonical checksum manifest.`);
  }

  const checksums = new Map();
  for (const line of source.slice(0, -1).split("\n")) {
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
  const linuxName = `agentlab-v${version}-linux-x64`;
  const macName = `agentlab-v${version}-mac-arm64`;
  const linuxSbomName = `${linuxName}.cdx.json`;
  const macSbomName = `${macName}.cdx.json`;
  const assetNames = [linuxName, linuxSbomName, macName, macSbomName].sort();
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
    verifyTargetAssets(
      join(directory, linuxName),
      join(directory, linuxSbomName),
      version,
      "linux-x64"
    ),
    verifyTargetAssets(join(directory, macName), join(directory, macSbomName), version, "mac-arm64")
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
