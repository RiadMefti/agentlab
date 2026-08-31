import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryAuthorityConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-authority-config.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory authority configuration boundary", () => {
  it("loads only the exact owner-only local identity and durable ledger target", async () => {
    const root = await temporaryRoot();
    const path = join(root, "authority.json");
    const config = validConfig(root);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryAuthorityConfig(path)).resolves.toEqual(config);
  });

  it("rejects unknown fields, relative fields, malformed JSON, and oversized input", async () => {
    const root = await temporaryRoot();
    const path = join(root, "authority.json");

    await writePrivateJson(path, { ...validConfig(root), enableScheduler: true });
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow();

    await writePrivateJson(path, { ...validConfig(root), databasePath: "agentlab.sqlite" });
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow(/normalized absolute/u);

    await writeFile(path, "{]", { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow(/not valid JSON/u);

    await writeFile(path, "x".repeat(16 * 1_024 + 1), { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow(/owner-only/u);
  });

  it("rejects permissive, symbolic-link, hard-linked, and noncanonical config paths", async () => {
    const root = await temporaryRoot();
    const path = join(root, "authority.json");
    const hardLink = join(root, "hard-link.json");
    const symbolicLink = join(root, "symbolic.json");
    const canonicalDirectory = join(root, "canonical");
    const aliasDirectory = join(root, "alias");
    await writePrivateJson(path, validConfig(root));

    await chmod(path, 0o644);
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    await symlink(path, symbolicLink);
    await expect(loadLocalFactoryAuthorityConfig(symbolicLink)).rejects.toThrow(
      /owner-only|canonical/u
    );

    await mkdir(canonicalDirectory, { mode: 0o700 });
    await writePrivateJson(join(canonicalDirectory, "authority.json"), validConfig(root));
    await symlink(canonicalDirectory, aliasDirectory);
    await expect(
      loadLocalFactoryAuthorityConfig(join(aliasDirectory, "authority.json"))
    ).rejects.toThrow(/canonical/u);

    await link(path, hardLink);
    await expect(loadLocalFactoryAuthorityConfig(path)).rejects.toThrow(/owner-only/u);
    await expect(loadLocalFactoryAuthorityConfig("authority.json")).rejects.toThrow(
      /bounded absolute path/u
    );
  });
});

function validConfig(root: string) {
  return {
    schemaVersion: "agentlab.local-factory-authority.v1",
    databasePath: join(root, "agentlab.sqlite"),
    operatorId: "maintainer/riad"
  } as const;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-authority-config-")));
  temporaryRoots.push(root);
  return root;
}
