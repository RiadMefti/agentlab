import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evidenceItemSchema,
  immutableTaskContractSchema,
  type EvidenceItem,
  type ImmutableTaskContract
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { FactoryControlPlane } from "../../packages/runtime/src/application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "../../packages/runtime/src/application/factory-evidence-ingress.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import {
  defaultFactoryPolicyBundle,
  FactoryPolicyEngine
} from "../../packages/runtime/src/domain/factory-policy.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { MemoryConversationRepository } from "../helpers/fakes.js";
import {
  TEST_FACTORY_CONVERSATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryContract
} from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("FactoryControlPlane", () => {
  it("registers an active conversation task with atomic contract and policy evidence", async () => {
    const fixture = controlPlaneFixture();
    try {
      const snapshot = await fixture.controlPlane.registerTask(policyContract(), requester);

      expect(snapshot).toMatchObject({ state: "intake", sequence: 1 });
      await expect(fixture.repository.listEvidence(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(1);
      const registration = await fixture.repository.latestEvidence(TEST_FACTORY_TASK_ID);
      expect(registration?.bundle.items.map(({ kind }) => kind)).toEqual(["contract", "policy"]);
      expect(registration?.bundle.contractDigest).toBe(snapshot.contractDigest);
    } finally {
      fixture.repository.close();
    }
  });

  it("requires the latest recorded allow decision before entering a privileged state", async () => {
    const fixture = controlPlaneFixture();
    try {
      const registered = await fixture.controlPlane.registerTask(policyContract(), requester);
      let current = registered;
      for (const nextState of ["qualified", "specified", "planned"] as const) {
        current = await fixture.controlPlane.transition({
          taskId: TEST_FACTORY_TASK_ID,
          expectedState: current.state,
          nextState,
          actor: requester,
          reasonCode: "stage-complete"
        });
      }

      await expect(
        fixture.controlPlane.transition({
          taskId: TEST_FACTORY_TASK_ID,
          expectedState: "planned",
          nextState: "queued",
          actor: policyActor,
          reasonCode: "execution-authorized"
        })
      ).rejects.toThrow(/latest exact evidence/u);

      await recordPreparationGates(fixture, current.contractDigest);
      const policy = await fixture.controlPlane.evaluatePolicy({
        taskId: TEST_FACTORY_TASK_ID,
        stage: "execution",
        approvalSubjectDigest: current.contractDigest,
        currentBaseRevision: current.contract.repository.baseRevision,
        changeSet: {
          baseRevision: current.contract.repository.baseRevision,
          headRevision: null,
          changedPaths: [],
          binaryPaths: [],
          changedFiles: 0,
          changedLines: 0
        },
        usage: zeroUsage,
        usageComplete: true,
        approvals: [],
        scheduled: false
      });
      expect(policy.decision.outcome).toBe("allow");

      const queued = await fixture.controlPlane.transition({
        taskId: TEST_FACTORY_TASK_ID,
        expectedState: "planned",
        nextState: "queued",
        actor: policyActor,
        reasonCode: "execution-authorized",
        evidenceBundleDigest: policy.evidence.digest
      });
      expect(queued).toMatchObject({ state: "queued", sequence: 5 });
      expect(queued.lastEvent.evidenceBundleDigest).toBe(policy.evidence.digest);
    } finally {
      fixture.repository.close();
    }
  });

  it("keeps authority disabled and permits only a human to enable it", async () => {
    const fixture = controlPlaneFixture();
    try {
      await expect(fixture.repository.state()).resolves.toEqual({
        scheduler: false,
        prBroker: false
      });
      await expect(
        fixture.controlPlane.setAuthority({
          control: "pr-broker",
          enabled: true,
          actor: { ...policyActor, kind: "agent", role: "implementer" },
          reason: "Agent requested authority."
        })
      ).rejects.toThrow(/Only a human/u);
      await expect(
        fixture.controlPlane.setAuthority({
          control: "pr-broker",
          enabled: true,
          actor: requester,
          reason: "Enable the bounded draft-PR lane."
        })
      ).resolves.toEqual({ scheduler: false, prBroker: true });
      await expect(
        fixture.controlPlane.setAuthority({
          control: "pr-broker",
          enabled: false,
          actor: policyActor,
          reason: "Circuit breaker opened."
        })
      ).resolves.toEqual({ scheduler: false, prBroker: false });
    } finally {
      fixture.repository.close();
    }
  });

  it("rejects tasks outside an active conversation and evidence with missing artifacts", async () => {
    const fixture = controlPlaneFixture(false);
    try {
      await expect(fixture.controlPlane.registerTask(policyContract(), requester)).rejects.toThrow(
        /does not exist/u
      );
      fixture.addActiveConversation();
      const snapshot = await fixture.controlPlane.registerTask(policyContract(), requester);
      const missing = evidenceItemSchema.parse({
        id: fixture.nextId(),
        kind: "test",
        result: "pass",
        subjectDigest: snapshot.contractDigest,
        artifact: {
          digest: testDigest("f"),
          mediaType: "application/json",
          sizeBytes: 10
        },
        producer: {
          kind: "control-plane",
          role: "gate-runner",
          id: "agentlab-local-gates",
          sessionId: null
        },
        createdAt: now,
        claims: [{ name: "gate-id", value: "test" }]
      });
      await expect(
        fixture.evidenceIngress.append(fixture.controlPlaneCredential, {
          taskId: TEST_FACTORY_TASK_ID,
          contractDigest: snapshot.contractDigest,
          items: [missing]
        })
      ).rejects.toThrow(/ENOENT|does not exist|artifact/u);
      await expect(
        fixture.evidenceIngress.append(createFactoryEvidenceCredential(), {
          taskId: TEST_FACTORY_TASK_ID,
          contractDigest: snapshot.contractDigest,
          items: [missing]
        })
      ).rejects.toThrow(/not registered/u);
      const existingArtifact = await fixture.artifacts.putText("forged gate");
      await expect(
        fixture.evidenceIngress.append(fixture.controlPlaneCredential, {
          taskId: TEST_FACTORY_TASK_ID,
          contractDigest: snapshot.contractDigest,
          items: [
            evidenceItemSchema.parse({
              ...missing,
              id: fixture.nextId(),
              artifact: { ...existingArtifact, mediaType: "text/plain" },
              producer: {
                kind: "ci",
                role: "gate-runner",
                id: "agentlab-local-sandbox",
                sessionId: null
              }
            })
          ]
        })
      ).rejects.toThrow(/control-plane cannot assert/u);
      const patchArtifact = await fixture.artifacts.putText("bounded patch");
      const patchRecord = fixture.documents.patchProposal({
        schemaVersion: "agentlab.patch-proposal.v1",
        taskId: TEST_FACTORY_TASK_ID,
        contractDigest: snapshot.contractDigest,
        executionId: "77777777-7777-4777-8777-777777777777",
        baseRevision: snapshot.contract.repository.baseRevision,
        changeSet: {
          baseRevision: snapshot.contract.repository.baseRevision,
          headRevision: null,
          changedPaths: ["tests/example.test.ts"],
          binaryPaths: [],
          changedFiles: 1,
          changedLines: 1
        },
        patchArtifact: { ...patchArtifact, mediaType: "text/x-diff" },
        createdAt: now
      });
      await fixture.artifacts.putText(patchRecord.json);
      await expect(
        fixture.evidenceIngress.append(fixture.controlPlaneCredential, {
          taskId: TEST_FACTORY_TASK_ID,
          contractDigest: snapshot.contractDigest,
          items: [
            evidenceItemSchema.parse({
              id: fixture.nextId(),
              kind: "patch",
              result: "pass",
              subjectDigest: patchRecord.digest,
              artifact: {
                digest: patchRecord.digest,
                mediaType: "application/vnd.agentlab.patch-proposal.v1+json",
                sizeBytes: Buffer.byteLength(patchRecord.json)
              },
              producer: {
                kind: "control-plane",
                role: "gate-runner",
                id: "agentlab-local-gates",
                sessionId: null
              },
              createdAt: now,
              claims: [
                { name: "patch-digest", value: patchArtifact.digest },
                { name: "base-revision", value: snapshot.contract.repository.baseRevision },
                { name: "execution-id", value: "88888888-8888-4888-8888-888888888888" }
              ]
            })
          ]
        })
      ).rejects.toThrow(/does not match/u);
      await expect(fixture.repository.listEvidence(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(1);
    } finally {
      fixture.repository.close();
    }
  });
});

const now = "2026-08-30T13:00:00.000Z";
const zeroUsage = {
  wallClockSeconds: 0,
  agentTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  processes: 0,
  outputBytes: 0,
  workers: 0,
  repairAttempts: 0,
  changedFiles: 0,
  changedLines: 0
};
const requester = {
  kind: "human",
  role: "requester",
  id: "maintainer",
  sessionId: null
} as const;
const policyActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

function policyContract(): ImmutableTaskContract {
  const base = testFactoryContract();
  return immutableTaskContractSchema.parse({
    ...base,
    gateProfile: {
      id: "baseline/r1",
      version: "1.1.0",
      policyDigest: encodeCanonicalDocument(defaultFactoryPolicyBundle).digest
    }
  });
}

function controlPlaneFixture(addConversation = true) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-control-plane-"));
  temporaryRoots.push(root);
  const repository = new SqliteFactoryRepository(":memory:");
  const artifacts = new FileFactoryArtifactStore(join(root, "evidence"));
  const conversations = new MemoryConversationRepository();
  const documents = new NodeFactoryDocumentCodec();
  const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
  const controlPlaneCredential = createFactoryEvidenceCredential();
  let nextIdentifier = 100;
  const nextId = (): string =>
    `00000000-0000-4000-8000-${String(nextIdentifier++).padStart(12, "0")}`;
  const addActiveConversation = (): void => {
    if (conversations.conversations.length > 0) return;
    conversations.conversations.push(
      storedConversationSchema.parse({
        id: TEST_FACTORY_CONVERSATION_ID,
        title: "Factory project",
        workspacePath: "/work/agentlab",
        provider: "codex",
        model: null,
        reasoning: null,
        captainSessionName: buildCaptainSessionName(TEST_FACTORY_CONVERSATION_ID, "codex"),
        createdAt: "2026-08-30T12:00:00.000Z",
        updatedAt: "2026-08-30T12:00:00.000Z",
        lifecycleState: "active",
        ownershipMode: "legacy-name",
        ownershipNonce: null
      })
    );
  };
  if (addConversation) addActiveConversation();
  const evidenceIngress = new FactoryEvidenceIngress({
    tasks: repository,
    evidence: repository,
    artifacts,
    documents,
    policyBundleDigest: policyBundle.digest,
    bindings: [{ credential: controlPlaneCredential, channel: "control-plane" }],
    now: () => now,
    createId: nextId
  });
  const controlPlane = new FactoryControlPlane({
    tasks: repository,
    evidence: repository,
    controls: repository,
    conversations,
    artifacts,
    documents,
    policy: new FactoryPolicyEngine(policyBundle.digest),
    policyBundle,
    evidenceIngress,
    evidenceCredential: controlPlaneCredential,
    now: () => now,
    createId: nextId
  });
  return {
    repository,
    artifacts,
    controlPlane,
    policyBundle,
    nextId,
    addActiveConversation,
    evidenceIngress,
    controlPlaneCredential,
    documents
  };
}

async function recordPreparationGates(
  fixture: ReturnType<typeof controlPlaneFixture>,
  contractDigest: string
): Promise<void> {
  const items: EvidenceItem[] = [];
  for (const gateId of ["contract-validation", "scope-validation", "policy-validation"]) {
    const artifact = await fixture.artifacts.putText(`gate:${gateId}`);
    items.push(
      evidenceItemSchema.parse({
        id: fixture.nextId(),
        kind: "test",
        result: "pass",
        subjectDigest: contractDigest,
        artifact: {
          digest: artifact.digest,
          mediaType: "text/plain",
          sizeBytes: artifact.sizeBytes
        },
        producer: {
          kind: "control-plane",
          role: "gate-runner",
          id: "agentlab-local-gates",
          sessionId: null
        },
        createdAt: now,
        claims: [{ name: "gate-id", value: gateId }]
      })
    );
  }
  await fixture.evidenceIngress.append(fixture.controlPlaneCredential, {
    taskId: TEST_FACTORY_TASK_ID,
    contractDigest,
    items
  });
}
