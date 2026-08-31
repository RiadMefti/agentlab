import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalFactoryIntake,
  type LocalFactoryIntakeOptions
} from "../../packages/runtime/src/local-factory-intake.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local factory intake composition", () => {
  it("owns a durable database and releases single-writer authority on close", async () => {
    const options = intakeOptions();
    const first = createLocalFactoryIntake(options);
    await first.close();

    const reopened = createLocalFactoryIntake(options);
    await expect(reopened.close()).resolves.toBeUndefined();
  });

  it("cleans failed construction and rejects overlapping or in-memory state", async () => {
    const options = intakeOptions();
    const [firstPackage, ...remainingPackages] = options.skillPackages;
    if (firstPackage === undefined) throw new Error("Test requires one factory skill package.");
    expect(() =>
      createLocalFactoryIntake({
        ...options,
        skillPackages: [
          { ...firstPackage, files: { ...firstPackage.files, extra: "substitution" } },
          ...remainingPackages
        ]
      })
    ).toThrow(/not authorized/u);

    const recovered = createLocalFactoryIntake(options);
    await recovered.close();
    expect(() => createLocalFactoryIntake({ ...options, databasePath: ":memory:" })).toThrow(
      /durable SQLite/u
    );
    expect(() =>
      createLocalFactoryIntake({ ...options, artifactRoot: options.repositoryRoot })
    ).toThrow(/must not overlap/u);
  });
});

function intakeOptions(): LocalFactoryIntakeOptions {
  const root = mkdtempSync(join(tmpdir(), "agentlab-intake-runtime-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const stateRoot = join(root, "state");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  const fixture = testFactoryIntakePolicyFixture();
  return {
    databasePath: join(stateRoot, "agentlab.sqlite"),
    artifactRoot: join(stateRoot, "artifacts"),
    repositoryRoot,
    repositoryId: "riadmefti/agentlab",
    conversationId: "0198f005-4ec4-7000-8000-000000000001",
    operatorId: "maintainer/riad",
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    costPolicy: fixture.costPolicy,
    preparationGrant: fixture.grant,
    skillPackages: fixture.packages,
    authorityLifetimeSeconds: 3_600
  };
}
