import {
  factoryPlanOutputSchema,
  factoryQualificationOutputSchema,
  factorySpecificationOutputSchema,
  factoryTimestampSchema,
  type FactoryActor,
  type FactoryArtifactReference,
  type FactoryPlan,
  type FactoryPreparationEvent,
  type FactoryPreparationPhase,
  type FactoryPreparationRunRequest,
  type FactoryQualification,
  type FactorySpecification
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryAgentExecutionOutput } from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { factoryUsageFits } from "../domain/factory-authority-limits.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryPreparationSnapshot } from "../domain/factory-preparation-repository.js";
import {
  preparationCompletionEventBase,
  preparationPhaseStates,
  preparationProfile
} from "./factory-preparation-coordinates.js";

const maximumPreparationArtifactBytes = 2 * 1_024 * 1_024;

export interface CapturedPreparationRun {
  readonly event: CanonicalFactoryDocument<FactoryPreparationEvent>;
  readonly exhausted: boolean;
  readonly phase: FactoryPreparationPhase;
}

export interface FactoryPreparationRunRecorderDependencies {
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly createId: () => string;
  readonly controlPlaneActor: FactoryActor;
}

/** Captures provider output and converts it into one immutable run record and phase event. */
export class FactoryPreparationRunRecorder {
  public constructor(private readonly dependencies: FactoryPreparationRunRecorderDependencies) {}

  public async capture(input: {
    readonly running: FactoryPreparationSnapshot;
    readonly started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>;
    readonly request: CanonicalFactoryDocument<FactoryPreparationRunRequest>;
    readonly output: FactoryAgentExecutionOutput;
    readonly correlationId: string;
  }): Promise<CapturedPreparationRun> {
    const { running, started, request, output, correlationId } = input;
    const stdoutArtifact = await this.#putText(output.stdout, "text/plain; charset=utf-8");
    const stderrArtifact = await this.#putText(output.stderr, "text/plain; charset=utf-8");
    const finalOutputArtifact =
      output.finalOutput === null
        ? null
        : await this.#putText(output.finalOutput, "application/json; charset=utf-8");

    let failureCode =
      output.status === "succeeded" ? null : (output.errorCode ?? "preparation-run-failed");
    if (!output.usageComplete) failureCode = "usage-incomplete";
    if (!factoryUsageFits(output.usage, request.value.budget)) {
      failureCode = "preparation-budget-exceeded";
    }
    if (output.status === "succeeded" && output.providerSessionId === null) {
      failureCode = "provider-session-missing";
    }

    let phaseDocument: PreparedPhaseDocument | null = null;
    if (failureCode === null && output.finalOutput !== null) {
      try {
        phaseDocument = this.#phaseDocument(
          running,
          request.value.phase,
          output.finalOutput,
          output.finishedAt
        );
      } catch {
        failureCode = "provider-output-invalid";
      }
    } else {
      failureCode ??= "provider-output-missing";
    }
    const outputArtifact =
      phaseDocument === null
        ? null
        : await this.#putCanonical(
            phaseDocument.document.json,
            phaseDocument.document.digest,
            phaseOutputMediaType(phaseDocument.phase)
          );
    const successful = failureCode === null && phaseDocument !== null && outputArtifact !== null;
    const record = this.dependencies.documents.preparationRunRecord({
      schemaVersion: "agentlab.preparation-run-record.v1",
      executionId: request.value.executionId,
      taskId: request.value.taskId,
      requestDigest: request.value.requestDigest,
      authorityDigest: request.value.authorityDigest,
      phase: request.value.phase,
      attempt: request.value.attempt,
      provider: request.value.provider,
      providerVersion: output.providerVersion,
      harnessVersion: output.harnessVersion,
      model: request.value.model,
      reasoning: request.value.reasoning,
      providerSessionId: output.providerSessionId,
      status: successful ? "succeeded" : normalizedFailureStatus(output),
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      exitCode: successful ? 0 : output.exitCode,
      stdoutArtifact,
      stderrArtifact,
      finalOutputArtifact,
      outputDocumentArtifact: outputArtifact,
      usage: output.usage,
      usageComplete: output.usageComplete,
      errorCode: successful ? null : (failureCode ?? "preparation-run-failed"),
      isolation: output.isolation
    });
    const runRecordArtifact = await this.#putCanonical(
      record.json,
      record.digest,
      "application/vnd.agentlab.preparation-run-record+json;version=1"
    );
    if (failureCode !== null || phaseDocument === null || outputArtifact === null) {
      return {
        event: this.dependencies.documents.preparationEvent({
          ...preparationCompletionEventBase(running, started, output.finishedAt, correlationId),
          eventId: this.#id(),
          kind: "phase-failed",
          from: preparationPhaseStates(request.value.phase).running,
          to: preparationPhaseStates(request.value.phase).stable,
          runRecordArtifact,
          errorCode: failureCode ?? "preparation-run-failed",
          actor: this.dependencies.controlPlaneActor
        }),
        exhausted: request.value.attempt >= running.authority.maximumPreparationAttempts,
        phase: request.value.phase
      };
    }
    const actor = phaseActor(
      request.value.phase,
      preparationProfile(running, request.value.phase).id,
      output.providerSessionId
    );
    const disposition =
      phaseDocument.phase === "qualify" ? phaseDocument.document.value.disposition : null;
    const kind =
      disposition === "needs-human"
        ? "needs-human"
        : disposition === "rejected"
          ? "rejected"
          : "phase-succeeded";
    return {
      event: this.dependencies.documents.preparationEvent({
        ...preparationCompletionEventBase(running, started, output.finishedAt, correlationId),
        eventId: this.#id(),
        kind,
        from: preparationPhaseStates(request.value.phase).running,
        to:
          kind === "needs-human" || kind === "rejected"
            ? kind
            : preparationPhaseStates(request.value.phase).complete,
        runRecordArtifact,
        outputArtifact,
        actor
      }),
      exhausted: false,
      phase: request.value.phase
    };
  }

  #phaseDocument(
    snapshot: FactoryPreparationSnapshot,
    phase: FactoryPreparationPhase,
    finalOutput: string,
    createdAtInput: string
  ): PreparedPhaseDocument {
    const createdAt = factoryTimestampSchema.parse(createdAtInput);
    const payload = parseJson(finalOutput, "preparation agent output");
    if (phase === "qualify") {
      const output = factoryQualificationOutputSchema.parse(payload);
      return {
        phase,
        document: this.dependencies.documents.qualification({
          schemaVersion: "agentlab.qualification.v1",
          taskId: snapshot.request.taskId,
          requestDigest: snapshot.requestDigest,
          createdAt,
          disposition: output.disposition,
          objective: output.objective,
          assumptions: output.assumptions,
          openQuestions: output.openQuestions,
          rejectionReason: output.rejectionReason
        })
      };
    }
    const qualification = latestOutputDigest(snapshot, "qualify");
    if (phase === "specify") {
      const output = factorySpecificationOutputSchema.parse(payload);
      return {
        phase,
        document: this.dependencies.documents.specification({
          schemaVersion: "agentlab.specification.v1",
          taskId: snapshot.request.taskId,
          requestDigest: snapshot.requestDigest,
          qualificationDigest: qualification,
          createdAt,
          objective: output.objective,
          acceptanceCriteria: output.acceptanceCriteria,
          nonGoals: output.nonGoals,
          scope: output.scope
        })
      };
    }
    const specification = latestOutputDigest(snapshot, "specify");
    const output = factoryPlanOutputSchema.parse(payload);
    return {
      phase,
      document: this.dependencies.documents.plan({
        schemaVersion: "agentlab.plan.v1",
        taskId: snapshot.request.taskId,
        requestDigest: snapshot.requestDigest,
        qualificationDigest: qualification,
        specificationDigest: specification,
        createdAt,
        proposedRiskTier: output.proposedRiskTier,
        selectedSkillIds: output.selectedSkillIds,
        selectedWorkerProfileIds: output.selectedWorkerProfileIds,
        capabilities: output.capabilities,
        budget: output.budget,
        requiredEvidence: output.requiredEvidence
      })
    };
  }

  async #putText(content: string, mediaType: string): Promise<FactoryArtifactReference> {
    const stored = await this.dependencies.artifacts.putText(content);
    return { digest: stored.digest, mediaType, sizeBytes: stored.sizeBytes };
  }

  async #putCanonical(
    json: string,
    expectedDigest: string,
    mediaType: string
  ): Promise<FactoryArtifactReference> {
    const artifact = await this.#putText(json, mediaType);
    if (artifact.digest !== expectedDigest) {
      throw new Error("Canonical preparation artifact digest changed during publication.");
    }
    return artifact;
  }

  #id(): string {
    return z.uuid().parse(this.dependencies.createId());
  }
}

type PreparedPhaseDocument =
  | { readonly phase: "qualify"; readonly document: CanonicalFactoryDocument<FactoryQualification> }
  | { readonly phase: "specify"; readonly document: CanonicalFactoryDocument<FactorySpecification> }
  | { readonly phase: "plan"; readonly document: CanonicalFactoryDocument<FactoryPlan> };

function phaseOutputMediaType(phase: FactoryPreparationPhase): string {
  if (phase === "qualify") return "application/vnd.agentlab.qualification+json;version=1";
  if (phase === "specify") return "application/vnd.agentlab.specification+json;version=1";
  return "application/vnd.agentlab.plan+json;version=1";
}

function latestOutputDigest(snapshot: FactoryPreparationSnapshot, phase: FactoryPreparationPhase) {
  if (
    snapshot.lastEvent.kind === "phase-started" &&
    snapshot.lastEvent.phase !== phase &&
    snapshot.lastEvent.inputArtifactDigests.length > 1
  ) {
    const digest =
      phase === "qualify"
        ? snapshot.lastEvent.inputArtifactDigests[1]
        : snapshot.lastEvent.inputArtifactDigests[2];
    if (digest !== undefined) return digest;
  }
  throw new Error(`Preparation run has no exact ${phase} digest.`);
}

function phaseActor(
  phase: FactoryPreparationPhase,
  id: string,
  sessionId: string | null
): FactoryActor {
  if (sessionId === null) throw new Error("Preparation completion requires a provider session ID.");
  return {
    kind: "agent",
    role: phase === "qualify" ? "qualifier" : phase === "specify" ? "specifier" : "planner",
    id,
    sessionId
  };
}

function normalizedFailureStatus(output: FactoryAgentExecutionOutput) {
  return output.status === "succeeded" ? "failed" : output.status;
}

function parseJson(value: string, label: string): unknown {
  if (new TextEncoder().encode(value).byteLength > maximumPreparationArtifactBytes) {
    throw new Error(`${label} exceeds the preparation artifact limit.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}
