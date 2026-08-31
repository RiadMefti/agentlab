import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceItem,
  type FactoryExecutionEvent,
  type FactoryPatchProposal,
  type FactoryPolicyDecision,
  type FactoryPullRequestUpdateRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import type {
  FactoryDraftPullRequestBroker,
  FactoryPullRequestBrokerIdentity
} from "../domain/factory-pull-request-broker.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import type { FactoryPullRequestRepairExecutionRepository } from "../domain/factory-pull-request-repair-execution-repository.js";
import type { FactoryPullRequestUpdateSnapshot } from "../domain/factory-pull-request-update-repository.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import { FactoryPullRequestLineageReader } from "./factory-pull-request-lineage.js";
import {
  factoryRepositoryGovernanceDenials,
  requireExactPolicyItem
} from "./factory-pull-request-policy.js";
import { FactoryPullRequestRepairEvidenceReader } from "./factory-pull-request-repair-evidence.js";
import {
  FactoryPullRequestUpdateJournalSession,
  type FactoryPullRequestUpdateJournalDependencies
} from "./factory-pull-request-update-journal.js";

const inputSchema = z
  .object({
    taskId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    correlationId: z.uuid().optional()
  })
  .strict();
const patchMediaType = "application/vnd.agentlab.patch-proposal.v1+json";

export interface FactoryPullRequestUpdateServiceDependencies extends FactoryPullRequestUpdateJournalDependencies {
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly executions: Pick<
    FactoryPullRequestRepairExecutionRepository,
    "findByAuthorizationDigest" | "listEvents"
  >;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence" | "latestEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "evaluatePolicy" | "transition">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "prBroker">;
  readonly artifacts: FactoryArtifactStore;
  readonly remote: FactoryDraftPullRequestBroker;
}

export type FactoryPullRequestUpdateOutcome =
  | {
      readonly status: "updated";
      readonly record: FactoryPullRequestUpdateRecord;
      readonly decision: FactoryPolicyDecision;
      readonly remoteUpdated: boolean;
    }
  | {
      readonly status: "denied" | "needs-human";
      readonly reasonCodes: readonly string[];
      readonly decision: FactoryPolicyDecision | null;
    };

/** Authorizes and crash-durably advances one existing draft branch after a successful repair. */
export class FactoryPullRequestUpdateService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #lineage: FactoryPullRequestLineageReader;
  readonly #reader: FactoryPullRequestRepairEvidenceReader;
  readonly #identity: FactoryPullRequestBrokerIdentity;

  public constructor(private readonly dependencies: FactoryPullRequestUpdateServiceDependencies) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { prBroker: dependencies.evidenceCredentials.prBroker },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#lineage = new FactoryPullRequestLineageReader(dependencies);
    this.#reader = new FactoryPullRequestRepairEvidenceReader(dependencies);
    this.#identity = dependencies.remote.identity();
  }

  public async update(input: unknown): Promise<FactoryPullRequestUpdateOutcome> {
    const command = inputSchema.parse(input);
    let task = await this.#requireTask(command.taskId);
    const existing = await this.dependencies.updates.findByAuthorizationDigest(
      command.authorizationDigest
    );
    if (existing !== null) return this.#resume(task, existing);
    if (task.state !== "pr-proposed") {
      throw new Error("Draft branch update requires a successfully repaired PR proposal.");
    }
    if (task.contract.riskTier !== "R1") {
      return denied("broker-risk-tier-unsupported");
    }
    this.#requireUnexpired(task, "before update authorization");
    const lineage = await this.#lineage.current(task);
    const prior = factoryPullRequestAuthorityCoordinates(lineage.record.value);
    if (
      this.#identity.repositoryId !== prior.repositoryId ||
      this.#identity.brokerId !== prior.brokerId
    ) {
      throw new Error("PR update broker identity differs from the authenticated PR lineage.");
    }
    const execution = await this.dependencies.executions.findByAuthorizationDigest(
      command.authorizationDigest
    );
    if (
      execution?.state !== "completed" ||
      execution.lastEvent.kind !== "execution-finished" ||
      execution.lastEvent.taskState !== "pr-proposed" ||
      execution.run.taskId !== task.contract.taskId ||
      execution.run.contractDigest !== task.contractDigest ||
      execution.run.policyBundleDigest !== task.contract.gateProfile.policyDigest ||
      execution.run.authorizationDigest !== command.authorizationDigest ||
      execution.run.priorPatchProposalDigest !== lineage.currentPatchProposalDigest ||
      execution.run.contractRepairAttempt !== lineage.contractRepairAttempt + 1
    ) {
      throw new Error("PR update requires the exact completed repair execution journal.");
    }
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const authorization = await this.#reader.exactAuthorization({
      bundles,
      expectedDigest: command.authorizationDigest,
      task,
      record: lineage.record,
      proposalDigest: lineage.dispatch.run.proposalDigest,
      priorPatchProposalDigest: lineage.currentPatchProposalDigest
    });
    const repairRuns = await this.#reader.repairRuns({
      bundles,
      task,
      authorizations: [authorization]
    });
    if (repairRuns.length !== 1 || repairRuns[0]?.digest !== execution.runDigest) {
      throw new Error("PR update repair-run evidence differs from its durable journal.");
    }
    const repairedPatch = await this.#repairedPatch(task, bundles, execution.run.runId);
    const usage = await this.#reader.initialUsage({
      bundles,
      task,
      patchProposalDigest: repairedPatch.digest
    });
    if (
      usage.value.usage.repairAttempts !== execution.run.contractRepairAttempt ||
      !usage.value.complete
    ) {
      throw new Error("PR update requires exact complete cumulative usage for the repair.");
    }
    const remote = await this.dependencies.remote.inspect(task.contract.repository.id);
    if (remote.repositoryId !== task.contract.repository.id) {
      throw new Error("PR update broker returned another repository identity.");
    }
    const governanceReasons = factoryRepositoryGovernanceDenials(remote.governance);
    if (governanceReasons.length > 0) {
      return { status: "denied", reasonCodes: governanceReasons, decision: null };
    }
    const policy = await this.dependencies.controlPlane.evaluatePolicy({
      taskId: task.contract.taskId,
      stage: "pull-request-creation",
      approvalSubjectDigest: repairedPatch.digest,
      currentBaseRevision: remote.baseRevision,
      changeSet: repairedPatch.value.changeSet,
      usage: usage.value.usage,
      usageComplete: usage.value.complete,
      approvals: [],
      scheduled: task.contract.trigger === "scheduled"
    });
    if (policy.decision.outcome !== "allow") {
      return {
        status: policy.decision.outcome === "needs-human" ? "needs-human" : "denied",
        reasonCodes: policy.decision.reasonCodes,
        decision: policy.decision
      };
    }
    const policyItem = requireExactPolicyItem(policy.evidence.bundle.items, repairedPatch.digest);
    const createdAt = this.#requireUnexpired(task, "after update authorization");
    const initialProposal = lineage.dispatch.run.proposal;
    const proposal = this.dependencies.documents.pullRequestUpdateProposal({
      schemaVersion: "agentlab.pull-request-update-proposal.v1",
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: task.contract.gateProfile.policyDigest,
      initialProposalDigest: lineage.dispatch.run.proposalDigest,
      priorPullRequestRecordDigest: lineage.record.digest,
      repairAuthorizationDigest: authorization.digest,
      repairRunDigest: execution.runDigest,
      repairedPatchProposalDigest: repairedPatch.digest,
      repairedPatchArtifactDigest: repairedPatch.value.patchArtifact.digest,
      policyEvaluationDigest: policyItem.artifact.digest,
      changeSet: repairedPatch.value.changeSet,
      repositoryId: task.contract.repository.id,
      baseRevision: task.contract.repository.baseRevision,
      baseBranch: initialProposal.baseBranch,
      branchName: prior.branchName,
      pullRequestNumber: prior.number,
      priorHeadRevision: prior.headRevision,
      brokerId: prior.brokerId,
      contractRepairAttempt: execution.run.contractRepairAttempt,
      commitTitle: repairedCommitTitle(initialProposal.title, execution.run.contractRepairAttempt),
      createdAt
    });
    const stored = await this.dependencies.artifacts.putText(proposal.json);
    if (stored.digest !== proposal.digest) {
      throw new Error("PR update proposal digest changed in immutable storage.");
    }
    const journal = await FactoryPullRequestUpdateJournalSession.start(
      this.dependencies,
      proposal,
      command.correlationId ?? z.uuid().parse(this.dependencies.createId())
    );
    task = await this.#requireTask(task.contract.taskId);
    return this.#drive(task, journal, lineage.record.value, policy.decision, policyItem);
  }

  async #resume(
    task: FactoryTaskSnapshot,
    snapshot: FactoryPullRequestUpdateSnapshot
  ): Promise<FactoryPullRequestUpdateOutcome> {
    const proposal = this.dependencies.documents.pullRequestUpdateProposal(snapshot.run.proposal);
    if (
      proposal.digest !== snapshot.run.proposalDigest ||
      snapshot.run.taskId !== task.contract.taskId ||
      snapshot.run.contractDigest !== task.contractDigest ||
      snapshot.run.brokerId !== this.#identity.brokerId ||
      proposal.value.policyBundleDigest !== task.contract.gateProfile.policyDigest ||
      proposal.value.repositoryId !== task.contract.repository.id ||
      proposal.value.baseRevision !== task.contract.repository.baseRevision ||
      proposal.value.brokerId !== this.#identity.brokerId
    ) {
      throw new Error("Durable PR update does not match its task and broker identity.");
    }
    const authorization = await this.#authorizingPolicy(task, proposal.value);
    if (snapshot.state === "completed") {
      const current = await this.#lineage.current(task);
      const completed = current.updates.find(({ run }) => run.updateId === snapshot.run.updateId);
      if (
        completed?.runDigest !== snapshot.runDigest ||
        completed.lastEventDigest !== snapshot.lastEventDigest ||
        completed.record === null ||
        authorization.decision.outcome !== "allow"
      ) {
        throw new Error("Completed PR update is not part of the authenticated current lineage.");
      }
      return {
        status: "updated",
        record: completed.record,
        decision: authorization.decision,
        remoteUpdated: completed.remoteUpdated ?? false
      };
    }
    const lineage = await this.#lineage.before(task, snapshot.run.updateId);
    const prior = factoryPullRequestAuthorityCoordinates(lineage.record.value);
    if (
      proposal.value.initialProposalDigest !== lineage.dispatch.run.proposalDigest ||
      proposal.value.priorPullRequestRecordDigest !== lineage.record.digest ||
      proposal.value.priorHeadRevision !== prior.headRevision ||
      proposal.value.pullRequestNumber !== prior.number ||
      proposal.value.branchName !== prior.branchName ||
      proposal.value.contractRepairAttempt !== lineage.contractRepairAttempt + 1
    ) {
      throw new Error("Recoverable PR update does not match its exact prior head lineage.");
    }
    return this.#drive(
      task,
      FactoryPullRequestUpdateJournalSession.resume(this.dependencies, snapshot),
      lineage.record.value,
      authorization.decision,
      authorization.item
    );
  }

  async #drive(
    task: FactoryTaskSnapshot,
    journal: FactoryPullRequestUpdateJournalSession,
    priorRecord: Parameters<FactoryDraftPullRequestBroker["updateDraft"]>[0]["priorRecord"],
    decision: FactoryPolicyDecision,
    policyItem: EvidenceItem
  ): Promise<FactoryPullRequestUpdateOutcome> {
    const proposal = this.dependencies.documents.pullRequestUpdateProposal(
      journal.snapshot.run.proposal
    );
    if (proposal.digest !== journal.snapshot.run.proposalDigest || decision.outcome !== "allow") {
      throw new Error("Durable PR update lost its exact allowing policy or proposal.");
    }
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) throw new Error("PR update recovery requires its repository.");
    const patch = await this.dependencies.artifacts.readText(
      proposal.value.repairedPatchArtifactDigest,
      task.contract.budget.maxOutputBytes + 1
    );

    if (journal.snapshot.state === "ready") {
      const stopped = await this.#disabledOutcome(decision);
      if (stopped !== null) return stopped;
      await journal.startUpdate();
    }
    if (journal.snapshot.state === "update-active") {
      const stopped = await this.#disabledOutcome(decision);
      if (stopped !== null) return stopped;
      const remote = await this.dependencies.remote.inspect(proposal.value.repositoryId);
      const governanceReasons = factoryRepositoryGovernanceDenials(remote.governance);
      if (
        remote.repositoryId !== proposal.value.repositoryId ||
        remote.baseBranch !== proposal.value.baseBranch ||
        remote.baseRevision !== proposal.value.baseRevision
      ) {
        throw new Error("Remote repository changed after durable PR update authorization.");
      }
      if (governanceReasons.length > 0) {
        return { status: "denied", reasonCodes: governanceReasons, decision };
      }
      const result = await this.dependencies.remote.updateDraft({
        proposal: proposal.value,
        priorRecord,
        patch,
        repositoryRoot
      });
      await journal.observeRemote(result.record, result.updated);
    }
    if (journal.snapshot.state === "remote-updated") {
      const stopped = await this.#disabledOutcome(decision);
      if (stopped !== null) return stopped;
      const record = requiredRecord(journal.snapshot);
      await this.dependencies.remote.verifyUpdatedDraft({ proposal: proposal.value, record });
      const evidence = await this.#recordEvidence(task, proposal, record, policyItem);
      await journal.recordEvidence(evidence.digest);
    }
    if (journal.snapshot.state === "evidence-recorded") {
      task = await this.#requireTask(task.contract.taskId);
      if (task.state === "pr-proposed") {
        const stopped = await this.#disabledOutcome(decision);
        if (stopped !== null) return stopped;
        const evidenceDigest = requiredEvidenceDigest(journal.snapshot);
        const latest = await this.dependencies.evidence.latestEvidence(task.contract.taskId);
        if (latest?.digest !== evidenceDigest) {
          throw new Error("PR update evidence is no longer the exact task ledger head.");
        }
        task = await this.dependencies.controlPlane.transition({
          taskId: task.contract.taskId,
          expectedState: "pr-proposed",
          nextState: "pr-open",
          actor: brokerActor(this.#identity.brokerId),
          reasonCode: "draft-pr-repaired",
          evidenceBundleDigest: evidenceDigest
        });
      }
      const taskEventDigest = this.#assertRecordedTask(
        task,
        requiredEvidenceDigest(journal.snapshot)
      );
      await journal.complete(taskEventDigest);
    }
    if (journal.snapshot.state !== "completed") {
      throw new Error(`PR update stopped in unexpected state ${journal.snapshot.state}.`);
    }
    return {
      status: "updated",
      record: requiredRecord(journal.snapshot),
      decision,
      remoteUpdated: journal.snapshot.remoteUpdated ?? false
    };
  }

  async #authorizingPolicy(
    task: FactoryTaskSnapshot,
    proposal: FactoryPullRequestUpdateSnapshot["run"]["proposal"]
  ): Promise<{ readonly decision: FactoryPolicyDecision; readonly item: EvidenceItem }> {
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const item = requireExactPolicyItem(
      bundles.flatMap(({ bundle }) => bundle.items),
      proposal.repairedPatchProposalDigest,
      proposal.policyEvaluationDigest
    );
    const evaluation = this.dependencies.documents.policyEvaluation(
      parseJson(
        await this.dependencies.artifacts.readText(
          item.artifact.digest,
          item.artifact.sizeBytes + 1
        )
      )
    );
    if (
      evaluation.digest !== proposal.policyEvaluationDigest ||
      evaluation.value.taskId !== task.contract.taskId ||
      evaluation.value.contractDigest !== task.contractDigest ||
      evaluation.value.policyBundleDigest !== task.contract.gateProfile.policyDigest ||
      evaluation.value.stage !== "pull-request-creation" ||
      evaluation.value.approvalSubjectDigest !== proposal.repairedPatchProposalDigest ||
      evaluation.value.decision.outcome !== "allow"
    ) {
      throw new Error("Durable PR update policy artifact is not its exact allowing decision.");
    }
    return { decision: evaluation.value.decision, item };
  }

  async #repairedPatch(
    task: FactoryTaskSnapshot,
    bundles: readonly StoredEvidenceBundle[],
    runId: string
  ): Promise<CanonicalFactoryDocument<FactoryPatchProposal>> {
    const events = await this.dependencies.executions.listEvents(runId);
    const repairer = events.filter(
      (
        event
      ): event is Extract<
        FactoryExecutionEvent,
        { kind: "operation-finished"; operationKind: "agent" }
      > =>
        event.kind === "operation-finished" &&
        event.operationKind === "agent" &&
        event.role === "repairer" &&
        event.result === "succeeded"
    );
    if (repairer.length !== 1) {
      throw new Error("Completed PR repair must contain one successful repairer operation.");
    }
    const executionId = repairer[0]?.operationId;
    for (const item of bundles.flatMap(({ bundle }) => bundle.items).toReversed()) {
      if (item.kind !== "patch" || item.artifact.mediaType !== patchMediaType) continue;
      const patch = this.dependencies.documents.patchProposal(
        parseJson(
          await this.dependencies.artifacts.readText(
            item.artifact.digest,
            item.artifact.sizeBytes + 1
          )
        )
      );
      if (
        patch.value.executionId === executionId &&
        patch.value.taskId === task.contract.taskId &&
        patch.value.contractDigest === task.contractDigest
      ) {
        return (
          await this.#reader.priorPatch({
            bundles,
            expectedDigest: patch.digest,
            task
          })
        ).proposal;
      }
    }
    throw new Error("PR update found no exact repaired patch evidence.");
  }

  async #recordEvidence(
    task: FactoryTaskSnapshot,
    proposal: CanonicalFactoryDocument<FactoryPullRequestUpdateSnapshot["run"]["proposal"]>,
    record: FactoryPullRequestUpdateRecord,
    policyItem: EvidenceItem
  ): Promise<StoredEvidenceBundle> {
    const existing = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const recordDocument = this.dependencies.documents.pullRequestUpdateRecord(record);
    for (const evidence of existing.toReversed()) {
      const item = evidence.bundle.items.find(
        (candidate) =>
          candidate.kind === "pull-request" &&
          candidate.result === "pass" &&
          candidate.subjectDigest === proposal.value.repairedPatchProposalDigest &&
          candidate.artifact.digest === recordDocument.digest &&
          candidate.producer.kind === "broker" &&
          candidate.producer.role === "pr-broker" &&
          candidate.producer.id === this.#identity.brokerId
      );
      if (item !== undefined) return evidence;
    }
    return this.#publisher.pullRequestUpdate({
      task,
      proposal,
      record,
      authorizingPolicyItem: policyItem
    });
  }

  #assertRecordedTask(task: FactoryTaskSnapshot, evidenceBundleDigest: string): Sha256Digest {
    const event = task.lastEvent;
    if (
      task.state !== "pr-open" ||
      event.from !== "pr-proposed" ||
      event.to !== "pr-open" ||
      event.actor.kind !== "broker" ||
      event.actor.role !== "pr-broker" ||
      event.actor.id !== this.#identity.brokerId ||
      event.actor.sessionId !== null ||
      event.reasonCode !== "draft-pr-repaired" ||
      event.evidenceBundleDigest !== evidenceBundleDigest
    ) {
      throw new Error("Task ledger does not contain the exact durable PR update transition.");
    }
    return this.dependencies.documents.taskEvent(event).digest;
  }

  async #disabledOutcome(
    decision: FactoryPolicyDecision
  ): Promise<FactoryPullRequestUpdateOutcome | null> {
    return (await this.dependencies.controls.state()).prBroker
      ? null
      : {
          status: "denied",
          reasonCodes: ["pr-broker-disabled-after-policy"],
          decision
        };
  }

  #requireUnexpired(task: FactoryTaskSnapshot, phase: string): string {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (now >= task.contract.expiresAt) throw new Error(`PR update task expired ${phase}.`);
    return now;
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function requiredRecord(
  snapshot: FactoryPullRequestUpdateSnapshot
): FactoryPullRequestUpdateRecord {
  if (snapshot.record === null) throw new Error("PR update has no durable remote record.");
  return snapshot.record;
}

function requiredEvidenceDigest(snapshot: FactoryPullRequestUpdateSnapshot): Sha256Digest {
  if (snapshot.evidenceBundleDigest === null) {
    throw new Error("PR update has no durable evidence-bundle digest.");
  }
  return snapshot.evidenceBundleDigest;
}

function repairedCommitTitle(title: string, attempt: number): string {
  const suffix = ` (repair ${String(attempt)})`;
  return `${title.slice(0, 120 - suffix.length)}${suffix}`;
}

function brokerActor(id: string) {
  return { kind: "broker", role: "pr-broker", id, sessionId: null } as const;
}

function denied(reasonCode: string): FactoryPullRequestUpdateOutcome {
  return { status: "denied", reasonCodes: [reasonCode], decision: null };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored factory artifact is invalid JSON.", { cause: error });
  }
}
