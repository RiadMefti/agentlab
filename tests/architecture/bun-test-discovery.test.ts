import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bunTestArguments, discoverBunTests } from "../../scripts/bun-test-discovery.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Bun test discovery", () => {
  it("discovers every Bun test recursively and excludes fixture programs", async () => {
    const tests = await discoverBunTests(projectRoot);

    expect(tests).toContain("tests/runtime/terminal-pty.bun.ts");
    expect(tests).toContain("tests/tui/use-workspace.bun.tsx");
    expect(tests.some((path) => path.includes("/fixtures/"))).toBe(false);
    expect(tests).toEqual([...tests].sort());
  });

  it("passes explicit relative paths to Bun instead of ambiguous filter strings", () => {
    expect(bunTestArguments(["tests/example.bun.ts", "./tests/ready.bun.ts"])).toEqual([
      "./tests/example.bun.ts",
      "./tests/ready.bun.ts"
    ]);
  });

  it("discovers co-located workspace tests and excludes generated or fixture programs", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-bun-discovery-"));
    temporaryRoots.push(root);
    write(root, "apps/tui/src/co-located.bun.tsx");
    write(root, "packages/runtime/tests/co-located.bun.ts");
    write(root, "tests/fixtures/program.bun.ts");
    write(root, "tests/release/owned-test.bun.ts");
    write(root, ".owned-tests/hidden-extension.bun.ts");
    write(root, "release/generated.bun.ts");
    write(root, "packages/runtime/dist/generated.bun.ts");

    await expect(discoverBunTests(root)).resolves.toEqual([
      ".owned-tests/hidden-extension.bun.ts",
      "apps/tui/src/co-located.bun.tsx",
      "packages/runtime/tests/co-located.bun.ts",
      "tests/release/owned-test.bun.ts"
    ]);
  });

  it("fails closed when a repository-owned test path is a symbolic link", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-bun-symlink-"));
    temporaryRoots.push(root);
    write(root, "target.ts");
    mkdirSync(join(root, "tests"), { recursive: true });
    symlinkSync("../target.ts", join(root, "tests/linked.bun.ts"));

    await expect(discoverBunTests(root)).rejects.toThrow(
      "Bun test discovery does not permit symbolic links: tests/linked.bun.ts"
    );
  });
});

function write(root: string, path: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, "export {};\n");
}
