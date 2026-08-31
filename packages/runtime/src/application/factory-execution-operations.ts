import {
  factoryAgentRunRequestSchema,
  type FactoryExecutionRole,
  type FactoryPatchProposal,
  type FactoryReviewResult,
  type ImmutableTaskContract,
  type Sha256Digest
} from "@agentlab/contracts";

import {
  factoryProcessCleanupUnconfirmedErrorCode,
  type FactoryAgentExecutionOutput,
  type FactoryAgentExecutor,
  type FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { FactoryBudgetMeter } from "../domain/factory-budget-meter.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryGateExecutor } from "../domain/factory-gate.js";
import type { FactoryPolicyEngine } from "../domain/factory-policy.js";
import { narrowFactoryResourceLimits } from "../domain/factory-process-isolation.js";
import { selectFactorySkills, type ResolvedFactorySkill } from "../domain/factory-skill.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";
import type {
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../domain/factory-workspace.js";
import type { FactoryExecutionJournalSession } from "./factory-execution-journal.js";
import {
  FactoryEvidencePublisher,
  type PublishedFactoryAgentRun
} from "./factory-evidence-publisher.js";
import { renderFactoryPrompt } from "./factory-prompt-renderer.js";

type WorkerProfile = ImmutableTaskContract["agentPolicy"]["workerProfiles"][number];

export interface FactoryExecutionOperationsDependencies {
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly workspaces: FactoryWorkspaceManager;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly gates: FactoryGateExecutor;
  readonly createId: () => string;
}

export interface FactoryExecutedAgent {
  readonly output: FactoryAgentExecutionOutput;
  readonly published: PublishedFactoryAgentRun;
}

/** Owns one journaled agent or gate operation and independent review mechanics. */
export class FactoryExecutionOperations {
  public constructor(
    private readonly dependencies: FactoryExecutionOperationsDependencies,
    private readonly publisher: FactoryEvidencePublisher
  ) {}

  public async runAgent(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly role: FactoryExecutionRole;
    readonly profile: WorkerProfile;
    readonly skills: readonly ResolvedFactorySkill[];
    readonly budget: ImmutableTaskContract["budget"];
    readonly attempt: number;
    readonly journal: FactoryExecutionJournalSession;
    readonly patchProposalDigest?: Sha256Digest;
    readonly repairReview?: FactoryReviewResult;
  }): Promise<FactoryExecutedAgent> {
    const capability = this.dependencies.agents
      .capabilities()
      .find(({ provider: id }) => id === input.profile.provider);
    if (!capability?.roles.includes(input.role)) {
      throw new Error(`Pinned provider cannot safely execute role ${input.role}.`);
    }
    this.dependencies.agents.preflight({
      provider: input.profile.provider,
      model: input.profile.model,
      policyBundleDigest: input.task.contract.gateProfile.policyDigest
    });
    const provider = await this.dependencies.providers.resolve(
      input.profile.provider,
      input.workspace.root
    );
    if (provider === null) {
      throw new Error(`Pinned provider ${input.profile.provider} is unavailable.`);
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
    const request = this.dependencies.documents.agentRunRequest(
      factoryAgentRunRequestSchema.parse({
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
      })
    );
    const storedRequest = await this.dependencies.artifacts.putText(request.json);
    if (storedRequest.digest !== request.digest) {
      throw new Error("Stored agent request digest disagrees with its canonical document.");
    }
    await input.journal.startAgent(request.value, request.digest);
    const output = await this.dependencies.agents.execute({
      request: request.value,
      policyBundleDigest: input.task.contract.gateProfile.policyDigest,
      executable: provider.executable,
      providerVersion: provider.version,
      workspace: input.workspace,
      prompt,
      resourceLimits: this.dependencies.policy.requirements(
        input.task.contract.riskTier,
        "execution"
      ).resourceLimits
    });
    if (output.errorCode === factoryProcessCleanupUnconfirmedErrorCode) {
      throw new Error("Factory agent process cleanup could not be confirmed.");
    }
    if (output.isolation.isolationId !== request.value.executionId) {
      throw new Error("Factory agent isolation identity differs from its durable execution ID.");
    }
    const published = await this.publisher.agentRun(input.task, request.value, output);
    await input.journal.finishOperation(
      output.status === "succeeded"
        ? "succeeded"
        : output.status === "timed-out"
          ? "timed-out"
          : "failed",
      published.document.digest
    );
    return { output, published };
  }

  public async verify(
    task: FactoryTaskSnapshot,
    workspace: FactoryWorkspace,
    patch: CanonicalFactoryDocument<FactoryPatchProposal>,
    expectedPatch: FactoryWorkspacePatch,
    meter: FactoryBudgetMeter,
    repairs: number,
    journal: FactoryExecutionJournalSession
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
        await this.publisher.internalGate(
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
      const isolationId = await journal.startGate(gateId);
      const output = await this.dependencies.gates.execute({
        gateId,
        isolationId,
        workspace,
        resourceLimits: narrowFactoryResourceLimits(
          required.resourceLimits,
          task.contract.budget.maxProcesses
        )
      });
      if (output.isolation.isolationId !== isolationId) {
        throw new Error("Factory gate isolation identity differs from its durable operation ID.");
      }
      meter.addGate(output);
      const observation = await this.publisher.gate(task, patch.digest, output, workspace.attempt);
      await journal.finishOperation(
        output.result === "pass"
          ? "succeeded"
          : output.result === "timed-out"
            ? "timed-out"
            : output.result === "fail"
              ? "failed"
              : "error",
        observation.digest
      );
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
      await this.publisher.internalGate(
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
    await this.publisher.internalGate(
      task,
      patch.digest,
      "workspace-integrity",
      "pass",
      "Patch remained byte-identical after all quality gates."
    );
    return { passed: true, reason: "quality-gates-passed", disposition: "attention" };
  }

  public async review(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly patch: CanonicalFactoryDocument<FactoryPatchProposal>;
    readonly expectedPatch: FactoryWorkspacePatch;
    readonly implementer: PublishedFactoryAgentRun;
    readonly resolvedSkills: readonly ResolvedFactorySkill[];
    readonly attempt: number;
    readonly meter: FactoryBudgetMeter;
    readonly journal: FactoryExecutionJournalSession;
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
      const reviewer = await this.runAgent({
        task: input.task,
        workspace: input.workspace,
        role: "reviewer",
        profile,
        skills: selection.skills,
        budget: selection.budget,
        attempt: input.attempt,
        journal: input.journal,
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
        decision = this.publisher.parseReviewDecision(reviewer.output.finalOutput);
      } catch {
        return {
          passed: false,
          reason: "independent-review-output-invalid",
          disposition: "attention",
          reviews
        };
      }
      const review = await this.publisher.review({
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
      await this.publisher.internalGate(
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
}

const preparationGateIds = new Set([
  "contract-validation",
  "scope-validation",
  "policy-validation"
]);

export function patchLimits(task: FactoryTaskSnapshot) {
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
