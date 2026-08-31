import {
  evidenceBundleSchema,
  evidenceItemSchema,
  factoryActorSchema,
  factoryControlEventSchema,
  factoryControlNameSchema,
  factoryPolicyCheckInputSchema,
  factoryTaskStateSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceBundle,
  type FactoryActor,
  type FactoryApprovalStage,
  type FactoryControlName,
  type FactoryPolicyDecision,
  type FactoryTaskState,
  type ImmutableTaskContract,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import {
  factoryPolicyBundleMediaType,
  FactoryPolicyEngine,
  type FactoryPolicyBundle,
  type FactoryPolicyEvaluation
} from "../domain/factory-policy.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";
import {
  isFactoryTaskTransitionAllowed,
  isTerminalFactoryTaskState
} from "../domain/factory-task-state.js";
import type {
  FactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./factory-evidence-ingress.js";

const transitionInputSchema = z
  .object({
    taskId: z.uuid(),
    expectedState: factoryTaskStateSchema,
    nextState: factoryTaskStateSchema,
    actor: factoryActorSchema,
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._/-]*$/u),
    summary: z.string().trim().min(1).max(500).nullable().optional(),
    evidenceBundleDigest: sha256DigestSchema.nullable().optional()
  })
  .strict();

const controlChangeInputSchema = z
  .object({
    control: factoryControlNameSchema,
    enabled: z.boolean(),
    actor: factoryActorSchema,
    reason: z.string().trim().min(1).max(500)
  })
  .strict();

export interface FactoryControlPlaneDependencies {
  readonly tasks: FactoryTaskRepository;
  readonly evidence: FactoryEvidenceRepository;
  readonly controls: FactoryControlRepository;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly policyBundle: CanonicalFactoryDocument<FactoryPolicyBundle>;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredential: FactoryEvidenceCredential;
  readonly now: () => string;
  readonly createId: () => string;
}

export interface RecordedPolicyDecision {
  readonly decision: FactoryPolicyDecision;
  readonly evidence: StoredEvidenceBundle;
}

const maximumPolicyEvidenceItems = 20_000;

/** Application boundary for durable task, evidence, policy, and authority operations. */
export class FactoryControlPlane {
  public constructor(private readonly dependencies: FactoryControlPlaneDependencies) {
    if (dependencies.policy.bundleDigest !== dependencies.policyBundle.digest) {
      throw new Error("Factory policy engine and policy bundle digests disagree.");
    }
  }

  public async registerTask(
    contractInput: unknown,
    actorInput: unknown
  ): Promise<FactoryTaskSnapshot> {
    const contract = this.dependencies.documents.taskContract(contractInput);
    const actor = factoryActorSchema.parse(actorInput);
    if (
      (actor.kind !== "human" && actor.kind !== "control-plane") ||
      (actor.role !== "requester" && actor.role !== "qualifier")
    ) {
      throw new ConflictError("Only a human requester or trusted qualifier may register a task.");
    }
    await this.#requireActiveConversation(contract.value.conversationId);
    const occurredAt = this.#now();
    if (contract.value.createdAt > occurredAt || contract.value.expiresAt <= occurredAt) {
      throw new ConflictError("Factory task contract is not currently valid.");
    }
    if (contract.value.gateProfile.policyDigest !== this.dependencies.policyBundle.digest) {
      throw new ConflictError("Factory task contract does not pin the active policy bundle.");
    }
    const initialEvent = this.dependencies.documents.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: this.dependencies.createId(),
      taskId: contract.value.taskId,
      sequence: 1,
      contractDigest: contract.digest,
      previousEventDigest: null,
      from: null,
      to: "intake",
      actor,
      occurredAt,
      reasonCode: "task-created",
      summary: null,
      evidenceBundleDigest: null,
      correlationId: this.dependencies.createId()
    });
    const initialEvidence = await this.#prepareRegistrationEvidence(contract, occurredAt);
    return this.dependencies.tasks.create(contract, initialEvent, initialEvidence);
  }

  public async transition(input: unknown): Promise<FactoryTaskSnapshot> {
    const command = transitionInputSchema.parse(input);
    const snapshot = await this.#requireTask(command.taskId);
    if (snapshot.state !== command.expectedState) {
      throw new ConflictError(
        `Factory task is ${snapshot.state}, not expected state ${command.expectedState}.`
      );
    }
    if (!isFactoryTaskTransitionAllowed(snapshot.state, command.nextState)) {
      throw new ConflictError(
        `Illegal factory task transition ${snapshot.state} -> ${command.nextState}.`
      );
    }
    assertLedgerActor(command.nextState, command.actor);
    const occurredAt = this.#now();
    if (
      snapshot.contract.expiresAt <= occurredAt &&
      command.nextState !== "expired" &&
      command.nextState !== "cancelled" &&
      command.nextState !== "failed" &&
      command.nextState !== "quarantined"
    ) {
      throw new ConflictError("Factory task contract has expired.");
    }
    if (!isTerminalFactoryTaskState(command.nextState)) {
      await this.#requireActiveConversation(snapshot.contract.conversationId);
    }

    const evidence = await this.#resolveTransitionEvidence(
      snapshot,
      command.nextState,
      command.evidenceBundleDigest ?? null,
      command.actor
    );
    const event = this.dependencies.documents.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: this.dependencies.createId(),
      taskId: snapshot.contract.taskId,
      sequence: snapshot.sequence + 1,
      contractDigest: snapshot.contractDigest,
      previousEventDigest: snapshot.lastEventDigest,
      from: snapshot.state,
      to: command.nextState,
      actor: command.actor,
      occurredAt,
      reasonCode: command.reasonCode,
      summary: command.summary ?? null,
      evidenceBundleDigest: evidence?.digest ?? null,
      correlationId: this.dependencies.createId()
    });
    const transitioned = await this.dependencies.tasks.append(event);
    if (transitioned === null) {
      throw new ConflictError("Factory task changed concurrently; reload before retrying.");
    }
    return transitioned;
  }

  public async evaluatePolicy(input: unknown): Promise<RecordedPolicyDecision> {
    const command = factoryPolicyCheckInputSchema.parse(input);
    const snapshot = await this.#requireTask(command.taskId);
    await this.#requireActiveConversation(snapshot.contract.conversationId);
    if (command.scheduled !== (snapshot.contract.trigger === "scheduled")) {
      throw new ConflictError("Policy scheduling context does not match the immutable contract.");
    }
    const evidenceBundles = await this.dependencies.evidence.listEvidence(command.taskId);
    const evidenceItems = evidenceBundles.flatMap(({ bundle }) => bundle.items);
    if (evidenceItems.length > maximumPolicyEvidenceItems) {
      throw new ConflictError("Factory task has too much evidence for one policy evaluation.");
    }
    const authority = await this.dependencies.controls.state();
    const evaluatedAt = this.#now();
    const evaluation: FactoryPolicyEvaluation = {
      contract: {
        value: snapshot.contract,
        digest: snapshot.contractDigest,
        json: this.dependencies.documents.taskContract(snapshot.contract).json
      },
      stage: command.stage,
      approvalSubjectDigest: command.approvalSubjectDigest,
      now: evaluatedAt,
      currentBaseRevision: command.currentBaseRevision,
      changeSet: command.changeSet,
      usage: command.usage,
      usageComplete: command.usageComplete,
      evidence: evidenceItems,
      approvals: command.approvals,
      authority,
      scheduled: command.scheduled
    };
    const decision = this.dependencies.documents.policyDecision(
      this.dependencies.policy.evaluate(evaluation)
    ).value;
    const evaluationRecord = this.dependencies.documents.policyEvaluation({
      schemaVersion: "agentlab.policy-evaluation.v1",
      taskId: snapshot.contract.taskId,
      contractDigest: snapshot.contractDigest,
      policyBundleDigest: this.dependencies.policyBundle.digest,
      stage: command.stage,
      approvalSubjectDigest: command.approvalSubjectDigest,
      evaluatedAt,
      currentBaseRevision: command.currentBaseRevision,
      changeSet: command.changeSet,
      usage: command.usage,
      usageComplete: command.usageComplete,
      evidenceBundleDigests: evidenceBundles.map(({ digest }) => digest),
      approvals: command.approvals,
      authority,
      scheduled: command.scheduled,
      decision
    });
    const artifact = await this.#storeDocument(evaluationRecord);
    const previous = evidenceBundles.at(-1) ?? null;
    if (previous === null) throw new ConflictError("Factory task has no evidence chain.");
    const recorded = await this.dependencies.evidenceIngress.append(
      this.dependencies.evidenceCredential,
      {
        taskId: snapshot.contract.taskId,
        contractDigest: snapshot.contractDigest,
        items: [
          evidenceItemSchema.parse({
            id: this.dependencies.createId(),
            kind: "policy",
            result:
              decision.outcome === "allow"
                ? "pass"
                : decision.outcome === "deny"
                  ? "fail"
                  : "informational",
            subjectDigest: command.approvalSubjectDigest,
            artifact: {
              digest: artifact.digest,
              mediaType: "application/vnd.agentlab.policy-evaluation.v1+json",
              sizeBytes: artifact.sizeBytes
            },
            producer: policyActor,
            createdAt: evaluatedAt,
            claims: [
              { name: "outcome", value: decision.outcome },
              { name: "stage", value: command.stage },
              { name: "profile-id", value: decision.profileId },
              { name: "subject-digest", value: command.approvalSubjectDigest }
            ]
          })
        ]
      }
    );
    return { decision, evidence: recorded };
  }

  public async setAuthority(input: unknown): Promise<{
    readonly scheduler: boolean;
    readonly prBroker: boolean;
  }> {
    const command = controlChangeInputSchema.parse(input);
    const event = factoryControlEventSchema.parse({
      schemaVersion: "agentlab.control-event.v1",
      eventId: this.dependencies.createId(),
      control: command.control,
      enabled: command.enabled,
      actor: command.actor,
      occurredAt: this.#now(),
      reason: command.reason
    });
    return this.dependencies.controls.record(this.dependencies.documents.controlEvent(event));
  }

  async #prepareRegistrationEvidence(
    contract: CanonicalFactoryDocument<ImmutableTaskContract>,
    createdAt: string
  ): Promise<CanonicalFactoryDocument<EvidenceBundle>> {
    const contractArtifact = await this.#storeDocument(contract);
    const policyArtifact = await this.#storeDocument(this.dependencies.policyBundle);
    const bundle = evidenceBundleSchema.parse({
      schemaVersion: "agentlab.evidence-bundle.v1",
      bundleId: this.dependencies.createId(),
      taskId: contract.value.taskId,
      sequence: 1,
      contractDigest: contract.digest,
      previousBundleDigest: null,
      policyBundleDigest: this.dependencies.policyBundle.digest,
      createdAt,
      items: [
        evidenceItemSchema.parse({
          id: this.dependencies.createId(),
          kind: "contract",
          result: "pass",
          subjectDigest: contract.digest,
          artifact: {
            digest: contractArtifact.digest,
            mediaType: "application/vnd.agentlab.task-contract.v1+json",
            sizeBytes: contractArtifact.sizeBytes
          },
          producer: policyActor,
          createdAt,
          claims: [{ name: "schema", value: contract.value.schemaVersion }]
        }),
        evidenceItemSchema.parse({
          id: this.dependencies.createId(),
          kind: "policy",
          result: "pass",
          subjectDigest: this.dependencies.policyBundle.digest,
          artifact: {
            digest: policyArtifact.digest,
            mediaType: factoryPolicyBundleMediaType(this.dependencies.policyBundle.value),
            sizeBytes: policyArtifact.sizeBytes
          },
          producer: policyActor,
          createdAt,
          claims: [
            { name: "policy-id", value: this.dependencies.policyBundle.value.id },
            { name: "policy-version", value: this.dependencies.policyBundle.value.version }
          ]
        })
      ],
      attestations: []
    });
    const document = this.dependencies.documents.evidenceBundle(bundle);
    await this.#storeDocument(document);
    return document;
  }

  async #resolveTransitionEvidence(
    snapshot: FactoryTaskSnapshot,
    nextState: FactoryTaskState,
    requestedDigest: Sha256Digest | null,
    actor: FactoryActor
  ): Promise<StoredEvidenceBundle | null> {
    const stage = policyStageForTransition(nextState);
    if (stage === null && requestedDigest === null) return null;
    const latest = await this.dependencies.evidence.latestEvidence(snapshot.contract.taskId);
    if (requestedDigest !== latest?.digest) {
      throw new ConflictError("Transition requires the latest exact evidence bundle.");
    }
    if (stage !== null) {
      assertAuthorityActor(nextState, actor);
      if (!(await this.#bundleAllowsStage(latest, snapshot, stage))) {
        throw new ConflictError(`Latest evidence does not authorize ${stage}.`);
      }
      if (nextState === "pr-open" && !(await this.dependencies.controls.state()).prBroker) {
        throw new ConflictError("PR broker was disabled after policy evaluation.");
      }
    }
    return latest;
  }

  async #bundleAllowsStage(
    evidence: StoredEvidenceBundle,
    snapshot: FactoryTaskSnapshot,
    stage: FactoryApprovalStage
  ): Promise<boolean> {
    for (const item of evidence.bundle.items) {
      if (
        item.kind !== "policy" ||
        item.result !== "pass" ||
        item.producer.kind !== "control-plane" ||
        item.producer.role !== "policy-engine"
      ) {
        continue;
      }
      const json = await this.dependencies.artifacts.readText(
        item.artifact.digest,
        Math.max(1, item.artifact.sizeBytes + 1)
      );
      const record = this.dependencies.documents.policyEvaluation(parseJson(json));
      if (
        record.digest === item.artifact.digest &&
        record.value.taskId === snapshot.contract.taskId &&
        record.value.contractDigest === snapshot.contractDigest &&
        record.value.policyBundleDigest === this.dependencies.policyBundle.digest &&
        record.value.stage === stage &&
        record.value.decision.outcome === "allow"
      ) {
        return stage !== "pull-request-creation"
          ? true
          : this.#bundleContainsPullRequestRecord(
              evidence.bundle,
              snapshot,
              record.value.approvalSubjectDigest
            );
      }
    }
    return false;
  }

  async #bundleContainsPullRequestRecord(
    bundle: EvidenceBundle,
    snapshot: FactoryTaskSnapshot,
    patchDigest: Sha256Digest
  ): Promise<boolean> {
    for (const item of bundle.items) {
      if (
        item.kind !== "pull-request" ||
        item.result !== "pass" ||
        item.subjectDigest !== patchDigest ||
        item.producer.kind !== "broker" ||
        item.producer.role !== "pr-broker"
      ) {
        continue;
      }
      const json = await this.dependencies.artifacts.readText(
        item.artifact.digest,
        Math.max(1, item.artifact.sizeBytes + 1)
      );
      const record = this.dependencies.documents.pullRequestAuthorityRecord(parseJson(json));
      const coordinates = factoryPullRequestAuthorityCoordinates(record.value);
      if (
        record.digest === item.artifact.digest &&
        coordinates.taskId === snapshot.contract.taskId &&
        coordinates.contractDigest === snapshot.contractDigest &&
        coordinates.brokerId === item.producer.id
      ) {
        return true;
      }
    }
    return false;
  }

  async #storeDocument<Value>(document: CanonicalFactoryDocument<Value>) {
    const stored = await this.dependencies.artifacts.putText(document.json);
    if (stored.digest !== document.digest) {
      throw new Error("Artifact store digest disagrees with canonical JSON.");
    }
    return stored;
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new NotFoundError(`Factory task ${taskId} does not exist.`);
    return task;
  }

  async #requireActiveConversation(conversationId: string): Promise<void> {
    const conversation = await this.dependencies.conversations.findById(conversationId);
    if (conversation === null) {
      throw new NotFoundError(`Conversation ${conversationId} does not exist.`);
    }
    if (conversation.lifecycleState !== "active") {
      throw new ConflictError(`Conversation ${conversationId} is not active.`);
    }
  }

  #now(): string {
    return factoryTimestampSchema.parse(this.dependencies.now());
  }
}

const policyActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

function policyStageForTransition(nextState: FactoryTaskState): FactoryApprovalStage | null {
  if (nextState === "queued") return "execution";
  if (nextState === "pr-open") return "pull-request-creation";
  if (nextState === "merge-queued") return "merge";
  if (nextState === "canary" || nextState === "released") return "release";
  return null;
}

function assertAuthorityActor(nextState: FactoryTaskState, actor: FactoryActor): void {
  if (nextState === "queued" && actor.kind === "control-plane" && actor.role === "policy-engine") {
    return;
  }
  if (nextState === "pr-open" && actor.kind === "broker" && actor.role === "pr-broker") return;
  if (nextState === "merge-queued" && actor.kind === "human" && actor.role === "merger") {
    return;
  }
  if (
    (nextState === "canary" || nextState === "released") &&
    actor.kind === "human" &&
    actor.role === "release-controller"
  ) {
    return;
  }
  throw new ConflictError(`Actor is not authorized to enter ${nextState}.`);
}

function assertLedgerActor(nextState: FactoryTaskState, actor: FactoryActor): void {
  if (actor.kind === "agent") {
    throw new ConflictError("Agent output cannot mutate the authoritative task ledger.");
  }
  if (actor.kind === "broker" && (nextState !== "pr-open" || actor.role !== "pr-broker")) {
    throw new ConflictError("The PR broker may record only the PR-open transition.");
  }
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored policy evaluation is invalid JSON.", { cause: error });
  }
}

export type FactoryAuthorityControl = FactoryControlName;
