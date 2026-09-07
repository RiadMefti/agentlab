import {
  factoryExternalPullRequestRepairGateProfileSchema,
  factoryExternalPullRequestRepairQualificationPolicySchema,
  factoryExternalPullRequestRepairQualificationRunSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  externalPullRequestRepairQualificationRun,
  testExternalPullRequestRepairQualificationFixture
} from "../helpers/factory-external-pull-request-repair-qualification.js";

describe("external pull-request repair qualification contracts", () => {
  it("pins the complete ordered R1 gate floor and a no-write reviewer quorum", () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    expect(fixture.policy.gateProfile.gates.map(({ id }) => id)).toEqual([
      "format",
      "architecture",
      "typecheck",
      "lint",
      "test",
      "build",
      "secret-scan"
    ]);
    expect(fixture.policy.reviewerProfiles[0]?.capabilities).toMatchObject({
      filesystem: "read",
      git: "read",
      remoteRepository: "none",
      process: "sandboxed",
      network: { mode: "off" },
      commandAllowlist: [],
      secretRefs: []
    });
    expect(fixture.execution.executionPolicy.qualificationPolicyDigest).toBe(
      fixture.policyDocument.digest
    );
  });

  it("rejects reordered or weakened gate profiles", () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const reordered = {
      ...fixture.gateProfile,
      gates: [
        fixture.gateProfile.gates[1],
        fixture.gateProfile.gates[0],
        ...fixture.gateProfile.gates.slice(2)
      ]
    };
    expect(factoryExternalPullRequestRepairGateProfileSchema.safeParse(reordered).success).toBe(
      false
    );
    expect(
      factoryExternalPullRequestRepairGateProfileSchema.safeParse({
        ...fixture.gateProfile,
        gates: fixture.gateProfile.gates.map((gate) =>
          gate.id === "secret-scan" ? { ...gate, evidenceKind: "test" } : gate
        )
      }).success
    ).toBe(false);
  });

  it("rejects reviewer mutation or a process mode its provider cannot enforce", () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const profile = fixture.policy.reviewerProfiles[0];
    expect(profile).toBeDefined();
    expect(
      factoryExternalPullRequestRepairQualificationPolicySchema.safeParse({
        ...fixture.policy,
        reviewerProfiles: [
          {
            ...profile,
            capabilities: { ...profile?.capabilities, filesystem: "workspace-write" }
          }
        ]
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestRepairQualificationPolicySchema.safeParse({
        ...fixture.policy,
        reviewerProfiles: [
          { ...profile, capabilities: { ...profile?.capabilities, process: "none" } }
        ]
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestRepairQualificationPolicySchema.safeParse({
        ...fixture.policy,
        reviewerProfiles: [
          {
            ...profile,
            provider: "claude",
            model: "claude-sonnet-4-5",
            reasoning: null,
            capabilities: { ...profile?.capabilities, process: "none" }
          }
        ]
      }).success
    ).toBe(true);
  });

  it("binds the qualification run to a deadline and repaired patch", () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const run = externalPullRequestRepairQualificationRun(fixture);
    expect(run.value.repairedPatchDigest).toBe(fixture.repairBundle.value.patchArtifact.digest);
    expect(
      factoryExternalPullRequestRepairQualificationRunSchema.safeParse({
        ...run.value,
        deadlineAt: run.value.createdAt
      }).success
    ).toBe(false);
  });

  it("requires the aggregate budget and deadline to reserve all mandatory work", () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    expect(
      factoryExternalPullRequestRepairQualificationPolicySchema.safeParse({
        ...fixture.policy,
        aggregateBudget: { ...fixture.policy.aggregateBudget, wallClockSeconds: 659 }
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestRepairQualificationPolicySchema.safeParse({
        ...fixture.policy,
        operationDeadlineSeconds: 659
      }).success
    ).toBe(false);
  });
});
