import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalFactoryBroker } from "../../packages/runtime/src/local-factory-broker.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory broker composition", () => {
  it("constructs and closes without loading credentials or contacting a provider", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-broker-")));
    temporaryRoots.push(root);
    const load = vi.fn<() => Promise<Uint8Array>>(() =>
      Promise.resolve(Buffer.from("unused private key", "utf8"))
    );

    const runtime = createLocalFactoryBroker({
      databasePath: join(root, "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      temporaryRoot: join(root, "temporary"),
      repositoryId: "riadmefti/agentlab",
      repositoryNumericId: 12_345,
      brokerId: "agentlab-pr-broker",
      gitExecutable: join(root, "git"),
      githubApp: {
        clientId: "Iv1.agentlab-test",
        installationId: 67_890,
        privateKeySource: { load },
        trustedStatusChecks: [
          { context: "verify", appId: 15_368 },
          { context: "factory-sandbox", appId: 15_368 }
        ]
      }
    });

    expect(load).not.toHaveBeenCalled();
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});
