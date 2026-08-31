import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileGitHubAppPrivateKeySource } from "../../packages/runtime/src/infrastructure/github/file-github-app-private-key-source.js";
import { NodeGitHubAppJwtSigner } from "../../packages/runtime/src/infrastructure/github/github-app-jwt.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("owner-only GitHub App private-key source", () => {
  it("loads one fresh buffer and lets the signer erase it after use", async () => {
    const root = await temporaryRoot();
    const keyPath = join(root, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeFile(keyPath, pem, { encoding: "utf8", mode: 0o600 });
    await chmod(keyPath, 0o600);
    const source = new FileGitHubAppPrivateKeySource(keyPath);
    const capture: { loaded: Uint8Array | null } = { loaded: null };
    const signer = new NodeGitHubAppJwtSigner({
      async load() {
        capture.loaded = await source.load();
        return capture.loaded;
      }
    });

    const signature = await signer.sign(Buffer.from("agentlab", "utf8"));

    expect(signature.byteLength).toBeGreaterThan(0);
    expect(capture.loaded).not.toBeNull();
    expect(capture.loaded?.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects group-readable, symbolic-link, and hard-linked key files", async () => {
    const root = await temporaryRoot();
    const keyPath = join(root, "github-app.pem");
    const linkedPath = join(root, "linked.pem");
    const symbolicPath = join(root, "symbolic.pem");
    await writeFile(keyPath, "x".repeat(128), { encoding: "utf8", mode: 0o600 });

    await chmod(keyPath, 0o640);
    await expect(new FileGitHubAppPrivateKeySource(keyPath).load()).rejects.toThrow(/owner-only/u);

    await chmod(keyPath, 0o600);
    await symlink(keyPath, symbolicPath);
    await expect(new FileGitHubAppPrivateKeySource(symbolicPath).load()).rejects.toThrow(
      /owner-only|canonical/u
    );

    await link(keyPath, linkedPath);
    await expect(new FileGitHubAppPrivateKeySource(keyPath).load()).rejects.toThrow(/owner-only/u);
    await expect(new FileGitHubAppPrivateKeySource(linkedPath).load()).rejects.toThrow(
      /owner-only/u
    );
  });

  it("rejects a non-normalized absolute key path at construction", async () => {
    const root = await temporaryRoot();

    expect(() => new FileGitHubAppPrivateKeySource(`${root}/nested/../github-app.pem`)).toThrow(
      /bounded absolute path/u
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-private-key-")));
  temporaryRoots.push(root);
  return root;
}
