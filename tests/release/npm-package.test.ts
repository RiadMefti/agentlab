import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("npm package preparation", () => {
  it("keeps AgentLab as the only publishable package without personal author metadata", async () => {
    const manifestPaths = [
      "package.json",
      "apps/tui/package.json",
      "packages/contracts/package.json",
      "packages/launcher/package.json",
      "packages/runtime/package.json"
    ];
    const manifests = await Promise.all(
      manifestPaths.map(async (path) => {
        const manifest = JSON.parse(await readFile(join(projectRoot, path), "utf8")) as {
          author?: unknown;
          copyright?: unknown;
          name: string;
          private?: boolean;
        };
        return { ...manifest, path };
      })
    );

    expect(
      manifests
        .filter((manifest) => manifest.private !== true)
        .map(({ name, path }) => ({
          name,
          path
        }))
    ).toEqual([{ name: "agentlab", path: "packages/launcher/package.json" }]);
    expect(
      manifests.every(({ author, copyright }) => author === undefined && copyright === undefined)
    ).toBe(true);
  });

  it("binds the npm launcher to the exact GitHub release binaries", async () => {
    const version = await currentLauncherVersion();
    const tag = `v${version}`;
    const root = await temporaryRoot();
    const assets = join(root, "assets");
    const output = join(root, "package");
    await mkdir(assets);
    const linux = Buffer.from("linux agentlab executable");
    const mac = Buffer.from("mac agentlab executable");
    await Promise.all([
      writeFile(join(assets, `agentlab-${tag}-linux-x64`), linux),
      writeFile(join(assets, `agentlab-${tag}-mac-arm64`), mac)
    ]);

    const prepared = runScript("prepare-npm-package.mjs", tag, assets, output);
    expect(prepared.status, prepared.stderr).toBe(0);

    const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8")) as {
      repository: string;
      targets: Record<string, { asset: string; sha256: string; size: number }>;
      version: string;
    };
    expect(manifest).toMatchObject({ repository: "RiadMefti/agentlab", version });
    expect(manifest.targets["linux-x64"]).toEqual({
      asset: `agentlab-${tag}-linux-x64`,
      sha256: sha256(linux),
      size: linux.byteLength
    });
    expect(manifest.targets["mac-arm64"]).toEqual({
      asset: `agentlab-${tag}-mac-arm64`,
      sha256: sha256(mac),
      size: mac.byteLength
    });

    const packageJson = JSON.parse(await readFile(join(output, "package.json"), "utf8")) as {
      author?: unknown;
      files: string[];
      name: string;
    };
    expect(packageJson).toMatchObject({
      files: ["dist/*.js", "release-manifest.json", "README.md", "LICENSE"],
      name: "agentlab"
    });
    expect(packageJson.author).toBeUndefined();

    const prepack = spawnSync(process.execPath, [join(output, "dist", "prepack.js")], {
      cwd: output,
      encoding: "utf8"
    });
    expect(prepack.status, prepack.stderr).toBe(0);
    expect(prepack.stdout).toContain(`Validated agentlab@${version} npm package.`);

    const packed = spawnSync("npm", ["pack", output, "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
    const packedPaths = packResult[0]?.files.map(({ path }) => path) ?? [];
    expect(packedPaths).toContain("dist/agentlab.js");
    expect(packedPaths).not.toContain("dist/.tsbuildinfo");
    expect(packedPaths.every((path) => !path.endsWith(".d.ts"))).toBe(true);
  });

  it("refuses to overwrite an existing output directory", async () => {
    const version = await currentLauncherVersion();
    const tag = `v${version}`;
    const root = await temporaryRoot();
    const assets = join(root, "assets");
    const output = join(root, "package");
    await Promise.all([mkdir(assets), mkdir(output)]);
    await Promise.all([
      writeFile(join(assets, `agentlab-${tag}-linux-x64`), "linux"),
      writeFile(join(assets, `agentlab-${tag}-mac-arm64`), "mac")
    ]);
    const prepared = runScript("prepare-npm-package.mjs", tag, assets, output);
    expect(prepared.status).toBe(1);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-npm-package-"));
  temporaryDirectories.push(root);
  return root;
}

async function currentLauncherVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, "packages", "launcher", "package.json"), "utf8")
  ) as { version: string };
  return manifest.version;
}

function runScript(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
