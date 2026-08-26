import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

interface PackageMetadata {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  version: string;
}

interface PackageLockMetadata {
  packages: Record<string, PackageMetadata>;
  version: string;
}

function parsePackageMetadata(source: string): PackageMetadata {
  return JSON.parse(source) as PackageMetadata;
}

function parsePackageLockMetadata(source: string): PackageLockMetadata {
  return JSON.parse(source) as PackageLockMetadata;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createVersionFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-release-version-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "apps", "tui", "src"), { recursive: true }),
    mkdir(join(root, "packages", "contracts"), { recursive: true }),
    mkdir(join(root, "packages", "runtime"), { recursive: true })
  ]);

  const workspaces = ["apps/*", "packages/*"];
  const rootPackage = {
    name: "agent-orchestrator",
    version: "0.1.0",
    private: true,
    workspaces
  };
  const tui = {
    name: "@orchestrator/tui",
    version: "0.1.0",
    private: true,
    dependencies: {
      "@orchestrator/contracts": "0.1.0",
      "@orchestrator/runtime": "0.1.0"
    }
  };
  const contracts = {
    name: "@orchestrator/contracts",
    version: "0.1.0",
    private: true
  };
  const runtime = {
    name: "@orchestrator/runtime",
    version: "0.1.0",
    private: true,
    dependencies: { "@orchestrator/contracts": "0.1.0" }
  };
  await Promise.all([
    writeJson(join(root, "package.json"), rootPackage),
    writeJson(join(root, "apps", "tui", "package.json"), tui),
    writeFile(
      join(root, "apps", "tui", "src", "version.ts"),
      'export const appVersion = "0.1.0";\n',
      "utf8"
    ),
    writeJson(join(root, "packages", "contracts", "package.json"), contracts),
    writeJson(join(root, "packages", "runtime", "package.json"), runtime),
    writeJson(join(root, "package-lock.json"), {
      name: rootPackage.name,
      version: rootPackage.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": rootPackage,
        "apps/tui": tui,
        "packages/contracts": contracts,
        "packages/runtime": runtime
      }
    })
  ]);
  return root;
}

function runScript(script: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [join(projectRoot, "scripts", script), ...arguments_], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

async function createSparseBinary(
  path: string,
  header: Uint8Array,
  size = 20 * 1024 * 1024 + 1
): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
    await handle.write(header, 0, header.length, 0);
    const provenanceMarker = Buffer.from(
      'https://api.anthropic.com X-Stainless-Lang;var EmbeddedSdk="0.112.1";{"X-Stainless-Package-Version":EmbeddedSdk};{"X-Stainless-Package-Version":EmbeddedSdk}',
      "utf8"
    );
    await handle.write(provenanceMarker, 0, provenanceMarker.length, header.length);
  } finally {
    await handle.close();
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error(`Could not hash ${path}.`);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function createAssetFixture(
  version = "0.1.0",
  includeChecksums = false,
  includeBun = true
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-release-assets-"));
  temporaryDirectories.push(root);
  const linuxName = `agent-orchestrator-v${version}-linux-x64`;
  const macName = `agent-orchestrator-v${version}-mac-arm64`;
  const linuxSbomName = `${linuxName}.cdx.json`;
  const macSbomName = `${macName}.cdx.json`;
  const linuxHeader = Buffer.alloc(24);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(linuxHeader);
  linuxHeader.writeUInt16LE(0x3e, 18);
  const macHeader = Buffer.alloc(24);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(macHeader);
  macHeader.writeUInt32LE(0x0100000c, 4);
  const bun = {
    "bom-ref": "bun@1.4.0",
    type: "framework",
    name: "bun",
    version: "1.4.0",
    scope: "required",
    purl: "pkg:github/oven-sh/bun@1.4.0",
    properties: [
      {
        name: "agent-orchestrator:component:distribution",
        value: "embedded-runtime"
      }
    ]
  };
  const nativeComponent = (name: string) => ({
    "bom-ref": `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@0.5.8`,
    type: "library",
    name,
    version: "0.5.8",
    scope: "required",
    purl: `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@0.5.8`,
    properties: [
      {
        name: "agent-orchestrator:component:distribution",
        value: "bundled"
      }
    ]
  });
  const claude = {
    "bom-ref": "pkg:npm/%40anthropic-ai/claude-agent-sdk@0.3.239",
    type: "library",
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.239",
    scope: "required",
    purl: "pkg:npm/%40anthropic-ai/claude-agent-sdk@0.3.239",
    properties: [
      {
        name: "agent-orchestrator:component:distribution",
        value: "bundled"
      }
    ]
  };
  const anthropic = {
    "bom-ref": "pkg:npm/%40anthropic-ai/sdk@0.112.1",
    type: "library",
    name: "@anthropic-ai/sdk",
    version: "0.112.1",
    scope: "required",
    purl: "pkg:npm/%40anthropic-ai/sdk@0.112.1",
    properties: [
      {
        name: "agent-orchestrator:component:distribution",
        value: "prebundled"
      },
      {
        name: "agent-orchestrator:component:provenance",
        value: "anthropic-stainless-runtime-marker"
      }
    ],
    evidence: {
      occurrences: [{ location: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" }]
    }
  };
  const sbom = (target: "linux-x64" | "mac-arm64", nativeName: string) => {
    const native = nativeComponent(nativeName);
    return {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: {
        component: {
          "bom-ref": `agent-orchestrator@${version}`,
          name: "agent-orchestrator",
          version,
          properties: [
            {
              name: "agent-orchestrator:binary:target",
              value: target
            }
          ]
        }
      },
      components: includeBun ? [native, claude, anthropic, bun] : [native, claude, anthropic],
      dependencies: [
        {
          ref: `agent-orchestrator@${version}`,
          dependsOn: includeBun
            ? [native["bom-ref"], claude["bom-ref"], bun["bom-ref"]]
            : [native["bom-ref"], claude["bom-ref"]]
        },
        { ref: native["bom-ref"], dependsOn: [] },
        { ref: claude["bom-ref"], dependsOn: [anthropic["bom-ref"]] },
        { ref: anthropic["bom-ref"], dependsOn: [] },
        ...(includeBun ? [{ ref: bun["bom-ref"], dependsOn: [] }] : [])
      ]
    };
  };

  await Promise.all([
    createSparseBinary(join(root, linuxName), linuxHeader),
    createSparseBinary(join(root, macName), macHeader),
    writeJson(join(root, linuxSbomName), sbom("linux-x64", "@opentui/core-linux-x64")),
    writeJson(join(root, macSbomName), sbom("mac-arm64", "@opentui/core-darwin-arm64"))
  ]);

  if (includeChecksums) {
    const assetNames = [linuxName, linuxSbomName, macName, macSbomName].sort();
    const checksums = await Promise.all(
      assetNames.map(async (name) => `${await sha256(join(root, name))}  ${name}`)
    );
    await writeFile(join(root, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("release version metadata", () => {
  it("accepts a tag only when every workspace, lock entry, and source version agrees", async () => {
    const root = await createVersionFixture();
    const result = runScript("check-release.mjs", "v0.1.0", "--root", root);
    expect(result.status).toBe(0);
  });

  it("rejects mismatched tags and internal dependency versions", async () => {
    const root = await createVersionFixture();
    const wrongTag = runScript("check-release.mjs", "v0.2.0", "--root", root);
    const tuiPath = join(root, "apps", "tui", "package.json");
    const tui = parsePackageMetadata(await readFile(tuiPath, "utf8"));
    if (!tui.dependencies) throw new Error("TUI fixture dependencies are missing.");
    tui.dependencies["@orchestrator/runtime"] = "0.0.9";
    await writeJson(tuiPath, tui);
    const wrongDependency = runScript("check-release.mjs", "v0.1.0", "--root", root);

    expect(wrongTag.status).toBe(1);
    expect(wrongDependency.status).toBe(1);
  });

  it("prepares one greater stable version across metadata and canonical source", async () => {
    const root = await createVersionFixture();
    const result = runScript("prepare-release.mjs", "0.2.0", "--root", root);
    const manifestPaths = [
      "package.json",
      "apps/tui/package.json",
      "packages/contracts/package.json",
      "packages/runtime/package.json"
    ];
    const manifests = await Promise.all(
      manifestPaths.map(async (path) =>
        parsePackageMetadata(await readFile(join(root, path), "utf8"))
      )
    );
    const lock = parsePackageLockMetadata(await readFile(join(root, "package-lock.json"), "utf8"));

    expect(result.status).toBe(0);
    expect(manifests.every((manifest) => manifest.version === "0.2.0")).toBe(true);
    expect(manifests[1]?.dependencies?.["@orchestrator/runtime"]).toBe("0.2.0");
    expect(manifests[3]?.dependencies?.["@orchestrator/contracts"]).toBe("0.2.0");
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages["apps/tui"]?.dependencies?.["@orchestrator/contracts"]).toBe("0.2.0");
    expect(await readFile(join(root, "apps", "tui", "src", "version.ts"), "utf8")).toBe(
      'export const appVersion = "0.2.0";\n'
    );
    expect(runScript("check-release.mjs", "v0.2.0", "--root", root).status).toBe(0);
  });

  it("does not mutate metadata for a non-increasing version", async () => {
    const root = await createVersionFixture();
    const packagePath = join(root, "package.json");
    const before = await readFile(packagePath, "utf8");
    const result = runScript("prepare-release.mjs", "0.1.0", "--root", root);
    expect(result.status).toBe(1);
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });
});

describe("release asset validation", () => {
  it("accepts only each executable and its target-specific production SBOM", async () => {
    const root = await createAssetFixture();
    const result = runScript("check-release-assets.mjs", "v0.1.0", root);
    expect(result.status).toBe(0);
  });

  it("rejects a release SBOM without the embedded Bun runtime", async () => {
    const root = await createAssetFixture("0.1.0", false, false);
    const result = runScript("check-release-assets.mjs", "v0.1.0", root);
    expect(result.status).toBe(1);
  });

  it("rejects extra files and malformed binary architecture", async () => {
    const root = await createAssetFixture();
    await writeFile(join(root, "unexpected.txt"), "unexpected", "utf8");
    const extraFile = runScript("check-release-assets.mjs", "v0.1.0", root);
    await rm(join(root, "unexpected.txt"));
    const linuxPath = join(root, "agent-orchestrator-v0.1.0-linux-x64");
    const handle = await open(linuxPath, "r+");
    try {
      await handle.write(Buffer.from("NOPE"), 0, 4, 0);
    } finally {
      await handle.close();
    }
    const malformed = runScript("check-release-assets.mjs", "v0.1.0", root);

    expect(extraFile.status).toBe(1);
    expect(malformed.status).toBe(1);
  });

  it("verifies the exact checksum manifest for published assets", async () => {
    const root = await createAssetFixture("0.1.0", true);
    const valid = runScript("check-release-assets.mjs", "v0.1.0", root, "--published");
    const checksumPath = join(root, "SHA256SUMS");
    const source = await readFile(checksumPath, "utf8");
    await writeFile(
      checksumPath,
      source.replace(/^[0-9a-f]/u, (character) => (character === "0" ? "1" : "0")),
      "utf8"
    );
    const invalid = runScript("check-release-assets.mjs", "v0.1.0", root, "--published");

    expect(valid.status).toBe(0);
    expect(invalid.status).toBe(1);
  });
});

describe("release SBOM generation", () => {
  it("derives target inputs and exact upstream prebundle versions from Bun provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-sbom-"));
    temporaryDirectories.push(root);
    const metafilePath = join(root, "metafile.json");
    const outputPath = join(root, "binary.cdx.json");
    await Promise.all([
      mkdir(join(root, "node_modules", "@opentui", "core"), { recursive: true }),
      mkdir(join(root, "node_modules", "@opentui", "core-linux-x64"), {
        recursive: true
      }),
      mkdir(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk"), {
        recursive: true
      })
    ]);
    await writeJson(join(root, "package-lock.json"), {
      packages: {
        "": { name: "agent-orchestrator", version: "0.1.10" },
        "node_modules/@opentui/core": { version: "0.5.8" },
        "node_modules/@opentui/core-linux-x64": { version: "0.5.8" },
        "node_modules/@opentui/core-darwin-arm64": { version: "0.5.8" },
        "node_modules/@anthropic-ai/claude-agent-sdk": { version: "0.3.239" },
        "node_modules/@anthropic-ai/sdk": { version: "9.9.9" },
        // Deliberately differs from the version embedded by the upstream prebundle. The SBOM must
        // trust the module marker carried by the actual Bun input, not this consumer lock entry.
        "node_modules/vendored-lib": { version: "9.9.9" },
        "node_modules/unused": { version: "9.9.9" }
      }
    });
    await Promise.all([
      writeFile(
        join(root, "node_modules", "@opentui", "core", "index.js"),
        "// ../../../node_modules/.bun/vendored-lib@2.3.4+deadbeef/node_modules/vendored-lib/index.js\nexport {};\n",
        "utf8"
      ),
      writeFile(
        join(root, "node_modules", "@opentui", "core-linux-x64", "index.js"),
        "export {};\n",
        "utf8"
      ),
      writeFile(
        join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
        claudeSdkBundleFixture(),
        "utf8"
      )
    ]);
    await writeJson(metafilePath, {
      inputs: {
        "apps/tui/src/main.tsx": {
          imports: [
            { path: "node_modules/@opentui/core/index.js" },
            { path: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" }
          ]
        },
        "node_modules/@opentui/core/index.js": {
          imports: [
            { path: "node_modules/@opentui/core-linux-x64/index.js" },
            { path: "@opentui/core-darwin-arm64", external: true }
          ]
        },
        "node_modules/@opentui/core-linux-x64/index.js": { imports: [] },
        "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": { imports: [] }
      }
    });
    const { generateBinarySbom } = await import("../../scripts/generate-release-sbom.js");
    const sbom = await generateBinarySbom({
      rootPath: root,
      metafilePath,
      outputPath,
      target: "linux-x64",
      version: "0.1.10",
      bunVersion: "1.4.0"
    });
    const bun = sbom.components.find(({ name }) => name === "bun");
    const applicationDependency = sbom.dependencies.find(
      ({ ref }) => ref === "agent-orchestrator@0.1.10"
    );
    const componentNames = sbom.components.map(({ name }) => name);
    const vendored = sbom.components.find(({ name }) => name === "vendored-lib");
    const core = sbom.components.find(({ name }) => name === "@opentui/core");
    const coreDependency = sbom.dependencies.find(({ ref }) => ref === core?.["bom-ref"]);
    const claude = sbom.components.find(({ name }) => name === "@anthropic-ai/claude-agent-sdk");
    const anthropic = sbom.components.find(
      ({ name, version }) => name === "@anthropic-ai/sdk" && version === "0.112.1"
    );
    const claudeDependency = sbom.dependencies.find(({ ref }) => ref === claude?.["bom-ref"]);

    expect(bun).toMatchObject({
      type: "framework",
      name: "bun",
      scope: "required"
    });
    expect(applicationDependency?.dependsOn).toContain(bun?.["bom-ref"]);
    expect(componentNames).toContain("@opentui/core-linux-x64");
    expect(componentNames).not.toContain("@opentui/core-darwin-arm64");
    expect(componentNames).not.toContain("unused");
    expect(vendored).toMatchObject({
      name: "vendored-lib",
      version: "2.3.4",
      properties: expect.arrayContaining([
        {
          name: "agent-orchestrator:component:distribution",
          value: "prebundled"
        },
        {
          name: "agent-orchestrator:component:provenance",
          value: "bun-module-marker"
        }
      ]),
      evidence: {
        occurrences: [{ location: "node_modules/@opentui/core/index.js" }]
      }
    });
    expect(coreDependency?.dependsOn).toContain(vendored?.["bom-ref"]);
    expect(anthropic).toMatchObject({
      name: "@anthropic-ai/sdk",
      version: "0.112.1",
      properties: expect.arrayContaining([
        {
          name: "agent-orchestrator:component:distribution",
          value: "prebundled"
        },
        {
          name: "agent-orchestrator:component:provenance",
          value: "anthropic-stainless-runtime-marker"
        }
      ]),
      evidence: {
        occurrences: [{ location: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" }]
      }
    });
    expect(claudeDependency?.dependsOn).toContain(anthropic?.["bom-ref"]);
    expect(sbom.components).not.toContainEqual(
      expect.objectContaining({ name: "vendored-lib", version: "9.9.9" })
    );
    expect(sbom.components).not.toContainEqual(
      expect.objectContaining({ name: "@anthropic-ai/sdk", version: "9.9.9" })
    );
    expect(sbom.metadata.component.properties).toContainEqual({
      name: "agent-orchestrator:binary:target",
      value: "linux-x64"
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(sbom);
  });
});

function claudeSdkBundleFixture(): string {
  return [
    "// Version: 0.3.239",
    'var SdkVersion="0.112.1";',
    'const headers={first:{"X-Stainless-Package-Version":SdkVersion},second:{"X-Stainless-Package-Version":SdkVersion}};',
    'const runtime={baseURL:"https://api.anthropic.com",language:"X-Stainless-Lang"};',
    "export {headers,runtime};"
  ].join("\n");
}

describe("dependency update policy", () => {
  it("automates compatible npm upgrades without batching breaking changes", async () => {
    const configuration = await readFile(join(projectRoot, ".github", "dependabot.yml"), "utf8");
    expect(configuration).toMatch(
      /npm-development:[\s\S]*?dependency-type: development[\s\S]*?- minor[\s\S]*?- patch/u
    );
    expect(configuration).toMatch(
      /npm-production:[\s\S]*?dependency-type: production[\s\S]*?- minor[\s\S]*?- patch/u
    );
    expect(configuration).toMatch(
      /ignore:[\s\S]*?dependency-name: "\*"[\s\S]*?- version-update:semver-major/u
    );
  });
});

describe("release workflow trust boundaries", () => {
  it("builds workspace export targets before every source and packaging entrypoint", async () => {
    const rootPackage = parsePackageMetadata(
      await readFile(join(projectRoot, "package.json"), "utf8")
    );

    for (const script of ["dev", "start", "test:bun", "package"] as const) {
      expect(rootPackage.scripts?.[script]).toMatch(/^npm run build:packages && /u);
    }
  });

  it("builds native Bun executables for the two supported release targets", async () => {
    const workflow = await readFile(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf8"
    );
    expect(workflow).toContain(
      "agent-orchestrator-v${{ needs.validate.outputs.version }}-linux-x64"
    );
    expect(workflow).toContain(
      "agent-orchestrator-v${{ needs.validate.outputs.version }}-mac-arm64"
    );
    expect(workflow).toContain('npm install --global "bun@${BUN_VERSION}"');
    expect(workflow).toContain("npm run package");
    expect(workflow).not.toMatch(/Electron|AppImage|\.dmg|electron-builder/u);
  });

  it("keeps publication immutable and attests executables plus the SBOM", async () => {
    const workflow = await readFile(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf8"
    );
    const inspectIndex = workflow.indexOf("- name: Inspect any existing release");
    const attestIndex = workflow.indexOf("- name: Attest build provenance");
    expect(inspectIndex).toBeGreaterThan(0);
    expect(inspectIndex).toBeLessThan(attestIndex);
    expect(workflow).toContain("if: steps.existing.outputs.state != 'published'");
    expect(workflow).toContain('gh release download "$GITHUB_REF_NAME"');
    expect(workflow).toContain('gh attestation verify "$asset"');
    expect(workflow).toContain("xattr -d com.apple.quarantine");
    expect(workflow).toContain("sbom-path:");
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow.split('test "$remote_digest" = "sha256:$digest"')).toHaveLength(3);
  });
});
