import {
  factoryIdentifierSchema,
  factoryPullRequestRecordSchema,
  type EvidenceItem,
  type FactoryPolicyDecision,
  type FactoryPullRequestProposal,
  type FactoryPullRequestRecord
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryDraftPullRequestBroker,
  FactoryPullRequestBrokerIdentity
} from "../domain/factory-pull-request-broker.js";
import type {
  FactoryPullRequestDispatchRepository,
  FactoryPullRequestDispatchSnapshot
} from "../domain/factory-pull-request-dispatch-repository.js";
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
import {
  FactoryPullRequestDispatchJournalSession,
  type FactoryPullRequestDispatchJournalDependencies
} from "./factory-pull-request-dispatch-journal.js";
import {
  factoryRepositoryGovernanceDenials,
  requireExactPolicyItem
} from "./factory-pull-request-policy.js";

const brokerIdentitySchema = z
  .object({
    brokerId: factoryIdentifierSchema,
    repositoryId: factoryIdentifierSchema
  })
  .strict();

export interface FactoryPullRequestDispatchServiceDependencies {
  readonly dispatches: FactoryPullRequestDispatchRepository;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence" | "latestEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "prBroker">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly remote: FactoryDraftPullRequestBroker;
  readonly now: () => string;
  readonly createId: () => string;
}

export type FactoryPullRequestOutcome =
  | {
      readonly status: "opened";
      readonly record: FactoryPullRequestRecord;
      readonly decision: FactoryPolicyDecision;
    }
  | {
      readonly status: "denied" | "needs-human";
      readonly reasonCodes: readonly string[];
      readonly decision: FactoryPolicyDecision | null;
    };

/** Drives one immutable PR dispatch journal from authorization to the task ledger. */
export class FactoryPullRequestDispatchService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #identity: FactoryPullRequestBrokerIdentity;

  public constructor(private readonly dependencies: FactoryPullRequestDispatchServiceDependencies) {
    this.#identity = brokerIdentitySchema.parse(dependencies.remote.identity());
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { prBroker: dependencies.evidenceCredentials.prBroker },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
  }

  public get identity(): FactoryPullRequestBrokerIdentity {
    return this.#identity;
  }

  public async start(
    task: FactoryTaskSnapshot,
    proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>,
    correlationId: string
  ): Promise<FactoryPullRequestOutcome> {
    const authorization = await this.#authorizingPolicy(task, proposal.value);
    const denied = await this.#disabledOutcome(authorization.decision);
    if (denied !== null) return denied;
    const journal = await FactoryPullRequestDispatchJournalSession.start(
      this.#journalDependencies(),
      proposal,
      z.uuid().parse(correlationId)
    );
    return this.resume(task, journal.snapshot);
  }

  public async resume(
    task: FactoryTaskSnapshot,
    snapshot: FactoryPullRequestDispatchSnapshot
  ): Promise<FactoryPullRequestOutcome> {
    if (
      snapshot.run.taskId !== task.contract.taskId ||
      snapshot.run.contractDigest !== task.contractDigest ||
      snapshot.run.brokerId !== this.#identity.brokerId ||
      snapshot.run.proposal.repositoryId !== this.#identity.repositoryId
    ) {
      throw new Error("Durable PR dispatch does not match its task or configured broker identity.");
    }
    const proposal = this.dependencies.documents.pullRequestProposal(snapshot.run.proposal);
    if (proposal.digest !== snapshot.run.proposalDigest) {
      throw new Error("Durable PR dispatch proposal failed canonical digest validation.");
    }
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) throw new Error("PR dispatch recovery requires its repository.");
    const authorization = await this.#authorizingPolicy(task, proposal.value);
    const patchText = await this.dependencies.artifacts.readText(
      proposal.value.patchArtifactDigest,
      task.contract.budget.maxOutputBytes + 1
    );
    return this.#drive(
      task,
      FactoryPullRequestDispatchJournalSession.resume(this.#journalDependencies(), snapshot),
      repositoryRoot,
      authorization.decision,
      authorization.item,
      patchText
    );
  }

  async #drive(
    task: FactoryTaskSnapshot,
    journal: FactoryPullRequestDispatchJournalSession,
    repositoryRoot: string,
    decision: FactoryPolicyDecision,
    policyItem: EvidenceItem,
    patchText: string
  ): Promise<FactoryPullRequestOutcome> {
    const proposal = this.dependencies.documents.pullRequestProposal(journal.snapshot.run.proposal);
    if (proposal.digest !== journal.snapshot.run.proposalDigest || decision.outcome !== "allow") {
      throw new Error("Durable PR dispatch lost its exact allowing policy or proposal.");
    }

    if (journal.snapshot.state === "ready") {
      const denied = await this.#disabledOutcome(decision);
      if (denied !== null) return denied;
      await journal.startDispatch();
    }
    if (journal.snapshot.state === "dispatch-active") {
      const denied = await this.#disabledOutcome(decision);
      if (denied !== null) return denied;
      const remote = await this.dependencies.remote.inspect(proposal.value.repositoryId);
      if (
        remote.repositoryId !== proposal.value.repositoryId ||
        remote.baseBranch !== proposal.value.baseBranch ||
        remote.baseRevision !== proposal.value.baseRevision
      ) {
        throw new Error("Remote repository changed after durable PR authorization.");
      }
      const governanceReasons = factoryRepositoryGovernanceDenials(remote.governance);
      if (governanceReasons.length > 0) {
        return { status: "denied", reasonCodes: governanceReasons, decision };
      }
      const opened = await this.dependencies.remote.openDraft({
        proposal: proposal.value,
        patch: patchText,
        repositoryRoot
      });
      const record = validateBrokerRecord(
        opened.record,
        proposal.digest,
        proposal.value,
        this.#identity.brokerId
      );
      await journal.observeRemote(record, opened.created);
    }
    if (journal.snapshot.state === "remote-open") {
      const denied = await this.#disabledOutcome(decision);
      if (denied !== null) return denied;
      const record = requiredDispatchRecord(journal.snapshot);
      await this.dependencies.remote.verifyDraft({ proposal: proposal.value, record });
      const evidence = await this.#recordPullRequestEvidence(task, proposal, record, policyItem);
      await journal.recordEvidence(evidence.digest);
    }
    if (journal.snapshot.state === "evidence-recorded") {
      task = await this.#requireTask(task.contract.taskId);
      if (task.state === "pr-proposed") {
        const denied = await this.#disabledOutcome(decision);
        if (denied !== null) return denied;
        const evidenceDigest = requiredEvidenceDigest(journal.snapshot);
        const latest = await this.dependencies.evidence.latestEvidence(task.contract.taskId);
        if (latest?.digest !== evidenceDigest) {
          throw new Error("PR dispatch evidence is no longer the exact task ledger head.");
        }
        task = await this.dependencies.controlPlane.transition({
          taskId: task.contract.taskId,
          expectedState: "pr-proposed",
          nextState: "pr-open",
          actor: brokerActor(this.#identity.brokerId),
          reasonCode: "draft-pr-opened",
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
      throw new Error(`PR dispatch stopped in unexpected state ${journal.snapshot.state}.`);
    }
    return {
      status: "opened",
      record: requiredDispatchRecord(journal.snapshot),
      decision
    };
  }

  async #authorizingPolicy(
    task: FactoryTaskSnapshot,
    proposal: FactoryPullRequestProposal
  ): Promise<{ readonly decision: FactoryPolicyDecision; readonly item: EvidenceItem }> {
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const item = requireExactPolicyItem(
      bundles.flatMap(({ bundle }) => bundle.items),
      proposal.patchProposalDigest,
      proposal.policyEvaluationDigest
    );
    const json = await this.dependencies.artifacts.readText(
      item.artifact.digest,
      Math.max(1, item.artifact.sizeBytes + 1)
    );
    const evaluation = this.dependencies.documents.policyEvaluation(parseJson(json));
    if (
      evaluation.digest !== proposal.policyEvaluationDigest ||
      evaluation.value.taskId !== task.contract.taskId ||
      evaluation.value.contractDigest !== task.contractDigest ||
      evaluation.value.policyBundleDigest !== task.contract.gateProfile.policyDigest ||
      evaluation.value.stage !== "pull-request-creation" ||
      evaluation.value.approvalSubjectDigest !== proposal.patchProposalDigest ||
      evaluation.value.decision.outcome !== "allow"
    ) {
      throw new Error("Durable PR dispatch policy artifact is not its exact allowing decision.");
    }
    return { decision: evaluation.value.decision, item };
  }

  async #recordPullRequestEvidence(
    task: FactoryTaskSnapshot,
    proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>,
    record: FactoryPullRequestRecord,
    policyItem: EvidenceItem
  ): Promise<StoredEvidenceBundle> {
    const existing = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    for (const evidence of [...existing].reverse()) {
      if (await this.#isExactPullRequestEvidence(evidence, proposal, record)) return evidence;
    }
    return this.#publisher.pullRequest({
      task,
      proposal,
      record,
      authorizingPolicyItem: policyItem
    });
  }

  async #isExactPullRequestEvidence(
    evidence: StoredEvidenceBundle,
    proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>,
    record: FactoryPullRequestRecord
  ): Promise<boolean> {
    const hasPolicy = evidence.bundle.items.some(
      (item) =>
        item.kind === "policy" &&
        item.result === "pass" &&
        item.subjectDigest === proposal.value.patchProposalDigest &&
        item.artifact.digest === proposal.value.policyEvaluationDigest &&
        item.producer.kind === "control-plane" &&
        item.producer.role === "policy-engine"
    );
    const recordDocument = this.dependencies.documents.pullRequestRecord(record);
    const item = evidence.bundle.items.find(
      (candidate) =>
        candidate.kind === "pull-request" &&
        candidate.result === "pass" &&
        candidate.subjectDigest === proposal.value.patchProposalDigest &&
        candidate.artifact.digest === recordDocument.digest &&
        candidate.producer.kind === "broker" &&
        candidate.producer.role === "pr-broker" &&
        candidate.producer.id === this.#identity.brokerId
    );
    if (!hasPolicy || item === undefined) return false;
    const json = await this.dependencies.artifacts.readText(
      item.artifact.digest,
      Math.max(1, item.artifact.sizeBytes + 1)
    );
    const stored = this.dependencies.documents.pullRequestRecord(parseJson(json));
    return stored.digest === recordDocument.digest;
  }

  #assertRecordedTask(task: FactoryTaskSnapshot, evidenceBundleDigest: string) {
    const event = task.lastEvent;
    if (
      task.state !== "pr-open" ||
      event.from !== "pr-proposed" ||
      event.to !== "pr-open" ||
      event.actor.kind !== "broker" ||
      event.actor.role !== "pr-broker" ||
      event.actor.id !== this.#identity.brokerId ||
      event.actor.sessionId !== null ||
      event.reasonCode !== "draft-pr-opened" ||
      event.evidenceBundleDigest !== evidenceBundleDigest
    ) {
      throw new Error("Task ledger does not contain the exact durable PR-open transition.");
    }
    return this.dependencies.documents.taskEvent(event).digest;
  }

  async #disabledOutcome(
    decision: FactoryPolicyDecision
  ): Promise<FactoryPullRequestOutcome | null> {
    return (await this.dependencies.controls.state()).prBroker
      ? null
      : {
          status: "denied",
          reasonCodes: ["pr-broker-disabled-after-policy"],
          decision
        };
  }

  #journalDependencies(): FactoryPullRequestDispatchJournalDependencies {
    return {
      dispatches: this.dependencies.dispatches,
      documents: this.dependencies.documents,
      brokerId: this.#identity.brokerId,
      now: this.dependencies.now,
      createId: this.dependencies.createId
    };
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function validateBrokerRecord(
  input: unknown,
  proposalDigest: string,
  proposal: ReturnType<FactoryDocumentCodec["pullRequestProposal"]>["value"],
  brokerId: string
): FactoryPullRequestRecord {
  const record = factoryPullRequestRecordSchema.parse(input);
  if (
    record.taskId !== proposal.taskId ||
    record.contractDigest !== proposal.contractDigest ||
    record.proposalDigest !== proposalDigest ||
    record.repositoryId !== proposal.repositoryId ||
    record.baseRevision !== proposal.baseRevision ||
    record.branchName !== proposal.branchName ||
    record.brokerId !== brokerId ||
    record.headRevision === record.baseRevision
  ) {
    throw new Error("PR broker result does not match the authorized proposal.");
  }
  return record;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored factory artifact is invalid JSON.", { cause: error });
  }
}

function requiredDispatchRecord(
  snapshot: FactoryPullRequestDispatchSnapshot
): FactoryPullRequestRecord {
  if (snapshot.record === null) throw new Error("PR dispatch has no durable remote record.");
  return snapshot.record;
}

function requiredEvidenceDigest(snapshot: FactoryPullRequestDispatchSnapshot) {
  if (snapshot.evidenceBundleDigest === null) {
    throw new Error("PR dispatch has no durable evidence-bundle digest.");
  }
  return snapshot.evidenceBundleDigest;
}

function brokerActor(id: string) {
  return {
    kind: "broker",
    role: "pr-broker",
    id: factoryIdentifierSchema.parse(id),
    sessionId: null
  } as const;
}
