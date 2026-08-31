import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface PrivateLocalFileOptions {
  readonly label: string;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
}

/** Reads a stable owner-only regular file without following its final or parent symlinks. */
export async function readPrivateLocalFile(
  pathInput: string,
  options: PrivateLocalFileOptions
): Promise<Buffer> {
  const path = privateLocalFilePath(pathInput, options.label);
  assertSizeBounds(options);
  const before = await lstat(path, { bigint: true });
  assertMetadata(before, options, "before opening");
  if ((await realpath(path)) !== path) {
    throw new Error(`${options.label} path must be canonical and symlink-free.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: Buffer | null = null;
  try {
    const opened = await handle.stat({ bigint: true });
    assertMetadata(opened, options, "after opening");
    if (!sameFile(before, opened)) throw new Error(`${options.label} changed while it was opened.`);
    content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || BigInt(content.byteLength) !== after.size) {
      content.fill(0);
      throw new Error(`${options.label} changed while it was read.`);
    }
  } catch (error: unknown) {
    content?.fill(0);
    try {
      await handle.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        `${options.label} read and descriptor cleanup both failed.`
      );
    }
    throw error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    content.fill(0);
    throw new Error(`${options.label} descriptor could not be closed.`, { cause: error });
  }
  return content;
}

export function privateLocalFilePath(path: string, label: string): string {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    Buffer.byteLength(path) > 4_096 ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} path must be a bounded absolute path.`);
  }
  return resolve(path);
}

function assertSizeBounds(options: PrivateLocalFileOptions): void {
  if (
    !Number.isSafeInteger(options.minimumBytes) ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.minimumBytes < 1 ||
    options.maximumBytes < options.minimumBytes
  ) {
    throw new Error("Private local file size bounds are invalid.");
  }
}

function assertMetadata(
  metadata: BigIntStats,
  options: PrivateLocalFileOptions,
  phase: string
): void {
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < BigInt(options.minimumBytes) ||
    metadata.size > BigInt(options.maximumBytes) ||
    (currentUserId !== undefined && metadata.uid !== BigInt(currentUserId)) ||
    (metadata.mode & 0o077n) !== 0n ||
    (metadata.mode & 0o400n) === 0n
  ) {
    throw new Error(`${options.label} is not an owner-only regular file ${phase}.`);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
