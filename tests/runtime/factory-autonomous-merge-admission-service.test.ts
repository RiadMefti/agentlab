import type {
  FactoryCostPolicy,
  FactoryRoleIdentityPolicy,
  ImmutableTaskContract
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryAutonomousMergeAdmissionService } from "../../packages/runtime/src/application/factory-autonomous-merge-admission-service.js";
import { createFactoryEvidenceCredential } from "../../packages/runtime/src/application/factory-evidence-ingress.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import {
  createAutonomousR1FactoryPolicyBundle,
  type FactoryPolicyBundleV3
} from "../../packages/runtime/src/domain/factory-policy.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryAutonomousMergePolicy } from "../helpers/factory-autonomous-merge.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryActor,
  testFactoryContract
} from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryAutonomousMergeAdmissionService", () => {
  it("is credentialless and reports every independent authority switch", async () => {
    const fixture = serviceFixture({ scheduler: true, prBroker: true, mergeBroker: true });

    await expect(fixture.service.preflight()).resolves.toMatchObject({
      status: "ready",
      credentialless: true,
      remoteWrite: false,
      directMerge: false,
      release: false,
      reasonCodes: []
    });
  });

  it("preserves human merge as the default immutable task contract", async () => {
    const fixture = serviceFixture({ scheduler: true, prBroker: true, mergeBroker: true });

    await expect(fixture.service.admit(fixture.command)).resolves.toEqual({
      status: "denied",
      reasonCodes: ["immutable-contract-requires-human-merge"]
    });
    expect(fixture.dispatches).not.toHaveBeenCalled();
    expect(fixture.evaluatePolicy).not.toHaveBeenCalled();
  });

  it("rejects drift in any reviewed command pin before reading task state", async () => {
    const fixture = serviceFixture({ scheduler: true, prBroker: true, mergeBroker: true });

    await expect(
      fixture.service.admit({
        ...fixture.command,
        expectedFactoryPolicyBundleDigest: testDigest("f")
      })
    ).rejects.toThrow(/changed after operator review/u);
    expect(fixture.findTask).not.toHaveBeenCalled();
  });

  it("keeps the bounded admission projector dormant until every switch is enabled", async () => {
    const blocked = serviceFixture({ scheduler: true, prBroker: true, mergeBroker: false });
    const pins = {
      expectedMergePolicyDigest: blocked.command.expectedMergePolicyDigest,
      expectedFactoryPolicyBundleDigest: blocked.command.expectedFactoryPolicyBundleDigest,
      expectedSchedulePolicyDigest: blocked.command.expectedSchedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: blocked.command.expectedDailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: blocked.command.expectedRoleIdentityPolicyDigest
    };

    await expect(blocked.service.tick(pins)).resolves.toMatchObject({
      status: "blocked",
      inspected: 0,
      reasonCodes: ["merge-broker-disabled"]
    });
    expect(blocked.listTasks).not.toHaveBeenCalled();

    const enabled = serviceFixture({ scheduler: true, prBroker: true, mergeBroker: true });
    await expect(enabled.service.tick(pins)).resolves.toMatchObject({
      status: "idle",
      inspected: 0,
      authorized: 0,
      denied: 0,
      reasonCodes: []
    });
  });
});

function serviceFixture(authority: {
  readonly scheduler: boolean;
  readonly prBroker: boolean;
  readonly mergeBroker: boolean;
}) {
  const roleIdentityPolicy: CanonicalFactoryDocument<FactoryRoleIdentityPolicy> =
    documents.roleIdentityPolicy(
      testFactoryRoleIdentityPolicy({
        keyId: testDigest("a"),
        workerUserId: 2_003,
        attestorUserId: 2_004
      })
    );
  const mergePolicy = documents.autonomousMergePolicy(
    testFactoryAutonomousMergePolicy({ roleIdentityPolicyDigest: roleIdentityPolicy.digest })
  );
  const policyBundle: CanonicalFactoryDocument<FactoryPolicyBundleV3> = encodeCanonicalDocument(
    createAutonomousR1FactoryPolicyBundle({
      costPolicy: testCostPolicy(),
      mergePolicy
    })
  );
  const contract: CanonicalFactoryDocument<ImmutableTaskContract> = documents.taskContract({
    ...testFactoryContract(),
    repository: {
      id: mergePolicy.value.repositoryId,
      baseRevision: "a".repeat(40)
    },
    trigger: "scheduled",
    gateProfile: { ...testFactoryContract().gateProfile, policyDigest: policyBundle.digest }
  });
  const lastEvent = documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId: "65000000-0000-4000-8000-000000000005",
    taskId: TEST_FACTORY_TASK_ID,
    sequence: 10,
    contractDigest: contract.digest,
    previousEventDigest: testDigest("b"),
    from: "pr-proposed",
    to: "pr-open",
    actor: testFactoryActor,
    occurredAt: "2026-09-01T12:00:00.000Z",
    reasonCode: "draft-pr-opened",
    summary: null,
    evidenceBundleDigest: testDigest("c"),
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const task = {
    contract: contract.value,
    contractDigest: contract.digest,
    state: "pr-open" as const,
    sequence: lastEvent.value.sequence,
    lastEvent: lastEvent.value,
    lastEventDigest: lastEvent.digest
  };
  const findTask = vi.fn(() => Promise.resolve(task));
  const listTasks = vi.fn(() => Promise.resolve([]));
  const dispatches = vi.fn(() => Promise.resolve(null));
  const evaluatePolicy = vi.fn();
  const service = new FactoryAutonomousMergeAdmissionService({
    mergePolicy,
    policyBundle,
    schedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
    dailyQuotaPolicyDigest: mergePolicy.value.dailyQuotaPolicyDigest,
    roleIdentityPolicy,
    dispatches: { findByTaskId: dispatches },
    updates: { listByTaskId: () => Promise.resolve([]) },
    tasks: { findById: findTask, listByState: listTasks },
    evidence: { listEvidence: () => Promise.resolve([]) },
    controls: { state: () => Promise.resolve(authority) },
    controlPlane: {
      evaluatePolicy,
      transition: vi.fn()
    },
    canaryAuthority: { requireReservation: vi.fn() },
    evidenceIngress: {} as never,
    evidenceCredentials: { controlPlane: createFactoryEvidenceCredential() },
    artifacts: {
      put: vi.fn(),
      putText: vi.fn(),
      read: vi.fn(),
      readText: vi.fn()
    },
    documents,
    now: () => "2026-09-01T12:00:01.000Z",
    createId: () => "66000000-0000-4000-8000-000000000006"
  });
  return {
    service,
    findTask,
    listTasks,
    dispatches,
    evaluatePolicy,
    command: {
      taskId: TEST_FACTORY_TASK_ID,
      observationDigest: testDigest("d"),
      canaryReservationDigest: testDigest("e"),
      expectedMergePolicyDigest: mergePolicy.digest,
      expectedFactoryPolicyBundleDigest: policyBundle.digest,
      expectedSchedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: mergePolicy.value.dailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicy.digest
    }
  };
}

function testCostPolicy(): FactoryCostPolicy {
  return {
    schemaVersion: "agentlab.cost-policy.v1",
    id: "agentlab/test-costs",
    version: "1.0.0",
    rules: [
      {
        provider: "codex",
        model: "gpt-5.4",
        accounting: {
          mode: "token-rate",
          inputMicrousdPerMillionTokens: 1_000_000,
          outputMicrousdPerMillionTokens: 2_000_000
        }
      }
    ]
  };
}
