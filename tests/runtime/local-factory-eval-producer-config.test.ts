import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryEvalProducerConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-eval-producer-config.js";
import { loadLocalFactoryEvalProductionJob } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-eval-production-job.js";
import { testEvalDigest } from "../helpers/factory-evaluation.js";
import { testFactoryEvalProductionJob } from "../helpers/factory-eval-production.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local factory eval producer configuration", () => {
  it("loads one owner-only strict sandbox configuration and production job", async () => {
    const root = temporaryRoot();
    const configPath = privateJson(root, "config.json", config(root));
    const job = testFactoryEvalProductionJob();
    const jobPath = privateJson(root, "job.json", job);

    await expect(loadLocalFactoryEvalProducerConfig(configPath)).resolves.toEqual(config(root));
    await expect(loadLocalFactoryEvalProductionJob(jobPath)).resolves.toEqual(job);
  });

  it("rejects overlapping storage, duplicate bindings, and group-readable input", async () => {
    const root = temporaryRoot();
    const value = config(root);
    const overlap = privateJson(root, "overlap.json", {
      ...value,
      workspaceRoot: value.artifactRoot
    });
    const duplicate = privateJson(root, "duplicate.json", {
      ...value,
      executables: [value.executables[0], value.executables[0]]
    });
    const databaseInArtifacts = privateJson(root, "database-in-artifacts.json", {
      ...value,
      databasePath: join(value.artifactRoot, "agentlab.sqlite")
    });
    const mountedArtifacts = privateJson(root, "mounted-artifacts.json", {
      ...value,
      sandbox: { ...value.sandbox, runtimeRoots: [value.artifactRoot] }
    });
    const exposed = privateJson(root, "exposed.json", value);
    chmodSync(exposed, 0o640);

    await expect(loadLocalFactoryEvalProducerConfig(overlap)).rejects.toThrow(/must not overlap/u);
    await expect(loadLocalFactoryEvalProducerConfig(duplicate)).rejects.toThrow(/must be unique/u);
    await expect(loadLocalFactoryEvalProducerConfig(databaseInArtifacts)).rejects.toThrow(
      /must not overlap/u
    );
    await expect(loadLocalFactoryEvalProducerConfig(mountedArtifacts)).rejects.toThrow(
      /must not overlap/u
    );
    await expect(loadLocalFactoryEvalProducerConfig(exposed)).rejects.toThrow(/owner-only/u);
  });
});

function config(root: string) {
  return {
    schemaVersion: "agentlab.local-factory-eval-producer.v1" as const,
    databasePath: join(root, "agentlab.sqlite"),
    artifactRoot: join(root, "artifacts"),
    workspaceRoot: join(root, "workspaces"),
    runnerId: "trusted-eval-runner",
    executables: [
      {
        descriptorDigest: testEvalDigest(1),
        executable: "/usr/bin/true",
        executableDigest: testEvalDigest(2),
        version: "1.0.0"
      },
      {
        descriptorDigest: testEvalDigest(3),
        executable: "/usr/bin/false",
        executableDigest: testEvalDigest(4),
        version: "1.0.0"
      }
    ],
    systemd: {
      runExecutable: "/usr/bin/systemd-run",
      controlExecutable: "/usr/bin/systemctl",
      environmentExecutable: "/usr/bin/env",
      version: "257"
    },
    sandbox: {
      bubblewrapExecutable: "/usr/bin/bwrap",
      runtimeRoots: ["/opt/agentlab-eval"]
    }
  };
}

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-eval-producer-config-"));
  roots.push(root);
  return root;
}
