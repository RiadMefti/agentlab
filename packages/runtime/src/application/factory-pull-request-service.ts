import { type EvidenceItem, type FactoryTaskUsageRecord } from "@agentlab/contracts";
import { z } from "zod";

import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import {
  FactoryPullRequestDispatchService,
  type FactoryPullRequestDispatchServiceDependencies,
  type FactoryPullRequestOutcome
} from "./factory-pull-request-dispatch-service.js";
import {
  factoryRepositoryGovernanceDenials,
  requireExactPolicyItem
} from "./factory-pull-request-policy.js";

const brokerInputSchema = z
  .object({ taskId: z.uuid(), correlationId: z.uuid().optional() })
  .strict();
const maximumPullRequestBodyCharacters = 16_384;

export type FactoryPullRequestServiceDependencies = Omit<
  FactoryPullRequestDispatchServiceDependencies,
  "controlPlane"
> & {
  readonly controlPlane: Pick<FactoryControlPlane, "evaluatePolicy" | "transition">;
};

export type { FactoryPullRequestOutcome } from "./factory-pull-request-dispatch-service.js";

/** Authorizes an exact proposal before delegating its durable remote lifecycle. */
export class FactoryPullRequestService {
  readonly #dispatch: FactoryPullRequestDispatchService;

  public constructor(private readonly dependencies: FactoryPullRequestServiceDependencies) {
    this.#dispatch = new FactoryPullRequestDispatchService(dependencies);
  }

  public async openDraft(input: unknown): Promise<FactoryPullRequestOutcome> {
    const command = brokerInputSchema.parse(input);
    const task = await this.#requireTask(command.taskId);
    const existing = await this.dependencies.dispatches.findByTaskId(command.taskId);
    if (existing !== null) return this.#dispatch.resume(task, existing);
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
    if (this.#dispatch.identity.repositoryId !== task.contract.repository.id) {
      throw new Error("PR broker identity is not bound to the task repository.");
    }

    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const items = bundles.flatMap(({ bundle }) => bundle.items);
    const patch = await this.#readLatestPatch(task, items);
    const usage = await this.#readUsage(task, patch.digest, items);
    const remote = await this.dependencies.remote.inspect(task.contract.repository.id);
    if (remote.repositoryId !== task.contract.repository.id) {
      throw new Error("PR broker returned another repository identity.");
    }
    const governanceReasons = factoryRepositoryGovernanceDenials(remote.governance);
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
    const policyItem = requireExactPolicyItem(policy.evidence.bundle.items, patch.digest);
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
    return this.#dispatch.start(
      task,
      proposal,
      command.correlationId ?? z.uuid().parse(this.dependencies.createId())
    );
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
