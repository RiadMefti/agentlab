import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileFactoryEvalAttestationKeySource } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-eval-attestation-key-source.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("FileFactoryEvalAttestationKeySource", () => {
  it("returns fresh mutable bytes from one owner-only stable regular file", async () => {
    const root = await temporaryRoot();
    const path = join(root, "eval-key.pem");
    const expected = Buffer.from("a".repeat(64));
    await writeFile(path, expected, { mode: 0o600 });
    await chmod(path, 0o600);
    const source = new FileFactoryEvalAttestationKeySource(path, "private");

    const first = await source.load();
    const second = await source.load();

    expect(first).not.toBe(second);
    expect(Buffer.from(first)).toEqual(expected);
    first.fill(0);
    expect(Buffer.from(second)).toEqual(expected);
    second.fill(0);
  });

  it("rejects public, hard-linked, symbolic, and non-canonical key paths", async () => {
    const root = await temporaryRoot();
    const path = join(root, "eval-key.pem");
    await writeFile(path, "a".repeat(64), { mode: 0o600 });

    await chmod(path, 0o644);
    await expect(new FileFactoryEvalAttestationKeySource(path, "public").load()).rejects.toThrow(
      /owner-only/u
    );

    await chmod(path, 0o600);
    const hardLink = join(root, "hard-link.pem");
    await link(path, hardLink);
    await expect(new FileFactoryEvalAttestationKeySource(path, "public").load()).rejects.toThrow(
      /owner-only/u
    );
    await rm(hardLink);

    const symbolic = join(root, "symbolic.pem");
    await symlink(path, symbolic);
    await expect(
      new FileFactoryEvalAttestationKeySource(symbolic, "public").load()
    ).rejects.toThrow();
    expect(() => new FileFactoryEvalAttestationKeySource("relative.pem", "private")).toThrow(
      /absolute path/u
    );
    expect(
      () =>
        new FileFactoryEvalAttestationKeySource(
          `${root}/../${basename(root)}/eval-key.pem`,
          "private"
        )
    ).toThrow(/absolute path/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-eval-key-source-")));
  temporaryRoots.push(root);
  return root;
}
