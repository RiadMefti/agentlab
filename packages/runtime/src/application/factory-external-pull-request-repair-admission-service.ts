import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryExternalPullRequestRepairAdmissionPolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { assertExternalPullRequestRepairAdmissionCandidate } from "../domain/factory-external-pull-request-repair-admission-integrity.js";
import { assessExternalPullRequestRepairAdmission } from "../domain/factory-external-pull-request-repair-admission-policy.js";
import type {
  FactoryExternalPullRequestRepairAdmissionCandidate,
  FactoryExternalPullRequestRepairAdmissionRepository,
  FactoryExternalPullRequestRepairAdmissionSnapshot
} from "../domain/factory-external-pull-request-repair-admission-repository.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";

const tickInputSchema = z
  .object({
    expectedAdmissionPolicyDigest: sha256DigestSchema,
    expectedReviewPolicyDigest: sha256DigestSchema,
    expectedFeedbackPolicyDigest: sha256DigestSchema,
    expectedRepairExecutionPolicyDigest: sha256DigestSchema,
    expectedCostPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    expectedGateProfileDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestRepairAdmissionPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-repair-admission-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly admissionPolicyDigest: Sha256Digest;
  readonly reviewPolicyDigest: Sha256Digest;
  readonly feedbackPolicyDigest: Sha256Digest;
  readonly repairExecutionPolicyDigest: Sha256Digest;
  readonly costPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly gateProfileDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly remoteWrite: false;
  readonly autoMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestRepairAdmissionTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-repair-admission-tick-result.v1";
  readonly status: "idle" | "completed" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly admissionPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly authorized: number;
  readonly denied: number;
  readonly existing: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly decisions: readonly FactoryExternalPullRequestRepairAdmissionDecisionReport[];
}

export interface FactoryExternalPullRequestRepairAdmissionDecisionReport {
  readonly decisionId: string | null;
  readonly decisionDigest: Sha256Digest | null;
  readonly authorizationDigest: Sha256Digest | null;
  readonly bundleDigest: Sha256Digest;
  readonly pullRequestNumber: number;
  readonly status: "authorized" | "denied" | "existing" | "blocked";
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestRepairAdmissionServiceDependencies {
  readonly admissionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
  readonly repository: FactoryExternalPullRequestRepairAdmissionRepository;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Converts exact completed feedback evidence into one bounded local repair capability. */
export class FactoryExternalPullRequestRepairAdmissionService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestRepairAdmissionServiceDependencies
  ) {}

  public async preflight(): Promise<FactoryExternalPullRequestRepairAdmissionPreflight> {
    const enabled = (await this.dependencies.controls.state()).scheduler;
    const policy = this.dependencies.admissionPolicy;
    return {
      schemaVersion: "agentlab.external-pull-request-repair-admission-preflight.v1",
      status: enabled ? "ready" : "blocked",
      repositoryId: policy.value.repositoryId,
      admissionPolicyDigest: policy.digest,
      reviewPolicyDigest: policy.value.reviewPolicyDigest,
      feedbackPolicyDigest: policy.value.feedbackPolicyDigest,
      repairExecutionPolicyDigest: policy.value.repairExecutionPolicyDigest,
      costPolicyDigest: policy.value.costPolicyDigest,
      roleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
      gateProfileDigest: policy.value.gateProfileDigest,
      schedulerEnabled: enabled,
      remoteWrite: false,
      autoMerge: false,
      release: false,
      reasonCodes: enabled ? [] : ["scheduler-disabled"]
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestRepairAdmissionTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const policy = this.dependencies.admissionPolicy;
    if (!(await this.dependencies.controls.state()).scheduler) {
      return this.#report([], "blocked", false, ["scheduler-disabled"]);
    }
    const candidates = await this.dependencies.repository.listCandidates({
      repositoryId: policy.value.repositoryId,
      reviewPolicyDigest: policy.value.reviewPolicyDigest,
      feedbackPolicyDigest: policy.value.feedbackPolicyDigest,
      admissionPolicyDigest: policy.digest,
      limit: policy.value.maximumCandidatesPerTick + 1
    });
    const hasMore = candidates.length > policy.value.maximumCandidatesPerTick;
    const reports: FactoryExternalPullRequestRepairAdmissionDecisionReport[] = [];
    for (const candidate of candidates.slice(0, policy.value.maximumCandidatesPerTick)) {
      if (!(await this.dependencies.controls.state()).scheduler) {
        reports.push(blockedReport(candidate, "scheduler-disabled-before-decision"));
        break;
      }
      reports.push(await this.#decide(candidate));
    }
    if (reports.length === 0) return this.#report([], "idle", hasMore, []);
    const blocked = reports.some(({ status }) => status === "blocked");
    return this.#report(
      reports,
      blocked ? (reports.length === 1 ? "blocked" : "partial") : "completed",
      hasMore,
      uniqueSorted(reports.flatMap(({ reasonCodes }) => reasonCodes))
    );
  }

  async #decide(
    candidate: FactoryExternalPullRequestRepairAdmissionCandidate
  ): Promise<FactoryExternalPullRequestRepairAdmissionDecisionReport> {
    const policy = this.dependencies.admissionPolicy;
    assertExternalPullRequestRepairAdmissionCandidate(candidate, this.dependencies.documents);
    const existing = await this.dependencies.repository.findByBundle(
      candidate.feedbackRun.value.bundleDigest,
      policy.digest
    );
    if (existing !== null) return existingReport(existing);

    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const evaluation = assessExternalPullRequestRepairAdmission(candidate, policy.value, now);
    const correlationId = this.dependencies.createId();
    const authorizationId = this.dependencies.createId();
    const authorization =
      evaluation.status === "authorized"
        ? this.dependencies.documents.externalPullRequestRepairAuthorization({
            schemaVersion: "agentlab.external-pull-request-repair-authorization.v1",
            authorizationId,
            repositoryId: candidate.feedbackRun.value.repositoryId,
            pullRequestNumber: candidate.feedbackRun.value.pullRequestNumber,
            reviewRunId: candidate.feedbackRun.value.reviewRunId,
            reviewRunDigest: candidate.feedbackRun.value.reviewRunDigest,
            bundleDigest: candidate.feedbackRun.value.bundleDigest,
            feedbackPublicationRunId: candidate.feedbackRun.value.publicationRunId,
            feedbackPublicationRunDigest: candidate.feedbackRun.digest,
            feedbackRecordDigest: candidate.feedbackRecord.digest,
            reviewPolicyDigest: policy.value.reviewPolicyDigest,
            feedbackPolicyDigest: policy.value.feedbackPolicyDigest,
            admissionPolicyDigest: policy.digest,
            repairExecutionPolicyDigest: policy.value.repairExecutionPolicyDigest,
            costPolicyDigest: policy.value.costPolicyDigest,
            roleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
            gateProfileDigest: policy.value.gateProfileDigest,
            skillPackageDigests: policy.value.skillPackageDigests,
            expectedBaseRevision: candidate.feedbackRun.value.expectedBaseRevision,
            expectedHeadRevision: candidate.feedbackRun.value.expectedHeadRevision,
            patchDigest: candidate.feedbackRun.value.bundle.patchDigest,
            fromFork: candidate.feedbackRun.value.reviewRun.candidate.fromFork,
            headRepositoryId: candidate.feedbackRun.value.reviewRun.candidate.head.repositoryId,
            headBranchName: candidate.feedbackRun.value.reviewRun.candidate.head.branchName,
            selectedFindings: evaluation.selectedFindings,
            repairAttempt: 1,
            publicationMode: "replacement-draft",
            remoteWrite: false,
            autoMerge: false,
            release: false,
            createdAt: now,
            expiresAt: factoryTimestampAddSeconds(now, policy.value.authorizationTtlSeconds),
            actor: admissionActor(authorizationId),
            correlationId
          })
        : null;
    if (!(await this.dependencies.controls.state()).scheduler) {
      return blockedReport(candidate, "scheduler-disabled-before-decision");
    }
    const decisionId = this.dependencies.createId();
    const decision = this.dependencies.documents.externalPullRequestRepairDecision({
      schemaVersion: "agentlab.external-pull-request-repair-decision.v1",
      decisionId,
      repositoryId: candidate.feedbackRun.value.repositoryId,
      pullRequestNumber: candidate.feedbackRun.value.pullRequestNumber,
      reviewRunId: candidate.feedbackRun.value.reviewRunId,
      reviewRunDigest: candidate.feedbackRun.value.reviewRunDigest,
      bundleDigest: candidate.feedbackRun.value.bundleDigest,
      feedbackPublicationRunId: candidate.feedbackRun.value.publicationRunId,
      feedbackPublicationRunDigest: candidate.feedbackRun.digest,
      feedbackRecordDigest: candidate.feedbackRecord.digest,
      admissionPolicyDigest: policy.digest,
      status: evaluation.status,
      reasonCodes: evaluation.reasonCodes,
      authorizationDigest: authorization?.digest ?? null,
      selectedFindingCount: authorization?.value.selectedFindings.length ?? 0,
      createdAt: now,
      actor: decisionActor(decisionId),
      correlationId
    });
    const result = await this.dependencies.repository.decide(
      policy,
      decision,
      authorization,
      candidate
    );
    return {
      decisionId: result.decision.decisionId,
      decisionDigest: result.decisionDigest,
      authorizationDigest: result.authorizationDigest,
      bundleDigest: result.decision.bundleDigest,
      pullRequestNumber: result.decision.pullRequestNumber,
      status: result.status === "existing" ? "existing" : result.decision.status,
      reasonCodes: result.decision.reasonCodes
    };
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    const policy = this.dependencies.admissionPolicy;
    const pins = {
      expectedAdmissionPolicyDigest: policy.digest,
      expectedReviewPolicyDigest: policy.value.reviewPolicyDigest,
      expectedFeedbackPolicyDigest: policy.value.feedbackPolicyDigest,
      expectedRepairExecutionPolicyDigest: policy.value.repairExecutionPolicyDigest,
      expectedCostPolicyDigest: policy.value.costPolicyDigest,
      expectedRoleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
      expectedGateProfileDigest: policy.value.gateProfileDigest
    };
    for (const key of Object.keys(pins) as (keyof typeof pins)[]) {
      if (command[key] !== pins[key]) {
        throw new Error("External repair admission pin changed after operator review.");
      }
    }
  }

  #report(
    decisions: readonly FactoryExternalPullRequestRepairAdmissionDecisionReport[],
    status: FactoryExternalPullRequestRepairAdmissionTickReport["status"],
    hasMore: boolean,
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestRepairAdmissionTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-repair-admission-tick-result.v1",
      status,
      repositoryId: this.dependencies.admissionPolicy.value.repositoryId,
      admissionPolicyDigest: this.dependencies.admissionPolicy.digest,
      inspected: decisions.length,
      authorized: decisions.filter(({ status: item }) => item === "authorized").length,
      denied: decisions.filter(({ status: item }) => item === "denied").length,
      existing: decisions.filter(({ status: item }) => item === "existing").length,
      hasMore,
      reasonCodes,
      decisions
    };
  }
}

function existingReport(
  existing: FactoryExternalPullRequestRepairAdmissionSnapshot
): FactoryExternalPullRequestRepairAdmissionDecisionReport {
  return {
    decisionId: existing.decision.decisionId,
    decisionDigest: existing.decisionDigest,
    authorizationDigest: existing.authorizationDigest,
    bundleDigest: existing.decision.bundleDigest,
    pullRequestNumber: existing.decision.pullRequestNumber,
    status: "existing",
    reasonCodes: existing.decision.reasonCodes
  };
}

function blockedReport(
  candidate: FactoryExternalPullRequestRepairAdmissionCandidate,
  reasonCode: string
): FactoryExternalPullRequestRepairAdmissionDecisionReport {
  return {
    decisionId: null,
    decisionDigest: null,
    authorizationDigest: null,
    bundleDigest: candidate.feedbackRun.value.bundleDigest,
    pullRequestNumber: candidate.feedbackRun.value.pullRequestNumber,
    status: "blocked",
    reasonCodes: [reasonCode]
  };
}

function admissionActor(authorizationId: string) {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "agentlab/external-pull-request-repair-admission" as const,
    sessionId: authorizationId
  };
}

function decisionActor(decisionId: string) {
  return { ...admissionActor(decisionId), sessionId: decisionId };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
