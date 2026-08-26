import { spawn } from "node:child_process";
import { constants } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCachedBinary, resolveCacheRoot } from "./cache.js";
import {
  currentRuntimePlatform,
  parseReleaseManifest,
  resolveRuntimeTarget,
  type RuntimePlatform
} from "./manifest.js";

const REGISTRY_LATEST_URL = "https://registry.npmjs.org/agentlab/latest";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export type ExecuteProgram = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
) => Promise<number>;

export interface LauncherOptions {
  readonly cacheRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execute?: ExecuteProgram;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly packageDirectory?: string;
  readonly runtime?: RuntimePlatform;
  readonly stderr?: ((message: string) => void) | undefined;
  readonly stdout?: (message: string) => void;
}

export async function runLauncher(
  args: readonly string[],
  options: LauncherOptions = {}
): Promise<number> {
  const packageDirectory = options.packageDirectory ?? defaultPackageDirectory();
  const packageVersion = await readPackageVersion(packageDirectory);
  const stdout = options.stdout ?? ((message) => process.stdout.write(message));
  const execute = options.execute ?? executeProgram;
  const environment = options.environment ?? process.env;

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    stdout(`${packageVersion}\n`);
    return 0;
  }
  if (args[0] === "update") {
    return runUpdate(args.slice(1), packageVersion, {
      execute,
      fetch: options.fetch,
      stderr: options.stderr,
      stdout,
      environment
    });
  }

  const manifest = await readManifest(packageDirectory);
  if (manifest.version !== packageVersion) {
    throw new Error("The npm package version does not match its release manifest.");
  }
  const runtime = options.runtime ?? currentRuntimePlatform();
  const target = resolveRuntimeTarget(runtime);
  const binary = await ensureCachedBinary(manifest, target, {
    cacheRoot: options.cacheRoot ?? resolveCacheRoot(environment),
    fetch: options.fetch
  });
  return execute(binary, args, {
    ...environment,
    AGENTLAB_INSTALL_METHOD: "npm",
    AGENTLAB_LAUNCHER_VERSION: packageVersion
  });
}

interface UpdateOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly execute: ExecuteProgram;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly stderr?: ((message: string) => void) | undefined;
  readonly stdout: (message: string) => void;
}

async function runUpdate(
  args: readonly string[],
  currentVersion: string,
  options: UpdateOptions
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: agentlab update [--check]");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(REGISTRY_LATEST_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`npm update check failed with HTTP ${String(response.status)}.`);
  }
  const latest = await readRegistryVersion(response);
  if (compareVersions(latest, currentVersion) <= 0) {
    options.stdout(`AgentLab ${currentVersion} is already current.\n`);
    return 0;
  }

  if (args[0] === "--check") {
    options.stdout(
      `AgentLab ${latest} is available. Run npm install --global agentlab@latest to update.\n`
    );
    return 0;
  }

  options.stdout(`Updating AgentLab ${currentVersion} to ${latest} through npm…\n`);
  const result = await options.execute(
    "npm",
    ["install", "--global", "agentlab@latest"],
    options.environment
  );
  if (result !== 0) {
    options.stderr?.("AgentLab update failed; npm did not complete the requested update.\n");
    return result;
  }
  options.stdout(`AgentLab ${latest} installed. Restart AgentLab to use it.\n`);
  return 0;
}

async function readPackageVersion(packageDirectory: string): Promise<string> {
  const input: unknown = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8")
  );
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("The AgentLab npm package manifest is invalid.");
  }
  const record = input as Record<string, unknown>;
  if (record.name !== "agentlab" || typeof record.version !== "string") {
    throw new Error("The AgentLab npm package identity is invalid.");
  }
  if (!STABLE_VERSION_PATTERN.test(record.version)) {
    throw new Error("The AgentLab npm package version must be stable MAJOR.MINOR.PATCH.");
  }
  return record.version;
}

async function readManifest(packageDirectory: string) {
  const input: unknown = JSON.parse(
    await readFile(resolve(packageDirectory, "release-manifest.json"), "utf8")
  );
  return parseReleaseManifest(input);
}

async function readRegistryVersion(response: Response): Promise<string> {
  const input: unknown = await response.json();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("npm returned invalid AgentLab metadata.");
  }
  const version = (input as Record<string, unknown>).version;
  if (typeof version !== "string" || !STABLE_VERSION_PATTERN.test(version)) {
    throw new Error("npm returned an invalid AgentLab version.");
  }
  return version;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function defaultPackageDirectory(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function executeProgram(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolvePromise(code);
        return;
      }
      const signalNumber = signal === null ? undefined : constants.signals[signal];
      resolvePromise(signalNumber === undefined ? 1 : 128 + signalNumber);
    });
  });
}
