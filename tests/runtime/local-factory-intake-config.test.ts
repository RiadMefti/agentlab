import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryIntakeConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-intake-config.js";
import { loadLocalFactoryIntakeSubmission } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-intake-submission.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory intake files", () => {
  it("loads exact owner-only config, cost, grant, and skill packages", async () => {
    const fixture = await writeFixture();

    await expect(loadLocalFactoryIntakeConfig(fixture.configPath)).resolves.toMatchObject({
      schemaVersion: "agentlab.local-factory-intake.v1",
      repositoryId: "riadmefti/agentlab",
      costPolicy: fixture.policy.costPolicy,
      preparationGrant: fixture.policy.grant,
      skillPackages: fixture.policy.packages
    });
  });

  it("rejects public files, overlapping state, and substituted skill documents", async () => {
    const publicFixture = await writeFixture();
    await chmod(publicFixture.configPath, 0o644);
    await expect(loadLocalFactoryIntakeConfig(publicFixture.configPath)).rejects.toThrow(
      /owner-only regular file/u
    );

    const overlapFixture = await writeFixture({ databaseInsideRepository: true });
    await expect(loadLocalFactoryIntakeConfig(overlapFixture.configPath)).rejects.toThrow(
      /database must remain outside/u
    );

    const substituted = await writeFixture();
    await writePrivateJson(substituted.skillPaths[0] ?? "", { schemaVersion: "unknown" });
    await expect(loadLocalFactoryIntakeConfig(substituted.configPath)).rejects.toThrow();
  });

  it("loads only a strict bounded feature or bug submission", async () => {
    const root = await temporaryRoot();
    const requestPath = join(root, "request.json");
    const request = {
      schemaVersion: "agentlab.intake-submission.v1",
      kind: "feature",
      sourceRef: "local/feature-1",
      title: "Add governed intake",
      body: "Register immutable report inputs without granting execution authority."
    };
    await writePrivateJson(requestPath, request);

    await expect(loadLocalFactoryIntakeSubmission(requestPath)).resolves.toEqual(request);
    await writePrivateJson(requestPath, { ...request, taskId: "caller-controlled" });
    await expect(loadLocalFactoryIntakeSubmission(requestPath)).rejects.toThrow();
    await chmod(requestPath, 0o644);
    await expect(loadLocalFactoryIntakeSubmission(requestPath)).rejects.toThrow(/owner-only/u);
  });
});

async function writeFixture(options: { readonly databaseInsideRepository?: boolean } = {}) {
  const root = await temporaryRoot();
  const configDirectory = join(root, "config");
  const repositoryRoot = join(root, "repository");
  const stateRoot = join(root, "state");
  await Promise.all([
    mkdir(configDirectory, { mode: 0o700 }),
    mkdir(repositoryRoot, { mode: 0o700 }),
    mkdir(stateRoot, { mode: 0o700 })
  ]);
  const policy = testFactoryIntakePolicyFixture();
  const costPolicyPath = join(configDirectory, "cost-policy.json");
  const preparationGrantPath = join(configDirectory, "grant.json");
  const skillPaths = policy.packages.map((_, index) =>
    join(configDirectory, `skill-${String(index)}.json`)
  );
  await Promise.all([
    writePrivateJson(costPolicyPath, policy.costPolicy),
    writePrivateJson(preparationGrantPath, policy.grant),
    ...policy.packages.map((skillPackage, index) =>
      writePrivateJson(skillPaths[index] ?? "", skillPackage)
    )
  ]);
  const configPath = join(configDirectory, "intake.json");
  await writePrivateJson(configPath, {
    schemaVersion: "agentlab.local-factory-intake.v1",
    databasePath: options.databaseInsideRepository
      ? join(repositoryRoot, "agentlab.sqlite")
      : join(stateRoot, "agentlab.sqlite"),
    artifactRoot: join(stateRoot, "artifacts"),
    repositoryRoot,
    repositoryId: "riadmefti/agentlab",
    conversationId: "0198f005-4ec4-7000-8000-000000000001",
    operatorId: "maintainer/riad",
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    costPolicyPath,
    preparationGrantPath,
    skillPackagePaths: skillPaths,
    authorityLifetimeSeconds: 3_600
  });
  return { configPath, skillPaths, policy };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-intake-config-"));
  temporaryRoots.push(root);
  return root;
}
