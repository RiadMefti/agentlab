import {
  type FactoryPolicyDecision,
  type FactoryRiskTier,
  type FactoryTaskState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { FactoryRepositoryRevisionReader } from "../domain/factory-repository-revision.js";
import type {
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";

const admissionInputSchema = z.object({ taskId: z.uuid() }).strict();

export interface FactoryExecutionAdmissionServiceDependencies {
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly revisions: FactoryRepositoryRevisionReader;
  readonly controlPlane: Pick<FactoryControlPlane, "evaluatePolicy" | "transition">;
}

export interface FactoryExecutionAdmissionOutcome {
  readonly status: "queued" | "denied" | "needs-human";
  readonly task: FactoryTaskSnapshot;
  readonly decision: FactoryPolicyDecision | null;
  readonly policyEvidenceDigest: Sha256Digest | null;
}

/** Rechecks local repository state and admits only policy-approved R1 work for execution. */
export class FactoryExecutionAdmissionService {
  public constructor(private readonly dependencies: FactoryExecutionAdmissionServiceDependencies) {}

  public async admit(input: unknown): Promise<FactoryExecutionAdmissionOutcome> {
    const command = admissionInputSchema.parse(input);
    const task = await this.#requireTask(command.taskId);
    this.#assertAdmissibleRisk(task.contract.riskTier);
    if (task.state === "queued") {
      return { status: "queued", task, decision: null, policyEvidenceDigest: null };
    }
    this.#assertAdmissibleState(task.state);
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    if (conversation?.lifecycleState !== "active" || conversation.workspacePath === null) {
      throw new ConflictError("Factory execution admission requires its active conversation.");
    }
    const currentBaseRevision = await this.dependencies.revisions.currentRevision(
      conversation.workspacePath
    );
    const policy = await this.dependencies.controlPlane.evaluatePolicy({
      taskId: task.contract.taskId,
      stage: "execution",
      approvalSubjectDigest: task.contractDigest,
      currentBaseRevision,
      changeSet: {
        baseRevision: task.contract.repository.baseRevision,
        headRevision: null,
        changedPaths: [],
        binaryPaths: [],
        changedFiles: 0,
        changedLines: 0
      },
      usage: {
        wallClockSeconds: 0,
        agentTurns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicrousd: 0,
        processes: 0,
        outputBytes: 0,
        workers: 0,
        repairAttempts: 0,
        changedFiles: 0,
        changedLines: 0
      },
      usageComplete: true,
      approvals: [],
      scheduled: task.contract.trigger === "scheduled"
    });
    if (policy.decision.outcome !== "allow") {
      return {
        status: policy.decision.outcome === "deny" ? "denied" : "needs-human",
        task,
        decision: policy.decision,
        policyEvidenceDigest: policy.evidence.digest
      };
    }
    const queued = await this.dependencies.controlPlane.transition({
      taskId: task.contract.taskId,
      expectedState: "planned",
      nextState: "queued",
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-policy",
        sessionId: null
      },
      reasonCode: "execution-authorized",
      evidenceBundleDigest: policy.evidence.digest
    });
    return {
      status: "queued",
      task: queued,
      decision: policy.decision,
      policyEvidenceDigest: policy.evidence.digest
    };
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new NotFoundError(`Factory task ${taskId} does not exist.`);
    return task;
  }

  #assertAdmissibleState(state: FactoryTaskState): void {
    if (state !== "planned") {
      throw new ConflictError(`Factory execution admission requires a planned task, not ${state}.`);
    }
  }

  #assertAdmissibleRisk(riskTier: FactoryRiskTier): void {
    if (riskTier !== "R1") {
      throw new ConflictError("The initial autonomous execution lane admits R1 tasks only.");
    }
  }
}
