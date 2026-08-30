import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const maximumDatabasePathBytes = 4_096;

/** Canonicalizes all ordinary local path spellings and rejects ambiguous SQLite identities. */
export function prepareDatabaseTarget(input: string, cwd: string = process.cwd()): string {
  validateDatabasePathInput(input);
  if (input === ":memory:") return input;

  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  rejectAmbiguousExistingTarget(absolute);
  const canonicalBeforeCreate = canonicalizePossiblyMissingPath(absolute);
  mkdirSync(dirname(canonicalBeforeCreate), { recursive: true, mode: 0o700 });
  const canonical = canonicalizePossiblyMissingPath(canonicalBeforeCreate);
  rejectAmbiguousExistingTarget(canonical);
  return canonical;
}

function validateDatabasePathInput(input: string): void {
  if (input.trim() === "") throw new Error("Database path cannot be empty.");
  if (input.includes("\0")) throw new Error("Database path cannot contain null bytes.");
  if (Buffer.byteLength(input) > maximumDatabasePathBytes) {
    throw new Error("Database path exceeds the 4096-byte limit.");
  }
  if (/^file:/iu.test(input)) {
    throw new Error("SQLite URI database targets are not supported.");
  }
}

function rejectAmbiguousExistingTarget(path: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    let target;
    try {
      target = statSync(path);
    } catch (error: unknown) {
      throw new Error("Database path must not be a dangling symbolic link.", { cause: error });
    }
    if (!target.isFile()) throw new Error("Database path must reference a regular file.");
    if (target.nlink > 1) throw new Error("Hard-linked database targets are not supported.");
    return;
  }
  if (!entry.isFile()) throw new Error("Database path must reference a regular file.");
  if (entry.nlink > 1) throw new Error("Hard-linked database targets are not supported.");
}

function canonicalizePossiblyMissingPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);

  let ancestor = dirname(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Database path has no existing filesystem ancestor.");
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  const suffix = relative(ancestor, path);
  return suffix === "" ? canonicalAncestor : join(canonicalAncestor, suffix);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
