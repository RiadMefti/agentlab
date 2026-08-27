import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("release notes baseline", () => {
  it("uses the latest published release while skipping newer unpublished tags", async () => {
    const root = await releaseRepository(["v0.2.5", "v0.2.6", "v0.2.7", "v0.2.8"]);
    const response = await releasesResponse(root, [
      publishedRelease("v0.2.5", "2026-08-27T09:28:05Z")
    ]);

    const result = runResolver(root, "v0.2.8", response);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.2.5\n");
  });

  it("supports a true first release without a baseline", async () => {
    const root = await releaseRepository(["v0.1.0"]);
    const response = await releasesResponse(root, []);

    const result = runResolver(root, "v0.1.0", response);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\n");
  });

  it("rejects hostile published tag text without evaluating it", async () => {
    const root = await releaseRepository(["v0.2.8"]);
    const marker = join(root, "shell-injection-marker");
    const response = await releasesResponse(root, [
      publishedRelease(`v0.2.5;touch ${marker}`, "2026-08-27T09:28:05Z")
    ]);

    const result = runResolver(root, "v0.2.8", response);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid stable release tag");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the selected baseline to be annotated", async () => {
    const root = await releaseRepository(["v0.2.8"]);
    expect(runGit(root, "tag", "v0.2.5").status).toBe(0);
    const response = await releasesResponse(root, [
      publishedRelease("v0.2.5", "2026-08-27T09:28:05Z")
    ]);

    const result = runResolver(root, "v0.2.8", response);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be annotated");
  });

  it("rejects an annotated published tag outside the current release history", async () => {
    const root = await releaseRepository(["v0.2.8"]);
    expect(runGit(root, "switch", "--orphan", "old-release").status).toBe(0);
    await writeFile(join(root, "version"), "v0.2.5\n", "utf8");
    expect(runGit(root, "add", "version").status).toBe(0);
    expect(runGit(root, "commit", "-m", "v0.2.5").status).toBe(0);
    expect(runGit(root, "tag", "-a", "v0.2.5", "-m", "v0.2.5").status).toBe(0);
    expect(runGit(root, "switch", "main").status).toBe(0);
    const response = await releasesResponse(root, [
      publishedRelease("v0.2.5", "2026-08-27T09:28:05Z")
    ]);

    const result = runResolver(root, "v0.2.8", response);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not an ancestor");
  });

  it("passes the validated baseline to gh through a quoted Bash array", async () => {
    const workflow = await readFile(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf8"
    );

    expect(workflow).toContain('notes_arguments+=(--notes-start-tag "$NOTES_START_TAG")');
    expect(workflow).toContain('"${notes_arguments[@]}"');
  });
});

function publishedRelease(tagName: string, publishedAt: string) {
  return { draft: false, prerelease: false, published_at: publishedAt, tag_name: tagName };
}

async function releaseRepository(tags: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-release-notes-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  expect(runGit(root, "init", "--initial-branch=main").status).toBe(0);
  expect(runGit(root, "config", "user.name", "Release Test").status).toBe(0);
  expect(runGit(root, "config", "user.email", "release-test@example.com").status).toBe(0);
  for (const tag of tags) {
    await writeFile(join(root, "version"), `${tag}\n`, "utf8");
    expect(runGit(root, "add", "version").status).toBe(0);
    expect(runGit(root, "commit", "-m", tag).status).toBe(0);
    expect(runGit(root, "tag", "-a", tag, "-m", tag).status).toBe(0);
  }
  return root;
}

async function releasesResponse(root: string, releases: readonly unknown[]): Promise<string> {
  const path = join(root, "releases.json");
  await writeFile(path, `${JSON.stringify([releases])}\n`, "utf8");
  return path;
}

function runGit(root: string, ...arguments_: string[]) {
  return spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
}

function runResolver(root: string, currentTag: string, response: string) {
  return spawnSync(
    process.execPath,
    [
      join(projectRoot, "scripts", "release-notes-baseline.ts"),
      currentTag,
      response,
      "--root",
      root
    ],
    { cwd: projectRoot, encoding: "utf8" }
  );
}
