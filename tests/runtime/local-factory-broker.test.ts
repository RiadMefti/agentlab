import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredLocalFactoryBroker,
  createLocalFactoryBroker
} from "../../packages/runtime/src/local-factory-broker.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";

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

  it("constructs from a resolved v2 config without reading the referenced credential", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-broker-v2-")));
    temporaryRoots.push(root);
    const runtime = createConfiguredLocalFactoryBroker({
      schemaVersion: "agentlab.local-factory-broker.v2",
      databasePath: join(root, "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      temporaryRoot: join(root, "temporary"),
      repositoryId: "riadmefti/agentlab",
      repositoryNumericId: 12_345,
      brokerId: "agentlab-pr-broker",
      gitExecutable: join(root, "git"),
      costPolicyPath: join(root, "cost-policy.json"),
      costPolicy: {
        schemaVersion: "agentlab.cost-policy.v1",
        id: "agentlab/live-costs",
        version: "1.0.0",
        rules: [
          {
            provider: "codex",
            model: "gpt-5.4",
            accounting: {
              mode: "token-rate",
              inputMicrousdPerMillionTokens: 1_000_000,
              outputMicrousdPerMillionTokens: 2_000_000
            }
          }
        ]
      },
      githubApp: {
        clientId: "Iv1.agentlab-test",
        installationId: 67_890,
        privateKeyPath: join(root, "github-app.pem"),
        trustedStatusChecks: [
          { context: "verify", appId: 15_368 },
          { context: "factory-sandbox", appId: 15_368 }
        ]
      }
    });

    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("constructs a v3 canary broker from exact schedule and role-policy pins", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-broker-v3-")));
    temporaryRoots.push(root);
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const costPolicy = {
      schemaVersion: "agentlab.cost-policy.v1" as const,
      id: "agentlab/live-costs",
      version: "1.0.0",
      rules: [
        {
          provider: "codex" as const,
          model: "gpt-5.4",
          accounting: {
            mode: "token-rate" as const,
            inputMicrousdPerMillionTokens: 1_000_000,
            outputMicrousdPerMillionTokens: 2_000_000
          }
        }
      ]
    };
    const runtime = createConfiguredLocalFactoryBroker({
      schemaVersion: "agentlab.local-factory-broker.v3",
      databasePath: join(root, "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      temporaryRoot: join(root, "temporary"),
      repositoryId: "riadmefti/agentlab",
      repositoryNumericId: 12_345,
      brokerId: "agentlab-pr-broker",
      gitExecutable: join(root, "git"),
      costPolicyPath: join(root, "cost-policy.json"),
      schedulePolicyPath: join(root, "schedule-policy.json"),
      roleIdentityPolicyPath: join(root, "role-identities.json"),
      expectedRoleIdentityPolicyDigest,
      costPolicy,
      schedulePolicy: testFactorySchedulePolicy(),
      roleIdentityPolicy,
      githubApp: {
        clientId: "Iv1.agentlab-test",
        installationId: 67_890,
        privateKeyPath: join(root, "github-app.pem"),
        trustedStatusChecks: [
          { context: "verify", appId: 15_368 },
          { context: "factory-sandbox", appId: 15_368 }
        ]
      }
    });

    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
