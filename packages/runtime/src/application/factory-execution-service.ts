import {
  factoryAgentRunRequestSchema,
  factoryTaskStateSchema,
  type FactoryBudgetUsage,
  type FactoryExecutionRole,
  type FactoryPatchProposal,
  type FactoryReviewResult,
  type ImmutableTaskContract,
  type Sha256Digest
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
  FactoryEvidencePublisher,
  type PublishedFactoryAgentRun
} from "./factory-evidence-publisher.js";
import { renderFactoryPrompt } from "./factory-prompt-renderer.js";

const executionInputSchema = z
  .object({
    taskId: z.uuid()
  })
  .strict();

type WorkerProfile = ImmutableTaskContract["agentPolicy"]["workerProfiles"][number];

export interface FactoryExecutionServiceDependencies {
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "latestEvidence">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition" | "recordEvidenceItems">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryWorkspaceManager;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly gates: FactoryGateExecutor;
  readonly now: () => string;
  readonly createId: () => string;
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

  public constructor(private readonly dependencies: FactoryExecutionServiceDependencies) {
    this.#publisher = new FactoryEvidencePublisher({
      controlPlane: dependencies.controlPlane,
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
  }

  public async execute(input: unknown): Promise<FactoryExecutionOutcome> {
    const command = executionInputSchema.parse(input);
    let task = await this.#requireTask(command.taskId);
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
    await this.#publisher.skillPlan(task, resolvedSkills);
    task = await this.#transition(task, "executing", "implementation-started");

    const meter = new FactoryBudgetMeter();
    let repairs = 0;
    let seedPatch: FactoryWorkspacePatch | null = null;
    let priorReview: FactoryReviewResult | undefined;
    let latestPatch: CanonicalFactoryDocument<FactoryPatchProposal> | null = null;
    let reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[] = [];

    while (repairs <= task.contract.budget.maxRepairAttempts) {
      const attempt = repairs + 1;
      let workspace: FactoryWorkspace;
      try {
        // Creation is handled separately because no owned workspace exists to clean on failure.
        workspace = await this.dependencies.workspaces.create({
          taskId: task.contract.taskId,
          attempt,
          repositoryRoot,
          baseRevision: task.contract.repository.baseRevision
        });
      } catch (error: unknown) {
        try {
          await this.#transition(task, "failed", "orchestration-error");
        } catch (transitionError: unknown) {
          throw new AggregateError(
            [error, transitionError],
            "Factory workspace creation failed and its terminal transition could not be recorded."
          );
        }
        throw error;
      }
      try {
        if (seedPatch !== null) {
          await this.dependencies.workspaces.apply(
            workspace,
            seedPatch.patch,
            task.contract.budget.maxOutputBytes
          );
        }
        const role: FactoryExecutionRole = repairs === 0 ? "implementer" : "repairer";
        const phase = repairs === 0 ? "implement" : "repair";
        const profile = workerProfile(task.contract, role);
        const selection = selectFactorySkills({
          contract: task.contract,
          resolved: resolvedSkills,
          phase,
          provider: profile.provider
        });
        const worker = await this.#runAgent({
          task,
          workspace,
          role,
          profile,
          skills: selection.skills,
          budget: selection.budget,
          attempt,
          ...(latestPatch === null ? {} : { patchProposalDigest: latestPatch.digest }),
          ...(priorReview === undefined ? {} : { repairReview: priorReview })
        });
        meter.addAgent(worker.output);
        if (worker.output.status !== "succeeded") {
          task = await this.#transition(task, "failed", `${role}-run-failed`);
          return outcome(task, latestPatch, reviews, meter, repairs);
        }

        const collected = await this.dependencies.workspaces.collect(workspace, patchLimits(task));
        latestPatch = await this.#publisher.patch(
          task,
          worker.published.document.value.executionId,
          collected
        );
        task = await this.#transition(task, "verifying", "patch-captured");
        if (meter.exceeds(task.contract.budget, collected.changeSet, repairs)) {
          task = await this.#transition(task, "needs-attention", "task-budget-exhausted");
          return outcome(task, latestPatch, reviews, meter, repairs);
        }
        const verification = await this.#verify(
          task,
          workspace,
          latestPatch,
          collected,
          meter,
          repairs
        );
        if (!verification.passed) {
          if (verification.disposition === "quarantine") {
            task = await this.#transition(task, "quarantined", verification.reason);
            return outcome(task, latestPatch, reviews, meter, repairs);
          }
          if (
            verification.disposition === "repair" &&
            this.#canRepair(task.contract, repairs, resolvedSkills)
          ) {
            repairs += 1;
            seedPatch = collected;
            priorReview = undefined;
            reviews = [];
            task = await this.#transition(task, "repairing", verification.reason);
            continue;
          }
          task = await this.#transition(task, "needs-attention", verification.reason);
          return outcome(task, latestPatch, reviews, meter, repairs);
        }
        if (meter.exceeds(task.contract.budget, collected.changeSet, repairs)) {
          task = await this.#transition(task, "needs-attention", "task-budget-exhausted");
          return outcome(task, latestPatch, reviews, meter, repairs);
        }

        task = await this.#transition(task, "reviewing", "quality-gates-passed");
        const reviewResult = await this.#review({
          task,
          workspace,
          patch: latestPatch,
          expectedPatch: collected,
          implementer: worker.published,
          resolvedSkills,
          attempt,
          meter
        });
        reviews = reviewResult.reviews;
        if (!reviewResult.passed) {
          if (reviewResult.disposition === "quarantine") {
            task = await this.#transition(task, "quarantined", reviewResult.reason);
            return outcome(task, latestPatch, reviews, meter, repairs);
          }
          if (
            reviewResult.disposition === "repair" &&
            reviewResult.repairReview !== undefined &&
            this.#canRepair(task.contract, repairs, resolvedSkills)
          ) {
            repairs += 1;
            seedPatch = collected;
            priorReview = reviewResult.repairReview;
            task = await this.#transition(task, "repairing", reviewResult.reason);
            continue;
          }
          task = await this.#transition(task, "needs-attention", reviewResult.reason);
          return outcome(task, latestPatch, reviews, meter, repairs);
        }
        if (meter.exceeds(task.contract.budget, latestPatch.value.changeSet, repairs)) {
          task = await this.#transition(task, "needs-attention", "task-budget-exhausted");
          return outcome(task, latestPatch, reviews, meter, repairs);
        }
        await this.#publisher.taskUsage(
          task,
          latestPatch.digest,
          meter.finish(latestPatch.value.changeSet, repairs),
          meter.complete
        );
        task = await this.#transition(task, "pr-proposed", "independent-review-passed");
        return outcome(task, latestPatch, reviews, meter, repairs);
      } catch (error: unknown) {
        if (isFactoryTaskTransitionAllowed(task.state, "failed")) {
          try {
            task = await this.#transition(task, "failed", "orchestration-error");
          } catch (transitionError: unknown) {
            throw new AggregateError(
              [error, transitionError],
              "Factory execution failed and its terminal transition could not be recorded."
            );
          }
        }
        throw error;
      } finally {
        await this.#closeWorkspace(workspace, task);
      }
    }
    task = await this.#transition(task, "needs-attention", "repair-budget-exhausted");
    return outcome(task, latestPatch, reviews, meter, repairs);
  }

  async #runAgent(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly role: FactoryExecutionRole;
    readonly profile: WorkerProfile;
    readonly skills: readonly ResolvedFactorySkill[];
    readonly budget: ImmutableTaskContract["budget"];
    readonly attempt: number;
    readonly patchProposalDigest?: Sha256Digest;
    readonly repairReview?: FactoryReviewResult;
  }) {
    const provider = await this.dependencies.providers.resolve(
      input.profile.provider,
      input.workspace.root
    );
    if (provider === null) {
      throw new Error(`Pinned provider ${input.profile.provider} is unavailable.`);
    }
    const capability = this.dependencies.agents
      .capabilities()
      .find(({ provider: id }) => id === input.profile.provider);
    if (!capability?.roles.includes(input.role)) {
      throw new Error(`Pinned provider cannot safely execute role ${input.role}.`);
    }
    const prompt = renderFactoryPrompt({
      role: input.role,
      contract: input.task.contract,
      contractDigest: input.task.contractDigest,
      skills: input.skills,
      attempt: input.attempt,
      ...(input.patchProposalDigest === undefined
        ? {}
        : { patchProposalDigest: input.patchProposalDigest }),
      ...(input.repairReview === undefined ? {} : { repairReview: input.repairReview })
    });
    const storedPrompt = await this.dependencies.artifacts.putText(prompt);
    const request = factoryAgentRunRequestSchema.parse({
      schemaVersion: "agentlab.agent-run-request.v1",
      executionId: this.dependencies.createId(),
      taskId: input.task.contract.taskId,
      contractDigest: input.task.contractDigest,
      role: input.role,
      attempt: input.attempt,
      provider: input.profile.provider,
      model: input.profile.model,
      reasoning: input.profile.reasoning,
      repository: input.task.contract.repository,
      promptArtifact: {
        digest: storedPrompt.digest,
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: storedPrompt.sizeBytes
      },
      outputSchemaDigest: null,
      skillDigests: input.skills.map(({ packageDigest }) => packageDigest),
      capabilities: selectFactorySkills({
        contract: input.task.contract,
        resolved: input.skills,
        phase:
          input.role === "implementer"
            ? "implement"
            : input.role === "repairer"
              ? "repair"
              : "review",
        provider: input.profile.provider
      }).capabilities,
      budget: input.budget
    });
    const output = await this.dependencies.agents.execute({
      request,
      executable: provider.executable,
      providerVersion: provider.version,
      workspace: input.workspace,
      prompt
    });
    const published = await this.#publisher.agentRun(input.task, request, output);
    return { output, published };
  }

  async #verify(
    task: FactoryTaskSnapshot,
    workspace: FactoryWorkspace,
    patch: CanonicalFactoryDocument<FactoryPatchProposal>,
    expectedPatch: FactoryWorkspacePatch,
    meter: FactoryBudgetMeter,
    repairs: number
  ): Promise<{
    readonly passed: boolean;
    readonly reason: string;
    readonly disposition: "repair" | "attention" | "quarantine";
  }> {
    const required = this.dependencies.policy.requirements(
      task.contract.riskTier,
      "pull-request-creation"
    );
    const externalGateIds = required.gateIds.filter(
      (gateId) => !preparationGateIds.has(gateId) && gateId !== "independent-review"
    );
    const installed = new Set(this.dependencies.gates.availableGateIds());
    for (const gateId of externalGateIds) {
      if (!installed.has(gateId)) {
        await this.#publisher.internalGate(
          task,
          patch.digest,
          gateId,
          "fail",
          `Required gate ${gateId} is not installed.`
        );
        return {
          passed: false,
          reason: `required-gate-unavailable/${gateId}`,
          disposition: "attention"
        };
      }
      const output = await this.dependencies.gates.execute({ gateId, workspace });
      meter.addGate(output);
      await this.#publisher.gate(task, patch.digest, output);
      if (meter.exceeds(task.contract.budget, expectedPatch.changeSet, repairs)) {
        return {
          passed: false,
          reason: "task-budget-exhausted",
          disposition: "attention"
        };
      }
      if (output.result !== "pass") {
        return {
          passed: false,
          reason: `quality-gate-failed/${gateId}`,
          disposition: "repair"
        };
      }
    }
    const afterGates = await this.dependencies.workspaces.collect(workspace, patchLimits(task));
    if (!samePatch(expectedPatch, afterGates)) {
      await this.#publisher.internalGate(
        task,
        patch.digest,
        "workspace-integrity",
        "fail",
        "A quality gate changed the reviewed patch."
      );
      return {
        passed: false,
        reason: "quality-gate-mutated-patch",
        disposition: "quarantine"
      };
    }
    await this.#publisher.internalGate(
      task,
      patch.digest,
      "workspace-integrity",
      "pass",
      "Patch remained byte-identical after all quality gates."
    );
    return { passed: true, reason: "quality-gates-passed", disposition: "attention" };
  }

  async #review(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly patch: CanonicalFactoryDocument<FactoryPatchProposal>;
    readonly expectedPatch: FactoryWorkspacePatch;
    readonly implementer: PublishedFactoryAgentRun;
    readonly resolvedSkills: readonly ResolvedFactorySkill[];
    readonly attempt: number;
    readonly meter: FactoryBudgetMeter;
  }): Promise<{
    readonly passed: boolean;
    readonly reason: string;
    readonly disposition: "repair" | "attention" | "quarantine";
    readonly reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[];
    readonly repairReview?: FactoryReviewResult;
  }> {
    if (input.implementer.actor.sessionId === null) {
      return {
        passed: false,
        reason: "implementation-identity-missing",
        disposition: "attention",
        reviews: []
      };
    }
    const requirements = this.dependencies.policy.requirements(
      input.task.contract.riskTier,
      "pull-request-creation"
    );
    const reviewerCount = Math.max(
      requirements.minimumIndependentReviews,
      input.task.contract.agentPolicy.minimumIndependentReviews
    );
    const profiles = input.task.contract.agentPolicy.workerProfiles
      .filter(({ roles }) => roles.includes("reviewer"))
      .slice(0, reviewerCount);
    if (profiles.length !== reviewerCount) {
      return {
        passed: false,
        reason: "reviewer-profile-missing",
        disposition: "attention",
        reviews: []
      };
    }
    const reviews: CanonicalFactoryDocument<FactoryReviewResult>[] = [];
    for (const profile of profiles) {
      const selection = selectFactorySkills({
        contract: input.task.contract,
        resolved: input.resolvedSkills,
        phase: "review",
        provider: profile.provider
      });
      const reviewer = await this.#runAgent({
        task: input.task,
        workspace: input.workspace,
        role: "reviewer",
        profile,
        skills: selection.skills,
        budget: selection.budget,
        attempt: input.attempt,
        patchProposalDigest: input.patch.digest
      });
      input.meter.addAgent(reviewer.output);
      if (reviewer.output.status !== "succeeded") {
        return {
          passed: false,
          reason: "independent-review-run-failed",
          disposition: "attention",
          reviews
        };
      }
      if (reviewer.published.actor.sessionId === null) {
        return {
          passed: false,
          reason: "independent-review-identity-missing",
          disposition: "attention",
          reviews
        };
      }
      let decision;
      try {
        decision = this.#publisher.parseReviewDecision(reviewer.output.finalOutput);
      } catch {
        return {
          passed: false,
          reason: "independent-review-output-invalid",
          disposition: "attention",
          reviews
        };
      }
      const review = await this.#publisher.review({
        task: input.task,
        patch: input.patch,
        reviewerRun: reviewer.published,
        decision,
        implementer: input.implementer.actor
      });
      reviews.push(review);
      if (review.value.verdict !== "approved") {
        return {
          passed: false,
          reason: "independent-review-requested-changes",
          disposition: "repair",
          reviews,
          repairReview: review.value
        };
      }
    }
    const afterReview = await this.dependencies.workspaces.collect(
      input.workspace,
      patchLimits(input.task)
    );
    if (!samePatch(input.expectedPatch, afterReview)) {
      await this.#publisher.internalGate(
        input.task,
        input.patch.digest,
        "review-workspace-integrity",
        "fail",
        "A read-only reviewer changed the proposed patch."
      );
      return {
        passed: false,
        reason: "reviewer-mutated-patch",
        disposition: "quarantine",
        reviews
      };
    }
    return {
      passed: true,
      reason: "independent-review-passed",
      disposition: "attention",
      reviews
    };
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

const preparationGateIds = new Set([
  "contract-validation",
  "scope-validation",
  "policy-validation"
]);

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

function patchLimits(task: FactoryTaskSnapshot) {
  return {
    maximumChangedFiles: task.contract.budget.maxChangedFiles,
    maximumChangedLines: task.contract.budget.maxChangedLines,
    maximumPatchBytes: task.contract.budget.maxOutputBytes
  };
}

function samePatch(left: FactoryWorkspacePatch, right: FactoryWorkspacePatch): boolean {
  return (
    left.patch === right.patch && JSON.stringify(left.changeSet) === JSON.stringify(right.changeSet)
  );
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
