import { describe, expect, it } from "vitest";

import {
  evidenceItemSchema,
  factoryApprovalRecordSchema,
  immutableTaskContractSchema,
  type EvidenceItem,
  type EvidenceKind,
  type FactoryApprovalRecord,
  type FactoryBudgetUsage,
  type ImmutableTaskContract,
  type Sha256Digest
} from "@agentlab/contracts";

import {
  defaultFactoryPolicyBundle,
  FactoryPolicyEngine,
  type FactoryPolicyEvaluation
} from "../../packages/runtime/src/domain/factory-policy.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryContract } from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const policyDigest = encodeCanonicalDocument(defaultFactoryPolicyBundle).digest;
const engine = new FactoryPolicyEngine(policyDigest);
const approvalSubject = digest("9");

const zeroUsage: FactoryBudgetUsage = {
  wallClockSeconds: 10,
  agentTurns: 1,
  toolCalls: 1,
  inputTokens: 100,
  outputTokens: 50,
  costMicrousd: 100,
  processes: 1,
  outputBytes: 100,
  workers: 1,
  repairAttempts: 0,
  changedFiles: 1,
  changedLines: 10
};

describe("FactoryPolicyEngine", () => {
  it("allows a fully evidenced R1 draft-PR proposal when the separate broker is enabled", () => {
    const input = r1PullRequestInput();
    const required = engine.evaluate(input).requiredGateIds;
    const decision = engine.evaluate({
      ...input,
      evidence: passingEvidence(required, input.contract.digest)
    });

    expect(decision).toMatchObject({
      outcome: "allow",
      effectiveRiskTier: "R1",
      profileId: "baseline/r1",
      requiredHumanApprovals: 0,
      satisfiedHumanApprovals: 0,
      reasonCodes: []
    });
  });

  it("requires the exact patch-producing execution and its resource isolation", () => {
    const input = r1PullRequestInput();
    const required = engine.evaluate(input).requiredGateIds;
    const complete = passingEvidence(required, input.contract.digest);
    const withoutAgentIsolation = complete.filter(
      (item) =>
        !(
          item.kind === "provenance" &&
          item.subjectDigest === input.contract.digest &&
          item.claims.some((claim) => claim.name === "execution-id")
        )
    );
    expect(engine.evaluate({ ...input, evidence: withoutAgentIsolation }).reasonCodes).toContain(
      "missing-resource-isolation/agent"
    );

    const wrongPatchExecution = complete.map((item) =>
      item.kind === "patch"
        ? evidenceItemSchema.parse({
            ...item,
            claims: item.claims.map((claim) =>
              claim.name === "execution-id" ? { ...claim, value: numberedUuid(81) } : claim
            )
          })
        : item
    );
    expect(engine.evaluate({ ...input, evidence: wrongPatchExecution }).reasonCodes).toContain(
      "missing-patch-implementation"
    );

    let changedGate = false;
    const wrongGateIsolation = complete.map((item) => {
      if (changedGate || item.producer.id !== "agentlab-local-sandbox") return item;
      changedGate = true;
      return evidenceItemSchema.parse({
        ...item,
        claims: item.claims.map((claim) =>
          claim.name === "isolation-id" ? { ...claim, value: numberedUuid(199) } : claim
        )
      });
    });
    expect(engine.evaluate({ ...input, evidence: wrongGateIsolation }).reasonCodes).toContain(
      "missing-resource-isolation/gate"
    );
  });

  it("fails closed when authority, trusted gates, or exact base revision is absent", () => {
    const input = r1PullRequestInput();
    const required = engine.evaluate(input).requiredGateIds;
    const untrusted = passingEvidence(required, input.contract.digest).map((item) => {
      const gateId = item.claims.find((claim) => claim.name === "gate-id")?.value;
      return item.producer.kind === "ci"
        ? evidence({
            index: Number(item.id.slice(-12)),
            kind: item.kind,
            producer: {
              kind: "agent",
              role: "implementer",
              id: "untrusted-agent",
              sessionId: "implementation-2"
            },
            ...(gateId === undefined ? {} : { gateId })
          })
        : item;
    });
    const decision = engine.evaluate({
      ...input,
      currentBaseRevision: "b".repeat(40),
      evidence: untrusted,
      authority: { scheduler: false, prBroker: false }
    });

    expect(decision.outcome).toBe("deny");
    expect(decision.reasonCodes).toContain("base-revision-mismatch");
    expect(decision.reasonCodes).toContain("pr-broker-disabled");
    expect(decision.reasonCodes).toContain("missing-gate/format");
  });

  it("denies an under-classified protected path and an exceeded diff budget", () => {
    const contract = policyContract({
      scope: {
        includePaths: ["packages/contracts/src/conversation.ts", ".github/workflows/ci.yml"],
        excludePaths: [],
        protectedPaths: []
      }
    });
    const input = r1PullRequestInput(contract);
    const decision = engine.evaluate({
      ...input,
      changeSet: {
        baseRevision: contract.repository.baseRevision,
        headRevision: "b".repeat(40),
        changedPaths: [".github/workflows/ci.yml"],
        binaryPaths: [],
        changedFiles: 1,
        changedLines: 501
      },
      usage: { ...zeroUsage, changedLines: 501 }
    });

    expect(decision.outcome).toBe("deny");
    expect(decision.effectiveRiskTier).toBe("R3");
    expect(decision.reasonCodes).toContain("risk-underclassified");
    expect(decision.reasonCodes).toContain("budget-exceeded/changed-lines");
  });

  it("raises production source above the unattended R1 lane", () => {
    const contract = policyContract();
    const input = r1PullRequestInput(contract);
    const decision = engine.evaluate({
      ...input,
      changeSet: {
        ...input.changeSet,
        changedPaths: ["packages/contracts/src/conversation.ts"]
      }
    });

    expect(decision.outcome).toBe("deny");
    expect(decision.effectiveRiskTier).toBe("R2");
    expect(decision.reasonCodes).toContain("risk-underclassified");
  });

  it("denies an under-classified write scope before any protected path is changed", () => {
    const contract = policyContract({
      scope: {
        includePaths: [".github/workflows/ci.yml"],
        excludePaths: [],
        protectedPaths: []
      }
    });
    const input = executionInput(contract);
    const required = engine.evaluate(input).requiredGateIds;
    const decision = engine.evaluate({
      ...input,
      evidence: preparationEvidence(required, input.contract.digest)
    });

    expect(decision).toMatchObject({
      outcome: "deny",
      effectiveRiskTier: "R3"
    });
    expect(decision.reasonCodes).toContain("risk-underclassified");
    expect(decision.reasonCodes).not.toContain("change-outside-contract-scope");
  });

  it("keeps broad read-only analysis in the R0 lane", () => {
    const contract = policyContract({
      riskTier: "R0",
      scope: { includePaths: ["**"], excludePaths: [], protectedPaths: [] },
      capabilities: {
        ...testFactoryContract().capabilities,
        filesystem: "read",
        git: "read"
      },
      gateProfile: { id: "baseline/r0", version: "1.2.0", policyDigest },
      approvals: {
        execution: { mode: "automatic" },
        pullRequestCreation: { mode: "forbidden" },
        merge: { mode: "forbidden" },
        release: { mode: "forbidden" }
      }
    });
    const input = executionInput(contract);
    const required = engine.evaluate(input).requiredGateIds;
    const decision = engine.evaluate({
      ...input,
      evidence: preparationEvidence(required, input.contract.digest)
    });

    expect(decision).toMatchObject({ outcome: "allow", effectiveRiskTier: "R0" });
  });

  it("treats factory policy and broker boundaries as protected R3 changes", () => {
    const contract = policyContract({
      scope: {
        includePaths: ["packages/runtime/src/domain/factory-policy.ts"],
        excludePaths: [],
        protectedPaths: []
      }
    });
    const input = r1PullRequestInput(contract);
    const decision = engine.evaluate({
      ...input,
      changeSet: {
        ...input.changeSet,
        changedPaths: ["packages/runtime/src/domain/factory-policy.ts"]
      }
    });

    expect(decision.outcome).toBe("deny");
    expect(decision.effectiveRiskTier).toBe("R3");
    expect(decision.reasonCodes).toContain("risk-underclassified");
  });

  it("requires a human before R3 execution and accepts only a matching authorized approval", () => {
    const contract = policyContract({
      riskTier: "R3",
      agentPolicy: {
        allowedProviders: ["codex", "claude"],
        workerProfiles: [
          ...testFactoryContract().agentPolicy.workerProfiles,
          {
            id: "codex-reviewer",
            roles: ["reviewer"],
            provider: "codex",
            model: "gpt-5.4",
            reasoning: "high"
          }
        ],
        minimumIndependentReviews: 2,
        requireDistinctReviewSession: true
      },
      gateProfile: { id: "baseline/r3", version: "1.2.0", policyDigest },
      approvals: {
        execution: { mode: "human", minimumApprovals: 1, roles: ["maintainer"] },
        pullRequestCreation: { mode: "human", minimumApprovals: 1, roles: ["maintainer"] },
        merge: { mode: "human", minimumApprovals: 2, roles: ["maintainer"] },
        release: { mode: "human", minimumApprovals: 2, roles: ["release-manager"] }
      }
    });
    const input = executionInput(contract);
    const required = engine.evaluate(input).requiredGateIds;
    const evidenced = {
      ...input,
      evidence: preparationEvidence(required, input.contract.digest)
    };

    expect(engine.evaluate(evidenced)).toMatchObject({
      outcome: "needs-human",
      effectiveRiskTier: "R3",
      requiredHumanApprovals: 1
    });
    expect(
      engine.evaluate({
        ...evidenced,
        approvals: [approval("maintainer", "execution", contractDigest(contract), ["maintainer"])]
      })
    ).toMatchObject({ outcome: "allow", satisfiedHumanApprovals: 1 });
  });

  it("does not count self-review from a different session as independent", () => {
    const input = r1PullRequestInput();
    const required = engine.evaluate(input).requiredGateIds;
    const selfReviewed = passingEvidence(required, input.contract.digest).map((item) =>
      item.kind === "review"
        ? evidence({
            index: 90,
            kind: "review",
            producer: {
              kind: "agent",
              role: "reviewer",
              id: "implementation-agent",
              sessionId: "review-session"
            }
          })
        : item
    );

    const decision = engine.evaluate({ ...input, evidence: selfReviewed });
    expect(decision.outcome).toBe("deny");
    expect(decision.reasonCodes).toContain("insufficient-independent-review");
  });

  it("does not count a passing review of a superseded patch", () => {
    const input = r1PullRequestInput();
    const required = engine.evaluate(input).requiredGateIds;
    const withoutCurrentReview = passingEvidence(required, input.contract.digest).filter(
      (item) => item.kind !== "review"
    );
    const supersededReview = evidence({
      index: 92,
      kind: "review",
      subjectDigest: digest("8"),
      producer: {
        kind: "agent",
        role: "reviewer",
        id: "old-review-agent",
        sessionId: "old-review-session"
      }
    });

    const decision = engine.evaluate({
      ...input,
      evidence: [...withoutCurrentReview, supersededReview]
    });
    expect(decision.outcome).toBe("deny");
    expect(decision.reasonCodes).toContain("insufficient-independent-review");
    expect(decision.reasonCodes).toContain("missing-evidence/review");
  });

  it("keeps merge and release human-controlled in the baseline profile", () => {
    const contract = policyContract();
    const pullRequest = r1PullRequestInput(contract);
    const required = engine.evaluate(pullRequest).requiredGateIds;
    const evidenceItems = [
      ...passingEvidence(required, pullRequest.contract.digest),
      evidence({ index: 91, kind: "pull-request" })
    ];
    const mergeInput: FactoryPolicyEvaluation = {
      ...pullRequest,
      stage: "merge",
      evidence: evidenceItems,
      authority: { scheduler: false, prBroker: false }
    };

    expect(engine.evaluate(mergeInput)).toMatchObject({
      outcome: "needs-human",
      requiredHumanApprovals: 1
    });
    expect(
      engine.evaluate({
        ...mergeInput,
        approvals: [approval("maintainer", "merge", approvalSubject, ["maintainer"])]
      })
    ).toMatchObject({ outcome: "allow" });
    expect(engine.evaluate({ ...mergeInput, stage: "release" }).reasonCodes).toContain(
      "stage-forbidden"
    );
  });
});

function policyContract(overrides: Partial<ImmutableTaskContract> = {}): ImmutableTaskContract {
  const base = testFactoryContract();
  return immutableTaskContractSchema.parse({
    ...base,
    ...overrides,
    scope: overrides.scope ?? {
      includePaths: ["tests/runtime/factory-change.test.ts"],
      excludePaths: [],
      protectedPaths: []
    },
    gateProfile: overrides.gateProfile ?? {
      id: "baseline/r1",
      version: "1.2.0",
      policyDigest
    }
  });
}

function r1PullRequestInput(
  contract: ImmutableTaskContract = policyContract()
): FactoryPolicyEvaluation {
  const document = codec.taskContract(contract);
  return {
    contract: document,
    stage: "pull-request-creation",
    approvalSubjectDigest: approvalSubject,
    now: "2026-08-30T13:00:00.000Z",
    currentBaseRevision: contract.repository.baseRevision,
    changeSet: {
      baseRevision: contract.repository.baseRevision,
      headRevision: "b".repeat(40),
      changedPaths: ["tests/runtime/factory-change.test.ts"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 10
    },
    usage: zeroUsage,
    usageComplete: true,
    evidence: [],
    approvals: [],
    authority: { scheduler: false, prBroker: true },
    scheduled: false
  };
}

function executionInput(contract: ImmutableTaskContract): FactoryPolicyEvaluation {
  return {
    contract: codec.taskContract(contract),
    stage: "execution",
    approvalSubjectDigest: contractDigest(contract),
    now: "2026-08-30T13:00:00.000Z",
    currentBaseRevision: contract.repository.baseRevision,
    changeSet: {
      baseRevision: contract.repository.baseRevision,
      headRevision: null,
      changedPaths: [],
      binaryPaths: [],
      changedFiles: 0,
      changedLines: 0
    },
    usage: { ...zeroUsage, changedFiles: 0, changedLines: 0 },
    usageComplete: true,
    evidence: [],
    approvals: [],
    authority: { scheduler: false, prBroker: false },
    scheduled: false
  };
}

function passingEvidence(
  requiredGateIds: readonly string[],
  contractDigestValue: Sha256Digest
): readonly EvidenceItem[] {
  const kinds: readonly EvidenceKind[] = [
    "contract",
    "policy",
    "skill",
    "patch",
    "usage",
    "test",
    "build",
    "security"
  ];
  const items = kinds.map((kind, index) =>
    evidence({
      index: index + 1,
      kind,
      subjectDigest:
        kind === "contract" || kind === "skill"
          ? contractDigestValue
          : kind === "policy"
            ? policyDigest
            : approvalSubject,
      ...(kind === "patch"
        ? {
            producer: localGateProducer,
            claims: [{ name: "execution-id", value: numberedUuid(80) }]
          }
        : {})
    })
  );
  items.push(
    evidence({
      index: 20,
      kind: "execution",
      producer: {
        kind: "agent",
        role: "implementer",
        id: "implementation-agent",
        sessionId: "implementation-session"
      },
      subjectDigest: contractDigestValue,
      claims: [
        { name: "execution-id", value: numberedUuid(80) },
        { name: "isolation-id", value: numberedUuid(80) }
      ]
    }),
    evidence({
      index: 21,
      kind: "review",
      producer: {
        kind: "agent",
        role: "reviewer",
        id: "review-agent",
        sessionId: "review-session"
      }
    }),
    evidence({
      index: 22,
      kind: "provenance",
      producer: resourceIsolationProducer,
      subjectDigest: contractDigestValue,
      claims: resourceClaims({ name: "execution-id", value: numberedUuid(80) }, numberedUuid(80))
    })
  );
  for (const [index, gateId] of requiredGateIds.entries()) {
    const preparation = gateId.endsWith("validation") || gateId === "independent-review";
    const isolationId = numberedUuid(index + 100);
    items.push(
      evidence({
        index: index + 30,
        kind: "test",
        gateId,
        subjectDigest: gateId.endsWith("validation") ? contractDigestValue : approvalSubject,
        producer: preparation ? localGateProducer : sandboxGateProducer,
        ...(preparation
          ? {}
          : {
              claims: [
                { name: "gate-id", value: gateId },
                { name: "isolation-id", value: isolationId }
              ]
            })
      })
    );
    if (!preparation) {
      items.push(
        evidence({
          index: index + 60,
          kind: "provenance",
          subjectDigest: approvalSubject,
          producer: resourceIsolationProducer,
          claims: resourceClaims({ name: "gate-id", value: gateId }, isolationId)
        })
      );
    }
  }
  return items;
}

function preparationEvidence(
  requiredGateIds: readonly string[],
  contractDigestValue: Sha256Digest
): readonly EvidenceItem[] {
  return [
    evidence({ index: 1, kind: "contract", subjectDigest: contractDigestValue }),
    evidence({ index: 2, kind: "policy", subjectDigest: policyDigest }),
    ...requiredGateIds.map((gateId, index) =>
      evidence({ index: index + 30, kind: "test", gateId, subjectDigest: contractDigestValue })
    )
  ];
}

function evidence(input: {
  readonly index: number;
  readonly kind: EvidenceKind;
  readonly producer?: EvidenceItem["producer"];
  readonly gateId?: string;
  readonly subjectDigest?: Sha256Digest;
  readonly claims?: readonly { readonly name: string; readonly value: string }[];
}): EvidenceItem {
  return evidenceItemSchema.parse({
    id: numberedUuid(input.index),
    kind: input.kind,
    result: "pass",
    subjectDigest: input.subjectDigest ?? approvalSubject,
    artifact: {
      digest: digest((input.index % 10).toString()),
      mediaType: "application/json",
      sizeBytes: 100
    },
    producer: input.producer ?? {
      kind: "ci",
      role: "gate-runner",
      id: "trusted-ci",
      sessionId: null
    },
    createdAt: "2026-08-30T12:30:00.000Z",
    claims:
      input.claims ?? (input.gateId === undefined ? [] : [{ name: "gate-id", value: input.gateId }])
  });
}

const localGateProducer = {
  kind: "control-plane",
  role: "gate-runner",
  id: "agentlab-local-gates",
  sessionId: null
} as const;
const sandboxGateProducer = {
  kind: "ci",
  role: "gate-runner",
  id: "agentlab-local-sandbox",
  sessionId: null
} as const;
const resourceIsolationProducer = {
  kind: "ci",
  role: "gate-runner",
  id: "agentlab-resource-isolator",
  sessionId: null
} as const;

function resourceClaims(
  link: { readonly name: string; readonly value: string },
  isolationId: string
) {
  return [
    link,
    { name: "isolation-id", value: isolationId },
    { name: "policy-bundle-digest", value: policyDigest },
    { name: "isolation-mechanism", value: "linux/systemd-user-scope" }
  ];
}

function approval(
  actorId: string,
  stage: "execution" | "pull-request-creation" | "merge" | "release",
  subjectDigest: Sha256Digest,
  authorityRoles: readonly string[]
): FactoryApprovalRecord {
  return factoryApprovalRecordSchema.parse({
    schemaVersion: "agentlab.approval-record.v1",
    approvalId: numberedUuid(95),
    stage,
    decision: "approved",
    subjectDigest,
    actor: {
      kind: "human",
      role: stage === "release" ? "release-controller" : "merger",
      id: actorId,
      sessionId: null
    },
    authorityRoles,
    occurredAt: "2026-08-30T12:45:00.000Z",
    reason: "Reviewed and approved."
  });
}

function contractDigest(contract: ImmutableTaskContract): Sha256Digest {
  return codec.taskContract(contract).digest;
}

function numberedUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}
