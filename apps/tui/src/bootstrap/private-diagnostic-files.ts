import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface PrivateDiagnosticDirectory {
  readonly fd: number;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

/** Creates only missing components, rejects links at every level, and pins the final directory. */
export function preparePrivateDiagnosticDirectory(
  directory: string,
  mode: number
): PrivateDiagnosticDirectory {
  const components = absolutePathComponents(directory);
  for (const [index, component] of components.entries()) {
    try {
      assertDirectoryComponent(component);
    } catch (error: unknown) {
      if (!isMissingPathError(error) || index === 0) throw error;
      try {
        mkdirSync(component, { mode });
      } catch (mkdirError: unknown) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      assertDirectoryComponent(component);
    }
  }

  // Re-walk every component after controlled creation before opening anything inside it.
  assertSafeDirectoryPath(directory);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const directoryOnly = process.platform === "win32" ? 0 : constants.O_DIRECTORY;
  const fd = openSync(directory, constants.O_RDONLY | directoryOnly | noFollow);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isDirectory()) throw unsafeDirectoryError(directory);
    const identity = fileIdentity(metadata);
    assertSafeDirectoryPath(directory, identity);
    setDescriptorMode(fd, mode);
    assertSafeDirectoryPath(directory, identity);
    return { fd, identity };
  } catch (error: unknown) {
    closePrivateDiagnosticDescriptor(fd);
    throw error;
  }
}

/** Opens one exclusive regular artifact and removes it only after its identity is established. */
export function openPrivateDiagnosticArtifact(
  activePath: string,
  directory: string,
  directoryIdentity: PrivateDiagnosticDirectory["identity"],
  mode: number
): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let fd: number | null = null;
  let identity: FileIdentity | undefined;
  try {
    fd = openSync(
      activePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      mode
    );
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw unsafeFileError(activePath);
    identity = fileIdentity(metadata);
    assertOwnedRegularFile(activePath, identity);
    setDescriptorMode(fd, mode);
    if (!fstatSync(fd).isFile()) throw unsafeFileError(activePath);
    assertSafeDirectoryPath(directory, directoryIdentity);
    assertOwnedRegularFile(activePath, identity);
    return fd;
  } catch (error: unknown) {
    if (fd !== null) {
      closePrivateDiagnosticDescriptor(fd);
      unlinkFailedArtifact(activePath, identity);
    }
    throw error;
  }
}

export function closePrivateDiagnosticDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Diagnostics-only cleanup must not replace renderer startup or exit status.
  }
}

export function isSafeAbsolutePath(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !hasControlCharacter(value);
}

function unlinkFailedArtifact(path: string, expected: FileIdentity | undefined): void {
  if (expected === undefined) return;
  try {
    const metadata = lstatSync(path);
    if (metadata.isFile() && !metadata.isSymbolicLink() && sameFile(metadata, expected)) {
      unlinkSync(path);
    }
  } catch {
    // The artifact may already be gone or its path may no longer identify the opened file.
  }
}

function assertOwnedRegularFile(path: string, expected: FileIdentity): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !sameFile(metadata, expected)) {
    throw unsafeFileError(path);
  }
}

function assertSafeDirectoryPath(directory: string, expected?: FileIdentity): void {
  const components = absolutePathComponents(directory);
  for (const component of components) assertDirectoryComponent(component);
  if (expected !== undefined && !sameFile(lstatSync(directory), expected)) {
    throw unsafeDirectoryError(directory);
  }
}

function absolutePathComponents(directory: string): string[] {
  if (!isSafeAbsolutePath(directory) || resolve(directory) !== directory) {
    throw unsafeDirectoryError(directory);
  }
  const root = parse(directory).root;
  if (root.length === 0) throw unsafeDirectoryError(directory);
  const remainder = relative(root, directory);
  const names = remainder.length === 0 ? [] : remainder.split(sep);
  if (names.some((name) => name.length === 0 || name === "." || name === "..")) {
    throw unsafeDirectoryError(directory);
  }
  const components = [root];
  for (const name of names) components.push(join(components.at(-1) ?? root, name));
  return components;
}

function assertDirectoryComponent(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unsafeDirectoryError(path);
}

function setDescriptorMode(fd: number, mode: number): void {
  // Windows permissions are ACL-based and Node does not provide POSIX-equivalent descriptor modes.
  if (process.platform !== "win32") fchmodSync(fd, mode);
}

function fileIdentity(metadata: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameFile(
  metadata: { readonly dev: number; readonly ino: number },
  expected: FileIdentity
): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

function unsafeDirectoryError(path: string): Error {
  return new Error(`Refusing unsafe AgentLab diagnostic directory: ${path}`);
}

function unsafeFileError(path: string): Error {
  return new Error(`Refusing unsafe AgentLab diagnostic file: ${path}`);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
