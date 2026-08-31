import {
  factoryTaskStateSchema,
  type FactoryBudgetUsage,
  type FactoryExecutionRole,
  type FactoryPatchProposal,
  type FactoryReviewResult,
  type ImmutableTaskContract
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type {
  FactoryAgentExecutor,
  FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { FactoryBudgetMeter } from "../domain/factory-budget-meter.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryGateExecutor } from "../domain/factory-gate.js";
import type { FactoryPolicyEngine } from "../domain/factory-policy.js";
import type { FactoryExecutionRepository } from "../domain/factory-execution-repository.js";
import {
  resolveFactorySkillPlan,
  selectFactorySkills,
  type FactorySkillSource,
  type ResolvedFactorySkill
} from "../domain/factory-skill.js";
import type {
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import { isFactoryTaskTransitionAllowed } from "../domain/factory-task-state.js";
import type {
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../domain/factory-workspace.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import {
  FactoryExecutionJournalSession,
  type FactoryExecutionJournalDependencies
} from "./factory-execution-journal.js";
import type { FactoryExecutionRecoveryService } from "./factory-execution-recovery-service.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import { FactoryExecutionOperations, patchLimits } from "./factory-execution-operations.js";

const executionInputSchema = z
  .object({
    taskId: z.uuid(),
    correlationId: z.uuid().optional()
  })
  .strict();

type WorkerProfile = ImmutableTaskContract["agentPolicy"]["workerProfiles"][number];

interface FactoryExecutionProgress {
  task: FactoryTaskSnapshot;
  repairs: number;
  seedPatch: FactoryWorkspacePatch | null;
  priorReview: FactoryReviewResult | undefined;
  latestPatch: CanonicalFactoryDocument<FactoryPatchProposal> | null;
  reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[];
}

export interface FactoryExecutionServiceDependencies extends Omit<
  FactoryExecutionJournalDependencies,
  "executions"
> {
  readonly executions: FactoryExecutionRepository;
  readonly recovery: Pick<FactoryExecutionRecoveryService, "recover">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "latestEvidence">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<
    FactoryEvidencePublisherCredentials,
    "controlPlane" | "executionObserver" | "gateObserver"
  >;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryWorkspaceManager;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly gates: FactoryGateExecutor;
}

export interface FactoryExecutionOutcome {
  readonly status: "pr-proposed" | "failed" | "needs-attention" | "quarantined";
  readonly task: FactoryTaskSnapshot;
  readonly patch: CanonicalFactoryDocument<FactoryPatchProposal> | null;
  readonly reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[];
  readonly usage: FactoryBudgetUsage;
  readonly usageComplete: boolean;
}

/** Bounded R1 implement → verify → independent-review → repair orchestration. */
export class FactoryExecutionService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #operations: FactoryExecutionOperations;

  public constructor(private readonly dependencies: FactoryExecutionServiceDependencies) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: {
        controlPlane: dependencies.evidenceCredentials.controlPlane,
        executionObserver: dependencies.evidenceCredentials.executionObserver,
        gateObserver: dependencies.evidenceCredentials.gateObserver
      },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#operations = new FactoryExecutionOperations(dependencies, this.#publisher);
  }

  public async execute(input: unknown): Promise<FactoryExecutionOutcome> {
    const command = executionInputSchema.parse(input);
    const task = await this.#requireTask(command.taskId);
    if (task.state !== "queued") throw new Error("Factory execution requires a queued task.");
    if (task.contract.riskTier !== "R1") {
      throw new Error("The initial autonomous execution lane admits R1 tasks only.");
    }
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) {
      throw new Error("Factory execution requires its active owning conversation.");
    }
    const resolvedSkills = await resolveFactorySkillPlan(this.dependencies.skills, task.contract);
    const correlationId = command.correlationId ?? z.uuid().parse(this.dependencies.createId());
    const journal = await FactoryExecutionJournalSession.start(
      this.dependencies,
      task,
      correlationId
    );
    const meter = new FactoryBudgetMeter();
    const progress: FactoryExecutionProgress = {
      task,
      repairs: 0,
      seedPatch: null,
      priorReview: undefined,
      latestPatch: null,
      reviews: []
    };
    let ownedWorkspace: FactoryWorkspace | null = null;
    try {
      await this.#publisher.skillPlan(progress.task, resolvedSkills);
      progress.task = await this.#transition(progress.task, "executing", "implementation-started");
      while (progress.repairs <= progress.task.contract.budget.maxRepairAttempts) {
        const attempt = progress.repairs + 1;
        const workspaceId = await journal.startAttempt(attempt);
        let decision: "continue" | "finish" = "finish";
        try {
          ownedWorkspace = await this.dependencies.workspaces.create({
            taskId: progress.task.contract.taskId,
            attempt,
            repositoryRoot,
            baseRevision: progress.task.contract.repository.baseRevision,
            workspaceId
          });
          if (
            ownedWorkspace.id !== workspaceId ||
            ownedWorkspace.taskId !== progress.task.contract.taskId ||
            ownedWorkspace.attempt !== attempt ||
            ownedWorkspace.repositoryRoot !== repositoryRoot ||
            ownedWorkspace.baseRevision !== progress.task.contract.repository.baseRevision
          ) {
            throw new Error("Factory workspace does not match its durable execution coordinates.");
          }
          decision = await this.#runAttempt(
            progress,
            ownedWorkspace,
            resolvedSkills,
            meter,
            journal
          );
        } finally {
          if (ownedWorkspace !== null && journal.snapshot.state === "workspace-active") {
            await this.#closeWorkspace(ownedWorkspace, progress.task);
            ownedWorkspace = null;
            await journal.closeAttempt(decision);
          }
        }
        if (decision === "continue") continue;
        await journal.finish(finishedTaskState(progress.task));
        return outcome(
          progress.task,
          progress.latestPatch,
          progress.reviews,
          meter,
          progress.repairs
        );
      }
      progress.task = await this.#transition(
        progress.task,
        "needs-attention",
        "repair-budget-exhausted"
      );
      await journal.finish("needs-attention");
      return outcome(
        progress.task,
        progress.latestPatch,
        progress.reviews,
        meter,
        progress.repairs
      );
    } catch (error: unknown) {
      try {
        await this.dependencies.recovery.recover({
          taskId: progress.task.contract.taskId,
          correlationId
        });
        if (ownedWorkspace !== null) {
          await ownedWorkspace.closeAndWait();
          ownedWorkspace = null;
        }
      } catch (recoveryError: unknown) {
        throw new AggregateError(
          [error, recoveryError],
          "Factory execution failed and durable recovery could not be confirmed.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async #runAttempt(
    progress: FactoryExecutionProgress,
    workspace: FactoryWorkspace,
    resolvedSkills: readonly ResolvedFactorySkill[],
    meter: FactoryBudgetMeter,
    journal: FactoryExecutionJournalSession
  ): Promise<"continue" | "finish"> {
    const attempt = progress.repairs + 1;
    if (progress.seedPatch !== null) {
      await this.dependencies.workspaces.apply(
        workspace,
        progress.seedPatch.patch,
        progress.task.contract.budget.maxOutputBytes
      );
    }
    const role: FactoryExecutionRole = progress.repairs === 0 ? "implementer" : "repairer";
    const phase = progress.repairs === 0 ? "implement" : "repair";
    const profile = workerProfile(progress.task.contract, role);
    const selection = selectFactorySkills({
      contract: progress.task.contract,
      resolved: resolvedSkills,
      phase,
      provider: profile.provider
    });
    const worker = await this.#operations.runAgent({
      task: progress.task,
      workspace,
      role,
      profile,
      skills: selection.skills,
      budget: selection.budget,
      attempt,
      journal,
      ...(progress.latestPatch === null
        ? {}
        : { patchProposalDigest: progress.latestPatch.digest }),
      ...(progress.priorReview === undefined ? {} : { repairReview: progress.priorReview })
    });
    meter.addAgent(worker.output);
    if (worker.output.status !== "succeeded") {
      progress.task = await this.#transition(progress.task, "failed", `${role}-run-failed`);
      return "finish";
    }

    const collected = await this.dependencies.workspaces.collect(
      workspace,
      patchLimits(progress.task)
    );
    progress.latestPatch = await this.#publisher.patch(
      progress.task,
      worker.published.document.value.executionId,
      collected
    );
    progress.task = await this.#transition(progress.task, "verifying", "patch-captured");
    if (meter.exceeds(progress.task.contract.budget, collected.changeSet, progress.repairs)) {
      progress.task = await this.#transition(
        progress.task,
        "needs-attention",
        "task-budget-exhausted"
      );
      return "finish";
    }
    const verification = await this.#operations.verify(
      progress.task,
      workspace,
      progress.latestPatch,
      collected,
      meter,
      progress.repairs,
      journal
    );
    if (!verification.passed) {
      if (verification.disposition === "quarantine") {
        progress.task = await this.#transition(progress.task, "quarantined", verification.reason);
        return "finish";
      }
      if (
        verification.disposition === "repair" &&
        this.#canRepair(progress.task.contract, progress.repairs, resolvedSkills)
      ) {
        progress.repairs += 1;
        progress.seedPatch = collected;
        progress.priorReview = undefined;
        progress.reviews = [];
        progress.task = await this.#transition(progress.task, "repairing", verification.reason);
        return "continue";
      }
      progress.task = await this.#transition(progress.task, "needs-attention", verification.reason);
      return "finish";
    }
    if (meter.exceeds(progress.task.contract.budget, collected.changeSet, progress.repairs)) {
      progress.task = await this.#transition(
        progress.task,
        "needs-attention",
        "task-budget-exhausted"
      );
      return "finish";
    }

    progress.task = await this.#transition(progress.task, "reviewing", "quality-gates-passed");
    const reviewResult = await this.#operations.review({
      task: progress.task,
      workspace,
      patch: progress.latestPatch,
      expectedPatch: collected,
      implementer: worker.published,
      resolvedSkills,
      attempt,
      meter,
      repairAttempts: progress.repairs,
      journal
    });
    progress.reviews = reviewResult.reviews;
    if (!reviewResult.passed) {
      if (reviewResult.disposition === "quarantine") {
        progress.task = await this.#transition(progress.task, "quarantined", reviewResult.reason);
        return "finish";
      }
      if (
        reviewResult.disposition === "repair" &&
        reviewResult.repairReview !== undefined &&
        this.#canRepair(progress.task.contract, progress.repairs, resolvedSkills)
      ) {
        progress.repairs += 1;
        progress.seedPatch = collected;
        progress.priorReview = reviewResult.repairReview;
        progress.task = await this.#transition(progress.task, "repairing", reviewResult.reason);
        return "continue";
      }
      progress.task = await this.#transition(progress.task, "needs-attention", reviewResult.reason);
      return "finish";
    }
    if (
      meter.exceeds(
        progress.task.contract.budget,
        progress.latestPatch.value.changeSet,
        progress.repairs
      )
    ) {
      progress.task = await this.#transition(
        progress.task,
        "needs-attention",
        "task-budget-exhausted"
      );
      return "finish";
    }
    await this.#publisher.taskUsage(
      progress.task,
      progress.latestPatch.digest,
      meter.finish(progress.latestPatch.value.changeSet, progress.repairs),
      meter.complete
    );
    progress.task = await this.#transition(
      progress.task,
      "pr-proposed",
      "independent-review-passed"
    );
    return "finish";
  }

  #canRepair(
    contract: ImmutableTaskContract,
    repairs: number,
    skills: readonly ResolvedFactorySkill[]
  ): boolean {
    return (
      repairs < contract.budget.maxRepairAttempts &&
      contract.skillPlan.some(({ phase }) => phase === "repair") &&
      skills.some(({ manifest }) => manifest.roles.includes("repairer"))
    );
  }

  async #transition(
    task: FactoryTaskSnapshot,
    nextState: z.infer<typeof factoryTaskStateSchema>,
    reasonCode: string
  ): Promise<FactoryTaskSnapshot> {
    const latest = await this.dependencies.evidence.latestEvidence(task.contract.taskId);
    return this.dependencies.controlPlane.transition({
      taskId: task.contract.taskId,
      expectedState: task.state,
      nextState,
      actor: orchestratorActor,
      reasonCode,
      evidenceBundleDigest: latest?.digest ?? null
    });
  }

  async #closeWorkspace(workspace: FactoryWorkspace, task: FactoryTaskSnapshot): Promise<void> {
    try {
      await workspace.closeAndWait();
    } catch (cleanupError: unknown) {
      let transitionError: unknown = null;
      if (isFactoryTaskTransitionAllowed(task.state, "quarantined")) {
        try {
          await this.#transition(task, "quarantined", "workspace-cleanup-failed");
        } catch (error: unknown) {
          transitionError = error;
        }
      }
      const cleanupFailure = new Error("Factory workspace cleanup could not be confirmed.", {
        cause: cleanupError
      });
      if (transitionError !== null) {
        throw new AggregateError(
          [cleanupFailure, transitionError],
          "Workspace cleanup and quarantine recording both failed."
        );
      }
      throw cleanupFailure;
    }
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

const orchestratorActor = {
  kind: "control-plane",
  role: "planner",
  id: "agentlab-local-orchestrator",
  sessionId: null
} as const;

function workerProfile(contract: ImmutableTaskContract, role: FactoryExecutionRole): WorkerProfile {
  const profile = contract.agentPolicy.workerProfiles.find(({ roles }) => roles.includes(role));
  if (profile === undefined) throw new Error(`Task has no pinned ${role} worker profile.`);
  return profile;
}

function finishedTaskState(
  task: FactoryTaskSnapshot
): "pr-proposed" | "needs-attention" | "failed" | "quarantined" {
  if (
    task.state === "pr-proposed" ||
    task.state === "needs-attention" ||
    task.state === "failed" ||
    task.state === "quarantined"
  ) {
    return task.state;
  }
  throw new Error(`Factory execution stopped in non-terminal handoff state ${task.state}.`);
}

function outcome(
  task: FactoryTaskSnapshot,
  patch: CanonicalFactoryDocument<FactoryPatchProposal> | null,
  reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[],
  meter: FactoryBudgetMeter,
  repairs: number
): FactoryExecutionOutcome {
  const changeSet = patch?.value.changeSet ?? {
    baseRevision: task.contract.repository.baseRevision,
    headRevision: null,
    changedPaths: [],
    binaryPaths: [],
    changedFiles: 0,
    changedLines: 0
  };
  return {
    status:
      task.state === "pr-proposed"
        ? "pr-proposed"
        : task.state === "quarantined"
          ? "quarantined"
          : task.state === "failed"
            ? "failed"
            : "needs-attention",
    task,
    patch,
    reviews,
    usage: meter.finish(changeSet, repairs),
    usageComplete: meter.complete
  };
}
