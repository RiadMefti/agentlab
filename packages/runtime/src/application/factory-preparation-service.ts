import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryActor,
  type FactoryArtifactReference,
  type FactoryPreparationEvent,
  type FactoryQualification,
  type FactorySpecification
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import {
  factoryProcessCleanupUnconfirmedErrorCode,
  type FactoryAgentProviderResolver,
  type FactoryPreparationAgentExecutor
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryPolicyEngine } from "../domain/factory-policy.js";
import type { FactoryPreparationRecoveryReconciler } from "../domain/factory-preparation-recovery.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import {
  isFactoryPreparationActiveState,
  isFactoryPreparationRunningState
} from "../domain/factory-preparation-state.js";
import {
  resolveFactoryPreparationSkill,
  type FactorySkillSource
} from "../domain/factory-skill.js";
import type { FactoryWorkspace, FactoryWorkspaceManager } from "../domain/factory-workspace.js";
import { renderFactoryPreparationPrompt } from "./factory-preparation-prompt-renderer.js";
import {
  nextPreparationPhase,
  preparationCompletionEventBase,
  preparationPhaseAttempt,
  preparationPhaseStates,
  preparationPredecessorDigests,
  preparationProfile,
  requirePreparationStart,
  successfulPreparationOutput
} from "./factory-preparation-coordinates.js";
import {
  FactoryPreparationRunRecorder,
  type CapturedPreparationRun
} from "./factory-preparation-run-recorder.js";

const preparationCommandSchema = z
  .object({
    taskId: z.uuid(),
    correlationId: z.uuid()
  })
  .strict();

const maximumPreparationArtifactBytes = 2 * 1_024 * 1_024;
const utf8Encoder = new TextEncoder();

export interface FactoryPreparationServiceDependencies {
  readonly preparations: Pick<FactoryPreparationRepository, "findById" | "listEvents" | "append">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryWorkspaceManager;
  readonly agents: FactoryPreparationAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly recovery: FactoryPreparationRecoveryReconciler;
  readonly now: () => string;
  readonly createId: () => string;
  readonly controlPlaneActorId: string;
}

/** Advances one crash-durable qualify/specify/plan checkpoint at a time. */
export class FactoryPreparationService {
  readonly #controlPlaneActor: FactoryActor;
  readonly #runRecorder: FactoryPreparationRunRecorder;

  public constructor(private readonly dependencies: FactoryPreparationServiceDependencies) {
    this.#controlPlaneActor = {
      kind: "control-plane",
      role: "policy-engine",
      id: factoryIdentifierSchema.parse(dependencies.controlPlaneActorId),
      sessionId: null
    };
    this.#runRecorder = new FactoryPreparationRunRecorder({
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      createId: dependencies.createId,
      controlPlaneActor: this.#controlPlaneActor
    });
  }

  public async advance(input: unknown): Promise<FactoryPreparationSnapshot> {
    const command = preparationCommandSchema.parse(input);
    const snapshot = await this.#requirePreparation(command.taskId);
    if (!isFactoryPreparationActiveState(snapshot.state)) return snapshot;
    if (isFactoryPreparationRunningState(snapshot.state)) {
      throw new Error("Preparation has an in-flight run that requires recovery reconciliation.");
    }
    const now = this.#timestamp();
    if (now >= snapshot.authority.expiresAt) {
      return this.#appendTerminal(
        snapshot,
        "expired",
        "preparation-authority-expired",
        command,
        now
      );
    }
    if (snapshot.state === "planned") return snapshot;

    const phase = nextPreparationPhase(snapshot.state);
    const history = await this.dependencies.preparations.listEvents(snapshot.request.taskId);
    const attempt = preparationPhaseAttempt(history, phase) + 1;
    if (attempt > snapshot.authority.maximumPreparationAttempts) {
      return this.#appendTerminal(snapshot, "failed", `${phase}-attempts-exhausted`, command, now);
    }
    const profile = preparationProfile(snapshot, phase);
    const capability = this.dependencies.agents
      .capabilities()
      .find(({ provider }) => provider === profile.provider);
    if (
      !capability?.preparationPhases.includes(phase) ||
      (profile.capabilities.commandAllowlist.length > 0 && !capability.acceptsCommandAllowlist)
    ) {
      throw new Error(`Pinned provider cannot safely execute preparation phase ${phase}.`);
    }
    const conversation = await this.dependencies.conversations.findById(
      snapshot.request.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) {
      throw new Error("Factory preparation requires its active owning conversation.");
    }
    const provider = await this.dependencies.providers.resolve(profile.provider, repositoryRoot);
    if (provider === null) throw new Error(`Pinned provider ${profile.provider} is unavailable.`);
    const skill = await resolveFactoryPreparationSkill(
      this.dependencies.skills,
      snapshot.authority,
      phase
    );
    const predecessors = await this.#predecessors(history);
    const prompt = renderFactoryPreparationPrompt({
      phase,
      attempt,
      request: snapshot.request,
      requestDigest: snapshot.requestDigest,
      authority: snapshot.authority,
      authorityDigest: snapshot.authorityDigest,
      qualification: predecessors.qualification?.value ?? null,
      specification: predecessors.specification?.value ?? null,
      skill
    });
    const promptArtifact = await this.#putText(prompt, "text/plain; charset=utf-8");
    const executionId = z.uuid().parse(this.dependencies.createId());
    const outputSchemaDigest = skill.manifest.outputSchemaDigest;
    if (outputSchemaDigest === null) {
      throw new Error(`Preparation skill ${skill.manifest.id} has no output schema digest.`);
    }
    const inputArtifactDigests = preparationPredecessorDigests(
      snapshot.requestDigest,
      predecessors.qualification,
      predecessors.specification,
      phase
    );
    const runRequest = this.dependencies.documents.preparationRunRequest({
      schemaVersion: "agentlab.preparation-run-request.v1",
      executionId,
      taskId: snapshot.request.taskId,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      phase,
      attempt,
      provider: profile.provider,
      model: profile.model,
      reasoning: profile.reasoning,
      repository: snapshot.request.repository,
      skillId: skill.manifest.id,
      skillPackageDigest: skill.packageDigest,
      promptArtifact,
      inputArtifactDigests,
      outputSchemaDigest,
      capabilities: profile.capabilities,
      budget: profile.budget
    });
    await this.#putCanonical(runRequest.json, runRequest.digest, preparationRunRequestMediaType);
    const started = this.dependencies.documents.preparationEvent({
      schemaVersion: "agentlab.preparation-event.v1",
      eventId: z.uuid().parse(this.dependencies.createId()),
      taskId: snapshot.request.taskId,
      sequence: snapshot.sequence + 1,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      previousEventDigest: snapshot.lastEventDigest,
      kind: "phase-started",
      phase,
      attempt,
      executionId,
      runRequestDigest: runRequest.digest,
      from: preparationPhaseStates(phase).stable,
      to: preparationPhaseStates(phase).running,
      skillId: skill.manifest.id,
      skillPackageDigest: skill.packageDigest,
      workerProfileId: profile.id,
      inputArtifactDigests,
      actor: this.#controlPlaneActor,
      occurredAt: now,
      reasonCode: `${phase}-started`,
      summary: null,
      correlationId: command.correlationId
    });
    const running = await this.dependencies.preparations.append(started);
    if (running === null) throw new Error("Preparation phase lost its append race.");
    const startedEvent = requirePreparationStart(started.value);

    let workspace: FactoryWorkspace | null = null;
    let cleanupState: PreparationRunCleanupState = "unconfirmed";
    try {
      workspace = await this.dependencies.workspaces.create({
        taskId: snapshot.request.taskId,
        attempt,
        repositoryRoot,
        baseRevision: snapshot.request.repository.baseRevision,
        workspaceId: executionId
      });
      cleanupState = "workspace-owned";
      const output = await this.dependencies.agents.execute({
        request: runRequest.value,
        executable: provider.executable,
        providerVersion: provider.version,
        workspace,
        prompt,
        resourceLimits: this.dependencies.policy.requirements("R0", "execution").resourceLimits
      });
      if (output.errorCode === factoryProcessCleanupUnconfirmedErrorCode) {
        cleanupState = "unconfirmed";
        throw new Error("Preparation process cleanup was not confirmed.");
      }
      const result = await this.#runRecorder.capture({
        running,
        started: startedEvent,
        request: runRequest,
        output,
        correlationId: command.correlationId
      });
      await workspace.closeAndWait();
      workspace = null;
      cleanupState = "confirmed";
      return await this.#appendRunResult(running, result);
    } catch (error: unknown) {
      if (cleanupState !== "confirmed") {
        if (cleanupState === "unconfirmed" || workspace === null) throw error;
        try {
          await workspace.closeAndWait();
          workspace = null;
          cleanupState = "confirmed";
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "Preparation run failed and workspace cleanup was not confirmed.",
            { cause: error }
          );
        }
      }
      const current = await this.#requirePreparation(snapshot.request.taskId);
      if (current.lastEventDigest === started.digest) {
        try {
          await this.#reconcileStoppedRun(current, startedEvent, command);
        } catch (recoveryError: unknown) {
          throw new AggregateError(
            [error, recoveryError],
            "Preparation run and durable recovery both failed.",
            { cause: error }
          );
        }
      }
      throw error;
    }
  }

  public async recover(input: unknown): Promise<FactoryPreparationSnapshot> {
    const command = preparationCommandSchema.parse(input);
    const snapshot = await this.#requirePreparation(command.taskId);
    if (!isFactoryPreparationRunningState(snapshot.state)) return snapshot;
    const started = snapshot.lastEvent;
    if (started.kind !== "phase-started") {
      throw new Error("Running preparation does not end in a phase-started event.");
    }
    const conversation = await this.dependencies.conversations.findById(
      snapshot.request.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) {
      throw new Error("Factory preparation recovery requires its active owning conversation.");
    }
    const recovery = await this.dependencies.recovery.reconcile({
      taskId: started.taskId,
      executionId: started.executionId,
      phase: started.phase,
      attempt: started.attempt,
      repositoryRoot,
      baseRevision: snapshot.request.repository.baseRevision
    });
    if (recovery.status !== "inactive") {
      throw new Error(`Preparation recovery is uncertain: ${recovery.reasonCode}.`);
    }
    return this.#reconcileStoppedRun(snapshot, started, command);
  }

  async #appendRunResult(
    running: FactoryPreparationSnapshot,
    result: CapturedPreparationRun
  ): Promise<FactoryPreparationSnapshot> {
    const completed = await this.dependencies.preparations.append(result.event);
    if (completed === null) throw new Error("Preparation result lost its append race.");
    if (!result.exhausted) return completed;
    const occurredAt = this.#timestamp();
    const expired = occurredAt >= completed.authority.expiresAt;
    return this.#appendTerminal(
      completed,
      expired ? "expired" : "failed",
      expired ? "preparation-authority-expired" : `${result.phase}-attempts-exhausted`,
      {
        taskId: completed.request.taskId,
        correlationId: result.event.value.correlationId
      },
      occurredAt
    );
  }

  async #predecessors(
    history: readonly FactoryPreparationEvent[]
  ): Promise<PreparationPredecessors> {
    const qualificationReference = successfulPreparationOutput(history, "qualify");
    const specificationReference = successfulPreparationOutput(history, "specify");
    return {
      qualification:
        qualificationReference === null
          ? null
          : await this.#readCanonical(
              qualificationReference,
              "qualification",
              this.dependencies.documents.qualification.bind(this.dependencies.documents)
            ),
      specification:
        specificationReference === null
          ? null
          : await this.#readCanonical(
              specificationReference,
              "specification",
              this.dependencies.documents.specification.bind(this.dependencies.documents)
            )
    };
  }

  async #readCanonical<Value>(
    artifact: FactoryArtifactReference,
    label: string,
    decode: (input: unknown) => CanonicalFactoryDocument<Value>
  ): Promise<CanonicalFactoryDocument<Value>> {
    const json = await this.dependencies.artifacts.readText(
      artifact.digest,
      maximumPreparationArtifactBytes
    );
    const document = decode(parseJson(json, label));
    if (
      document.digest !== artifact.digest ||
      document.json !== json ||
      utf8Encoder.encode(json).byteLength !== artifact.sizeBytes
    ) {
      throw new Error(`Stored ${label} does not match its journal artifact reference.`);
    }
    return document;
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

  #abandonedEvent(
    snapshot: FactoryPreparationSnapshot,
    started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>,
    correlationId: string,
    occurredAt: string
  ) {
    return this.dependencies.documents.preparationEvent({
      ...preparationCompletionEventBase(snapshot, started, occurredAt, correlationId),
      eventId: z.uuid().parse(this.dependencies.createId()),
      kind: "phase-abandoned",
      from: preparationPhaseStates(started.phase).running,
      to: preparationPhaseStates(started.phase).stable,
      actor: this.#controlPlaneActor
    });
  }

  async #reconcileStoppedRun(
    snapshot: FactoryPreparationSnapshot,
    started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>,
    command: z.infer<typeof preparationCommandSchema>
  ): Promise<FactoryPreparationSnapshot> {
    const occurredAt = this.#timestamp();
    if (occurredAt >= snapshot.authority.expiresAt) {
      return this.#appendTerminal(
        snapshot,
        "expired",
        "preparation-authority-expired",
        command,
        occurredAt
      );
    }
    const abandoned = this.#abandonedEvent(snapshot, started, command.correlationId, occurredAt);
    const recovered = await this.dependencies.preparations.append(abandoned);
    if (recovered === null) throw new Error("Preparation recovery lost its append race.");
    return recovered;
  }

  async #appendTerminal(
    snapshot: FactoryPreparationSnapshot,
    kind: "failed" | "expired",
    reasonCode: string,
    command: z.infer<typeof preparationCommandSchema>,
    occurredAt = this.#timestamp()
  ): Promise<FactoryPreparationSnapshot> {
    const event = this.dependencies.documents.preparationEvent({
      schemaVersion: "agentlab.preparation-event.v1",
      eventId: z.uuid().parse(this.dependencies.createId()),
      taskId: snapshot.request.taskId,
      sequence: snapshot.sequence + 1,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      previousEventDigest: snapshot.lastEventDigest,
      kind,
      from: snapshot.state,
      to: kind,
      ...(kind === "failed" ? { errorCode: reasonCode } : {}),
      actor: this.#controlPlaneActor,
      occurredAt,
      reasonCode,
      summary: null,
      correlationId: command.correlationId
    });
    const appended = await this.dependencies.preparations.append(event);
    if (appended === null) throw new Error("Preparation terminal transition lost its append race.");
    return appended;
  }

  async #requirePreparation(taskId: string): Promise<FactoryPreparationSnapshot> {
    const snapshot = await this.dependencies.preparations.findById(taskId);
    if (snapshot === null) throw new Error(`Factory preparation ${taskId} does not exist.`);
    return snapshot;
  }

  #timestamp(): string {
    return factoryTimestampSchema.parse(this.dependencies.now());
  }
}

interface PreparationPredecessors {
  readonly qualification: CanonicalFactoryDocument<FactoryQualification> | null;
  readonly specification: CanonicalFactoryDocument<FactorySpecification> | null;
}

type PreparationRunCleanupState = "unconfirmed" | "workspace-owned" | "confirmed";

const preparationRunRequestMediaType =
  "application/vnd.agentlab.preparation-run-request+json;version=1";

function parseJson(value: string, label: string): unknown {
  if (utf8Encoder.encode(value).byteLength > maximumPreparationArtifactBytes) {
    throw new Error(`${label} exceeds the preparation artifact limit.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}
