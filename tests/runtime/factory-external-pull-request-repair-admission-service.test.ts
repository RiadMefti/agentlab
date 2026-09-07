import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairDecision
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryExternalPullRequestRepairAdmissionService } from "../../packages/runtime/src/application/factory-external-pull-request-repair-admission-service.js";
import { assertExternalPullRequestRepairDecision } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-admission-integrity.js";
import type {
  FactoryExternalPullRequestRepairAdmissionCandidate,
  FactoryExternalPullRequestRepairAdmissionRepository,
  FactoryExternalPullRequestRepairAdmissionSnapshot
} from "../../packages/runtime/src/domain/factory-external-pull-request-repair-admission-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { testExternalPullRequestRepairAdmissionFixture } from "../helpers/factory-external-pull-request-repair-admission.js";

describe("FactoryExternalPullRequestRepairAdmissionService", () => {
  it("issues one selectors-only replacement-draft capability from completed feedback", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const repository = new MemoryAdmissionRepository([fixture.candidate]);
    const controls = { state: vi.fn(() => Promise.resolve({ scheduler: true, prBroker: false })) };
    const service = serviceFor(fixture, repository, controls);

    await expect(service.preflight()).resolves.toMatchObject({
      status: "ready",
      schedulerEnabled: true,
      remoteWrite: false,
      autoMerge: false,
      release: false
    });
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "completed",
      inspected: 1,
      authorized: 1,
      denied: 0
    });

    const authorization = repository.snapshot?.authorization;
    expect(authorization).toMatchObject({
      publicationMode: "replacement-draft",
      remoteWrite: false,
      autoMerge: false,
      release: false,
      repairAttempt: 1,
      selectedFindings: [
        { reviewerId: "maintainability-reviewer", findingId: "review/finding-2" },
        { reviewerId: "security-reviewer", findingId: "review/finding-1" }
      ]
    });
    const encoded = JSON.stringify(authorization);
    expect(encoded).not.toContain("Correct the behavior");
    expect(encoded).not.toContain("Untrusted contributor text");
    expect(controls.state).toHaveBeenCalledTimes(4);
  });

  it("records a deterministic denial when reviewed policy excludes fork repairs", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture({ allowForks: false });
    const repository = new MemoryAdmissionRepository([fixture.candidate]);
    const service = serviceFor(fixture, repository, {
      state: () => Promise.resolve({ scheduler: true, prBroker: false })
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "completed",
      authorized: 0,
      denied: 1,
      reasonCodes: ["fork-repair-not-admitted"]
    });
    expect(repository.snapshot).toMatchObject({
      decision: { status: "denied", reasonCodes: ["fork-repair-not-admitted"] },
      authorization: null,
      authorizationDigest: null
    });
  });

  it("rejects a forged authorization when the durable boundary recomputes a denial", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const repository = new MemoryAdmissionRepository([fixture.candidate]);
    const service = serviceFor(fixture, repository, {
      state: () => Promise.resolve({ scheduler: true, prBroker: false })
    });
    await service.tick(pins(fixture));
    const snapshot = repository.snapshot;
    if (snapshot?.authorization === null || snapshot?.authorization === undefined) {
      throw new Error("Expected the admitted test authorization.");
    }
    const validAuthorization =
      fixture.feedback.review.documents.externalPullRequestRepairAuthorization(
        snapshot.authorization
      );
    const validDecision = fixture.feedback.review.documents.externalPullRequestRepairDecision(
      snapshot.decision
    );
    expect(() => {
      assertExternalPullRequestRepairDecision(
        fixture.policyDocument,
        fixture.candidate,
        validDecision,
        validAuthorization,
        fixture.feedback.review.documents,
        "2026-09-01T12:40:00.000Z"
      );
    }).toThrow(/deterministic policy result/u);

    const deniedPolicy = fixture.feedback.review.documents.externalPullRequestRepairAdmissionPolicy(
      { ...fixture.policy, allowForks: false }
    );
    const forgedAuthorization =
      fixture.feedback.review.documents.externalPullRequestRepairAuthorization({
        ...snapshot.authorization,
        admissionPolicyDigest: deniedPolicy.digest
      });
    const forgedDecision = fixture.feedback.review.documents.externalPullRequestRepairDecision({
      ...snapshot.decision,
      admissionPolicyDigest: deniedPolicy.digest,
      authorizationDigest: forgedAuthorization.digest
    });

    expect(() => {
      assertExternalPullRequestRepairDecision(
        deniedPolicy,
        fixture.candidate,
        forgedDecision,
        forgedAuthorization,
        fixture.feedback.review.documents,
        "2026-09-01T12:24:00.000Z"
      );
    }).toThrow(/deterministic policy result/u);
  });

  it("does not create local authority after the scheduler switch is revoked", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const repository = new MemoryAdmissionRepository([fixture.candidate]);
    let reads = 0;
    const service = serviceFor(fixture, repository, {
      state: () => {
        reads += 1;
        return Promise.resolve({ scheduler: reads < 2, prBroker: false });
      }
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      authorized: 0,
      denied: 0,
      reasonCodes: ["scheduler-disabled-before-decision"]
    });
    expect(repository.snapshot).toBeNull();
  });
});

function serviceFor(
  fixture: ReturnType<typeof testExternalPullRequestRepairAdmissionFixture>,
  repository: MemoryAdmissionRepository,
  controls: { state(): Promise<{ scheduler: boolean; prBroker: boolean }> }
) {
  return new FactoryExternalPullRequestRepairAdmissionService({
    admissionPolicy: fixture.policyDocument,
    repository,
    controls,
    documents: fixture.feedback.review.documents,
    now: () => "2026-09-01T12:24:00.000Z",
    createId: idFactory()
  });
}

function pins(fixture: ReturnType<typeof testExternalPullRequestRepairAdmissionFixture>) {
  return {
    expectedAdmissionPolicyDigest: fixture.policyDocument.digest,
    expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest,
    expectedFeedbackPolicyDigest: fixture.policy.feedbackPolicyDigest,
    expectedRepairExecutionPolicyDigest: fixture.policy.repairExecutionPolicyDigest,
    expectedCostPolicyDigest: fixture.policy.costPolicyDigest,
    expectedRoleIdentityPolicyDigest: fixture.policy.roleIdentityPolicyDigest,
    expectedGateProfileDigest: fixture.policy.gateProfileDigest
  };
}

class MemoryAdmissionRepository implements FactoryExternalPullRequestRepairAdmissionRepository {
  public snapshot: FactoryExternalPullRequestRepairAdmissionSnapshot | null = null;

  public constructor(
    private readonly candidates: readonly FactoryExternalPullRequestRepairAdmissionCandidate[]
  ) {}

  public listCandidates() {
    return Promise.resolve(this.snapshot === null ? this.candidates : []);
  }

  public findByBundle() {
    return Promise.resolve(this.snapshot);
  }

  public decide(
    _policy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    decision: CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>,
    authorization: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization> | null
  ) {
    if (this.snapshot !== null)
      return Promise.resolve({ status: "existing" as const, ...this.snapshot });
    this.snapshot = {
      decision: decision.value,
      decisionDigest: decision.digest,
      authorization: authorization?.value ?? null,
      authorizationDigest: authorization?.digest ?? null
    };
    return Promise.resolve({ status: "created" as const, ...this.snapshot });
  }

  public close(): void {
    // The in-memory repository owns no external resources.
  }
}

function idFactory() {
  let next = 1;
  return () => `94000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
