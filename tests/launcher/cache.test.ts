import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedBinaryPath,
  ensureCachedBinary,
  resolveCacheRoot
} from "../../packages/launcher/src/cache.js";
import { parseReleaseManifest } from "../../packages/launcher/src/manifest.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-launcher-cache-"));
  temporaryRoots.push(root);
  return root;
}

function releaseManifest(bytes: Uint8Array, checksum = sha256(bytes)) {
  return parseReleaseManifest({
    repository: "RiadMefti/agentlab",
    targets: {
      "linux-x64": {
        asset: "agentlab-v0.2.0-linux-x64",
        sha256: checksum,
        size: bytes.byteLength
      },
      "mac-arm64": {
        asset: "agentlab-v0.2.0-mac-arm64",
        sha256: checksum,
        size: bytes.byteLength
      }
    },
    version: "0.2.0"
  });
}

function downloadResponse(
  bytes: Uint8Array,
  url = "https://release-assets.githubusercontent.com/file"
) {
  const response = new Response(arrayBuffer(bytes), {
    headers: { "content-length": String(bytes.byteLength) },
    status: 200
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function chunkedDownloadResponse(chunks: readonly Uint8Array[]): Response {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    }),
    { headers: { "content-length": String(size) }, status: 200 }
  );
  Object.defineProperty(response, "url", {
    value: "https://release-assets.githubusercontent.com/chunked-agentlab"
  });
  return response;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("AgentLab binary cache", () => {
  it("downloads, verifies, atomically activates, and reuses a versioned binary", async () => {
    const root = await temporaryRoot();
    const bytes = new TextEncoder().encode("agentlab executable");
    const manifest = releaseManifest(bytes);
    const fetchFirst = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes))
    ) as unknown as typeof fetch;

    const installed = await ensureCachedBinary(manifest, "linux-x64", {
      cacheRoot: root,
      fetch: fetchFirst
    });
    expect(installed).toBe(cachedBinaryPath(root, manifest, "linux-x64"));
    expect(await readFile(installed)).toEqual(Buffer.from(bytes));
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    expect(fetchFirst).toHaveBeenCalledOnce();

    const offline = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await expect(
      ensureCachedBinary(manifest, "linux-x64", { cacheRoot: root, fetch: offline })
    ).resolves.toBe(installed);
    expect(offline).not.toHaveBeenCalled();
  });

  it("replaces a same-sized cached binary that no longer matches the signed checksum", async () => {
    const root = await temporaryRoot();
    const bytes = new TextEncoder().encode("agentlab executable");
    const manifest = releaseManifest(bytes);
    const firstFetch = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes))
    ) as unknown as typeof fetch;
    const installed = await ensureCachedBinary(manifest, "linux-x64", {
      cacheRoot: root,
      fetch: firstFetch
    });
    await writeFile(installed, new TextEncoder().encode("tampered executable"), { mode: 0o755 });

    const repairFetch = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes))
    ) as unknown as typeof fetch;
    await expect(
      ensureCachedBinary(manifest, "linux-x64", { cacheRoot: root, fetch: repairFetch })
    ).resolves.toBe(installed);
    expect(repairFetch).toHaveBeenCalledOnce();
    expect(await readFile(installed)).toEqual(Buffer.from(bytes));
  });

  it("reports each streamed download step and stays quiet on a cache hit", async () => {
    const root = await temporaryRoot();
    const chunks = [new TextEncoder().encode("agentlab "), new TextEncoder().encode("executable")];
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const manifest = releaseManifest(bytes);
    const progress: { downloadedBytes: number; totalBytes: number }[] = [];

    await ensureCachedBinary(manifest, "linux-x64", {
      cacheRoot: root,
      fetch: vi.fn(() =>
        Promise.resolve(chunkedDownloadResponse(chunks))
      ) as unknown as typeof fetch,
      onDownloadProgress: (event) => progress.push(event)
    });

    expect(progress).toEqual([
      { downloadedBytes: 0, totalBytes: bytes.byteLength },
      { downloadedBytes: chunks[0]?.byteLength, totalBytes: bytes.byteLength },
      { downloadedBytes: bytes.byteLength, totalBytes: bytes.byteLength }
    ]);

    const cachedProgress: { downloadedBytes: number; totalBytes: number }[] = [];
    const offline = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await ensureCachedBinary(manifest, "linux-x64", {
      cacheRoot: root,
      fetch: offline,
      onDownloadProgress: (event) => cachedProgress.push(event)
    });
    expect(cachedProgress).toEqual([]);
    expect(offline).not.toHaveBeenCalled();
  });

  it("rejects checksum failures and removes temporary downloads", async () => {
    const root = await temporaryRoot();
    const bytes = new TextEncoder().encode("tampered executable");
    const manifest = releaseManifest(bytes, "0".repeat(64));
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes))
    ) as unknown as typeof fetch;

    await expect(
      ensureCachedBinary(manifest, "linux-x64", {
        cacheRoot: root,
        fetch: fetchImplementation
      })
    ).rejects.toThrow("checksum verification");
    const directory = join(root, "releases", "0.2.0", "linux-x64");
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects redirects outside GitHub's release infrastructure", async () => {
    const root = await temporaryRoot();
    const bytes = new TextEncoder().encode("agentlab executable");
    const manifest = releaseManifest(bytes);
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes, "https://example.com/payload"))
    ) as unknown as typeof fetch;

    await expect(
      ensureCachedBinary(manifest, "linux-x64", {
        cacheRoot: root,
        fetch: fetchImplementation
      })
    ).rejects.toThrow("untrusted host");
  });

  it("requires absolute cache overrides", () => {
    expect(() => resolveCacheRoot({ AGENTLAB_CACHE_PATH: "relative" }, "/home/test")).toThrow(
      "absolute path"
    );
    expect(resolveCacheRoot({ XDG_CACHE_HOME: "/tmp/cache" }, "/home/test")).toBe(
      "/tmp/cache/agentlab"
    );
    expect(() => resolveCacheRoot({ AGENTLAB_CACHE_PATH: "/" }, "/home/test")).toThrow(
      "absolute path"
    );
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
