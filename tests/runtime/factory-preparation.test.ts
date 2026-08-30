import { describe, expect, it } from "vitest";

import {
  FactoryPreparationCompiler,
  FactoryPreparationError
} from "../../packages/runtime/src/domain/factory-preparation.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

describe("FactoryPreparationCompiler", () => {
  it("compiles a valid digest-linked chain into policy-derived immutable authority", () => {
    const fixture = testFactoryPreparationFixture();
    const compilation = new FactoryPreparationCompiler(
      fixture.documents,
      fixture.policy,
      fixture.authority
    ).compile(fixture.input);

    expect(compilation.contract.value).toMatchObject({
      taskId: fixture.request.taskId,
      repository: fixture.request.repository,
      objective: fixture.specification.objective,
      riskTier: "R1",
      gateProfile: {
        id: "baseline/r1",
        version: "1.3.0",
        policyDigest: fixture.policyDigest
      },
      agentPolicy: {
        allowedProviders: ["codex", "claude"],
        minimumIndependentReviews: 1,
        requireDistinctReviewSession: true
      },
      approvals: {
        execution: { mode: "automatic" },
        pullRequestCreation: { mode: "automatic" },
        merge: { mode: "human", minimumApprovals: 1, roles: ["maintainer", "security-owner"] },
        release: { mode: "forbidden" }
      }
    });
    expect(compilation.contract.value.skillPlan.map(({ id }) => id)).toEqual([
      "preparation/qualify",
      "preparation/specify",
      "preparation/plan",
      "execution/implement",
      "execution/verify",
      "execution/review",
      "execution/repair"
    ]);
    expect(compilation.contract.value.requiredEvidence).toEqual(
      expect.arrayContaining([
        "request",
        "qualification",
        "specification",
        "plan",
        "contract",
        "policy",
        "skill",
        "patch",
        "test",
        "review"
      ])
    );
  });

  it("does not compile a request that still needs a human answer", () => {
    const fixture = testFactoryPreparationFixture({ qualificationDisposition: "needs-human" });

    expectReason(fixture, "qualification-needs-human");
  });

  it("rejects digest substitution and cross-chain replay", () => {
    const fixture = testFactoryPreparationFixture();
    const substituted = {
      ...fixture.input,
      qualification: {
        ...fixture.qualification,
        objective: "Silently replace the qualified objective."
      }
    };

    expectReason({ ...fixture, input: substituted }, "qualification-digest-mismatch");
  });

  it("pins authority outside the preparation-output input", () => {
    const fixture = testFactoryPreparationFixture();
    const compiler = new FactoryPreparationCompiler(
      fixture.documents,
      fixture.policy,
      fixture.authority
    );
    const attemptedSwap = {
      ...fixture.input,
      authority: {
        ...fixture.authority,
        maximumRiskTier: "R4",
        allowedIncludePaths: ["**"]
      }
    };

    expect(compiler.compile(attemptedSwap).authority.value).toEqual(fixture.authority);
    expect(
      () =>
        new FactoryPreparationCompiler(fixture.documents, fixture.policy, {
          ...fixture.authority,
          policyBundleDigest: `sha256:${"f".repeat(64)}`
        })
    ).toThrow(
      expect.objectContaining<Partial<FactoryPreparationError>>({
        reasonCode: "policy-digest-mismatch"
      })
    );
  });

  it("rejects planner attempts to widen capabilities or cumulative budget", () => {
    const baseline = testFactoryPreparationFixture();
    const widenedCapabilities = testFactoryPreparationFixture({
      planCapabilities: {
        ...baseline.plan.capabilities,
        network: { mode: "allowlist", hosts: ["api.github.com"] }
      }
    });
    expectReason(widenedCapabilities, "capability-ceiling-exceeded");

    const widenedBudget = testFactoryPreparationFixture({
      planBudget: { ...baseline.plan.budget, maxToolCalls: 501 }
    });
    expectReason(widenedBudget, "budget-ceiling-exceeded");
  });

  it("rejects unpinned skills, worker profiles, and include scope", () => {
    expectReason(
      testFactoryPreparationFixture({ selectedSkillIds: ["untrusted/skill"] }),
      "execution-skill-not-authorized"
    );
    expectReason(
      testFactoryPreparationFixture({ selectedWorkerProfileIds: ["untrusted-worker"] }),
      "worker-profile-not-authorized"
    );
    expectReason(
      testFactoryPreparationFixture({
        includePaths: ["docs/architecture.md"],
        allowedIncludePaths: ["README.md"]
      }),
      "scope-not-authorized"
    );
  });

  it("raises protected scope to R3 and derives every approval from policy", () => {
    const fixture = testFactoryPreparationFixture({
      includePaths: [".github/workflows/ci.yml"],
      maximumRiskTier: "R3",
      proposedRiskTier: "R1",
      reviewerCount: 2
    });
    const contract = new FactoryPreparationCompiler(
      fixture.documents,
      fixture.policy,
      fixture.authority
    ).compile(fixture.input).contract.value;

    expect(contract.riskTier).toBe("R3");
    expect(contract.gateProfile.id).toBe("baseline/r3");
    expect(contract.agentPolicy.minimumIndependentReviews).toBe(2);
    expect(contract.approvals).toEqual({
      execution: { mode: "human", minimumApprovals: 1, roles: ["maintainer"] },
      pullRequestCreation: { mode: "human", minimumApprovals: 1, roles: ["maintainer"] },
      merge: {
        mode: "human",
        minimumApprovals: 2,
        roles: ["maintainer", "security-owner"]
      },
      release: {
        mode: "human",
        minimumApprovals: 2,
        roles: ["release-owner", "security-owner"]
      }
    });
  });

  it("enforces authority expiry and maximum contract lifetime", () => {
    expectReason(
      testFactoryPreparationFixture({ contractExpiresAt: "2026-08-31T12:01:01.000Z" }),
      "authority-expired"
    );
    expectReason(
      testFactoryPreparationFixture({
        contractExpiresAt: "2026-08-30T14:09:01.000Z",
        maximumContractLifetimeSeconds: 7_200
      }),
      "contract-lifetime-exceeded"
    );
  });
});

function expectReason(
  fixture: ReturnType<typeof testFactoryPreparationFixture>,
  reasonCode: string
): void {
  try {
    new FactoryPreparationCompiler(fixture.documents, fixture.policy, fixture.authority).compile(
      fixture.input
    );
    throw new Error("Expected preparation compilation to fail.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FactoryPreparationError);
    expect((error as FactoryPreparationError).reasonCode).toBe(reasonCode);
  }
}
