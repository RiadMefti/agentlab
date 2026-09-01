import {
  factoryMaintenanceDiscoveryOutputSchema,
  factoryMaintenanceDiscoveryPolicySchema,
  factoryMaintenanceDiscoveryRunRequestSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
  testFactoryMaintenanceDiscoveryFixture,
  testFactoryMaintenanceDiscoveryOutput
} from "../helpers/factory-maintenance-discovery.js";

describe("factory maintenance discovery contracts", () => {
  it("admits only a pinned, local, read-only, single-scout policy", () => {
    const { policy } = testFactoryMaintenanceDiscoveryFixture();

    expect(factoryMaintenanceDiscoveryPolicySchema.parse(policy)).toEqual(policy);
    for (const unsafe of [
      {
        requestedCapabilities: {
          ...policy.skill.requestedCapabilities,
          filesystem: "workspace-write"
        }
      },
      {
        requestedCapabilities: { ...policy.skill.requestedCapabilities, remoteRepository: "write" }
      },
      { requestedCapabilities: { ...policy.skill.requestedCapabilities, network: { mode: "on" } } },
      { budgetCeiling: { ...policy.skill.budgetCeiling, maxChangedFiles: 1 } }
    ]) {
      expect(
        factoryMaintenanceDiscoveryPolicySchema.safeParse({
          ...policy,
          skill: { ...policy.skill, ...unsafe }
        }).success
      ).toBe(false);
    }
    expect(
      factoryMaintenanceDiscoveryPolicySchema.safeParse({
        ...policy,
        maximumAdmissionsPerTick: policy.maximumFindingsPerTick + 1
      }).success
    ).toBe(false);
  });

  it("strictly bounds untrusted findings to evidenced R1 candidates", () => {
    const output = testFactoryMaintenanceDiscoveryOutput();

    expect(factoryMaintenanceDiscoveryOutputSchema.parse(output)).toEqual(output);
    expect(
      factoryMaintenanceDiscoveryOutputSchema.safeParse({
        ...output,
        findings: [output.findings[0], { ...output.findings[0], title: "A duplicate identity" }]
      }).success
    ).toBe(false);
    expect(
      factoryMaintenanceDiscoveryOutputSchema.safeParse({
        ...output,
        findings: [{ ...output.findings[0], proposedRiskTier: "R2" }]
      }).success
    ).toBe(false);
    expect(
      factoryMaintenanceDiscoveryOutputSchema.safeParse({
        ...output,
        findings: [{ ...output.findings[0], executableCommand: "git push" }]
      }).success
    ).toBe(false);
  });

  it("forbids run requests from gaining write, network, secret, or worker authority", () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const request = {
      schemaVersion: "agentlab.maintenance-discovery-run-request.v1",
      executionId: TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
      runId: fixture.run.value.runId,
      taskId: fixture.run.value.runId,
      runDigest: fixture.run.digest,
      attempt: 1,
      provider: fixture.policy.profile.provider,
      model: fixture.policy.profile.model,
      reasoning: fixture.policy.profile.reasoning,
      repository: fixture.run.value.repository,
      skillId: fixture.skill.id,
      skillPackageDigest: fixture.skill.packageDigest,
      promptArtifact: {
        digest: fixture.skill.packageDigest,
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: 100
      },
      outputSchemaDigest: fixture.skill.outputSchemaDigest,
      capabilities: fixture.skill.requestedCapabilities,
      budget: fixture.skill.budgetCeiling
    };

    expect(factoryMaintenanceDiscoveryRunRequestSchema.parse(request)).toEqual(request);
    expect(
      factoryMaintenanceDiscoveryRunRequestSchema.safeParse({
        ...request,
        taskId: "82000000-0000-4000-8000-000000000001"
      }).success
    ).toBe(false);
    expect(
      factoryMaintenanceDiscoveryRunRequestSchema.safeParse({
        ...request,
        capabilities: { ...request.capabilities, secretRefs: ["github-token"] }
      }).success
    ).toBe(false);
    expect(
      factoryMaintenanceDiscoveryRunRequestSchema.safeParse({
        ...request,
        budget: { ...request.budget, maxWorkers: 2 }
      }).success
    ).toBe(false);
  });
});
