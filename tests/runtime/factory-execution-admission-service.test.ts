import { describe, expect, it } from "vitest";

import {
  type FactoryPolicyCheckInput,
  type FactoryPolicyDecision,
  type FactoryRiskTier
} from "@agentlab/contracts";

import { FactoryExecutionAdmissionService } from "../../packages/runtime/src/application/factory-execution-admission-service.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_FACTORY_CONVERSATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";

describe("FactoryExecutionAdmissionService", () => {
  it("uses the observed repository revision and queues only an allowed R1 task", async () => {
    const context = admissionContext("allow");

    const outcome = await context.service.admit({ taskId: TEST_FACTORY_TASK_ID });

    expect(outcome).toMatchObject({
      status: "queued",
      task: { state: "queued" },
      decision: { outcome: "allow" },
      policyEvidenceDigest: context.policyEvidenceDigest
    });
    expect(context.revisionRoots).toEqual(["/work/agentlab"]);
    expect(context.evaluations).toEqual([
      expect.objectContaining({
        taskId: TEST_FACTORY_TASK_ID,
        stage: "execution",
        approvalSubjectDigest: context.planned.contractDigest,
        currentBaseRevision: context.planned.contract.repository.baseRevision,
        changeSet: {
          baseRevision: context.planned.contract.repository.baseRevision,
          headRevision: null,
          changedPaths: [],
          binaryPaths: [],
          changedFiles: 0,
          changedLines: 0
        },
        usageComplete: true,
        approvals: [],
        scheduled: false
      })
    ]);
    expect(context.transitions).toEqual([
      {
        taskId: TEST_FACTORY_TASK_ID,
        expectedState: "planned",
        nextState: "queued",
        actor: {
          kind: "control-plane",
          role: "policy-engine",
          id: "agentlab-policy",
          sessionId: null
        },
        reasonCode: "execution-authorized",
        evidenceBundleDigest: context.policyEvidenceDigest
      }
    ]);
  });

  it("records a denial without transitioning when the observed base has changed", async () => {
    const context = admissionContext("deny", "b".repeat(40));

    const outcome = await context.service.admit({ taskId: TEST_FACTORY_TASK_ID });

    expect(outcome).toMatchObject({
      status: "denied",
      task: { state: "planned" },
      decision: { outcome: "deny", reasonCodes: ["base-revision-mismatch"] }
    });
    expect(context.evaluations[0]).toMatchObject({ currentBaseRevision: "b".repeat(40) });
    expect(context.transitions).toEqual([]);
  });

  it("preserves a human-approval requirement without transitioning", async () => {
    const context = admissionContext("needs-human");

    await expect(context.service.admit({ taskId: TEST_FACTORY_TASK_ID })).resolves.toMatchObject({
      status: "needs-human",
      task: { state: "planned" },
      decision: { outcome: "needs-human" }
    });
    expect(context.transitions).toEqual([]);
  });

  it("is idempotent after admission and performs no second revision or policy check", async () => {
    const context = admissionContext("allow", undefined, "queued");

    await expect(context.service.admit({ taskId: TEST_FACTORY_TASK_ID })).resolves.toMatchObject({
      status: "queued",
      decision: null,
      policyEvidenceDigest: null
    });
    expect(context.revisionRoots).toEqual([]);
    expect(context.evaluations).toEqual([]);
    expect(context.transitions).toEqual([]);
  });

  it("rejects malformed commands, inactive conversations, and non-R1 work", async () => {
    const malformed = admissionContext("allow");
    await expect(
      malformed.service.admit({ taskId: TEST_FACTORY_TASK_ID, currentBaseRevision: "a".repeat(40) })
    ).rejects.toThrow();

    const inactive = admissionContext("allow", undefined, "planned", "R1", false);
    await expect(inactive.service.admit({ taskId: TEST_FACTORY_TASK_ID })).rejects.toThrow(
      "active conversation"
    );
    expect(inactive.revisionRoots).toEqual([]);

    const elevated = admissionContext("allow", undefined, "planned", "R2");
    await expect(elevated.service.admit({ taskId: TEST_FACTORY_TASK_ID })).rejects.toThrow(
      "admits R1 tasks only"
    );
    expect(elevated.revisionRoots).toEqual([]);

    const elevatedQueued = admissionContext("allow", undefined, "queued", "R2");
    await expect(elevatedQueued.service.admit({ taskId: TEST_FACTORY_TASK_ID })).rejects.toThrow(
      "admits R1 tasks only"
    );
  });
});

function admissionContext(
  outcome: FactoryPolicyDecision["outcome"],
  currentRevision = "a".repeat(40),
  state: "planned" | "queued" = "planned",
  riskTier: FactoryRiskTier = "R1",
  active = true
) {
  const documents = new NodeFactoryDocumentCodec();
  const contractDocument = documents.taskContract({ ...testFactoryContract(), riskTier });
  const plannedEvent = documents.taskEvent(
    testTaskEvent({
      contractDigest: contractDocument.digest,
      eventId: "00000000-0000-4000-8000-000000000004",
      sequence: 4,
      previousEventDigest: testDigest("3"),
      from: "specified",
      to: "planned"
    })
  );
  const planned: FactoryTaskSnapshot = {
    contract: contractDocument.value,
    contractDigest: contractDocument.digest,
    state: "planned",
    sequence: 4,
    lastEvent: plannedEvent.value,
    lastEventDigest: plannedEvent.digest
  };
  const queuedEvent = documents.taskEvent(
    testTaskEvent({
      contractDigest: contractDocument.digest,
      eventId: "00000000-0000-4000-8000-000000000005",
      sequence: 5,
      previousEventDigest: plannedEvent.digest,
      from: "planned",
      to: "queued"
    })
  );
  const queued: FactoryTaskSnapshot = {
    ...planned,
    state: "queued",
    sequence: 5,
    lastEvent: queuedEvent.value,
    lastEventDigest: queuedEvent.digest
  };
  const evidenceDocument = documents.evidenceBundle(
    testEvidenceBundle({
      contractDigest: contractDocument.digest,
      bundleId: "00000000-0000-4000-8000-000000000006",
      sequence: 2,
      previousBundleDigest: testDigest("4")
    })
  );
  const decision: FactoryPolicyDecision = {
    outcome,
    effectiveRiskTier: riskTier,
    profileId: "baseline/r1",
    reasonCodes: outcome === "deny" ? ["base-revision-mismatch"] : [],
    requiredGateIds: ["contract-validation", "scope-validation", "policy-validation"],
    requiredEvidence: ["contract", "policy"],
    requiredHumanApprovals: 0,
    satisfiedHumanApprovals: 0
  };
  const evaluations: FactoryPolicyCheckInput[] = [];
  const transitions: unknown[] = [];
  const revisionRoots: string[] = [];
  const current = state === "queued" ? queued : planned;
  const service = new FactoryExecutionAdmissionService({
    tasks: { findById: () => Promise.resolve(current) },
    conversations: {
      findById: () =>
        Promise.resolve(
          storedConversationSchema.parse({
            id: TEST_FACTORY_CONVERSATION_ID,
            title: "Factory execution admission",
            workspacePath: "/work/agentlab",
            provider: "codex",
            model: null,
            reasoning: null,
            captainSessionName: buildCaptainSessionName(TEST_FACTORY_CONVERSATION_ID, "codex"),
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
            lifecycleState: active ? "active" : "deleting",
            ownershipMode: "legacy-name",
            ownershipNonce: null
          })
        )
    },
    revisions: {
      currentRevision(root) {
        revisionRoots.push(root);
        return Promise.resolve(currentRevision);
      }
    },
    controlPlane: {
      evaluatePolicy(input) {
        evaluations.push(input as FactoryPolicyCheckInput);
        return Promise.resolve({
          decision,
          evidence: { bundle: evidenceDocument.value, digest: evidenceDocument.digest }
        });
      },
      transition(input) {
        transitions.push(input);
        return Promise.resolve(queued);
      }
    }
  });
  return {
    service,
    planned,
    evaluations,
    transitions,
    revisionRoots,
    policyEvidenceDigest: evidenceDocument.digest
  };
}
