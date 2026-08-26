import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_BUMPS = new Set(["major", "minor", "patch"]);
const WORKSPACE_PATTERN = /^([A-Za-z0-9._-]+)\/\*$/;

/** @typedef {Record<string, unknown>} JsonObject */
/**
 * @typedef {object} PackageManifest
 * @property {JsonObject} json
 * @property {string} name
 * @property {string} path
 * @property {string} relativePath
 * @property {string} version
 */
/**
 * @typedef {object} ReleaseState
 * @property {PackageManifest[]} manifests
 * @property {JsonObject} packageLock
 * @property {string} packageLockPath
 * @property {string} root
 * @property {string} versionSourcePath
 * @property {string} versionSourceVersion
 */

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
function expectJsonObject(value, label) {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function expectString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

/**
 * @param {string} path
 * @returns {Promise<JsonObject>}
 */
async function readJsonObject(path) {
  const source = await readFile(path, "utf8");
  /** @type {unknown} */
  let value;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${path} is not valid JSON.`, { cause: error });
  }

  return expectJsonObject(value, path);
}

/**
 * @param {JsonObject} rootManifest
 * @returns {string[]}
 */
function readWorkspaceRoots(rootManifest) {
  const workspaces = rootManifest.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("package.json workspaces must be a non-empty array.");
  }

  return workspaces.map((workspace, index) => {
    const pattern = expectString(workspace, `package.json workspaces[${String(index)}]`);
    const match = WORKSPACE_PATTERN.exec(pattern);
    if (!match?.[1]) {
      throw new Error(
        `Unsupported workspace pattern: ${pattern}. Expected a direct "directory/*" pattern.`
      );
    }

    return match[1];
  });
}

/**
 * @param {string} root
 * @param {string} path
 * @param {JsonObject} json
 * @returns {PackageManifest}
 */
function packageManifest(root, path, json) {
  return {
    json,
    name: expectString(json.name, `${path} name`),
    path,
    relativePath: relative(root, dirname(path)).split(sep).join("/"),
    version: expectString(json.version, `${path} version`)
  };
}

/**
 * @param {string} rootPath
 * @returns {Promise<ReleaseState>}
 */
export async function loadReleaseState(rootPath) {
  const root = resolve(rootPath);
  const rootManifestPath = join(root, "package.json");
  const rootManifestJson = await readJsonObject(rootManifestPath);
  const manifests = [packageManifest(root, rootManifestPath, rootManifestJson)];

  for (const workspaceRoot of readWorkspaceRoots(rootManifestJson)) {
    const workspaceDirectory = join(root, workspaceRoot);
    const entries = (await readdir(workspaceDirectory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(workspaceDirectory, entry.name, "package.json"))
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const path = join(workspaceDirectory, entry.name, "package.json");
      const json = await readJsonObject(path);
      manifests.push(packageManifest(root, path, json));
    }
  }

  const packageLockPath = join(root, "package-lock.json");
  const versionSourcePath = join(root, "apps", "tui", "src", "version.ts");
  const versionSource = await readFile(versionSourcePath, "utf8");
  const versionMatch = /^export const appVersion = "([0-9]+\.[0-9]+\.[0-9]+)";\n$/u.exec(
    versionSource
  );
  if (!versionMatch?.[1]) {
    throw new Error(`${versionSourcePath} must contain only the canonical appVersion export.`);
  }
  return {
    manifests,
    packageLock: await readJsonObject(packageLockPath),
    packageLockPath,
    root,
    versionSourcePath,
    versionSourceVersion: versionMatch[1]
  };
}

/**
 * @param {string} version
 * @returns {[bigint, bigint, bigint]}
 */
function parseStableVersion(version) {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(
      `Invalid stable version: ${version}. Expected MAJOR.MINOR.PATCH without prefixes.`
    );
  }

  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

/**
 * @param {string} tag
 * @returns {string}
 */
export function stableVersionFromTag(tag) {
  if (!tag.startsWith("v")) {
    throw new Error(`Invalid release tag: ${tag}. Expected vMAJOR.MINOR.PATCH.`);
  }

  const version = tag.slice(1);
  parseStableVersion(version);
  return version;
}

/**
 * @param {string} candidate
 * @param {string} current
 * @returns {number}
 */
export function compareStableVersions(candidate, current) {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);

  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index];
    const currentPart = currentParts[index];
    if (candidatePart === undefined || currentPart === undefined) {
      throw new Error("Stable versions must contain exactly three components.");
    }
    if (candidatePart > currentPart) return 1;
    if (candidatePart < currentPart) return -1;
  }

  return 0;
}

/**
 * Resolves either an exact stable version or a semantic bump from the current version.
 *
 * @param {string} request
 * @param {string} current
 * @returns {string}
 */
export function resolveReleaseVersion(request, current) {
  const [major, minor, patch] = parseStableVersion(current);
  if (VERSION_BUMPS.has(request)) {
    if (request === "major") return `${String(major + 1n)}.0.0`;
    if (request === "minor") return `${String(major)}.${String(minor + 1n)}.0`;
    return `${String(major)}.${String(minor)}.${String(patch + 1n)}`;
  }

  parseStableVersion(request);
  return request;
}

/**
 * @param {JsonObject} container
 * @param {string} field
 * @param {string} label
 * @returns {JsonObject | undefined}
 */
function optionalObject(container, field, label) {
  const value = container[field];
  return value === undefined ? undefined : expectJsonObject(value, `${label} ${field}`);
}

/**
 * @param {ReleaseState} state
 * @returns {string[]}
 */
function collectVersionErrors(state) {
  const errors = [];
  const [rootManifest] = state.manifests;
  if (!rootManifest) {
    return ["No package manifests were found."];
  }

  try {
    parseStableVersion(rootManifest.version);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (state.versionSourceVersion !== rootManifest.version) {
    errors.push(
      `apps/tui/src/version.ts has version ${state.versionSourceVersion}; expected ${rootManifest.version}.`
    );
  }

  /** @type {Map<string, PackageManifest>} */
  const manifestByName = new Map();
  for (const manifest of state.manifests) {
    if (manifestByName.has(manifest.name)) {
      errors.push(`Duplicate workspace package name: ${manifest.name}.`);
    }
    manifestByName.set(manifest.name, manifest);

    if (manifest.version !== rootManifest.version) {
      errors.push(
        `${manifest.relativePath || "package.json"} has version ${manifest.version}; expected ${rootManifest.version}.`
      );
    }
  }

  for (const manifest of state.manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = optionalObject(manifest.json, field, manifest.path);
      if (!dependencies) continue;

      for (const name of manifestByName.keys()) {
        if (name in dependencies && dependencies[name] !== rootManifest.version) {
          errors.push(
            `${manifest.relativePath || "package.json"} ${field}.${name} is ${String(dependencies[name])}; expected ${rootManifest.version}.`
          );
        }
      }
    }
  }

  if (state.packageLock.lockfileVersion !== 3) {
    errors.push("package-lock.json must use lockfileVersion 3.");
  }
  if (state.packageLock.name !== rootManifest.name) {
    errors.push(`package-lock.json name must be ${rootManifest.name}.`);
  }
  if (state.packageLock.version !== rootManifest.version) {
    errors.push(
      `package-lock.json version is ${String(state.packageLock.version)}; expected ${rootManifest.version}.`
    );
  }

  const lockPackages = optionalObject(state.packageLock, "packages", state.packageLockPath);
  if (!lockPackages) {
    errors.push("package-lock.json packages must be an object.");
    return errors;
  }

  for (const manifest of state.manifests) {
    const lockPath = manifest.relativePath;
    const lockPackageValue = lockPackages[lockPath];
    if (!isJsonObject(lockPackageValue)) {
      errors.push(`package-lock.json is missing packages[${JSON.stringify(lockPath)}].`);
      continue;
    }

    if (lockPackageValue.name !== manifest.name) {
      errors.push(
        `package-lock.json packages[${JSON.stringify(lockPath)}].name must be ${manifest.name}.`
      );
    }
    if (lockPackageValue.version !== rootManifest.version) {
      errors.push(
        `package-lock.json packages[${JSON.stringify(lockPath)}].version is ${String(lockPackageValue.version)}; expected ${rootManifest.version}.`
      );
    }

    for (const field of DEPENDENCY_FIELDS) {
      const manifestDependencies = optionalObject(manifest.json, field, manifest.path);
      if (!manifestDependencies) continue;
      const lockDependencies = optionalObject(
        lockPackageValue,
        field,
        `package-lock.json packages[${lockPath}]`
      );

      for (const name of manifestByName.keys()) {
        if (!(name in manifestDependencies)) continue;
        if (!lockDependencies || lockDependencies[name] !== manifestDependencies[name]) {
          errors.push(
            `package-lock.json packages[${JSON.stringify(lockPath)}].${field}.${name} must match ${manifest.relativePath || "package.json"}.`
          );
        }
      }
    }
  }

  return errors;
}

/**
 * @param {ReleaseState} state
 */
function assertVersionState(state) {
  const errors = collectVersionErrors(state);
  if (errors.length > 0) {
    throw new Error(`Release metadata is inconsistent:\n- ${errors.join("\n- ")}`);
  }
}

/**
 * @param {string} rootPath
 * @param {string} tag
 * @returns {Promise<string>}
 */
export async function checkRelease(rootPath, tag) {
  const state = await loadReleaseState(rootPath);
  assertVersionState(state);
  const version = state.manifests[0]?.version;
  if (!version) {
    throw new Error("The root package version is missing.");
  }

  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}; expected ${expectedTag}.`
    );
  }

  return version;
}

/**
 * @param {JsonObject} json
 * @param {Set<string>} internalNames
 * @param {string} version
 */
function setInternalDependencyVersions(json, internalNames, version) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = optionalObject(json, field, "package metadata");
    if (!dependencies) continue;

    for (const name of internalNames) {
      if (name in dependencies) dependencies[name] = version;
    }
  }
}

/**
 * @param {Array<{content: string, path: string}>} files
 */
async function writeFilesAtomically(files) {
  const suffix = `.release-${String(process.pid)}-${randomUUID()}.tmp`;
  const pending = files.map(({ content, path }) => ({
    path,
    temporaryPath: `${path}${suffix}`,
    content
  }));

  try {
    await Promise.all(
      pending.map(({ content, temporaryPath }) =>
        writeFile(temporaryPath, content, {
          encoding: "utf8",
          flag: "wx"
        })
      )
    );
    for (const { path, temporaryPath } of pending) {
      await rename(temporaryPath, path);
    }
  } finally {
    await Promise.all(pending.map(({ temporaryPath }) => rm(temporaryPath, { force: true })));
  }
}

/**
 * @param {string} rootPath
 * @param {string} request
 * @returns {Promise<string[]>}
 */
export async function prepareRelease(rootPath, request) {
  const state = await loadReleaseState(rootPath);
  assertVersionState(state);

  const currentVersion = state.manifests[0]?.version;
  if (!currentVersion) {
    throw new Error("The root package version is missing.");
  }
  const version = resolveReleaseVersion(request, currentVersion);
  if (compareStableVersions(version, currentVersion) <= 0) {
    throw new Error(
      `Release version ${version} must be greater than current version ${currentVersion}.`
    );
  }

  const internalNames = new Set(state.manifests.map((manifest) => manifest.name));
  for (const manifest of state.manifests) {
    manifest.json.version = version;
    manifest.version = version;
    setInternalDependencyVersions(manifest.json, internalNames, version);
  }

  state.packageLock.version = version;
  const lockPackages = expectJsonObject(state.packageLock.packages, "package-lock.json packages");
  for (const manifest of state.manifests) {
    const lockPackage = expectJsonObject(
      lockPackages[manifest.relativePath],
      `package-lock.json packages[${JSON.stringify(manifest.relativePath)}]`
    );
    lockPackage.version = version;
    setInternalDependencyVersions(lockPackage, internalNames, version);
  }

  const files = [
    ...state.manifests.map((manifest) => ({
      content: `${JSON.stringify(manifest.json, null, 2)}\n`,
      path: manifest.path
    })),
    {
      content: `${JSON.stringify(state.packageLock, null, 2)}\n`,
      path: state.packageLockPath
    },
    {
      content: `export const appVersion = "${version}";\n`,
      path: state.versionSourcePath
    }
  ];
  await writeFilesAtomically(files);
  await checkRelease(state.root, `v${version}`);
  return files.map(({ path }) => path);
}

/**
 * @param {string[]} arguments_
 * @param {string} usage
 * @returns {{root: string, value: string}}
 */
export function parseReleaseCommand(arguments_, usage) {
  let root = process.cwd();
  /** @type {string | undefined} */
  let value;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const rootArgument = arguments_[index + 1];
      if (!rootArgument) throw new Error(`${usage}\n--root requires a path.`);
      root = resolve(process.cwd(), rootArgument);
      index += 1;
      continue;
    }
    if (!argument || argument.startsWith("-")) {
      throw new Error(`${usage}\nUnknown option: ${argument ?? ""}`);
    }
    if (value !== undefined) {
      throw new Error(`${usage}\nOnly one value may be supplied.`);
    }
    value = argument;
  }

  if (!value) throw new Error(usage);
  return { root, value };
}
