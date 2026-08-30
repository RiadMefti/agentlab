import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const bunTestPattern = /\.bun\.tsx?$/u;

/** Discovers every repository-owned Bun test while excluding generated, vendor, and fixture data. */
export async function discoverBunTests(projectRoot: string): Promise<readonly string[]> {
  return (await walk(resolve(projectRoot), resolve(projectRoot))).sort();
}

/** Forces Bun to interpret discovered values as paths instead of filename filter patterns. */
export function bunTestArguments(paths: readonly string[]): readonly string[] {
  return paths.map((path) => (path.startsWith("./") ? path : `./${path}`));
}

async function walk(projectRoot: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if ((entry.isDirectory() || entry.isSymbolicLink()) && excludedDirectory(projectRoot, path)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Bun test discovery does not permit symbolic links: ${relative(projectRoot, path).split(sep).join("/")}`
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walk(projectRoot, path)));
    } else if (entry.isFile() && bunTestPattern.test(entry.name)) {
      files.push(relative(projectRoot, path).split(sep).join("/"));
    }
  }
  return files;
}

function excludedDirectory(projectRoot: string, directory: string): boolean {
  const path = relative(projectRoot, directory).split(sep).join("/");
  const segments = path.split("/");
  if (path === ".claude" || path.startsWith(".claude/")) return true;
  if (path === ".git" || path.startsWith(".git/")) return true;
  if (path === ".test-types" || path.startsWith(".test-types/")) return true;
  if (path === "coverage" || path.startsWith("coverage/")) return true;
  if (path === "release" || path.startsWith("release/")) return true;
  if (segments.includes("node_modules") || segments.includes("fixtures")) return true;
  return (
    segments.length === 3 &&
    (segments[0] === "apps" || segments[0] === "packages") &&
    segments[2] === "dist"
  );
}
