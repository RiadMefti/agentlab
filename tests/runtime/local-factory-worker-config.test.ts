import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryWorkerConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-worker-config.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory worker configuration boundary", () => {
  it("loads exact owner-only process, provider, gate, and cost pins", async () => {
    const root = await temporaryRoot();
    const path = join(root, "worker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const costPolicy = validCostPolicy();
    const config = validConfig(root, costPolicyPath);
    await writePrivateJson(costPolicyPath, costPolicy);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryWorkerConfig(path)).resolves.toEqual({ ...config, costPolicy });
  });

  it("rejects unknown fields, overlapping roots, unsafe runtime roots, and malformed JSON", async () => {
    const root = await temporaryRoot();
    const path = join(root, "worker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    await writePrivateJson(costPolicyPath, validCostPolicy());

    await writePrivateJson(path, { ...validConfig(root, costPolicyPath), surprise: true });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, {
      ...validConfig(root, costPolicyPath),
      workspaceRoot: join(root, "artifacts", "worktrees")
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/must not overlap/u);

    await writePrivateJson(path, {
      ...validConfig(root, costPolicyPath),
      sandbox: { ...validConfig(root, costPolicyPath).sandbox, runtimeRoots: ["/"] }
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/dedicated non-root/u);

    await writeFile(path, "{]", { encoding: "utf8", mode: 0o600 });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/not valid JSON/u);
  });

  it("requires the exact unique R1 gate set and trusted evidence mapping", async () => {
    const root = await temporaryRoot();
    const path = join(root, "worker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    await writePrivateJson(costPolicyPath, validCostPolicy());
    const config = validConfig(root, costPolicyPath);

    await writePrivateJson(path, {
      ...config,
      gates: config.gates.map((gate) =>
        gate.id === "secret-scan" ? { ...gate, evidenceKind: "test" } : gate
      )
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/wrong evidence kind/u);

    await writePrivateJson(path, {
      ...config,
      gates: [...config.gates.slice(0, 6), config.gates[0]]
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/gate IDs must be unique/u);
  });

  it("rejects unsupported or duplicate providers and non-private config or policy files", async () => {
    const root = await temporaryRoot();
    const path = join(root, "worker.json");
    const alias = join(root, "worker-alias.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const config = validConfig(root, costPolicyPath);
    await writePrivateJson(costPolicyPath, validCostPolicy());

    await writePrivateJson(path, {
      ...config,
      providers: [config.providers[0], config.providers[0]]
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(
      /provider IDs must be unique/u
    );

    await writePrivateJson(path, {
      ...config,
      providers: [{ provider: "opencode", executable: "/opt/opencode", version: "1" }]
    });
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, config);
    await chmod(path, 0o644);
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    await symlink(path, alias);
    await expect(loadLocalFactoryWorkerConfig(alias)).rejects.toThrow(/owner-only|canonical/u);

    await chmod(costPolicyPath, 0o644);
    await expect(loadLocalFactoryWorkerConfig(path)).rejects.toThrow(/owner-only/u);
  });
});

function validConfig(root: string, costPolicyPath: string) {
  const evidenceKinds = {
    format: "test",
    architecture: "test",
    typecheck: "test",
    lint: "test",
    test: "test",
    build: "build",
    "secret-scan": "security"
  } as const;
  return {
    schemaVersion: "agentlab.local-factory-worker.v1",
    databasePath: join(root, "agentlab.sqlite"),
    artifactRoot: join(root, "artifacts"),
    workspaceRoot: join(root, "worktrees"),
    costPolicyPath,
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    systemd: {
      runExecutable: "/usr/bin/systemd-run",
      controlExecutable: "/usr/bin/systemctl",
      environmentExecutable: "/usr/bin/env",
      version: "systemd 261"
    },
    sandbox: {
      bubblewrapExecutable: "/usr/bin/bwrap",
      runtimeRoots: ["/opt/agentlab/node"]
    },
    providers: [
      {
        provider: "codex",
        executable: "/opt/agentlab/bin/codex",
        executableDigest: `sha256:${"a".repeat(64)}`,
        version: "codex-cli 1.2.3"
      },
      {
        provider: "claude",
        executable: "/opt/agentlab/bin/claude",
        executableDigest: `sha256:${"b".repeat(64)}`,
        version: "claude 2.3.4"
      }
    ],
    gates: Object.entries(evidenceKinds).map(([id, evidenceKind]) => ({
      id,
      evidenceKind,
      command: { executable: "/usr/bin/npm", args: ["run", id] },
      timeoutMs: 600_000,
      maximumOutputBytes: 8 * 1_024 * 1_024
    }))
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-worker-config-")));
  temporaryRoots.push(root);
  return root;
}
