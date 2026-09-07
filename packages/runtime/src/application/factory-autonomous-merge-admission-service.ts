import {
  evidenceItemSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceItem,
  type FactoryAutonomousMergeAuthorization,
  type FactoryAutonomousMergePolicy,
  type FactoryRoleIdentityPolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { assessFactoryAutonomousMerge } from "../domain/factory-autonomous-merge.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import type { FactoryPullRequestUpdateRepository } from "../domain/factory-pull-request-update-repository.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import { FactoryPullRequestLineageReader } from "./factory-pull-request-lineage.js";
import type { FactoryPullRequestCanaryAuthority } from "./factory-pull-request-canary-authority.js";
import { FactoryPullRequestRepairEvidenceReader } from "./factory-pull-request-repair-evidence.js";
import type { FactoryPolicyBundleV3 } from "../domain/factory-policy.js";

const policyPinsSchema = z
  .object({
    expectedMergePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedDailyQuotaPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

const inputSchema = policyPinsSchema
  .extend({
    taskId: z.uuid(),
    observationDigest: sha256DigestSchema,
    canaryReservationDigest: sha256DigestSchema,
    correlationId: z.uuid().optional()
  })
  .strict();

const observationMediaType = "application/vnd.agentlab.pull-request-observation.v1+json";
const authorizationMediaType = "application/vnd.agentlab.autonomous-merge-authorization.v1+json";

export interface FactoryAutonomousMergeAdmissionServiceDependencies {
  readonly mergePolicy: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>;
  readonly policyBundle: CanonicalFactoryDocument<FactoryPolicyBundleV3>;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicy: CanonicalFactoryDocument<FactoryRoleIdentityPolicy>;
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly updates: Pick<FactoryPullRequestUpdateRepository, "listByTaskId">;
  readonly tasks: Pick<FactoryTaskRepository, "findById" | "listByState">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly controlPlane: Pick<FactoryControlPlane, "evaluatePolicy" | "transition">;
  readonly canaryAuthority: Pick<FactoryPullRequestCanaryAuthority, "requireReservation">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "controlPlane">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
}

export type FactoryAutonomousMergeAdmissionOutcome =
  | {
      readonly status: "authorized";
      readonly authorization: FactoryAutonomousMergeAuthorization;
      readonly authorizationDigest: Sha256Digest;
      readonly evidenceBundleDigest: Sha256Digest;
      readonly created: boolean;
    }
  | { readonly status: "denied"; readonly reasonCodes: readonly string[] };

export interface FactoryAutonomousMergeAdmissionPreflight {
  readonly schemaVersion: "agentlab.autonomous-merge-admission-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly mergePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly mergeBrokerEnabled: boolean;
  readonly credentialless: true;
  readonly remoteWrite: false;
  readonly directMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}

export interface FactoryAutonomousMergeAdmissionTickReport {
  readonly schemaVersion: "agentlab.autonomous-merge-admission-tick-result.v1";
  readonly status: "completed" | "idle" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly mergePolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly authorized: number;
  readonly denied: number;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly status: "authorized" | "denied";
    readonly authorizationDigest: Sha256Digest | null;
    readonly reasonCodes: readonly string[];
  }[];
}

/**
 * Credentialless merge admission. It trusts only canonical local lineage plus the latest
 * broker-authenticated observation and can never mark ready, enqueue, merge, release, or mint a
 * remote credential.
 */
export class FactoryAutonomousMergeAdmissionService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #lineage: FactoryPullRequestLineageReader;
  readonly #repairEvidence: FactoryPullRequestRepairEvidenceReader;

  public constructor(
    private readonly dependencies: FactoryAutonomousMergeAdmissionServiceDependencies
  ) {
    this.#assertStaticPolicy();
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { controlPlane: dependencies.evidenceCredentials.controlPlane },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#lineage = new FactoryPullRequestLineageReader(dependencies);
    this.#repairEvidence = new FactoryPullRequestRepairEvidenceReader(dependencies);
  }

  public async preflight(): Promise<FactoryAutonomousMergeAdmissionPreflight> {
    const controls = await this.dependencies.controls.state();
    const reasonCodes = [
      ...(controls.scheduler ? [] : ["scheduler-disabled"]),
      ...(controls.prBroker ? [] : ["pr-broker-disabled"]),
      ...(controls.mergeBroker ? [] : ["merge-broker-disabled"]),
      ...(this.dependencies.policyBundle.value.costPolicy.rules.length > 0
        ? []
        : ["cost-policy-unconfigured"])
    ].toSorted();
    return {
      schemaVersion: "agentlab.autonomous-merge-admission-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: this.dependencies.mergePolicy.value.repositoryId,
      mergePolicyDigest: this.dependencies.mergePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.policyBundle.digest,
      schedulerEnabled: controls.scheduler,
      prBrokerEnabled: controls.prBroker,
      mergeBrokerEnabled: controls.mergeBroker ?? false,
      credentialless: true,
      remoteWrite: false,
      directMerge: false,
      release: false,
      reasonCodes
    };
  }

  public async admit(input: unknown): Promise<FactoryAutonomousMergeAdmissionOutcome> {
    const command = inputSchema.parse(input);
    this.#assertCommandPins(command);
    const controls = await this.dependencies.controls.state();
    if (!controls.scheduler || !controls.prBroker || !controls.mergeBroker) {
      return denied([
        ...(controls.scheduler ? [] : ["scheduler-disabled"]),
        ...(controls.prBroker ? [] : ["pr-broker-disabled"]),
        ...(controls.mergeBroker ? [] : ["merge-broker-disabled"])
      ]);
    }
    const task = await this.#requireTask(command.taskId);
    if (task.state !== "pr-open" && task.state !== "merge-ready") {
      throw new Error("Autonomous merge admission requires a PR-open or merge-ready task.");
    }
    const contractReasons = this.#contractDenials(task);
    if (contractReasons.length > 0) return denied(contractReasons);
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (now >= task.contract.expiresAt) return denied(["task-contract-expired"]);
    const lineage = await this.#lineage.current(task);
    const record = lineage.record;
    const coordinates = factoryPullRequestAuthorityCoordinates(record.value);
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const observed = await this.#exactLatestObservation(
      bundles,
      command.observationDigest,
      task,
      lineage.dispatch.run.proposalDigest,
      record
    );
    const existing = await this.#authorizations(bundles, task);
    const exactExisting = existing.find(
      ({ document }) => document.value.observationDigest === observed.observation.digest
    );
    if (exactExisting !== undefined) {
      this.#assertExisting(exactExisting.document.value, task, observed.bundle.digest);
      if (now >= exactExisting.document.value.expiresAt) {
        return denied(["merge-authorization-expired"]);
      }
      await this.#ensureMergeReady(task, exactExisting.bundle.digest);
      return {
        status: "authorized",
        authorization: exactExisting.document.value,
        authorizationDigest: exactExisting.document.digest,
        evidenceBundleDigest: exactExisting.bundle.digest,
        created: false
      };
    }
    if (existing.length > 0 || task.state === "merge-ready") {
      return denied(["merge-authorization-outstanding"]);
    }
    const assessment = assessFactoryAutonomousMerge(
      observed.observation.value,
      this.dependencies.mergePolicy.value,
      now
    );
    if (assessment.status === "denied") return denied(assessment.reasonCodes);
    const reservation = await this.dependencies.canaryAuthority.requireReservation(task, {
      reservationDigest: command.canaryReservationDigest,
      schedulePolicyDigest: command.expectedSchedulePolicyDigest,
      roleIdentityPolicyDigest: command.expectedRoleIdentityPolicyDigest
    });
    if (reservation?.digest !== command.canaryReservationDigest) {
      throw new Error("Autonomous merge requires its exact scheduled canary reservation.");
    }
    const priorPatch = await this.#repairEvidence.priorPatch({
      bundles,
      expectedDigest: lineage.currentPatchProposalDigest,
      task
    });
    const usage = await this.#repairEvidence.initialUsage({
      bundles,
      task,
      patchProposalDigest: lineage.currentPatchProposalDigest
    });
    const policy = await this.dependencies.controlPlane.evaluatePolicy({
      taskId: task.contract.taskId,
      stage: "merge",
      approvalSubjectDigest: lineage.currentPatchProposalDigest,
      currentBaseRevision: task.contract.repository.baseRevision,
      changeSet: priorPatch.proposal.value.changeSet,
      usage: usage.value.usage,
      usageComplete: usage.value.complete,
      approvals: [],
      scheduled: true
    });
    if (
      policy.decision.outcome !== "allow" ||
      policy.decision.effectiveRiskTier !== "R1" ||
      policy.decision.requiredHumanApprovals !== 0
    ) {
      return denied(policy.decision.reasonCodes);
    }
    const policyItem = exactPolicyItem(policy.evidence, lineage.currentPatchProposalDigest);
    if (!(await this.#authorityStillCurrent(task, command, reservation.value.expiresAt))) {
      return denied(["merge-authority-changed-after-policy"]);
    }
    const issuedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const expiresAt = earliest(
      task.contract.expiresAt,
      reservation.value.expiresAt,
      factoryTimestampAddSeconds(
        issuedAt,
        this.dependencies.mergePolicy.value.authorizationLifetimeSeconds
      )
    );
    if (issuedAt >= expiresAt) return denied(["merge-authorization-window-exhausted"]);
    const authorization = this.dependencies.documents.autonomousMergeAuthorization({
      schemaVersion: "agentlab.autonomous-merge-authorization.v1",
      authorizationId: this.dependencies.createId(),
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: this.dependencies.policyBundle.digest,
      mergePolicyDigest: this.dependencies.mergePolicy.digest,
      observationDigest: observed.observation.digest,
      observationEvidenceBundleDigest: observed.bundle.digest,
      policyEvaluationDigest: policyItem.artifact.digest,
      policyEvidenceBundleDigest: policy.evidence.digest,
      proposalDigest: lineage.currentPatchProposalDigest,
      pullRequestRecordDigest: record.digest,
      repositoryId: coordinates.repositoryId,
      pullRequestNumber: coordinates.number,
      pullRequestUrl: coordinates.url,
      branchName: coordinates.branchName,
      expectedBaseRevision: coordinates.baseRevision,
      expectedHeadRevision: coordinates.headRevision,
      canaryReservationDigest: reservation.digest,
      schedulePolicyDigest: this.dependencies.schedulePolicyDigest,
      dailyQuotaPolicyDigest: this.dependencies.dailyQuotaPolicyDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicy.digest,
      riskTier: "R1",
      trigger: "scheduled",
      deliveryMode: "merge-queue",
      markReadyForReview: true,
      directMerge: false,
      release: false,
      issuedAt,
      expiresAt,
      correlationId: command.correlationId ?? this.dependencies.createId()
    });
    const evidence = await this.#publisher.autonomousMergeAuthorization({
      task,
      authorization,
      policyItem
    });
    await this.#ensureMergeReady(task, evidence.digest);
    return {
      status: "authorized",
      authorization: authorization.value,
      authorizationDigest: authorization.digest,
      evidenceBundleDigest: evidence.digest,
      created: true
    };
  }

  public async tick(input: unknown): Promise<FactoryAutonomousMergeAdmissionTickReport> {
    const command = policyPinsSchema.parse(input);
    this.#assertCommandPins(command);
    const controls = await this.dependencies.controls.state();
    const controlReasons = [
      ...(controls.scheduler ? [] : ["scheduler-disabled"]),
      ...(controls.prBroker ? [] : ["pr-broker-disabled"]),
      ...(controls.mergeBroker ? [] : ["merge-broker-disabled"])
    ].toSorted();
    if (controlReasons.length > 0) {
      return admissionTickReport([], controlReasons, this.dependencies.mergePolicy);
    }
    const tasks = await this.dependencies.tasks.listByState(
      "pr-open",
      this.dependencies.mergePolicy.value.maximumCandidatesPerTick
    );
    const results: FactoryAutonomousMergeAdmissionTickReport["tasks"][number][] = [];
    for (const task of tasks) {
      if (task.contract.repository.id !== this.dependencies.mergePolicy.value.repositoryId) {
        continue;
      }
      const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
      const observationDigest = latestObservationDigest(bundles);
      const lineage = await this.#lineage.current(task);
      if (
        observationDigest === null ||
        lineage.dispatch.run.schemaVersion !== "agentlab.pull-request-dispatch.v2"
      ) {
        results.push({
          taskId: task.contract.taskId,
          status: "denied",
          authorizationDigest: null,
          reasonCodes: [
            ...(observationDigest === null ? ["merge-observation-missing"] : []),
            ...(lineage.dispatch.run.schemaVersion === "agentlab.pull-request-dispatch.v2"
              ? []
              : ["scheduled-dispatch-authority-missing"])
          ].toSorted()
        });
        continue;
      }
      const outcome = await this.admit({
        ...command,
        taskId: task.contract.taskId,
        observationDigest,
        canaryReservationDigest: lineage.dispatch.run.canaryReservationDigest,
        correlationId: task.lastEvent.correlationId
      });
      results.push(
        outcome.status === "authorized"
          ? {
              taskId: task.contract.taskId,
              status: "authorized",
              authorizationDigest: outcome.authorizationDigest,
              reasonCodes: []
            }
          : {
              taskId: task.contract.taskId,
              status: "denied",
              authorizationDigest: null,
              reasonCodes: outcome.reasonCodes
            }
      );
    }
    return admissionTickReport(results, [], this.dependencies.mergePolicy);
  }

  #assertStaticPolicy(): void {
    const { mergePolicy, policyBundle, roleIdentityPolicy } = this.dependencies;
    if (
      policyBundle.value.autonomousMergePolicyDigest !== mergePolicy.digest ||
      mergePolicy.value.repositoryId.length === 0 ||
      mergePolicy.value.schedulePolicyDigest !== this.dependencies.schedulePolicyDigest ||
      mergePolicy.value.dailyQuotaPolicyDigest !== this.dependencies.dailyQuotaPolicyDigest ||
      mergePolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
      mergePolicy.value.mergerUserId === roleIdentityPolicy.value.worker.userId ||
      mergePolicy.value.mergerUserId === roleIdentityPolicy.value.evalAttestor.userId
    ) {
      throw new Error("Autonomous merge policies, identities, and factory-policy pins disagree.");
    }
  }

  #assertCommandPins(command: z.infer<typeof policyPinsSchema>): void {
    if (
      command.expectedMergePolicyDigest !== this.dependencies.mergePolicy.digest ||
      command.expectedFactoryPolicyBundleDigest !== this.dependencies.policyBundle.digest ||
      command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicyDigest ||
      command.expectedDailyQuotaPolicyDigest !== this.dependencies.dailyQuotaPolicyDigest ||
      command.expectedRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicy.digest
    ) {
      throw new Error("Autonomous merge admission policy changed after operator review.");
    }
  }

  #contractDenials(task: FactoryTaskSnapshot): readonly string[] {
    const reasons = [
      ...(task.contract.repository.id === this.dependencies.mergePolicy.value.repositoryId
        ? []
        : ["merge-repository-not-authorized"]),
      ...(task.contract.trigger === "scheduled" ? [] : ["merge-trigger-not-authorized"]),
      ...(task.contract.riskTier === "R1" ? [] : ["merge-risk-tier-not-authorized"]),
      ...(task.contract.gateProfile.policyDigest === this.dependencies.policyBundle.digest
        ? []
        : ["merge-factory-policy-mismatch"]),
      ...(task.contract.approvals.merge.mode === "automatic"
        ? []
        : ["immutable-contract-requires-human-merge"]),
      ...(task.contract.agentPolicy.minimumIndependentReviews >=
      this.dependencies.mergePolicy.value.minimumIndependentReviews
        ? []
        : ["merge-independent-review-floor-too-weak"])
    ];
    return reasons.toSorted();
  }

  async #authorityStillCurrent(
    task: FactoryTaskSnapshot,
    command: z.infer<typeof inputSchema>,
    reservationExpiresAt: string
  ): Promise<boolean> {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const controls = await this.dependencies.controls.state();
    if (
      !controls.scheduler ||
      !controls.prBroker ||
      !controls.mergeBroker ||
      now >= reservationExpiresAt
    )
      return false;
    const reservation = await this.dependencies.canaryAuthority.requireReservation(task, {
      reservationDigest: command.canaryReservationDigest,
      schedulePolicyDigest: command.expectedSchedulePolicyDigest,
      roleIdentityPolicyDigest: command.expectedRoleIdentityPolicyDigest
    });
    return reservation?.digest === command.canaryReservationDigest;
  }

  async #exactLatestObservation(
    bundles: readonly StoredEvidenceBundle[],
    expectedDigest: Sha256Digest,
    task: FactoryTaskSnapshot,
    proposalDigest: Sha256Digest,
    record: CanonicalFactoryDocument<
      import("@agentlab/contracts").FactoryPullRequestAuthorityRecord
    >
  ) {
    const candidates = bundles.flatMap((bundle) =>
      bundle.bundle.items
        .filter(
          (item) => item.kind === "pull-request" && item.artifact.mediaType === observationMediaType
        )
        .map((item) => ({ bundle, item }))
    );
    const latest = candidates.at(-1);
    if (latest?.item.artifact.digest !== expectedDigest) {
      throw new Error("Autonomous merge requires the exact latest PR observation digest.");
    }
    const observation = this.dependencies.documents.pullRequestObservation(
      parseJson(
        await this.dependencies.artifacts.readText(
          latest.item.artifact.digest,
          latest.item.artifact.sizeBytes + 1
        )
      )
    );
    const coordinates = factoryPullRequestAuthorityCoordinates(record.value);
    if (
      observation.digest !== expectedDigest ||
      latest.item.subjectDigest !== observation.digest ||
      latest.item.result !== "pass" ||
      latest.item.producer.kind !== "broker" ||
      latest.item.producer.role !== "pr-broker" ||
      latest.item.producer.id !== coordinates.brokerId ||
      latest.item.createdAt !== observation.value.observedAt ||
      claim(latest.item, "disposition") !== "clear" ||
      observation.value.taskId !== task.contract.taskId ||
      observation.value.contractDigest !== task.contractDigest ||
      observation.value.proposalDigest !== proposalDigest ||
      observation.value.pullRequestRecordDigest !== record.digest ||
      observation.value.repositoryId !== coordinates.repositoryId ||
      observation.value.pullRequestNumber !== coordinates.number ||
      observation.value.url !== coordinates.url ||
      observation.value.brokerId !== coordinates.brokerId ||
      observation.value.authorizedBaseRevision !== coordinates.baseRevision ||
      observation.value.recordedHeadRevision !== coordinates.headRevision ||
      observation.value.remoteBaseRevision !== coordinates.baseRevision ||
      observation.value.remoteHeadRevision !== coordinates.headRevision ||
      observation.value.branchName !== coordinates.branchName
    ) {
      throw new Error("Autonomous merge observation failed canonical identity validation.");
    }
    return { observation, item: latest.item, bundle: latest.bundle };
  }

  async #authorizations(
    bundles: readonly StoredEvidenceBundle[],
    task: FactoryTaskSnapshot
  ): Promise<
    readonly {
      readonly document: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>;
      readonly bundle: StoredEvidenceBundle;
    }[]
  > {
    const found = [];
    for (const bundle of bundles) {
      for (const item of bundle.bundle.items) {
        if (item.kind !== "merge" || item.artifact.mediaType !== authorizationMediaType) continue;
        const document = this.dependencies.documents.autonomousMergeAuthorization(
          parseJson(
            await this.dependencies.artifacts.readText(
              item.artifact.digest,
              item.artifact.sizeBytes + 1
            )
          )
        );
        if (
          document.digest !== item.artifact.digest ||
          document.digest !== item.subjectDigest ||
          document.value.taskId !== task.contract.taskId ||
          document.value.contractDigest !== task.contractDigest ||
          document.value.policyBundleDigest !== this.dependencies.policyBundle.digest ||
          document.value.mergePolicyDigest !== this.dependencies.mergePolicy.digest ||
          item.result !== "pass" ||
          item.producer.kind !== "control-plane" ||
          item.producer.role !== "policy-engine" ||
          item.producer.id !== "agentlab-policy" ||
          item.createdAt !== document.value.issuedAt ||
          claim(item, "observation-digest") !== document.value.observationDigest ||
          claim(item, "policy-evaluation-digest") !== document.value.policyEvaluationDigest ||
          claim(item, "head-revision") !== document.value.expectedHeadRevision
        ) {
          throw new Error("Stored autonomous merge authorization failed identity validation.");
        }
        found.push({ document, bundle });
      }
    }
    if (
      new Set(found.map(({ document }) => document.value.observationDigest)).size !== found.length
    ) {
      throw new Error("Autonomous merge authorizations reuse an observation.");
    }
    return found;
  }

  #assertExisting(
    authorization: FactoryAutonomousMergeAuthorization,
    task: FactoryTaskSnapshot,
    observationEvidenceBundleDigest: Sha256Digest
  ): void {
    if (
      authorization.observationEvidenceBundleDigest !== observationEvidenceBundleDigest ||
      authorization.repositoryId !== task.contract.repository.id ||
      authorization.expectedBaseRevision !== task.contract.repository.baseRevision ||
      authorization.riskTier !== task.contract.riskTier ||
      authorization.trigger !== task.contract.trigger
    ) {
      throw new Error("Existing autonomous merge authorization changed its task authority.");
    }
  }

  async #ensureMergeReady(
    task: FactoryTaskSnapshot,
    evidenceBundleDigest: Sha256Digest
  ): Promise<void> {
    if (task.state === "merge-ready") return;
    await this.dependencies.controlPlane.transition({
      taskId: task.contract.taskId,
      expectedState: "pr-open",
      nextState: "merge-ready",
      actor: mergeAdmissionActor,
      reasonCode: "autonomous-merge-authorized",
      summary: "Exact scheduled R1 draft head admitted for the separate merge queue broker.",
      evidenceBundleDigest
    });
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

const mergeAdmissionActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

function admissionTickReport(
  tasks: FactoryAutonomousMergeAdmissionTickReport["tasks"],
  reasonCodes: readonly string[],
  policy: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>
): FactoryAutonomousMergeAdmissionTickReport {
  const authorized = tasks.filter(({ status }) => status === "authorized").length;
  const denied = tasks.length - authorized;
  const reasons = [...reasonCodes, ...tasks.flatMap((task) => task.reasonCodes)]
    .filter((value, index, values) => values.indexOf(value) === index)
    .toSorted();
  const status =
    tasks.length === 0
      ? reasons.length === 0
        ? "idle"
        : "blocked"
      : denied === 0
        ? "completed"
        : authorized > 0
          ? "partial"
          : "blocked";
  return {
    schemaVersion: "agentlab.autonomous-merge-admission-tick-result.v1",
    status,
    repositoryId: policy.value.repositoryId,
    mergePolicyDigest: policy.digest,
    inspected: tasks.length,
    authorized,
    denied,
    reasonCodes: reasons,
    tasks
  };
}

function latestObservationDigest(bundles: readonly StoredEvidenceBundle[]): Sha256Digest | null {
  const latest = bundles
    .flatMap(({ bundle }) => bundle.items)
    .filter(
      (item) => item.kind === "pull-request" && item.artifact.mediaType === observationMediaType
    )
    .at(-1);
  return latest?.artifact.digest ?? null;
}

function exactPolicyItem(bundle: StoredEvidenceBundle, subjectDigest: Sha256Digest): EvidenceItem {
  const item = bundle.bundle.items.find(
    (candidate) =>
      candidate.kind === "policy" &&
      candidate.result === "pass" &&
      candidate.subjectDigest === subjectDigest &&
      candidate.producer.kind === "control-plane" &&
      candidate.producer.role === "policy-engine"
  );
  return evidenceItemSchema.parse(
    item ??
      (() => {
        throw new Error("Autonomous merge policy evidence is missing its exact allow record.");
      })()
  );
}

function earliest(...timestamps: readonly string[]): string {
  return (
    [...timestamps].sort()[0] ??
    (() => {
      throw new Error("Expected an autonomous merge expiration bound.");
    })()
  );
}

function denied(reasonCodes: readonly string[]): FactoryAutonomousMergeAdmissionOutcome {
  return { status: "denied", reasonCodes: [...new Set(reasonCodes)].toSorted() };
}

function claim(item: EvidenceItem, name: string): string | null {
  return item.claims.find((candidate) => candidate.name === name)?.value ?? null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored autonomous merge evidence is not valid JSON.", { cause: error });
  }
}
