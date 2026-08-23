#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseReleaseCommand } from "./release-versions.mjs";

const execFileAsync = promisify(execFile);
const ELECTRON_PATH = "node_modules/electron";
const RUNTIME_PROPERTY = {
  name: "agent-orchestrator:component:distribution",
  value: "embedded-runtime"
};

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {JsonObject}
 */
function expectObject(value, label) {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

/**
 * @param {string} source
 * @param {string} label
 * @returns {JsonObject}
 */
function parseObject(source, label) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  return expectObject(value, label);
}

/**
 * Adds the Electron framework that electron-builder embeds while intentionally
 * excluding Electron's development-only downloader package and its dependencies.
 *
 * @param {JsonObject} sbom
 * @param {JsonObject} packageLock
 * @returns {JsonObject}
 */
export function addElectronRuntime(sbom, packageLock) {
  const lockPackages = expectObject(packageLock.packages, "package-lock.json packages");
  const rootPackage = expectObject(lockPackages[""], 'package-lock.json packages[""]');
  const productionDependencies = expectObject(
    rootPackage.dependencies,
    'package-lock.json packages[""].dependencies'
  );
  const developmentDependencies = expectObject(
    rootPackage.devDependencies,
    'package-lock.json packages[""].devDependencies'
  );
  if ("electron" in productionDependencies) {
    throw new Error(
      "Electron must remain a development dependency so its downloaded payload is not nested in the packaged app."
    );
  }
  if (typeof developmentDependencies.electron !== "string") {
    throw new Error("Electron must be declared as a development dependency for desktop packaging.");
  }

  const lockedElectron = expectObject(
    lockPackages[ELECTRON_PATH],
    `package-lock.json packages[${JSON.stringify(ELECTRON_PATH)}]`
  );
  if (lockedElectron.dev !== true) {
    throw new Error("The locked Electron package must remain development-only.");
  }
  if (
    typeof lockedElectron.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(lockedElectron.version)
  ) {
    throw new Error("The locked Electron runtime version is invalid.");
  }

  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    throw new Error("The npm production SBOM is missing components or dependencies.");
  }
  if (
    sbom.components.some((component) => isJsonObject(component) && component.name === "electron")
  ) {
    throw new Error("The npm production SBOM unexpectedly already contains Electron.");
  }

  const metadata = expectObject(sbom.metadata, "SBOM metadata");
  const application = expectObject(metadata.component, "SBOM metadata.component");
  if (typeof application["bom-ref"] !== "string") {
    throw new Error("The npm production SBOM application is missing its bom-ref.");
  }
  /** @type {unknown} */
  let applicationDependency;
  for (const dependency of /** @type {unknown[]} */ (sbom.dependencies)) {
    if (isJsonObject(dependency) && dependency.ref === application["bom-ref"]) {
      applicationDependency = dependency;
    }
  }
  if (!isJsonObject(applicationDependency) || !Array.isArray(applicationDependency.dependsOn)) {
    throw new Error("The npm production SBOM is missing its application dependency graph.");
  }

  const version = lockedElectron.version;
  const bomRef = `electron@${version}`;
  sbom.components.push({
    "bom-ref": bomRef,
    type: "framework",
    name: "electron",
    version,
    scope: "required",
    purl: `pkg:npm/electron@${version}`,
    properties: [RUNTIME_PROPERTY]
  });
  applicationDependency.dependsOn.push(bomRef);
  applicationDependency.dependsOn.sort();
  sbom.dependencies.push({ ref: bomRef, dependsOn: [] });
  return sbom;
}

/**
 * @param {string} rootPath
 * @param {string} outputPath
 */
export async function generateReleaseSbom(rootPath, outputPath) {
  const root = resolve(rootPath);
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileAsync(
    npmExecutable,
    [
      "sbom",
      "--package-lock-only",
      "--omit=dev",
      "--sbom-format=cyclonedx",
      "--sbom-type=application"
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  const sbom = parseObject(stdout, "npm production SBOM");
  const packageLock = parseObject(
    await readFile(resolve(root, "package-lock.json"), "utf8"),
    "package-lock.json"
  );
  addElectronRuntime(sbom, packageLock);
  await writeFile(resolve(outputPath), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const usage = "Usage: npm run release:sbom -- OUTPUT [--root PATH]";
  try {
    const { root, value: output } = parseReleaseCommand(process.argv.slice(2), usage);
    await generateReleaseSbom(root, output);
    console.info(`Generated release SBOM at ${resolve(output)}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
