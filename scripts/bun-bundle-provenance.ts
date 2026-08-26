import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024;
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const BUN_MODULE_MARKER =
  /^\/\/ [^\r\n]*node_modules\/\.bun\/([^/\r\n]+)\/node_modules\/((?:@[^/\r\n]+\/)?[^/\r\n]+)\//gmu;
const CLAUDE_AGENT_SDK_PACKAGE_SUFFIX = "node_modules/@anthropic-ai/claude-agent-sdk";
const PACKAGE_VERSION = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const CLAUDE_AGENT_SDK_VERSION = new RegExp(`^// Version: (${PACKAGE_VERSION})$`, "gmu");
const STAINLESS_PACKAGE_HEADER =
  /["']X-Stainless-Package-Version["']\s*:\s*([A-Za-z_$][0-9A-Za-z_$]*)/gu;

export type PrebundleProvenanceMethod = "anthropic-stainless-runtime-marker" | "bun-module-marker";

export interface PrebundledPackageProvenance {
  readonly ownerPackagePath: string;
  readonly name: string;
  readonly version: string;
  readonly provenance: PrebundleProvenanceMethod;
  readonly sourcePaths: readonly string[];
}

export interface BunBundleProvenanceInput {
  readonly rootPath: string;
  readonly inputPaths: Iterable<string>;
  readonly ownerByInput: ReadonlyMap<string, string | null>;
  readonly ownerVersionByInput: ReadonlyMap<string, string | null>;
}

/** Scans only actual Bun inputs for supported, exact upstream prebundle identities. */
export async function discoverPrebundledPackages(
  input: BunBundleProvenanceInput
): Promise<readonly PrebundledPackageProvenance[]> {
  const root = await realpath(resolve(input.rootPath));
  const discovered = new Map<
    string,
    Omit<PrebundledPackageProvenance, "sourcePaths"> & { readonly sourcePaths: Set<string> }
  >();
  const claudeOwners = new Set<string>();
  const scannedClaudeOwners = new Set<string>();
  let totalBytes = 0;

  for (const inputPath of input.inputPaths) {
    const ownerPackagePath = input.ownerByInput.get(inputPath);
    if (typeof ownerPackagePath !== "string" || !JAVASCRIPT_EXTENSIONS.has(extname(inputPath))) {
      continue;
    }
    const sourcePath = await realpath(resolve(root, inputPath));
    assertContainedPath(root, sourcePath);
    const metadata = await stat(sourcePath);
    if (!metadata.isFile() || metadata.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Bun input ${inputPath} is too large for prebundle provenance scanning.`);
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error("Bun inputs exceed the prebundle provenance scan budget.");
    }

    const source = await readFile(sourcePath, "utf8");
    const markers: {
      readonly name: string;
      readonly version: string;
      readonly provenance: PrebundleProvenanceMethod;
    }[] = parseBunModuleMarkers(source, inputPath).map((marker) => ({
      ...marker,
      provenance: "bun-module-marker"
    }));

    if (isClaudeAgentSdkOwner(ownerPackagePath)) {
      claudeOwners.add(ownerPackagePath);
      if (normalizePath(inputPath) === `${normalizePath(ownerPackagePath)}/sdk.mjs`) {
        const ownerVersion = input.ownerVersionByInput.get(inputPath);
        if (typeof ownerVersion !== "string") {
          throw new Error(`Claude Agent SDK input ${inputPath} has no locked owner version.`);
        }
        markers.push(parseClaudeAgentSdkPrebundle(source, inputPath, ownerVersion));
        scannedClaudeOwners.add(ownerPackagePath);
      }
    }

    for (const marker of markers) {
      const key = `${ownerPackagePath}\0${marker.name}\0${marker.version}\0${marker.provenance}`;
      const existing = discovered.get(key);
      if (existing === undefined) {
        discovered.set(key, {
          ownerPackagePath,
          name: marker.name,
          version: marker.version,
          provenance: marker.provenance,
          sourcePaths: new Set([inputPath])
        });
      } else {
        existing.sourcePaths.add(inputPath);
      }
    }
  }

  for (const owner of claudeOwners) {
    if (!scannedClaudeOwners.has(owner)) {
      throw new Error(
        `Claude Agent SDK bundle ${owner} has no supported sdk.mjs provenance input.`
      );
    }
  }

  return [...discovered.values()]
    .map(({ sourcePaths, ...component }) => ({
      ...component,
      sourcePaths: [...sourcePaths].sort()
    }))
    .sort((left, right) =>
      `${left.ownerPackagePath}\0${left.name}\0${left.version}\0${left.provenance}`.localeCompare(
        `${right.ownerPackagePath}\0${right.name}\0${right.version}\0${right.provenance}`
      )
    );
}

/** Parses exact package identities from Bun's generated module provenance comments. */
export function parseBunModuleMarkers(
  source: string,
  sourceLabel: string
): readonly { readonly name: string; readonly version: string }[] {
  const components = new Map<string, { readonly name: string; readonly version: string }>();
  for (const match of source.matchAll(BUN_MODULE_MARKER)) {
    const cacheEntry = match[1];
    const name = match[2];
    if (cacheEntry === undefined || name === undefined) continue;
    const prefix = `${name.replace("/", "+")}@`;
    if (!cacheEntry.startsWith(prefix)) {
      throw new Error(`Bun module marker in ${sourceLabel} has an inconsistent package identity.`);
    }
    const versionWithBuildHash = cacheEntry.slice(prefix.length);
    const version = versionWithBuildHash.replace(/\+[0-9a-f]{8,}$/u, "");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`Bun module marker in ${sourceLabel} has an invalid package version.`);
    }
    components.set(`${name}\0${version}`, { name, version });
  }
  return [...components.values()].sort((left, right) =>
    `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`)
  );
}

/** Identifies the Anthropic SDK embedded into Claude Agent SDK's opaque published bundle. */
export function parseClaudeAgentSdkPrebundle(
  source: string,
  sourceLabel: string,
  expectedOwnerVersion: string
): {
  readonly name: "@anthropic-ai/sdk";
  readonly version: string;
  readonly provenance: "anthropic-stainless-runtime-marker";
} {
  const wrapperVersions = new Set(
    [...source.matchAll(CLAUDE_AGENT_SDK_VERSION)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
  );
  if (wrapperVersions.size !== 1 || !wrapperVersions.has(expectedOwnerVersion)) {
    throw new Error(
      `Claude Agent SDK input ${sourceLabel} does not match its locked wrapper version.`
    );
  }
  if (!source.includes("https://api.anthropic.com") || !source.includes("X-Stainless-Lang")) {
    throw new Error(`Claude Agent SDK input ${sourceLabel} has no Anthropic runtime signature.`);
  }
  const versions = parseStainlessRuntimeVersions(source, sourceLabel);
  if (versions.length !== 1) {
    throw new Error(`Claude Agent SDK input ${sourceLabel} has ambiguous Anthropic SDK versions.`);
  }
  const version = versions[0];
  if (version === undefined) {
    throw new Error(`Claude Agent SDK input ${sourceLabel} has no Anthropic SDK version.`);
  }
  return {
    name: "@anthropic-ai/sdk",
    version,
    provenance: "anthropic-stainless-runtime-marker"
  };
}

/** Extracts exact package versions bound to Stainless runtime telemetry headers. */
export function parseStainlessRuntimeVersions(
  source: string,
  sourceLabel: string
): readonly string[] {
  const references = [...source.matchAll(STAINLESS_PACKAGE_HEADER)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  if (references.length < 2 || new Set(references).size !== 1) {
    throw new Error(`Stainless runtime marker in ${sourceLabel} is missing or inconsistent.`);
  }
  const identifier = references[0];
  if (identifier === undefined) {
    throw new Error(`Stainless runtime marker in ${sourceLabel} has no version binding.`);
  }
  const escapedIdentifier = escapeRegularExpression(identifier);
  const assignment = new RegExp(
    `(?:^|[;,]|\\b(?:const|let|var)\\s+)${escapedIdentifier}\\s*=\\s*["'](${PACKAGE_VERSION})["']`,
    "gu"
  );
  const versions = new Set(
    [...source.matchAll(assignment)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
  );
  if (versions.size === 0) {
    throw new Error(`Stainless runtime marker in ${sourceLabel} has no exact package version.`);
  }
  return [...versions].sort();
}

function assertContainedPath(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Bun input resolves outside the build root: ${path}`);
  }
}

function isClaudeAgentSdkOwner(ownerPackagePath: string): boolean {
  const normalized = normalizePath(ownerPackagePath);
  return (
    normalized === CLAUDE_AGENT_SDK_PACKAGE_SUFFIX ||
    normalized.endsWith(`/${CLAUDE_AGENT_SDK_PACKAGE_SUFFIX}`)
  );
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/u, "");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
