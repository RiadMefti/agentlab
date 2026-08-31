import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryBrokerConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-broker-config.js";
import { loadLocalFactoryCostPolicy } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-cost-policy.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory broker configuration boundary", () => {
  it("loads an exact owner-only configuration", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const config = validConfig(root);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual(config);
  });

  it("loads v2 with one separately protected exact cost policy", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const costPolicy = validCostPolicy();
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v2" as const,
      costPolicyPath
    };
    await writePrivateJson(costPolicyPath, costPolicy);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual({ ...config, costPolicy });
    await expect(loadLocalFactoryCostPolicy(costPolicyPath)).resolves.toEqual(costPolicy);
  });

  it("rejects unknown fields, unsafe numbers, relative fields, and malformed JSON", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");

    await writePrivateJson(path, { ...validConfig(root), surprise: true });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, {
      ...validConfig(root),
      costPolicyPath: join(root, "cost-policy.json")
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, {
      ...validConfig(root),
      repositoryNumericId: Number.MAX_SAFE_INTEGER + 1
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, { ...validConfig(root), artifactRoot: "relative/artifacts" });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/normalized absolute/u);

    await writePrivateJson(path, {
      ...validConfig(root),
      githubApp: {
        ...validConfig(root).githubApp,
        trustedStatusChecks: [
          { context: "verify", appId: 15_368 },
          { context: "verify", appId: 15_368 }
        ]
      }
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/trusted status checks/iu);

    await writeFile(path, "{]", { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/not valid JSON/u);
  });

  it("rejects permissive, symbolic-link, hard-linked, and relative config paths", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const linkedPath = join(root, "linked.json");
    const symbolicPath = join(root, "symbolic.json");
    const canonicalDirectory = join(root, "canonical");
    const aliasDirectory = join(root, "alias");
    await writePrivateJson(path, validConfig(root));

    await chmod(path, 0o644);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    await symlink(path, symbolicPath);
    await expect(loadLocalFactoryBrokerConfig(symbolicPath)).rejects.toThrow(
      /owner-only|canonical/u
    );

    await mkdir(canonicalDirectory, { mode: 0o700 });
    await writePrivateJson(join(canonicalDirectory, "broker.json"), validConfig(root));
    await symlink(canonicalDirectory, aliasDirectory);
    await expect(loadLocalFactoryBrokerConfig(join(aliasDirectory, "broker.json"))).rejects.toThrow(
      /canonical/u
    );

    await link(path, linkedPath);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);
    await expect(loadLocalFactoryBrokerConfig("broker.json")).rejects.toThrow(
      /bounded absolute path/u
    );
  });

  it("rejects missing, malformed, permissive, or non-exact v2 cost policy", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v2" as const,
      costPolicyPath
    };
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(costPolicyPath, { ...validCostPolicy(), mutableFallback: 0 });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(costPolicyPath, {
      ...validCostPolicy(),
      rules: [{ ...validCostPolicy().rules[0], model: "gpt-*" }]
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/exact model/iu);

    await writePrivateJson(costPolicyPath, validCostPolicy());
    await chmod(costPolicyPath, 0o644);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);
  });
});

function validConfig(root: string) {
  return {
    schemaVersion: "agentlab.local-factory-broker.v1",
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
      privateKeyPath: join(root, "github-app.pem"),
      trustedStatusChecks: [
        { context: "verify", appId: 15_368 },
        { context: "factory-sandbox", appId: 15_368 }
      ]
    }
  } as const;
}

function validCostPolicy() {
  return {
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
      },
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        accounting: { mode: "provider-reported" }
      }
    ]
  } as const;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-broker-config-")));
  temporaryRoots.push(root);
  return root;
}
