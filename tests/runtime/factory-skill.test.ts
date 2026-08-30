import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { immutableTaskContractSchema, type FactorySkillPackage } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactFactorySkillSource } from "../../packages/runtime/src/application/artifact-factory-skill-source.js";
import {
  resolveFactorySkillPlan,
  selectFactorySkills
} from "../../packages/runtime/src/domain/factory-skill.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest, testFactoryContract } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("factory skill packages", () => {
  it("resolves a canonical pinned package and derives least-privilege run limits", async () => {
    const fixture = await skillFixture();
    const resolved = await resolveFactorySkillPlan(fixture.source, fixture.contract);
    const selected = selectFactorySkills({
      contract: fixture.contract,
      resolved,
      phase: "implement",
      provider: "codex"
    });

    expect(resolved.map(({ manifest }) => manifest.id)).toEqual(["factory/implement"]);
    expect(selected.capabilities).toMatchObject({
      filesystem: "workspace-write",
      git: "worktree-write",
      remoteRepository: "none",
      process: "sandboxed",
      network: { mode: "off" }
    });
    expect(selected.budget.wallClockSeconds).toBe(900);
    expect(selected.skills[0]?.instructions).toContain("immutable contract");
  });

  it("rejects non-canonical packages and a package that disagrees with its task plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-skill-test-"));
    temporaryRoots.push(root);
    const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
    const documents = new NodeFactoryDocumentCodec();
    const packageValue = skillPackage();
    const noncanonical = JSON.stringify(packageValue, null, 2);
    const stored = await artifacts.putText(noncanonical);
    const source = new ArtifactFactorySkillSource(artifacts, documents);
    await expect(source.resolve(stored.digest)).rejects.toThrow(/canonical artifact/u);

    const canonical = documents.skillPackage(packageValue);
    await artifacts.putText(canonical.json);
    const base = testFactoryContract();
    const contract = immutableTaskContractSchema.parse({
      ...base,
      skillPlan: [
        {
          id: "factory/another-skill",
          version: "1.0.0",
          packageDigest: canonical.digest,
          phase: "implement",
          dependsOn: []
        }
      ]
    });
    await expect(resolveFactorySkillPlan(source, contract)).rejects.toThrow(/does not match/u);
  });

  it("fails closed when any pinned phase skill is incompatible with the provider", async () => {
    const fixture = await skillFixture();
    const resolved = await resolveFactorySkillPlan(fixture.source, fixture.contract);
    const compatible = resolved[0];
    if (compatible === undefined) throw new Error("Expected a resolved skill.");
    const incompatibleDigest = testDigest("f");
    const incompatible = {
      ...compatible,
      packageDigest: incompatibleDigest,
      package: {
        ...compatible.package,
        manifest: {
          ...compatible.package.manifest,
          id: "factory/claude-only",
          providerCompatibility: { mode: "allowlist" as const, providers: ["claude" as const] }
        }
      },
      manifest: {
        ...compatible.manifest,
        id: "factory/claude-only",
        packageDigest: incompatibleDigest,
        providerCompatibility: { mode: "allowlist" as const, providers: ["claude" as const] }
      }
    };
    const contract = immutableTaskContractSchema.parse({
      ...fixture.contract,
      skillPlan: [
        ...fixture.contract.skillPlan,
        {
          id: "factory/claude-only",
          version: "1.0.0",
          packageDigest: incompatibleDigest,
          phase: "implement",
          dependsOn: []
        }
      ]
    });

    expect(() =>
      selectFactorySkills({
        contract,
        resolved: [...resolved, incompatible],
        phase: "implement",
        provider: "codex"
      })
    ).toThrow(/claude-only.*not compatible/u);
  });
});

async function skillFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-skill-test-"));
  temporaryRoots.push(root);
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  const documents = new NodeFactoryDocumentCodec();
  const packageDocument = documents.skillPackage(skillPackage());
  const stored = await artifacts.putText(packageDocument.json);
  if (stored.digest !== packageDocument.digest) throw new Error("Test package digest mismatch.");
  const base = testFactoryContract();
  const contract = immutableTaskContractSchema.parse({
    ...base,
    skillPlan: [
      {
        id: "factory/implement",
        version: "1.0.0",
        packageDigest: packageDocument.digest,
        phase: "implement",
        dependsOn: []
      }
    ]
  });
  return {
    source: new ArtifactFactorySkillSource(artifacts, documents),
    contract,
    packageDocument
  };
}

function skillPackage(): FactorySkillPackage {
  const contract = testFactoryContract();
  return {
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id: "factory/implement",
      version: "1.0.0",
      instructionPath: "SKILL.md",
      description: "Implement one bounded task.",
      roles: ["implementer"],
      triggers: ["manual"],
      inputSchemaDigest: null,
      outputSchemaDigest: null,
      requestedCapabilities: {
        filesystem: "workspace-write",
        git: "worktree-write",
        remoteRepository: "none",
        process: "sandboxed",
        network: { mode: "off" },
        commandAllowlist: [],
        secretRefs: []
      },
      riskCeiling: "R2",
      allowedFromStates: ["executing"],
      allowedToStates: ["verifying"],
      providerCompatibility: { mode: "allowlist", providers: ["codex"] },
      budgetCeiling: { ...contract.budget, wallClockSeconds: 900 },
      requiredEvidence: ["execution", "patch"],
      dependencyDigests: []
    },
    files: { "SKILL.md": "Implement only the immutable contract and report tests." }
  };
}
