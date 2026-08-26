import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appVersion } from "../apps/tui/src/version.js";
import { assertBinarySbomCorrespondence } from "./binary-sbom-correspondence.js";
import { generateBinarySbom, type BinarySbomTarget } from "./generate-release-sbom.js";

const OPEN_TUI_NATIVE_PACKAGES = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64"
] as const;

export interface BinaryTarget {
  readonly artifactSuffix: BinarySbomTarget;
  readonly nativePackage: (typeof OPEN_TUI_NATIVE_PACKAGES)[number];
}

export function resolveBinaryTarget(platform: NodeJS.Platform, arch: string): BinaryTarget {
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return {
      artifactSuffix: `linux-${arch}`,
      nativePackage: `@opentui/core-linux-${arch}`
    };
  }
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return {
      artifactSuffix: `mac-${arch}`,
      nativePackage: `@opentui/core-darwin-${arch}`
    };
  }
  throw new Error(`Unsupported binary target: ${platform}-${arch}.`);
}

export function externalNativePackages(target: BinaryTarget): readonly string[] {
  return OPEN_TUI_NATIVE_PACKAGES.filter((name) => name !== target.nativePackage);
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const packageJson = (await Bun.file(resolve(root, "package.json")).json()) as {
    readonly version?: unknown;
  };
  if (packageJson.version !== appVersion) {
    throw new Error("package.json and apps/tui/src/version.ts must have the same version.");
  }
  const target = resolveBinaryTarget(process.platform, process.arch);
  const releaseDirectory = resolve(root, "release");
  const artifactName = `agent-orchestrator-v${appVersion}-${target.artifactSuffix}`;
  const artifactPath = resolve(releaseDirectory, artifactName);
  const sbomPath = `${artifactPath}.cdx.json`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-orchestrator-build-"));
  const metafilePath = resolve(temporaryDirectory, "bun-metafile.json");
  await mkdir(releaseDirectory, { recursive: true });

  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--minify",
        "--sourcemap=none",
        `--metafile=${metafilePath}`,
        ...externalNativePackages(target).flatMap((name) => ["--external", name]),
        `--outfile=${artifactPath}`,
        "apps/tui/src/main.tsx"
      ],
      { cwd: root, stderr: "inherit", stdout: "inherit" }
    );
    const buildExitCode = await build.exited;
    if (buildExitCode !== 0) {
      throw new Error(`Bun compile failed with exit code ${String(buildExitCode)}.`);
    }
    const sbom = await generateBinarySbom({
      rootPath: root,
      metafilePath,
      outputPath: sbomPath,
      target: target.artifactSuffix,
      version: appVersion,
      bunVersion: Bun.version
    });
    await assertBinarySbomCorrespondence(artifactPath, sbom);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  await chmod(artifactPath, 0o755);

  await assertOutput(artifactPath, ["--version"], `${appVersion}\n`);
  const help = await capture(artifactPath, ["--help"]);
  if (!help.includes("orchestrator")) {
    throw new Error("Packaged binary help smoke test failed.");
  }

  if (process.platform === "linux") {
    await assertFailure(
      artifactPath,
      [],
      { OPENTUI_LIBC: "musl" },
      "This Linux executable requires glibc"
    );
  }
  process.stdout.write(`Packaged ${artifactPath} and ${sbomPath}\n`);
}

async function assertOutput(
  executable: string,
  args: readonly string[],
  expected: string
): Promise<void> {
  const output = await capture(executable, args);
  if (output !== expected) {
    throw new Error(`Packaged binary returned unexpected output for ${args.join(" ")}.`);
  }
}

async function capture(executable: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn([executable, ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`Packaged binary smoke test failed: ${stderr.trim()}`);
  }
  return stdout;
}

async function assertFailure(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  expectedError: string
): Promise<void> {
  const child = Bun.spawn([executable, ...args], {
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "ignore"
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode === 0 || !stderr.includes(expectedError)) {
    throw new Error(`Packaged binary did not reject the unsupported runtime: ${stderr.trim()}`);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
