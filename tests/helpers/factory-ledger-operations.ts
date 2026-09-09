import { randomUUID } from "node:crypto";

import {
  factoryLedgerOperationSchema,
  factoryLedgerOperationResultSchema,
  type FactoryLedgerOperation,
  type FactoryLedgerOperationResult
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryArtifactWireCodec } from "../../packages/runtime/src/infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest } from "./factory.js";
import { ledgerArtifactSeed } from "./factory-ledger-artifacts.js";

/** Trusted queue fixture coordinates; no model or gate is claimed to have run by this seed. */
export function ledgerOperationSeed(
  now: string,
  uid = 1001,
  baseRevision?: string
): ReturnType<typeof ledgerArtifactSeed> & {
  job: CanonicalFactoryDocument<FactoryLedgerOperation>;
} {
  const seed = ledgerArtifactSeed(
    now,
    baseRevision === undefined ? undefined : { id: "agentlab", baseRevision }
  );
  const codec = new NodeFactoryDocumentCodec();
  const event = seed.executionEvents.at(-1);
  const profile = seed.contract.agentPolicy.workerProfiles.find((entry) =>
    entry.roles.includes("implementer")
  );
  if (event?.kind !== "operation-started" || profile === undefined)
    throw new Error("Missing operation fixture coordinates.");
  const prompt = "Implement only this bounded fixture.";
  const request = codec.agentRunRequest({
    schemaVersion: "agentlab.agent-run-request.v1",
    executionId: event.operationId,
    taskId: seed.contract.taskId,
    contractDigest: codec.taskContract(seed.contract).digest,
    role: "implementer",
    attempt: 1,
    provider: profile.provider,
    model: profile.model,
    reasoning: profile.reasoning,
    repository: seed.contract.repository,
    promptArtifact: {
      digest: new NodeFactoryArtifactWireCodec().digest(Buffer.from(prompt)),
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(prompt)
    },
    outputSchemaDigest: null,
    skillDigests: [testDigest("a")],
    capabilities: seed.contract.capabilities,
    budget: { ...seed.contract.budget, wallClockSeconds: 10 }
  });
  const active = codec.executionEvent({ ...event, requestDigest: request.digest });
  seed.executionEvents[seed.executionEvents.length - 1] = active.value;
  const job = encodeCanonicalDocument(
    factoryLedgerOperationSchema.parse({
      schemaVersion: "agentlab.ledger-operation.v1",
      jobId: event.operationId,
      taskId: seed.contract.taskId,
      contractDigest: request.value.contractDigest,
      expectedTaskEventDigest: codec.taskEvent(seed.taskEvents.at(-1)).digest,
      execution: {
        kind: "execution",
        runId: event.runId,
        runDigest: event.runDigest,
        eventDigest: active.digest
      },
      attempt: 1,
      logicalWorkspaceId: event.workspaceId,
      principal: { uid, id: "worker", kind: "implementer" },
      workerPolicyDigest: testDigest("a"),
      factoryPolicyDigest: seed.contract.gateProfile.policyDigest,
      repository: seed.contract.repository,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
      resourceLimits: { maxProcesses: 4, maxMemoryBytes: 134_217_728, cpuQuotaPercent: 100 },
      limits: {
        maximumChangedFiles: 5,
        maximumChangedLines: 10,
        maximumPatchBytes: 8192,
        maximumResultBytes: 16384,
        maximumRunSeconds: 10,
        cleanupReserveSeconds: 30
      },
      seedPatch: null,
      kind: "agent",
      request: request.value,
      prompt,
      providerVersion: "1.0.0"
    })
  );
  return { ...seed, job };
}

export function ledgerOperationResult(
  job: { value: FactoryLedgerOperation; digest: string },
  now: string
): CanonicalFactoryDocument<FactoryLedgerOperationResult> {
  if (job.value.kind !== "agent") throw new Error("Fixture result requires an agent job.");
  return encodeCanonicalDocument(
    factoryLedgerOperationResultSchema.parse({
      schemaVersion: "agentlab.ledger-operation-result.v1",
      jobId: job.value.jobId,
      jobDigest: job.digest,
      kind: "agent",
      workspace: "closed",
      completedAt: now,
      patch: {
        patch: "",
        changeSet: {
          baseRevision: job.value.repository.baseRevision,
          headRevision: null,
          changedPaths: [],
          binaryPaths: [],
          changedFiles: 0,
          changedLines: 0
        }
      },
      output: {
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderr: "",
        finalOutput: "Fixture only",
        providerSessionId: randomUUID(),
        providerVersion: job.value.providerVersion,
        harnessVersion: "fixture-only",
        startedAt: now,
        finishedAt: now,
        usage: {
          wallClockSeconds: 0,
          agentTurns: 1,
          toolCalls: 0,
          inputTokens: 1,
          outputTokens: 1,
          costMicrousd: 0,
          processes: 1,
          outputBytes: 12,
          workers: 1,
          repairAttempts: 0,
          changedFiles: 0,
          changedLines: 0
        },
        usageComplete: true,
        errorCode: null,
        isolation: {
          isolationId: job.value.jobId,
          mechanism: { id: "fixture-only", version: "1" },
          scopeName: `agentlab-factory-${job.value.jobId.replaceAll("-", "")}.scope`,
          limits: job.value.resourceLimits
        }
      }
    })
  );
}
