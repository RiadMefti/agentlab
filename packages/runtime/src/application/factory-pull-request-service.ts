import {
  factoryPullRequestRecordSchema,
  type EvidenceItem,
  type FactoryPolicyDecision,
  type FactoryPullRequestRecord,
  type FactoryTaskUsageRecord
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
  FactoryRepositoryGovernance
} from "../domain/factory-pull-request-broker.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import { isFactoryTaskTransitionAllowed } from "../domain/factory-task-state.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";

const brokerInputSchema = z.object({ taskId: z.uuid() }).strict();
const maximumPullRequestBodyCharacters = 16_384;

export interface FactoryPullRequestServiceDependencies {
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence" | "latestEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "evaluatePolicy" | "transition">;
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

/** Revalidates exact local evidence and remote governance before invoking the sole write broker. */
export class FactoryPullRequestService {
  readonly #publisher: FactoryEvidencePublisher;

  public constructor(private readonly dependencies: FactoryPullRequestServiceDependencies) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { prBroker: dependencies.evidenceCredentials.prBroker },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
  }

  public async openDraft(input: unknown): Promise<FactoryPullRequestOutcome> {
    const command = brokerInputSchema.parse(input);
    let task = await this.#requireTask(command.taskId);
    if (task.state !== "pr-proposed") {
      throw new Error("Draft PR creation requires a reviewed PR proposal.");
    }
    if (task.contract.riskTier !== "R1") {
      return {
        status: "denied",
        reasonCodes: ["broker-risk-tier-unsupported"],
        decision: null
      };
    }
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) throw new Error("PR broker requires its active local repository.");

    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const patch = await this.#readLatestPatch(
      task,
      bundles.flatMap(({ bundle }) => bundle.items)
    );
    const usage = await this.#readUsage(
      task,
      patch.digest,
      bundles.flatMap(({ bundle }) => bundle.items)
    );
    const remote = await this.dependencies.remote.inspect(task.contract.repository.id);
    if (remote.repositoryId !== task.contract.repository.id) {
      throw new Error("PR broker returned another repository identity.");
    }
    const governanceReasons = governanceDenials(remote.governance);
    if (governanceReasons.length > 0) {
      return { status: "denied", reasonCodes: governanceReasons, decision: null };
    }

    const policy = await this.dependencies.controlPlane.evaluatePolicy({
      taskId: task.contract.taskId,
      stage: "pull-request-creation",
      approvalSubjectDigest: patch.digest,
      currentBaseRevision: remote.baseRevision,
      changeSet: patch.value.changeSet,
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
    const policyItem = exactPolicyItem(policy.evidence.bundle.items, patch.digest);
    const proposal = this.dependencies.documents.pullRequestProposal({
      schemaVersion: "agentlab.pull-request-proposal.v1",
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      patchProposalDigest: patch.digest,
      patchArtifactDigest: patch.value.patchArtifact.digest,
      changeSet: patch.value.changeSet,
      policyEvaluationDigest: policyItem.artifact.digest,
      deduplicationKey: task.contract.deduplicationKey,
      repositoryId: task.contract.repository.id,
      baseRevision: task.contract.repository.baseRevision,
      baseBranch: remote.baseBranch,
      branchName: `agentlab/${task.contract.deduplicationKey.slice("sha256:".length)}`,
      title: pullRequestTitle(task.contract.objective),
      body: pullRequestBody(task, patch.digest, usage.value),
      draft: true,
      createdAt: this.dependencies.now()
    });
    const storedProposal = await this.dependencies.artifacts.putText(proposal.json);
    if (storedProposal.digest !== proposal.digest) {
      throw new Error("PR proposal digest changed in immutable storage.");
    }
    const patchText = await this.dependencies.artifacts.readText(
      patch.value.patchArtifact.digest,
      Math.max(1, patch.value.patchArtifact.sizeBytes + 1)
    );
    if (!(await this.dependencies.controls.state()).prBroker) {
      return {
        status: "denied",
        reasonCodes: ["pr-broker-disabled-after-policy"],
        decision: policy.decision
      };
    }

    let opened: Awaited<ReturnType<FactoryDraftPullRequestBroker["openDraft"]>> | null = null;
    try {
      opened = await this.dependencies.remote.openDraft({
        proposal: proposal.value,
        patch: patchText,
        repositoryRoot
      });
      const record = validateBrokerRecord(opened.record, proposal.digest, proposal.value);
      if (!(await this.dependencies.controls.state()).prBroker) {
        throw new Error("PR broker authority was revoked during remote creation.");
      }
      await this.#publisher.pullRequest({
        task,
        proposal,
        record,
        authorizingPolicyItem: policyItem
      });
      const latest = await this.dependencies.evidence.latestEvidence(task.contract.taskId);
      task = await this.dependencies.controlPlane.transition({
        taskId: task.contract.taskId,
        expectedState: "pr-proposed",
        nextState: "pr-open",
        actor: {
          kind: "broker",
          role: "pr-broker",
          id: record.brokerId,
          sessionId: null
        },
        reasonCode: "draft-pr-opened",
        evidenceBundleDigest: latest?.digest ?? null
      });
      return { status: "opened", record, decision: policy.decision };
    } catch (error: unknown) {
      if (opened?.created === true) {
        try {
          await this.dependencies.remote.closeDraft(opened.record, "AgentLab broker rollback");
        } catch (compensationError: unknown) {
          if (isFactoryTaskTransitionAllowed(task.state, "quarantined")) {
            try {
              await this.dependencies.controlPlane.transition({
                taskId: task.contract.taskId,
                expectedState: task.state,
                nextState: "quarantined",
                actor: brokerActor,
                reasonCode: "pr-compensation-failed"
              });
            } catch (transitionError: unknown) {
              throw new AggregateError(
                [error, compensationError, transitionError],
                "PR creation, compensation, and quarantine recording failed."
              );
            }
          }
          throw new AggregateError(
            [error, compensationError],
            "PR creation failed and the draft could not be closed."
          );
        }
      }
      throw error;
    }
  }

  async #readLatestPatch(task: FactoryTaskSnapshot, items: readonly EvidenceItem[]) {
    for (const item of [...items].reverse()) {
      if (
        item.kind !== "patch" ||
        item.result !== "pass" ||
        item.producer.kind !== "control-plane" ||
        item.producer.role !== "gate-runner"
      ) {
        continue;
      }
      const json = await this.dependencies.artifacts.readText(
        item.artifact.digest,
        Math.max(1, item.artifact.sizeBytes + 1)
      );
      const document = this.dependencies.documents.patchProposal(parseJson(json));
      if (
        document.digest === item.artifact.digest &&
        document.digest === item.subjectDigest &&
        document.value.taskId === task.contract.taskId &&
        document.value.contractDigest === task.contractDigest
      ) {
        return document;
      }
    }
    throw new Error("PR broker found no valid patch proposal evidence.");
  }

  async #readUsage(
    task: FactoryTaskSnapshot,
    patchDigest: string,
    items: readonly EvidenceItem[]
  ): Promise<CanonicalFactoryDocument<FactoryTaskUsageRecord>> {
    for (const item of [...items].reverse()) {
      if (
        item.kind !== "usage" ||
        item.subjectDigest !== patchDigest ||
        item.producer.kind !== "control-plane" ||
        item.producer.role !== "gate-runner"
      ) {
        continue;
      }
      const json = await this.dependencies.artifacts.readText(
        item.artifact.digest,
        Math.max(1, item.artifact.sizeBytes + 1)
      );
      const document = this.dependencies.documents.taskUsage(parseJson(json));
      if (
        document.digest === item.artifact.digest &&
        document.value.taskId === task.contract.taskId &&
        document.value.contractDigest === task.contractDigest &&
        document.value.patchProposalDigest === patchDigest &&
        item.result === (document.value.complete ? "pass" : "informational")
      ) {
        return document;
      }
    }
    throw new Error("PR broker found no exact aggregate usage evidence.");
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function governanceDenials(governance: FactoryRepositoryGovernance): readonly string[] {
  const reasons: string[] = [];
  if (!governance.requiresPullRequest) reasons.push("repository-pr-rule-missing");
  if (governance.requiredApprovals < 1) reasons.push("repository-approval-rule-too-weak");
  if (!governance.dismissesStaleReviews) reasons.push("repository-stale-review-rule-missing");
  if (!governance.requiresLastPushApproval) reasons.push("repository-last-push-rule-missing");
  if (!governance.enforcesAdmins) reasons.push("repository-admin-bypass-enabled");
  if (governance.allowsForcePushes) reasons.push("repository-force-push-enabled");
  if (governance.allowsDeletions) reasons.push("repository-branch-deletion-enabled");
  if (!governance.requiredStatusChecks.includes("verify")) {
    reasons.push("repository-verify-check-missing");
  }
  return reasons.sort();
}

function exactPolicyItem(items: readonly EvidenceItem[], subjectDigest: string): EvidenceItem {
  const item = items.find(
    (candidate) =>
      candidate.kind === "policy" &&
      candidate.result === "pass" &&
      candidate.subjectDigest === subjectDigest &&
      candidate.producer.kind === "control-plane" &&
      candidate.producer.role === "policy-engine"
  );
  if (item === undefined) throw new Error("Policy allow evidence is missing from its own bundle.");
  return item;
}

function validateBrokerRecord(
  input: unknown,
  proposalDigest: string,
  proposal: ReturnType<FactoryDocumentCodec["pullRequestProposal"]>["value"]
): FactoryPullRequestRecord {
  const record = factoryPullRequestRecordSchema.parse(input);
  if (
    record.taskId !== proposal.taskId ||
    record.contractDigest !== proposal.contractDigest ||
    record.proposalDigest !== proposalDigest ||
    record.repositoryId !== proposal.repositoryId ||
    record.baseRevision !== proposal.baseRevision ||
    record.branchName !== proposal.branchName ||
    record.headRevision === record.baseRevision
  ) {
    throw new Error("PR broker result does not match the authorized proposal.");
  }
  return record;
}

function pullRequestTitle(objective: string): string {
  const firstLine = replaceAsciiControls(objective.split("\n", 1)[0] ?? "", " ", false)
    .replace(/\s+/gu, " ")
    .trim();
  const title = escapeGitHubText(firstLine.length === 0 ? "AgentLab factory change" : firstLine);
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function pullRequestBody(
  task: FactoryTaskSnapshot,
  patchDigest: string,
  usage: FactoryTaskUsageRecord
): string {
  const prelude = [
    "AgentLab brokered draft PR. Agent output is an untrusted proposal; repository rules remain authoritative.",
    "",
    `Task: ${task.contract.taskId}`,
    `Contract: ${task.contractDigest}`,
    `Patch proposal: ${patchDigest}`,
    `Policy: ${task.contract.gateProfile.policyDigest}`,
    `Usage complete: ${String(usage.complete)}`,
    "",
    "Acceptance criteria:"
  ].join("\n");
  const omission = "\n- [ ] Additional acceptance criteria omitted from this bounded summary.";
  let body = prelude;
  for (const criterion of task.contract.acceptanceCriteria) {
    const line = `\n- [ ] ${escapeGitHubText(criterion)}`;
    if (body.length + line.length <= maximumPullRequestBodyCharacters) {
      body += line;
      continue;
    }
    if (body.length + omission.length <= maximumPullRequestBodyCharacters) body += omission;
    break;
  }
  return body;
}

function escapeGitHubText(value: string): string {
  const normalized = value
    .replaceAll("@", "@\u200b")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  return replaceAsciiControls(normalized, "�", true).replaceAll("\n", "\n  ");
}

function replaceAsciiControls(value: string, replacement: string, preserveLayout: boolean): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || codePoint === 0x7f;
    const preserved = preserveLayout && (codePoint === 0x09 || codePoint === 0x0a);
    return isControl && !preserved ? replacement : character;
  }).join("");
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored factory artifact is invalid JSON.", { cause: error });
  }
}

const brokerActor = {
  kind: "broker",
  role: "pr-broker",
  id: "agentlab-pr-broker",
  sessionId: null
} as const;
