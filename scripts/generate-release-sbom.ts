import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { discoverPrebundledPackages } from "./bun-bundle-provenance.js";

const BUNDLED_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "bundled"
} as const;
const RUNTIME_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "embedded-runtime"
} as const;
const PREBUNDLED_PROPERTY = {
  name: "agentlab:component:distribution",
  value: "prebundled"
} as const;
const PREBUNDLE_PROVENANCE_PROPERTY_NAME = "agentlab:component:provenance";
const TARGET_PROPERTY_NAME = "agentlab:binary:target";
const NATIVE_PACKAGE_BY_TARGET = {
  "linux-x64": "@opentui/core-linux-x64",
  "linux-arm64": "@opentui/core-linux-arm64",
  "mac-x64": "@opentui/core-darwin-x64",
  "mac-arm64": "@opentui/core-darwin-arm64"
} as const;
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

export type BinarySbomTarget = keyof typeof NATIVE_PACKAGE_BY_TARGET;

export interface BinarySbomInput {
  readonly rootPath: string;
  readonly metafilePath: string;
  readonly outputPath: string;
  readonly target: BinarySbomTarget;
  readonly version: string;
  readonly bunVersion: string;
}

type JsonObject = Readonly<Record<string, unknown>>;

interface MetafileImport {
  readonly path: string;
  readonly external: boolean;
}

interface MetafileInput {
  readonly imports: readonly MetafileImport[];
}

interface CycloneComponent {
  readonly "bom-ref": string;
  readonly type: "library" | "framework";
  readonly name: string;
  readonly version: string;
  readonly scope: "required";
  readonly purl: string;
  readonly hashes?: readonly { readonly alg: "SHA-512"; readonly content: string }[];
  readonly properties: readonly { readonly name: string; readonly value: string }[];
  readonly evidence?: {
    readonly occurrences: readonly { readonly location: string }[];
  };
}

export interface BinarySbom {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.5";
  readonly version: 1;
  readonly metadata: {
    readonly component: {
      readonly "bom-ref": string;
      readonly type: "application";
      readonly name: "agentlab";
      readonly version: string;
      readonly properties: readonly { readonly name: string; readonly value: string }[];
    };
  };
  readonly components: readonly CycloneComponent[];
  readonly dependencies: readonly {
    readonly ref: string;
    readonly dependsOn: readonly string[];
  }[];
}

/**
 * Produces a target-specific CycloneDX document from Bun's input graph plus exact, supported
 * package/version markers embedded in upstream prebundles.
 */
export async function generateBinarySbom(input: BinarySbomInput): Promise<BinarySbom> {
  assertVersion(input.version, "Application");
  assertVersion(input.bunVersion, "Embedded Bun runtime");
  const nativePackage = NATIVE_PACKAGE_BY_TARGET[input.target];
  const root = resolve(input.rootPath);
  const [lockSource, metafileSource] = await Promise.all([
    readFile(resolve(root, "package-lock.json"), "utf8"),
    readFile(resolve(input.metafilePath), "utf8")
  ]);
  const lockPackages = expectObject(
    parseObject(lockSource, "package-lock.json").packages,
    "package-lock.json packages"
  );
  const metafileInputs = parseMetafileInputs(
    expectObject(parseObject(metafileSource, "Bun metafile").inputs, "Bun metafile inputs")
  );
  const packages = dependencyPackages(lockPackages);
  const packagePaths = [...packages.keys()].sort((left, right) => right.length - left.length);
  const ownerByInput = new Map<string, string | null>();
  const ownerVersionByInput = new Map<string, string | null>();

  for (const inputPath of metafileInputs.keys()) {
    const owner = owningPackagePath(inputPath, packagePaths);
    ownerByInput.set(inputPath, owner);
    const ownerVersion = owner === null ? null : packages.get(owner)?.version;
    ownerVersionByInput.set(inputPath, typeof ownerVersion === "string" ? ownerVersion : null);
  }
  const includedPackagePaths = new Set(
    [...ownerByInput.values()].filter((value): value is string => value !== null)
  );
  const componentByPackagePath = new Map<string, CycloneComponent>();
  const componentByRef = new Map<string, CycloneComponent>();

  for (const packagePath of [...includedPackagePaths].sort()) {
    const metadata = packages.get(packagePath);
    const name = packageNameFromLockPath(packagePath);
    if (metadata === undefined || name === null || typeof metadata.version !== "string") {
      throw new Error(`Bundled package ${packagePath} has no locked identity.`);
    }
    const purl = npmPurl(name, metadata.version);
    const hashes = hashesFromIntegrity(metadata.integrity);
    const component: CycloneComponent = {
      "bom-ref": purl,
      type: "library",
      name,
      version: metadata.version,
      scope: "required",
      purl,
      ...(hashes === undefined ? {} : { hashes }),
      properties: [BUNDLED_PROPERTY]
    };
    componentByPackagePath.set(packagePath, component);
    componentByRef.set(purl, component);
  }

  const prebundledPackages = await discoverPrebundledPackages({
    rootPath: root,
    inputPaths: metafileInputs.keys(),
    ownerByInput,
    ownerVersionByInput
  });
  for (const prebundled of prebundledPackages) {
    const purl = npmPurl(prebundled.name, prebundled.version);
    const existing = componentByRef.get(purl);
    const locked = matchingLockedPackage(packages, prebundled.name, prebundled.version);
    const hashes = existing?.hashes ?? hashesFromIntegrity(locked?.integrity);
    componentByRef.set(purl, {
      ...(existing ?? {
        "bom-ref": purl,
        type: "library",
        name: prebundled.name,
        version: prebundled.version,
        scope: "required",
        purl
      }),
      ...(hashes === undefined ? {} : { hashes }),
      properties: mergeProperties(existing?.properties ?? [], [
        PREBUNDLED_PROPERTY,
        {
          name: PREBUNDLE_PROVENANCE_PROPERTY_NAME,
          value: prebundled.provenance
        }
      ]),
      evidence: {
        occurrences: mergeOccurrences(
          existing?.evidence?.occurrences ?? [],
          prebundled.sourcePaths.map((location) => ({ location }))
        )
      }
    });
  }

  const bundledNativePackages = [...componentByRef.values()]
    .map((component) => component.name)
    .filter((name) => OPEN_TUI_NATIVE_PACKAGES.has(name));
  if (bundledNativePackages.length !== 1 || bundledNativePackages[0] !== nativePackage) {
    throw new Error(
      `Bun metafile must contain only ${nativePackage}; found ${bundledNativePackages.join(", ") || "none"}.`
    );
  }

  const applicationRef = `agentlab@${input.version}`;
  const bunRef = `bun@${input.bunVersion}`;
  const edges = new Map<string, Set<string>>();
  edges.set(applicationRef, new Set([bunRef]));
  edges.set(bunRef, new Set());
  for (const ref of componentByRef.keys()) edges.set(ref, new Set());

  for (const [sourcePath, metafileInput] of metafileInputs) {
    const sourceOwner = ownerByInput.get(sourcePath);
    const sourceRef =
      typeof sourceOwner === "string"
        ? componentByPackagePath.get(sourceOwner)?.["bom-ref"]
        : applicationRef;
    if (sourceRef === undefined) continue;

    for (const imported of metafileInput.imports) {
      if (imported.external) continue;
      const destinationOwner = ownerByInput.get(imported.path);
      if (typeof destinationOwner !== "string") continue;
      const destinationRef = componentByPackagePath.get(destinationOwner)?.["bom-ref"];
      if (destinationRef !== undefined && destinationRef !== sourceRef) {
        edges.get(sourceRef)?.add(destinationRef);
      }
    }
  }

  for (const prebundled of prebundledPackages) {
    const ownerRef = componentByPackagePath.get(prebundled.ownerPackagePath)?.["bom-ref"];
    const componentRef = npmPurl(prebundled.name, prebundled.version);
    if (ownerRef === undefined || !edges.has(componentRef)) {
      throw new Error(`Prebundled component ${componentRef} has no bundle owner.`);
    }
    if (ownerRef !== componentRef) edges.get(ownerRef)?.add(componentRef);
  }

  const unreachable = unreachableRefs(applicationRef, edges);
  if (unreachable.length > 0) {
    throw new Error(`Bun metafile contains disconnected components: ${unreachable.join(", ")}.`);
  }

  const bunComponent: CycloneComponent = {
    "bom-ref": bunRef,
    type: "framework",
    name: "bun",
    version: input.bunVersion,
    scope: "required",
    purl: `pkg:github/oven-sh/bun@${input.bunVersion}`,
    properties: [RUNTIME_PROPERTY]
  };
  const sbom: BinarySbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        "bom-ref": applicationRef,
        type: "application",
        name: "agentlab",
        version: input.version,
        properties: [{ name: TARGET_PROPERTY_NAME, value: input.target }]
      }
    },
    components: [
      ...[...componentByRef.values()].sort((left, right) =>
        left["bom-ref"].localeCompare(right["bom-ref"])
      ),
      bunComponent
    ],
    dependencies: [...edges.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
      .sort((left, right) => left.ref.localeCompare(right.ref))
  };

  await writeFile(resolve(input.outputPath), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  return sbom;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function parseObject(source: string, label: string): JsonObject {
  try {
    return expectObject(JSON.parse(source), label);
  } catch (error: unknown) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function parseMetafileInputs(value: JsonObject): Map<string, MetafileInput> {
  const inputs = new Map<string, MetafileInput>();
  for (const [path, rawInput] of Object.entries(value)) {
    const input = expectObject(rawInput, `Bun metafile input ${path}`);
    if (!Array.isArray(input.imports)) {
      throw new Error(`Bun metafile input ${path} has no import list.`);
    }
    const imports = input.imports.map((rawImport, index): MetafileImport => {
      const imported = expectObject(rawImport, `Bun metafile import ${path}:${String(index)}`);
      if (typeof imported.path !== "string") {
        throw new Error(`Bun metafile import ${path}:${String(index)} has no path.`);
      }
      return { path: imported.path, external: imported.external === true };
    });
    inputs.set(path, { imports });
  }
  return inputs;
}

function assertVersion(value: string, label: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${label} version is invalid.`);
  }
}

function packageNameFromLockPath(path: string): string | null {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const segments = path.slice(index + marker.length).split("/");
  const first = segments[0];
  if (first === undefined) return null;
  if (first.startsWith("@")) {
    const second = segments[1];
    return second === undefined ? null : `${first}/${second}`;
  }
  return first;
}

function npmPurl(name: string, version: string): string {
  const segments = name.split("/");
  const scope = segments[0];
  const packageName = segments[1];
  const encodedName =
    name.startsWith("@") && scope !== undefined && packageName !== undefined
      ? `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`
      : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function hashesFromIntegrity(
  integrity: unknown
): readonly { readonly alg: "SHA-512"; readonly content: string }[] | undefined {
  if (typeof integrity !== "string") return undefined;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  return [{ alg: "SHA-512", content: Buffer.from(encoded, "base64").toString("hex") }];
}

function dependencyPackages(lockPackages: JsonObject): Map<string, JsonObject> {
  const packages = new Map<string, JsonObject>();
  for (const [path, metadata] of Object.entries(lockPackages)) {
    if (path.includes("node_modules/") && isJsonObject(metadata)) packages.set(path, metadata);
  }
  return packages;
}

function matchingLockedPackage(
  packages: ReadonlyMap<string, JsonObject>,
  name: string,
  version: string
): JsonObject | null {
  for (const [path, metadata] of packages) {
    if (packageNameFromLockPath(path) === name && metadata.version === version) return metadata;
  }
  return null;
}

function mergeProperties(
  current: readonly { readonly name: string; readonly value: string }[],
  added: readonly { readonly name: string; readonly value: string }[]
): readonly { readonly name: string; readonly value: string }[] {
  const properties = new Map<string, { readonly name: string; readonly value: string }>();
  for (const property of [...current, ...added]) {
    properties.set(`${property.name}\0${property.value}`, property);
  }
  return [...properties.values()].sort((left, right) =>
    `${left.name}\0${left.value}`.localeCompare(`${right.name}\0${right.value}`)
  );
}

function mergeOccurrences(
  current: readonly { readonly location: string }[],
  added: readonly { readonly location: string }[]
): readonly { readonly location: string }[] {
  return [...new Set([...current, ...added].map(({ location }) => location))]
    .sort()
    .map((location) => ({ location }));
}

function owningPackagePath(inputPath: string, packagePaths: readonly string[]): string | null {
  const normalized = inputPath.replaceAll("\\", "/");
  return (
    packagePaths.find((path) => normalized === path || normalized.startsWith(`${path}/`)) ?? null
  );
}

function unreachableRefs(root: string, edges: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const reached = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined || reached.has(ref)) continue;
    reached.add(ref);
    for (const dependency of edges.get(ref) ?? []) pending.push(dependency);
  }
  return [...edges.keys()].filter((ref) => !reached.has(ref)).sort();
}
