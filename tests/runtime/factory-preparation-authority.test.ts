import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { FactoryPreparationAuthorityGrant } from "@agentlab/contracts";

import { FactoryPreparationIntakeService } from "../../packages/runtime/src/application/factory-preparation-intake-service.js";
import {
  FactoryPreparationAuthorityError,
  FactoryPreparationAuthorityIssuer
} from "../../packages/runtime/src/domain/factory-preparation-authority.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

describe("FactoryPreparationAuthorityIssuer", () => {
  it("derives task, request, repository, and policy identity from trusted inputs", () => {
    const fixture = testFactoryPreparationFixture();
    const issuer = new FactoryPreparationAuthorityIssuer(
      fixture.documents,
      fixture.policy,
      grantFromFixture(fixture)
    );

    const issued = issuer.issue({
      request: fixture.request,
      issuedAt: fixture.authority.issuedAt,
      expiresAt: fixture.authority.expiresAt,
      supersedesContractDigest: null
    });

    expect(issued.request.value).toEqual(fixture.request);
    expect(issued.authority.value).toEqual(fixture.authority);
    expect(issued.authority.value.policyBundleDigest).toBe(fixture.policy.bundleDigest);
    expect(issued.authority.value.requestDigest).toBe(issued.request.digest);
  });

  it("issues and registers the request without exposing event-authoring authority", async () => {
    const fixture = testFactoryPreparationFixture();
    const repository = new SqliteFactoryPreparationRepository(":memory:");
    const issuer = new FactoryPreparationAuthorityIssuer(
      fixture.documents,
      fixture.policy,
      grantFromFixture(fixture)
    );
    const service = new FactoryPreparationIntakeService(
      fixture.documents,
      issuer,
      repository,
      {
        putText: (content) =>
          Promise.resolve({
            digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
            sizeBytes: Buffer.byteLength(content, "utf8")
          })
      },
      {
        controlPlaneActorId: "local/factory-control-plane",
        createEventId: () => "11111111-1111-4111-8111-111111111111"
      }
    );

    try {
      await expect(
        service.register({
          request: fixture.request,
          issuedAt: fixture.authority.issuedAt,
          expiresAt: fixture.authority.expiresAt,
          supersedesContractDigest: null,
          correlationId: "22222222-2222-4222-8222-222222222222"
        })
      ).resolves.toMatchObject({
        state: "registered",
        request: fixture.request,
        authority: fixture.authority,
        lastEvent: {
          kind: "registered",
          actor: { kind: "control-plane", role: "policy-engine" }
        }
      });
    } finally {
      repository.close();
    }
  });

  it("rejects authority timing outside the repository grant", () => {
    const fixture = testFactoryPreparationFixture();
    const issuer = new FactoryPreparationAuthorityIssuer(
      fixture.documents,
      fixture.policy,
      grantFromFixture(fixture)
    );

    expectReason(
      () =>
        issuer.issue({
          request: fixture.request,
          issuedAt: "2026-08-30T11:59:59.000Z",
          expiresAt: "2026-08-31T11:59:59.000Z",
          supersedesContractDigest: null
        }),
      "authority-predates-request"
    );
    expectReason(
      () =>
        issuer.issue({
          request: fixture.request,
          issuedAt: fixture.authority.issuedAt,
          expiresAt: "2026-09-01T12:01:00.000Z",
          supersedesContractDigest: null
        }),
      "authority-lifetime-exceeded"
    );
  });

  it("rejects a preparation profile that cannot enforce its pinned skill", () => {
    const fixture = testFactoryPreparationFixture();
    const grant = grantFromFixture(fixture);
    const weakenedProfiles = grant.preparationProfiles.map((profile, index) =>
      index === 0
        ? {
            ...profile,
            capabilities: {
              ...profile.capabilities,
              process: "none" as const,
              commandAllowlist: []
            }
          }
        : profile
    );

    expectReason(
      () =>
        new FactoryPreparationAuthorityIssuer(fixture.documents, fixture.policy, {
          ...grant,
          preparationProfiles: weakenedProfiles
        }),
      "preparation-capability-missing"
    );
  });

  it("keeps preparation and execution worker identities separate", () => {
    const fixture = testFactoryPreparationFixture();
    const grant = grantFromFixture(fixture);
    const reused = grant.preparationProfiles.map((profile, index) =>
      index === 0 ? { ...profile, id: "codex-writer" } : profile
    );

    expectReason(
      () =>
        new FactoryPreparationAuthorityIssuer(fixture.documents, fixture.policy, {
          ...grant,
          preparationProfiles: reused
        }),
      "worker-id-reused"
    );
  });

  it("requires each preparation skill to declare its direct predecessor", () => {
    const fixture = testFactoryPreparationFixture();
    const grant = grantFromFixture(fixture);
    const skills = grant.skills.map((skill) =>
      skill.phase === "specify"
        ? {
            ...skill,
            dependsOn: [],
            manifest: { ...skill.manifest, dependencyDigests: [] }
          }
        : skill
    );

    expectReason(
      () =>
        new FactoryPreparationAuthorityIssuer(fixture.documents, fixture.policy, {
          ...grant,
          skills
        }),
      "preparation-dependency-missing"
    );
  });
});

function grantFromFixture(
  fixture: ReturnType<typeof testFactoryPreparationFixture>
): FactoryPreparationAuthorityGrant {
  const authority = fixture.authority;
  return {
    schemaVersion: "agentlab.preparation-authority-grant.v1",
    authorityId: authority.authorityId,
    version: authority.version,
    maximumAuthorityLifetimeSeconds: 86_400,
    allowedIncludePaths: [...authority.allowedIncludePaths],
    protectedPaths: [...authority.protectedPaths],
    maximumRiskTier: authority.maximumRiskTier,
    skills: authority.skills,
    preparationProfiles: authority.preparationProfiles,
    workerProfiles: authority.workerProfiles,
    capabilityCeiling: authority.capabilityCeiling,
    budgetCeiling: authority.budgetCeiling,
    evidenceFloor: [...authority.evidenceFloor],
    approvalRoles: authority.approvalRoles,
    maximumPreparationAttempts: authority.maximumPreparationAttempts,
    maximumContractLifetimeSeconds: authority.maximumContractLifetimeSeconds
  };
}

function expectReason(operation: () => unknown, reasonCode: string): void {
  try {
    operation();
    throw new Error("Expected authority issuance to fail.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FactoryPreparationAuthorityError);
    expect((error as FactoryPreparationAuthorityError).reasonCode).toBe(reasonCode);
  }
}
