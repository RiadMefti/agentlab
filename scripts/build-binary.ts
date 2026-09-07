import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appVersion } from "../apps/tui/src/version.js";
import { exitCodeForSignal } from "../apps/tui/src/bootstrap/signal-exit.js";
import { assertBinarySbomCorrespondence } from "./binary-sbom-correspondence.js";
import { generateBinarySbom, type BinarySbomTarget } from "./generate-release-sbom.js";
import { createRuntimeSmokeSandbox } from "./runtime-smoke-sandbox.js";

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
  const artifactName = `agentlab-v${appVersion}-${target.artifactSuffix}`;
  const artifactPath = resolve(releaseDirectory, artifactName);
  const sbomPath = `${artifactPath}.cdx.json`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentlab-build-"));
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

  const smokeSandbox = await createRuntimeSmokeSandbox("agentlab-compiled-smoke-");
  try {
    await assertOutput(artifactPath, ["--version"], `${appVersion}\n`, smokeSandbox.environment);
    const help = await capture(artifactPath, ["--help"], smokeSandbox.environment);
    if (!help.includes("agentlab")) {
      throw new Error("Packaged binary help smoke test failed.");
    }
    await assertDiagnosticsRedirected(artifactPath, smokeSandbox.environment);
    await assertSignalCleanup(artifactPath, smokeSandbox.environment);

    if (process.platform === "linux") {
      await assertFailure(
        artifactPath,
        [],
        { ...smokeSandbox.environment, OPENTUI_LIBC: "musl" },
        "This Linux executable requires glibc"
      );
    }
  } finally {
    await smokeSandbox.dispose();
  }
  process.stdout.write(`Packaged ${artifactPath} and ${sbomPath}\n`);
}

async function assertSignalCleanup(
  executable: string,
  environment: Readonly<Record<string, string>>
): Promise<void> {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGBUS"] as const) {
    let output = "";
    const decoder = new TextDecoder();
    const child = Bun.spawn([executable], {
      env: environment,
      terminal: {
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        data: (_terminal, data) => {
          output += decoder.decode(data, { stream: true });
        }
      }
    });
    try {
      await waitFor(() => output.includes("\x1b[?1049h"));
      const signalNumber = osConstants.signals[signal];
      child.kill(signalNumber);
      const exitCode = await child.exited;
      const expectedExitCode = exitCodeForSignal(signal);
      const disabledMouse = output.includes("\x1b[?1006l");
      const leftAlternateScreen = output.includes("\x1b[?1049l");
      if (exitCode !== expectedExitCode || !disabledMouse || !leftAlternateScreen) {
        throw new Error(
          `Packaged binary failed ${signal} cleanup/status smoke test: ${JSON.stringify({
            disabledMouse,
            exitCode,
            expectedExitCode,
            leftAlternateScreen,
            signalNumber
          })}`
        );
      }
    } finally {
      if (!child.killed) child.kill();
    }
  }
}

async function assertDiagnosticsRedirected(
  executable: string,
  environment: Readonly<Record<string, string>>
): Promise<void> {
  const child = Bun.spawn([executable], {
    env: environment,
    stderr: "pipe",
    stdout: "ignore"
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const diagnosticPath = /diagnostics: ([^\n]+)/u.exec(stderr)?.[1];
  let log = "";
  let logReadError: unknown;
  if (diagnosticPath !== undefined) {
    try {
      log = await readFile(diagnosticPath, "utf8");
    } catch (error: unknown) {
      logReadError = error;
    }
  }
  if (
    exitCode === 0 ||
    diagnosticPath === undefined ||
    stderr.includes("must run in an interactive terminal") ||
    !log.includes("must run in an interactive terminal")
  ) {
    throw new Error(
      `Packaged binary did not isolate renderer diagnostics from stderr: ${formatSmokeDetails({
        diagnosticPath,
        exitCode,
        log,
        logReadError,
        stderr
      })}`
    );
  }
}

function formatSmokeDetails(details: {
  readonly diagnosticPath: string | undefined;
  readonly exitCode: number;
  readonly log: string;
  readonly logReadError: unknown;
  readonly stderr: string;
}): string {
  const limit = 2_000;
  const bounded = (value: string): string =>
    value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
  return JSON.stringify({
    exitCode: details.exitCode,
    diagnosticPath: details.diagnosticPath ?? null,
    stderr: bounded(details.stderr),
    log: bounded(details.log),
    logReadError:
      details.logReadError === undefined
        ? null
        : bounded(
            details.logReadError instanceof Error
              ? details.logReadError.message
              : typeof details.logReadError === "string"
                ? details.logReadError
                : "A non-Error value was thrown while reading the diagnostics log."
          )
  });
}

async function assertOutput(
  executable: string,
  args: readonly string[],
  expected: string,
  environment: Readonly<Record<string, string>>
): Promise<void> {
  const output = await capture(executable, args, environment);
  if (output !== expected) {
    throw new Error(`Packaged binary returned unexpected output for ${args.join(" ")}.`);
  }
}

async function capture(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>
): Promise<string> {
  const process = Bun.spawn([executable, ...args], {
    env: environment,
    stderr: "pipe",
    stdout: "pipe"
  });
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
    env: environment,
    stderr: "pipe",
    stdout: "ignore"
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode === 0 || !stderr.includes(expectedError)) {
    throw new Error(`Packaged binary did not reject the unsupported runtime: ${stderr.trim()}`);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for packaged terminal startup.");
    await Bun.sleep(20);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
