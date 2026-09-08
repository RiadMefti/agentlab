import { randomUUID } from "node:crypto";

import type { FactoryExecutionEvent, FactoryTaskState, TaskEvent } from "@agentlab/contracts";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest, testEvidenceBundle, testFactoryContract } from "./factory.js";

/** Trusted fixture state, not an assertion that policy gates or model execution actually ran. */
export function ledgerArtifactSeed(now: string) {
  const codec = new NodeFactoryDocumentCodec();
  const contract = codec.taskContract({
    ...testFactoryContract(),
    taskId: randomUUID(),
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString()
  });
  const actor = {
    kind: "control-plane",
    role: "policy-engine",
    id: "ledger-fixture",
    sessionId: null
  } as const;
  const taskEvents: TaskEvent[] = [];
  let previous: ReturnType<NodeFactoryDocumentCodec["taskEvent"]> | null = null;
  for (const state of [
    "intake",
    "qualified",
    "specified",
    "planned",
    "queued",
    "executing"
  ] satisfies FactoryTaskState[]) {
    const event = codec.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: randomUUID(),
      taskId: contract.value.taskId,
      contractDigest: contract.digest,
      sequence: taskEvents.length + 1,
      previousEventDigest: previous?.digest ?? null,
      from: previous?.value.to ?? null,
      to: state,
      actor,
      occurredAt: now,
      reasonCode: "trusted-fixture",
      summary: null,
      evidenceBundleDigest: null,
      correlationId: randomUUID()
    });
    taskEvents.push(event.value);
    previous = event;
  }
  const evidence = {
    ...testEvidenceBundle({
      bundleId: randomUUID(),
      contractDigest: contract.digest,
      sequence: 1,
      previousBundleDigest: null
    }),
    taskId: contract.value.taskId,
    createdAt: now
  };
  const run = codec.executionRun({
    schemaVersion: "agentlab.execution-run.v1",
    runId: randomUUID(),
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    repository: contract.value.repository,
    maximumAttempts: contract.value.budget.maxRepairAttempts + 1,
    createdAt: now,
    correlationId: randomUUID()
  });
  const executionEvents: FactoryExecutionEvent[] = [];
  let previousExecution: ReturnType<NodeFactoryDocumentCodec["executionEvent"]> | null = null;
  const workspaceId = randomUUID();
  for (const fields of [
    { kind: "registered", from: null, to: "ready" },
    { kind: "attempt-started", from: "ready", to: "workspace-active", attempt: 1, workspaceId },
    {
      kind: "operation-started",
      from: "workspace-active",
      to: "operation-active",
      attempt: 1,
      workspaceId,
      operationKind: "agent",
      operationId: randomUUID(),
      role: "implementer",
      gateId: null,
      requestDigest: testDigest("f")
    }
  ]) {
    const event = codec.executionEvent({
      schemaVersion: "agentlab.execution-event.v1",
      eventId: randomUUID(),
      runId: run.value.runId,
      runDigest: run.digest,
      taskId: contract.value.taskId,
      contractDigest: contract.digest,
      sequence: executionEvents.length + 1,
      previousEventDigest: previousExecution?.digest ?? null,
      actor,
      occurredAt: now,
      reasonCode: "trusted-fixture",
      summary: null,
      correlationId: run.value.correlationId,
      ...fields
    });
    executionEvents.push(event.value);
    previousExecution = event;
  }
  return {
    contract: contract.value,
    taskEvents,
    evidence,
    executionRun: run.value,
    executionEvents
  };
}
