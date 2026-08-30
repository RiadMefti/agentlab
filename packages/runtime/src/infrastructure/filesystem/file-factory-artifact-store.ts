import { constants } from "node:fs";
import { chmod, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";

import type {
  FactoryArtifactStore,
  StoredFactoryArtifact
} from "../../domain/factory-artifact-store.js";

const defaultMaximumArtifactBytes = 128 * 1_024 * 1_024;

export interface FileFactoryArtifactStoreOptions {
  readonly maximumArtifactBytes?: number;
}

/** Owner-only, content-addressed evidence store with atomic immutable publication. */
export class FileFactoryArtifactStore implements FactoryArtifactStore {
  readonly #rootPath: string;
  #root: Promise<string> | null = null;
  readonly #maximumArtifactBytes: number;

  public constructor(root: string, options: FileFactoryArtifactStoreOptions = {}) {
    this.#maximumArtifactBytes = options.maximumArtifactBytes ?? defaultMaximumArtifactBytes;
    if (!Number.isInteger(this.#maximumArtifactBytes) || this.#maximumArtifactBytes < 1) {
      throw new Error("Maximum artifact bytes must be a positive integer.");
    }
    this.#rootPath = safeOwnedStorageRoot(root);
  }

  public async put(content: Uint8Array): Promise<StoredFactoryArtifact> {
    if (!(content instanceof Uint8Array)) throw new TypeError("Factory artifact must be bytes.");
    if (content.byteLength > this.#maximumArtifactBytes) {
      throw new Error(
        `Factory artifact exceeds the ${String(this.#maximumArtifactBytes)} byte store limit.`
      );
    }
    const digest = contentDigest(content);
    const { directory, target } = await this.#artifactPath(digest);
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    let closed = false;
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      closed = true;
      try {
        await link(temporary, target);
      } catch (error: unknown) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        await this.#verifyExisting(target, digest, content.byteLength);
      }
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      });
    }
    return { digest, sizeBytes: content.byteLength };
  }

  public putText(content: string): Promise<StoredFactoryArtifact> {
    return this.put(Buffer.from(content, "utf8"));
  }

  public async read(digest: Sha256Digest, maximumBytes: number): Promise<Uint8Array> {
    const parsedDigest = sha256DigestSchema.parse(digest);
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("Maximum read bytes must be a positive integer.");
    }
    const { target } = await this.#artifactPath(parsedDigest);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`Factory artifact ${parsedDigest} is not a file.`);
      const limit = Math.min(maximumBytes, this.#maximumArtifactBytes);
      if (metadata.size > limit) {
        throw new Error(
          `Factory artifact ${parsedDigest} exceeds the ${String(limit)} byte read limit.`
        );
      }
      const content = await handle.readFile();
      if (contentDigest(content) !== parsedDigest) {
        throw new Error(`Factory artifact ${parsedDigest} failed content-digest verification.`);
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  public async readText(digest: Sha256Digest, maximumBytes: number): Promise<string> {
    return Buffer.from(await this.read(digest, maximumBytes)).toString("utf8");
  }

  async #artifactPath(
    digest: Sha256Digest
  ): Promise<{ readonly directory: string; readonly target: string }> {
    this.#root ??= prepareRoot(this.#rootPath);
    const root = await this.#root;
    const hexadecimal = digest.slice("sha256:".length);
    const directory = join(root, "sha256", hexadecimal.slice(0, 2));
    await mkdir(directory, { mode: 0o700, recursive: true });
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== resolve(directory)) {
      throw new Error("Factory artifact shard resolves outside its canonical path.");
    }
    await chmod(resolvedDirectory, 0o700);
    return { directory: resolvedDirectory, target: join(resolvedDirectory, hexadecimal) };
  }

  async #verifyExisting(
    target: string,
    digest: Sha256Digest,
    expectedBytes: number
  ): Promise<void> {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== expectedBytes) {
        throw new Error(`Existing factory artifact ${digest} has conflicting content.`);
      }
      const content = await handle.readFile();
      if (contentDigest(content) !== digest) {
        throw new Error(`Existing factory artifact ${digest} has conflicting content.`);
      }
    } finally {
      await handle.close();
    }
  }
}

async function prepareRoot(root: string): Promise<string> {
  const absolute = safeOwnedStorageRoot(root);
  await mkdir(absolute, { mode: 0o700, recursive: true });
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error("Factory artifact root must not be a symbolic-link alias.");
  }
  await chmod(canonical, 0o700);
  await mkdir(join(canonical, "sha256"), { mode: 0o700, recursive: true });
  if ((await realpath(join(canonical, "sha256"))) !== join(canonical, "sha256")) {
    throw new Error("Factory artifact digest directory is not canonical.");
  }
  await chmod(join(canonical, "sha256"), 0o700);
  return canonical;
}

function safeOwnedStorageRoot(root: string): string {
  if (root.length === 0 || root.includes("\0")) {
    throw new Error("Factory artifact root is invalid.");
  }
  const absolute = resolve(root);
  if (absolute === parse(absolute).root) {
    throw new Error("Factory artifact root must be a dedicated non-root path.");
  }
  return absolute;
}

function contentDigest(content: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
