import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { releaseDownloadUrl, type ReleaseManifest, type ReleaseTargetKey } from "./manifest.js";

const DOWNLOAD_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_PATH_LENGTH = 4096;
const TRUSTED_DOWNLOAD_HOSTS = new Set(["github.com"]);

export interface BinaryCacheOptions {
  readonly cacheRoot?: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export function resolveCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir()
): string {
  const override = environment.AGENTLAB_CACHE_PATH;
  if (override !== undefined) return validateAbsolutePath(override, "AGENTLAB_CACHE_PATH");

  const xdgCache = environment.XDG_CACHE_HOME;
  if (xdgCache !== undefined) {
    return resolve(validateAbsolutePath(xdgCache, "XDG_CACHE_HOME"), "agentlab");
  }
  return resolve(homeDirectory, ".cache", "agentlab");
}

export function cachedBinaryPath(
  cacheRoot: string,
  manifest: ReleaseManifest,
  key: ReleaseTargetKey
): string {
  return join(cacheRoot, "releases", manifest.version, key, "agentlab");
}

export async function ensureCachedBinary(
  manifest: ReleaseManifest,
  key: ReleaseTargetKey,
  options: BinaryCacheOptions = {}
): Promise<string> {
  const cacheRoot = options.cacheRoot ?? resolveCacheRoot();
  const binaryPath = cachedBinaryPath(cacheRoot, manifest, key);
  const target = manifest.targets[key];
  if (await isUsableCachedBinary(binaryPath, target.size, target.sha256)) return binaryPath;

  await mkdir(dirname(binaryPath), { mode: 0o700, recursive: true });
  await rm(binaryPath, { force: true });
  const temporaryPath = `${binaryPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const downloadUrl = releaseDownloadUrl(manifest, key);

  try {
    const response = await fetchImplementation(downloadUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS)
    });
    if (!response.ok) {
      throw new Error(`AgentLab download failed with HTTP ${String(response.status)}.`);
    }
    assertTrustedDownloadUrl(response.url || downloadUrl);
    if (response.body === null) throw new Error("AgentLab download returned an empty body.");

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== target.size) {
      throw new Error("AgentLab download size does not match the signed release manifest.");
    }

    const file = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const readResult: unknown = await reader.read();
        const chunk = readDownloadChunk(readResult);
        if (chunk === undefined) break;
        size += chunk.byteLength;
        if (size > target.size) {
          throw new Error("AgentLab download exceeded the signed release size.");
        }
        hash.update(chunk);
        await writeAll(file, chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    if (size !== target.size || hash.digest("hex") !== target.sha256) {
      throw new Error("AgentLab download failed checksum verification.");
    }
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, binaryPath);
    return binaryPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function isUsableCachedBinary(
  path: string,
  expectedSize: number,
  expectedChecksum: string
): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size !== expectedSize || (details.mode & 0o111) === 0) {
      return false;
    }
    const hash = createHash("sha256");
    for await (const rawChunk of createReadStream(path)) {
      const chunk: unknown = rawChunk;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("AgentLab cached binary returned an invalid file chunk.");
      }
      hash.update(chunk);
    }
    return hash.digest("hex") === expectedChecksum;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function assertTrustedDownloadUrl(value: string): void {
  const url = new URL(value);
  const trusted =
    url.protocol === "https:" &&
    (TRUSTED_DOWNLOAD_HOSTS.has(url.hostname) || url.hostname.endsWith(".githubusercontent.com"));
  if (!trusted) throw new Error("AgentLab download redirected to an untrusted host.");
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_PATH_LENGTH ||
    !isAbsolute(value) ||
    dirname(resolve(value)) === resolve(value)
  ) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  return value;
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("AgentLab download could not be written to disk.");
    offset += bytesWritten;
  }
}

function readDownloadChunk(value: unknown): Uint8Array | undefined {
  if (typeof value !== "object" || value === null || !("done" in value)) {
    throw new Error("AgentLab download returned an invalid stream result.");
  }
  const result = value as { readonly done: unknown; readonly value?: unknown };
  if (result.done === true) return undefined;
  if (result.done !== false || !(result.value instanceof Uint8Array)) {
    throw new Error("AgentLab download returned an invalid stream chunk.");
  }
  return result.value;
}
