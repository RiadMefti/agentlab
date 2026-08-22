import { spawnSync } from "node:child_process";
import { open, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

interface PackageMetadata {
  dependencies?: Record<string, string>;
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
    mkdir(join(root, "apps", "desktop"), { recursive: true }),
    mkdir(join(root, "apps", "server"), { recursive: true }),
    mkdir(join(root, "packages", "contracts"), { recursive: true })
  ]);

  await Promise.all([
    writeJson(join(root, "package.json"), {
      name: "agent-orchestrator",
      version: "0.1.0",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      dependencies: { "@orchestrator/desktop": "0.1.0" }
    }),
    writeJson(join(root, "apps", "desktop", "package.json"), {
      name: "@orchestrator/desktop",
      version: "0.1.0",
      private: true,
      dependencies: {
        "@orchestrator/contracts": "0.1.0",
        "@orchestrator/server": "0.1.0"
      }
    }),
    writeJson(join(root, "apps", "server", "package.json"), {
      name: "@orchestrator/server",
      version: "0.1.0",
      private: true,
      dependencies: { "@orchestrator/contracts": "0.1.0", fastify: "1.0.0" }
    }),
    writeJson(join(root, "packages", "contracts", "package.json"), {
      name: "@orchestrator/contracts",
      version: "0.1.0",
      private: true
    }),
    writeJson(join(root, "package-lock.json"), {
      name: "agent-orchestrator",
      version: "0.1.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "agent-orchestrator",
          version: "0.1.0",
          workspaces: ["apps/*", "packages/*"],
          dependencies: { "@orchestrator/desktop": "0.1.0" }
        },
        "apps/desktop": {
          name: "@orchestrator/desktop",
          version: "0.1.0",
          dependencies: {
            "@orchestrator/contracts": "0.1.0",
            "@orchestrator/server": "0.1.0"
          }
        },
        "apps/server": {
          name: "@orchestrator/server",
          version: "0.1.0",
          dependencies: { "@orchestrator/contracts": "0.1.0", fastify: "1.0.0" }
        },
        "packages/contracts": {
          name: "@orchestrator/contracts",
          version: "0.1.0"
        }
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
  trailer?: Uint8Array
): Promise<void> {
  const size = 50 * 1024 * 1024 + 1;
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
    await handle.write(header, 0, header.length, 0);
    if (trailer) await handle.write(trailer, 0, trailer.length, size - 512);
  } finally {
    await handle.close();
  }
}

async function createAssetFixture(version = "0.1.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-release-assets-"));
  temporaryDirectories.push(root);
  const appImageHeader = Buffer.alloc(11);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(appImageHeader, 0);
  Buffer.from([0x41, 0x49, 0x02]).copy(appImageHeader, 8);
  const dmgTrailer = Buffer.alloc(512);
  dmgTrailer.write("koly", 0, "ascii");

  await Promise.all([
    createSparseBinary(join(root, "Orchestrator-linux-x64.AppImage"), appImageHeader),
    createSparseBinary(join(root, "Orchestrator-mac-arm64.dmg"), Buffer.alloc(0), dmgTrailer),
    createSparseBinary(join(root, "Orchestrator-mac-x64.dmg"), Buffer.alloc(0), dmgTrailer),
    writeJson(join(root, `Orchestrator-${version}.cdx.json`), {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: { component: { name: "agent-orchestrator", version } },
      components: [{ name: "node-pty", version: "1.1.0" }]
    })
  ]);

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
  it("accepts a tag only when every workspace and lock entry agrees", async () => {
    const root = await createVersionFixture();

    const result = runScript("check-release.mjs", "v0.1.0", "--root", root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Release metadata is valid for v0.1.0.");
  });

  it("rejects mismatched tags and internal dependency versions", async () => {
    const root = await createVersionFixture();
    const wrongTag = runScript("check-release.mjs", "v0.2.0", "--root", root);
    const desktopPath = join(root, "apps", "desktop", "package.json");
    const desktop = parsePackageMetadata(await readFile(desktopPath, "utf8"));
    if (!desktop.dependencies) throw new Error("Desktop fixture dependencies are missing.");
    desktop.dependencies["@orchestrator/server"] = "0.0.9";
    await writeJson(desktopPath, desktop);

    const wrongDependency = runScript("check-release.mjs", "v0.1.0", "--root", root);

    expect(wrongTag.status).toBe(1);
    expect(wrongTag.stderr).toContain("does not match package version");
    expect(wrongDependency.status).toBe(1);
    expect(wrongDependency.stderr).toContain("dependencies.@orchestrator/server");
  });

  it("prepares one greater stable version across manifests and the lockfile", async () => {
    const root = await createVersionFixture();

    const result = runScript("prepare-release.mjs", "0.2.0", "--root", root);
    const manifests = await Promise.all(
      [
        "package.json",
        "apps/desktop/package.json",
        "apps/server/package.json",
        "packages/contracts/package.json"
      ].map(async (path) => parsePackageMetadata(await readFile(join(root, path), "utf8")))
    );
    const lock = parsePackageLockMetadata(await readFile(join(root, "package-lock.json"), "utf8"));

    expect(result.status).toBe(0);
    expect(manifests.every((manifest) => manifest.version === "0.2.0")).toBe(true);
    expect(manifests[0]?.dependencies?.["@orchestrator/desktop"]).toBe("0.2.0");
    expect(manifests[1]?.dependencies?.["@orchestrator/server"]).toBe("0.2.0");
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages["apps/desktop"]?.dependencies?.["@orchestrator/contracts"]).toBe("0.2.0");
    expect(runScript("check-release.mjs", "v0.2.0", "--root", root).status).toBe(0);
  });

  it("does not mutate metadata for an invalid or non-increasing version", async () => {
    const root = await createVersionFixture();
    const packagePath = join(root, "package.json");
    const before = await readFile(packagePath, "utf8");

    const result = runScript("prepare-release.mjs", "0.1.0", "--root", root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be greater than current version");
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });
});

describe("release asset validation", () => {
  it("accepts only the complete release set with valid container signatures", async () => {
    const root = await createAssetFixture();

    const result = runScript("check-release-assets.mjs", "v0.1.0", root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Validated 4 release assets for v0.1.0.");
  });

  it("rejects extra files and malformed binary containers", async () => {
    const root = await createAssetFixture();
    await writeFile(join(root, "unexpected.txt"), "unexpected", "utf8");
    const extraFile = runScript("check-release-assets.mjs", "v0.1.0", root);
    await rm(join(root, "unexpected.txt"));
    const appImagePath = join(root, "Orchestrator-linux-x64.AppImage");
    const handle = await open(appImagePath, "r+");
    try {
      await handle.write(Buffer.from("NOPE"), 0, 4, 0);
    } finally {
      await handle.close();
    }

    const malformed = runScript("check-release-assets.mjs", "v0.1.0", root);

    expect(extraFile.status).toBe(1);
    expect(extraFile.stderr).toContain("Release asset set is invalid");
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("valid type-2 AppImage header");
  });
});

describe("dependency update policy", () => {
  it("automates compatible npm upgrades without batching breaking changes", async () => {
    const configuration = await readFile(join(projectRoot, ".github", "dependabot.yml"), "utf8");

    expect(configuration).toMatch(
      /npm-development:[\s\S]*?applies-to: version-updates[\s\S]*?dependency-type: development[\s\S]*?- minor[\s\S]*?- patch/
    );
    expect(configuration).toMatch(
      /npm-production:[\s\S]*?applies-to: version-updates[\s\S]*?dependency-type: production[\s\S]*?- minor[\s\S]*?- patch/
    );
    expect(configuration).toMatch(
      /ignore:[\s\S]*?dependency-name: "\*"[\s\S]*?- version-update:semver-major/
    );
  });
});
