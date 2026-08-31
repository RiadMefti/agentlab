import {
  factoryTaskStateSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryBudgetUsage,
  type FactoryPatchProposal,
  type FactoryPullRequestRepairRun,
  type FactoryReviewResult,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type {
  FactoryAgentExecutor,
  FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { minimumFactoryBudget } from "../domain/factory-authority-limits.js";
import { FactoryBudgetMeter } from "../domain/factory-budget-meter.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryGateExecutor } from "../domain/factory-gate.js";
import type { FactoryPolicyEngine } from "../domain/factory-policy.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import type {
  FactoryPullRequestRepairExecutionRepository,
  FactoryPullRequestRepairExecutionSnapshot
} from "../domain/factory-pull-request-repair-execution-repository.js";
import type { FactoryPullRequestUpdateRepository } from "../domain/factory-pull-request-update-repository.js";
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
import type {
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../domain/factory-workspace.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import {
  FactoryExecutionJournalSession,
  type FactoryExecutionJournalDependencies
} from "./factory-execution-journal.js";
import { FactoryExecutionOperations, patchLimits } from "./factory-execution-operations.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import { FactoryPullRequestRepairEvidenceReader } from "./factory-pull-request-repair-evidence.js";
import { FactoryPullRequestLineageReader } from "./factory-pull-request-lineage.js";
import type { FactoryPullRequestRepairRecoveryService } from "./factory-pull-request-repair-recovery-service.js";

const repairInputSchema = z
  .object({
    taskId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    correlationId: z.uuid().optional()
  })
  .strict();

type WorkerProfile = FactoryTaskSnapshot["contract"]["agentPolicy"]["workerProfiles"][number];
type RepairTerminalState = "pr-proposed" | "needs-attention" | "failed" | "quarantined";
type RepairExecutionStatus = RepairTerminalState | "already-advanced";

interface RepairAttemptResult {
  readonly state: RepairTerminalState;
  readonly reasonCode: string;
  readonly patch: CanonicalFactoryDocument<FactoryPatchProposal> | null;
  readonly reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[];
  readonly usageSubject: CanonicalFactoryDocument<FactoryPatchProposal>;
}

export interface FactoryPullRequestRepairExecutionServiceDependencies extends Omit<
  FactoryExecutionJournalDependencies<FactoryPullRequestRepairRun>,
  "executions"
> {
  readonly executions: FactoryPullRequestRepairExecutionRepository;
  readonly recovery: Pick<FactoryPullRequestRepairRecoveryService, "recover">;
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly updates: Pick<
    FactoryPullRequestUpdateRepository,
    "listByTaskId" | "findByRepairRunDigest"
  >;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence" | "latestEvidence">;
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

export interface FactoryPullRequestRepairExecutionOutcome {
  readonly status: RepairExecutionStatus;
  readonly task: FactoryTaskSnapshot;
  readonly authorizationDigest: Sha256Digest;
  readonly repairRunDigest: Sha256Digest;
  readonly patch: CanonicalFactoryDocument<FactoryPatchProposal> | null;
  readonly reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[];
  readonly usage: FactoryBudgetUsage | null;
  readonly usageComplete: boolean;
  readonly created: boolean;
}

/** Executes exactly one authorized post-PR repair in a fresh credentialless workspace. */
export class FactoryPullRequestRepairExecutionService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #operations: FactoryExecutionOperations;
  readonly #reader: FactoryPullRequestRepairEvidenceReader;
  readonly #lineage: FactoryPullRequestLineageReader;

  public constructor(
    private readonly dependencies: FactoryPullRequestRepairExecutionServiceDependencies
  ) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: dependencies.evidenceCredentials,
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#operations = new FactoryExecutionOperations(dependencies, this.#publisher);
    this.#reader = new FactoryPullRequestRepairEvidenceReader(dependencies);
    this.#lineage = new FactoryPullRequestLineageReader(dependencies);
  }

  public async execute(input: unknown): Promise<FactoryPullRequestRepairExecutionOutcome> {
    const command = repairInputSchema.parse(input);
    let task = await this.#requireTask(command.taskId);
    const existing = await this.dependencies.executions.findByAuthorizationDigest(
      command.authorizationDigest
    );
    if (existing !== null) return this.#resumeOrReport(command, task, existing);
    if (task.state !== "pr-open") {
      throw new Error("Fresh PR repair execution requires an open pull-request task.");
    }
    if (task.contract.riskTier !== "R1") {
      throw new Error("The autonomous post-PR repair lane admits R1 tasks only.");
    }
    this.#requireUnexpired(task, "before repair evidence loading");
    const conversation = await this.dependencies.conversations.findById(
      task.contract.conversationId
    );
    const repositoryRoot =
      conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
    if (repositoryRoot === null) {
      throw new Error("PR repair execution requires its active owning conversation.");
    }
    const lineage = await this.#lineage.current(task);
    const record = lineage.record;
    const bundles = await this.dependencies.evidence.listEvidence(command.taskId);
    const authorization = await this.#reader.exactAuthorization({
      bundles,
      expectedDigest: command.authorizationDigest,
      task,
      record,
      proposalDigest: lineage.dispatch.run.proposalDigest,
      priorPatchProposalDigest: lineage.currentPatchProposalDigest
    });
    const observed = await this.#reader.exactLatestObservation({
      bundles,
      expectedDigest: authorization.value.observationDigest,
      task,
      proposalDigest: lineage.dispatch.run.proposalDigest,
      record
    });
    const feedback = this.#reader.repairFeedback({
      authorization: authorization.value,
      observation: observed.observation.value
    });
    const priorPatch = await this.#reader.priorPatch({
      bundles,
      expectedDigest: lineage.currentPatchProposalDigest,
      task
    });
    const initialUsage = await this.#reader.initialUsage({
      bundles,
      task,
      patchProposalDigest: authorization.value.priorPatchProposalDigest
    });
    if (authorization.value.contractRepairAttempt !== initialUsage.value.usage.repairAttempts + 1) {
      throw new Error("PR repair authorization does not reserve the next cumulative attempt.");
    }
    const authorizations = await this.#reader.authorizations({
      bundles,
      task,
      record,
      proposalDigest: lineage.dispatch.run.proposalDigest,
      priorPatchProposalDigest: lineage.currentPatchProposalDigest
    });
    const recordedRuns = await this.#reader.repairRuns({ bundles, task, authorizations });
    if (recordedRuns.some(({ value }) => value.authorizationDigest === authorization.digest)) {
      throw new Error("PR repair evidence exists without its durable execution journal.");
    }
    const resolvedSkills = await resolveFactorySkillPlan(this.dependencies.skills, task.contract);
    const profile = workerProfile(task, "repairer");
    const skillSelection = selectFactorySkills({
      contract: task.contract,
      resolved: resolvedSkills,
      phase: "repair",
      provider: profile.provider
    });
    const correlationId = command.correlationId ?? z.uuid().parse(this.dependencies.createId());
    const createdAt = this.#requireUnexpired(task, "after repair evidence loading");
    const run = this.dependencies.documents.pullRequestRepairRun({
      schemaVersion: "agentlab.pull-request-repair-run.v1",
      runId: this.dependencies.createId(),
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: task.contract.gateProfile.policyDigest,
      authorizationId: authorization.value.authorizationId,
      authorizationDigest: authorization.digest,
      observationDigest: authorization.value.observationDigest,
      priorPatchProposalDigest: authorization.value.priorPatchProposalDigest,
      repository: task.contract.repository,
      contractRepairAttempt: authorization.value.contractRepairAttempt,
      maximumAttempts: authorization.value.contractRepairAttempt,
      createdAt,
      correlationId
    });

    let journal: FactoryExecutionJournalSession<FactoryPullRequestRepairRun> | null = null;
    let workspace: FactoryWorkspace | null = null;
    const meter = new FactoryBudgetMeter({
      usage: initialUsage.value.usage,
      complete: initialUsage.value.complete
    });
    try {
      journal = await FactoryExecutionJournalSession.register(
        this.dependencies,
        run,
        "pr-repair-execution-registered"
      );
      await this.#publisher.pullRequestRepairRun({ task, run });
      await this.#publisher.skillPlan(task, resolvedSkills);
      task = await this.#transition(task, "repairing", "authorized-pr-repair-started");
      const remaining = meter.remaining(
        task.contract.budget,
        priorPatch.workspacePatch.changeSet,
        authorization.value.contractRepairAttempt
      );
      if (remaining === null) {
        const usage = meter.finish(
          priorPatch.workspacePatch.changeSet,
          authorization.value.contractRepairAttempt
        );
        await this.#publisher.taskUsage(task, priorPatch.proposal.digest, usage, meter.complete);
        task = await this.#transition(task, "needs-attention", "pr-repair-budget-exhausted");
        await journal.finish("needs-attention");
        return outcome(task, run, null, [], usage, meter.complete, true);
      }

      const workspaceId = await journal.startAttempt(authorization.value.contractRepairAttempt);
      workspace = await this.dependencies.workspaces.create({
        taskId: task.contract.taskId,
        attempt: authorization.value.contractRepairAttempt,
        repositoryRoot,
        baseRevision: task.contract.repository.baseRevision,
        workspaceId
      });
      assertWorkspaceIdentity(
        workspace,
        task,
        repositoryRoot,
        workspaceId,
        authorization.value.contractRepairAttempt
      );
      const attemptResult = await this.#runAttempt({
        task,
        workspace,
        priorPatch: priorPatch.workspacePatch,
        priorProposal: priorPatch.proposal,
        authorizationDigest: authorization.digest,
        feedback,
        resolvedSkills,
        profile,
        agentBudget: minimumFactoryBudget(skillSelection.budget, remaining),
        repairAttempt: authorization.value.contractRepairAttempt,
        meter,
        journal
      });
      task = attemptResult.task;
      await workspace.closeAndWait();
      workspace = null;
      await journal.closeAttempt("finish");
      const usage = meter.finish(
        attemptResult.usageSubject.value.changeSet,
        authorization.value.contractRepairAttempt
      );
      await this.#publisher.taskUsage(
        task,
        attemptResult.usageSubject.digest,
        usage,
        meter.complete
      );
      const finalState =
        attemptResult.state === "pr-proposed" && !meter.complete
          ? "needs-attention"
          : attemptResult.state;
      const reasonCode =
        attemptResult.state === "pr-proposed" && !meter.complete
          ? "pr-repair-usage-incomplete"
          : attemptResult.reasonCode;
      task = await this.#transition(task, finalState, reasonCode);
      await journal.finish(finalState);
      return outcome(
        task,
        run,
        attemptResult.patch,
        attemptResult.reviews,
        usage,
        meter.complete,
        true
      );
    } catch (error: unknown) {
      if (journal === null) throw error;
      try {
        await this.dependencies.recovery.recover({
          taskId: task.contract.taskId,
          authorizationDigest: authorization.digest,
          correlationId
        });
        if (workspace !== null) {
          await workspace.closeAndWait();
          workspace = null;
        }
      } catch (recoveryError: unknown) {
        throw new AggregateError(
          [error, recoveryError],
          "PR repair execution failed and durable recovery could not be confirmed.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async #runAttempt(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly priorPatch: FactoryWorkspacePatch;
    readonly priorProposal: CanonicalFactoryDocument<FactoryPatchProposal>;
    readonly authorizationDigest: Sha256Digest;
    readonly feedback: ReturnType<FactoryPullRequestRepairEvidenceReader["repairFeedback"]>;
    readonly resolvedSkills: readonly ResolvedFactorySkill[];
    readonly profile: WorkerProfile;
    readonly agentBudget: FactoryTaskSnapshot["contract"]["budget"];
    readonly repairAttempt: number;
    readonly meter: FactoryBudgetMeter;
    readonly journal: FactoryExecutionJournalSession<FactoryPullRequestRepairRun>;
  }): Promise<RepairAttemptResult & { readonly task: FactoryTaskSnapshot }> {
    let task = input.task;
    await this.dependencies.workspaces.apply(
      input.workspace,
      input.priorPatch.patch,
      task.contract.budget.maxOutputBytes
    );
    const selection = selectFactorySkills({
      contract: task.contract,
      resolved: input.resolvedSkills,
      phase: "repair",
      provider: input.profile.provider
    });
    const repairer = await this.#operations.runAgent({
      task,
      workspace: input.workspace,
      role: "repairer",
      profile: input.profile,
      skills: selection.skills,
      budget: input.agentBudget,
      attempt: input.repairAttempt,
      journal: input.journal,
      patchProposalDigest: input.priorProposal.digest,
      repairAuthorizationDigest: input.authorizationDigest,
      pullRequestFeedback: input.feedback
    });
    input.meter.addAgent(repairer.output);
    if (repairer.output.status !== "succeeded") {
      return {
        task,
        state: "failed",
        reasonCode: "post-pr-repairer-run-failed",
        patch: null,
        reviews: [],
        usageSubject: input.priorProposal
      };
    }

    const collected = await this.dependencies.workspaces.collect(
      input.workspace,
      patchLimits(task)
    );
    const patch = await this.#publisher.patch(
      task,
      repairer.published.document.value.executionId,
      collected
    );
    task = await this.#transition(task, "verifying", "post-pr-repair-patch-captured");
    if (input.meter.exceeds(task.contract.budget, collected.changeSet, input.repairAttempt)) {
      return terminalAttempt(task, "needs-attention", "pr-repair-budget-exhausted", patch);
    }
    const verification = await this.#operations.verify(
      task,
      input.workspace,
      patch,
      collected,
      input.meter,
      input.repairAttempt,
      input.journal
    );
    if (!verification.passed) {
      return terminalAttempt(
        task,
        verification.disposition === "quarantine" ? "quarantined" : "needs-attention",
        `post-pr-${verification.reason}`,
        patch
      );
    }
    if (input.meter.exceeds(task.contract.budget, collected.changeSet, input.repairAttempt)) {
      return terminalAttempt(task, "needs-attention", "pr-repair-budget-exhausted", patch);
    }

    task = await this.#transition(task, "reviewing", "post-pr-quality-gates-passed");
    const review = await this.#operations.review({
      task,
      workspace: input.workspace,
      patch,
      expectedPatch: collected,
      implementer: repairer.published,
      resolvedSkills: input.resolvedSkills,
      attempt: input.repairAttempt,
      meter: input.meter,
      repairAttempts: input.repairAttempt,
      journal: input.journal
    });
    if (!review.passed) {
      return {
        ...terminalAttempt(
          task,
          review.disposition === "quarantine" ? "quarantined" : "needs-attention",
          `post-pr-${review.reason}`,
          patch
        ),
        reviews: review.reviews
      };
    }
    if (input.meter.exceeds(task.contract.budget, collected.changeSet, input.repairAttempt)) {
      return {
        ...terminalAttempt(task, "needs-attention", "pr-repair-budget-exhausted", patch),
        reviews: review.reviews
      };
    }
    return {
      task,
      state: "pr-proposed",
      reasonCode: "post-pr-independent-review-passed",
      patch,
      reviews: review.reviews,
      usageSubject: patch
    };
  }

  async #resumeOrReport(
    command: z.infer<typeof repairInputSchema>,
    task: FactoryTaskSnapshot,
    execution: FactoryPullRequestRepairExecutionSnapshot
  ): Promise<FactoryPullRequestRepairExecutionOutcome> {
    if (
      execution.run.taskId !== command.taskId ||
      execution.run.authorizationDigest !== command.authorizationDigest ||
      execution.run.contractDigest !== task.contractDigest ||
      execution.run.policyBundleDigest !== task.contract.gateProfile.policyDigest ||
      execution.run.repository.id !== task.contract.repository.id ||
      execution.run.repository.baseRevision !== task.contract.repository.baseRevision
    ) {
      throw new Error("Existing PR repair run does not match the confirmed command and task.");
    }
    if (execution.state !== "completed") {
      const recovered = await this.dependencies.recovery.recover({
        taskId: command.taskId,
        authorizationDigest: command.authorizationDigest,
        correlationId: command.correlationId ?? this.dependencies.createId()
      });
      task = recovered.task;
      execution = recovered.execution;
    }
    if (execution.state === "completed") {
      if (
        execution.lastEvent.kind !== "execution-finished" ||
        execution.lastEvent.taskState !== task.state
      ) {
        const update = await this.dependencies.updates.findByRepairRunDigest(execution.runDigest);
        const alreadyAdvanced =
          execution.lastEvent.kind === "execution-finished" &&
          execution.lastEvent.taskState === "pr-proposed" &&
          task.state === "pr-open" &&
          update?.state === "completed" &&
          update.run.taskId === command.taskId &&
          update.run.proposal.repairAuthorizationDigest === command.authorizationDigest &&
          update.run.proposal.repairRunDigest === execution.runDigest &&
          update.record !== null &&
          update.record.repairAuthorizationDigest === command.authorizationDigest &&
          update.record.repairRunDigest === execution.runDigest &&
          update.record.headRevision !== update.run.proposal.priorHeadRevision;
        if (!alreadyAdvanced) {
          throw new Error("Completed PR repair journal disagrees with its durable task state.");
        }
        return outcome(task, execution, null, [], null, false, false, "already-advanced");
      }
    }
    const status = repairTerminalState(task);
    return outcome(task, execution, null, [], null, false, false, status);
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
      actor: repairOrchestratorActor,
      reasonCode,
      evidenceBundleDigest: latest?.digest ?? null
    });
  }

  #requireUnexpired(task: FactoryTaskSnapshot, phase: string): string {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (now >= task.contract.expiresAt) {
      throw new Error(`PR repair task contract expired ${phase}.`);
    }
    return now;
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

const repairOrchestratorActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

function workerProfile(task: FactoryTaskSnapshot, role: "repairer"): WorkerProfile {
  const profile = task.contract.agentPolicy.workerProfiles.find(({ roles }) =>
    roles.includes(role)
  );
  if (profile === undefined) throw new Error(`Task has no pinned ${role} worker profile.`);
  return profile;
}

function terminalAttempt(
  task: FactoryTaskSnapshot,
  state: Exclude<RepairTerminalState, "pr-proposed">,
  reasonCode: string,
  patch: CanonicalFactoryDocument<FactoryPatchProposal>
): RepairAttemptResult & { readonly task: FactoryTaskSnapshot } {
  return { task, state, reasonCode, patch, reviews: [], usageSubject: patch };
}

function assertWorkspaceIdentity(
  workspace: FactoryWorkspace,
  task: FactoryTaskSnapshot,
  repositoryRoot: string,
  workspaceId: string,
  attempt: number
): void {
  if (
    workspace.id !== workspaceId ||
    workspace.taskId !== task.contract.taskId ||
    workspace.attempt !== attempt ||
    workspace.repositoryRoot !== repositoryRoot ||
    workspace.baseRevision !== task.contract.repository.baseRevision
  ) {
    throw new Error("PR repair workspace does not match its durable execution coordinates.");
  }
}

function repairTerminalState(task: FactoryTaskSnapshot): RepairTerminalState {
  if (
    task.state === "pr-proposed" ||
    task.state === "needs-attention" ||
    task.state === "failed" ||
    task.state === "quarantined"
  ) {
    return task.state;
  }
  throw new Error(`PR repair stopped in non-terminal handoff state ${task.state}.`);
}

function outcome(
  task: FactoryTaskSnapshot,
  run:
    | CanonicalFactoryDocument<FactoryPullRequestRepairRun>
    | FactoryPullRequestRepairExecutionSnapshot,
  patch: CanonicalFactoryDocument<FactoryPatchProposal> | null,
  reviews: readonly CanonicalFactoryDocument<FactoryReviewResult>[],
  usage: FactoryBudgetUsage | null,
  usageComplete: boolean,
  created: boolean,
  status: RepairExecutionStatus = repairTerminalState(task)
): FactoryPullRequestRepairExecutionOutcome {
  return {
    status,
    task,
    authorizationDigest:
      "digest" in run ? run.value.authorizationDigest : run.run.authorizationDigest,
    repairRunDigest: "digest" in run ? run.digest : run.runDigest,
    patch,
    reviews,
    usage,
    usageComplete,
    created
  };
}
