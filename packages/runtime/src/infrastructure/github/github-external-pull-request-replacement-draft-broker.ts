import { createHash } from "node:crypto";

import {
  factoryExternalPullRequestReplacementDraftProposalSchema,
  factoryExternalPullRequestReplacementDraftRecordSchema,
  gitObjectIdSchema,
  type FactoryExternalPullRequestReplacementDraftProposal,
  type GitObjectId
} from "@agentlab/contracts";
import { z } from "zod";

import {
  FactoryExternalPullRequestReplacementQuarantineError,
  FactoryExternalPullRequestReplacementStaleError,
  type FactoryExternalPullRequestOriginalSnapshot,
  type FactoryExternalPullRequestReplacementDraftBroker
} from "../../domain/factory-external-pull-request-replacement-draft-broker.js";
import type { FactoryDocumentCodec } from "../../domain/factory-documents.js";
import type { CommandRunner } from "../process/command-runner.js";
import { GitBrokerWorkspace } from "./git-broker-workspace.js";
import {
  githubAuthorSchema,
  githubExternalPullRequestSchema,
  githubPullRequestSchema
} from "./github-pull-request-api-contracts.js";
import {
  GitHubApiError,
  type GitHubRestApi,
  type GitHubTokenSource
} from "./github-rest-client.js";
import {
  githubTrustedStatusCheckBindings,
  type GitHubTrustedStatusCheck
} from "./github-trusted-status-checks.js";

const refSchema = z.object({ object: z.object({ sha: gitObjectIdSchema }) });
const protectionSchema = z.object({
  required_pull_request_reviews: z
    .object({
      required_approving_review_count: z.number().int().min(0).max(100),
      dismiss_stale_reviews: z.boolean(),
      require_code_owner_reviews: z.boolean().optional(),
      require_last_push_approval: z.boolean().optional()
    })
    .nullable()
    .optional(),
  required_status_checks: z
    .object({
      checks: z
        .array(
          z.object({
            context: z.string().min(1).max(256),
            app_id: z.number().int().positive().nullable().optional()
          })
        )
        .max(1_000)
        .optional()
    })
    .nullable()
    .optional(),
  enforce_admins: z.object({ enabled: z.boolean() }).optional(),
  allow_force_pushes: z.object({ enabled: z.boolean() }).optional(),
  allow_deletions: z.object({ enabled: z.boolean() }).optional()
});

export interface GitHubExternalPullRequestReplacementDraftBrokerOptions {
  readonly repositoryId: string;
  readonly brokerId: string;
  readonly tokenSource: GitHubTokenSource;
  readonly api: GitHubRestApi;
  readonly documents: Pick<FactoryDocumentCodec, "externalPullRequestReplacementDraftProposal">;
  readonly gitExecutable: string;
  readonly temporaryRoot: string;
  readonly maximumPatchBytes: number;
  readonly publisherUserId: number;
  readonly trustedStatusChecks: readonly GitHubTrustedStatusCheck[];
  readonly authorName?: string;
  readonly authorEmail?: string;
}

/** Dedicated GitHub adapter with only branch-create and draft-PR-create authority. */
export class GitHubExternalPullRequestReplacementDraftBroker implements FactoryExternalPullRequestReplacementDraftBroker {
  readonly #owner: string;
  readonly #workspace: GitBrokerWorkspace;
  readonly #trustedChecks: ReadonlyMap<string, number>;

  public constructor(
    runner: CommandRunner,
    private readonly options: GitHubExternalPullRequestReplacementDraftBrokerOptions
  ) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId))
      throw new Error("Replacement-draft repository ID is invalid.");
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.brokerId))
      throw new Error("Replacement-draft broker ID is invalid.");
    if (!Number.isSafeInteger(options.maximumPatchBytes) || options.maximumPatchBytes < 1)
      throw new Error("Replacement-draft patch limit is invalid.");
    if (!Number.isSafeInteger(options.publisherUserId) || options.publisherUserId < 1)
      throw new Error("Replacement-draft publisher identity is invalid.");
    this.#owner = options.repositoryId.split("/", 1)[0] ?? "";
    this.#trustedChecks = githubTrustedStatusCheckBindings(options.trustedStatusChecks);
    this.#workspace = new GitBrokerWorkspace(runner, {
      root: options.temporaryRoot,
      gitExecutable: options.gitExecutable,
      authorName: options.authorName ?? "AgentLab External Repair Broker",
      authorEmail: options.authorEmail ?? "agentlab-external-repair@users.noreply.github.com"
    });
  }

  public identity() {
    return { repositoryId: this.options.repositoryId, brokerId: this.options.brokerId };
  }

  public async inspectOriginal(
    pullRequestNumber: number
  ): Promise<FactoryExternalPullRequestOriginalSnapshot> {
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
      throw new Error("Original PR number is invalid.");
    const pullRequest = githubExternalPullRequestSchema.parse(
      await this.options.api.request(
        "GET",
        `/repos/${this.options.repositoryId}/pulls/${String(pullRequestNumber)}`
      )
    );
    if (pullRequest.base.repo.full_name.toLowerCase() !== this.options.repositoryId)
      throw new Error("Original PR base repository changed.");
    const protectionValue = await this.#optional(
      "GET",
      `/repos/${this.options.repositoryId}/branches/${encodeURIComponent(pullRequest.base.ref)}/protection`
    );
    const protection = protectionValue === null ? null : protectionSchema.parse(protectionValue);
    const reviews = protection?.required_pull_request_reviews ?? null;
    const checks = protection?.required_status_checks?.checks ?? [];
    return {
      repositoryId: this.options.repositoryId,
      number: pullRequest.number,
      url: pullRequest.html_url,
      state: pullRequest.state,
      baseBranch: pullRequest.base.ref,
      baseRevision: pullRequest.base.sha,
      headRevision: pullRequest.head.sha,
      governance: {
        requiresPullRequest: reviews !== null,
        requiredApprovals: reviews?.required_approving_review_count ?? 0,
        dismissesStaleReviews: reviews?.dismiss_stale_reviews ?? false,
        requiresCodeOwnerReviews: reviews?.require_code_owner_reviews ?? false,
        requiresLastPushApproval: reviews?.require_last_push_approval ?? false,
        enforcesAdmins: protection?.enforce_admins?.enabled ?? false,
        allowsForcePushes: protection?.allow_force_pushes?.enabled ?? true,
        allowsDeletions: protection?.allow_deletions?.enabled ?? true,
        requiredStatusChecks: checks
          .filter((check) => this.#trustedChecks.get(check.context) === check.app_id)
          .map(({ context }) => context)
          .filter((context, index, values) => values.indexOf(context) === index)
      }
    };
  }

  public async publishBranch(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly patch: string;
    readonly repositoryRoot: string;
  }) {
    const proposal = this.#proposal(input.proposal, input.patch);
    await this.#assertOriginalStillExact(proposal);
    const prepared = await this.#workspace.prepare({
      repositoryRoot: input.repositoryRoot,
      baseRevision: proposal.expectedOriginalHeadRevision,
      patch: input.patch,
      patchMaximumBytes: this.options.maximumPatchBytes,
      expectedChangeSet: proposal.changeSet,
      title: proposal.commitTitle,
      timestamp: proposal.createdAt
    });
    try {
      const headRevision = prepared.headRevision;
      if (headRevision === null)
        throw new Error("Replacement-draft commit preparation returned no head.");
      const existing = await this.#branch(proposal.branchName);
      if (existing !== null) {
        if (existing.object.sha !== headRevision)
          throw new FactoryExternalPullRequestReplacementQuarantineError(
            "Replacement-draft branch already exists with a different commit."
          );
        return { headRevision, created: false };
      }
      await this.#assertOriginalStillExact(proposal);
      const token = validateToken(await this.options.tokenSource.token(this.options.repositoryId));
      try {
        await prepared.push({
          repositoryUrl: `https://github.com/${this.options.repositoryId}.git`,
          branchName: proposal.branchName,
          authorizationHeader: gitAuthorizationHeader(token)
        });
      } catch (error: unknown) {
        this.options.tokenSource.invalidate?.(this.options.repositoryId, token);
        const recovered = await this.#branch(proposal.branchName);
        if (recovered !== null && recovered.object.sha !== headRevision)
          throw new FactoryExternalPullRequestReplacementQuarantineError(
            "Replacement-draft branch reconciled to a conflicting commit."
          );
        if (recovered === null)
          throw new Error("Replacement-draft branch publication was not confirmed.", {
            cause: error
          });
        return { headRevision, created: false };
      }
      const confirmed = await this.#branch(proposal.branchName);
      if (confirmed?.object.sha !== headRevision)
        throw new Error("Replacement-draft branch did not confirm its exact commit.");
      return { headRevision, created: true };
    } finally {
      await prepared.close();
    }
  }

  public async openDraft(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly headRevision: GitObjectId;
  }) {
    const proposal = factoryExternalPullRequestReplacementDraftProposalSchema.parse(input.proposal);
    this.#assertCoordinates(proposal);
    await this.#assertOriginalStillExact(proposal);
    const branch = await this.#branch(proposal.branchName);
    if (branch?.object.sha !== input.headRevision)
      throw new FactoryExternalPullRequestReplacementQuarantineError(
        "Replacement-draft branch changed before PR creation."
      );
    const existing = await this.#pullRequestsForBranch(proposal.branchName);
    if (existing.length > 1)
      throw new FactoryExternalPullRequestReplacementQuarantineError(
        "Replacement-draft branch maps to multiple PRs."
      );
    const prior = existing[0];
    if (prior !== undefined) {
      if (!matches(prior, proposal, input.headRevision, this.options.publisherUserId))
        throw new FactoryExternalPullRequestReplacementQuarantineError(
          "Existing replacement draft does not match its durable intent."
        );
      return { record: this.#record(prior, proposal, input.headRevision), created: false };
    }
    let created: z.infer<typeof replacementPullRequestSchema>;
    try {
      created = replacementPullRequestSchema.parse(
        await this.options.api.request("POST", `/repos/${this.options.repositoryId}/pulls`, {
          title: proposal.title,
          body: proposal.body,
          head: proposal.branchName,
          base: proposal.expectedBaseBranch,
          draft: true,
          maintainer_can_modify: false
        })
      );
    } catch (error: unknown) {
      const recovered = await this.#pullRequestsForBranch(proposal.branchName);
      if (
        recovered.length === 1 &&
        recovered[0] !== undefined &&
        matches(recovered[0], proposal, input.headRevision, this.options.publisherUserId)
      ) {
        return { record: this.#record(recovered[0], proposal, input.headRevision), created: false };
      }
      if (recovered.length > 0)
        throw new FactoryExternalPullRequestReplacementQuarantineError(
          "Replacement-draft PR creation reconciled to conflicting remote evidence."
        );
      throw new Error(
        "Replacement-draft PR creation was not exactly reconciled; the branch was retained.",
        { cause: error }
      );
    }
    if (!matches(created, proposal, input.headRevision, this.options.publisherUserId)) {
      await this.#closeMismatchedCreatedDraft(created, proposal, input.headRevision);
      throw new FactoryExternalPullRequestReplacementQuarantineError(
        "GitHub created a replacement draft that differs from its durable intent."
      );
    }
    return { record: this.#record(created, proposal, input.headRevision), created: true };
  }

  public async verifyDraft(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly record: z.infer<typeof factoryExternalPullRequestReplacementDraftRecordSchema>;
  }): Promise<void> {
    const proposal = factoryExternalPullRequestReplacementDraftProposalSchema.parse(input.proposal);
    const record = factoryExternalPullRequestReplacementDraftRecordSchema.parse(input.record);
    this.#assertCoordinates(proposal);
    const [branch, pullRequest] = await Promise.all([
      this.#branch(record.branchName),
      this.#pullRequest(record.replacementPullRequestNumber)
    ]);
    if (
      record.publisherId !== `github-user/${String(this.options.publisherUserId)}` ||
      branch?.object.sha !== record.headRevision ||
      pullRequest.html_url !== record.replacementPullRequestUrl ||
      !matches(pullRequest, proposal, record.headRevision, this.options.publisherUserId)
    ) {
      throw new Error("Replacement draft no longer matches its exact broker record.");
    }
  }

  #proposal(input: unknown, patch: string) {
    const proposal = factoryExternalPullRequestReplacementDraftProposalSchema.parse(input);
    this.#assertCoordinates(proposal);
    if (
      Buffer.byteLength(patch, "utf8") > this.options.maximumPatchBytes ||
      `sha256:${createHash("sha256").update(patch, "utf8").digest("hex")}` !==
        proposal.repairedPatchDigest
    ) {
      throw new Error("Replacement-draft patch bytes differ from qualified evidence.");
    }
    return proposal;
  }
  #assertCoordinates(proposal: FactoryExternalPullRequestReplacementDraftProposal): void {
    if (proposal.repositoryId !== this.options.repositoryId)
      throw new Error("Replacement-draft broker repository changed.");
  }
  async #assertOriginalStillExact(
    proposal: FactoryExternalPullRequestReplacementDraftProposal
  ): Promise<void> {
    const current = await this.inspectOriginal(proposal.originalPullRequestNumber);
    if (
      current.state !== "open" ||
      current.url !== proposal.originalPullRequestUrl ||
      current.baseBranch !== proposal.expectedBaseBranch ||
      current.baseRevision !== proposal.expectedBaseRevision ||
      current.headRevision !== proposal.expectedOriginalHeadRevision
    ) {
      throw new FactoryExternalPullRequestReplacementStaleError(
        "Original PR moved after repair qualification."
      );
    }
    const governance = current.governance;
    if (
      !governance.requiresPullRequest ||
      governance.requiredApprovals < 1 ||
      !governance.dismissesStaleReviews ||
      !governance.requiresCodeOwnerReviews ||
      !governance.requiresLastPushApproval ||
      !governance.enforcesAdmins ||
      governance.allowsForcePushes ||
      governance.allowsDeletions ||
      proposal.changeSet.changedFiles < 1 ||
      !this.options.trustedStatusChecks.every(({ context }) =>
        governance.requiredStatusChecks.includes(context)
      )
    ) {
      throw new FactoryExternalPullRequestReplacementStaleError(
        "Repository governance weakened before replacement-draft publication."
      );
    }
  }
  #record(
    pullRequest: z.infer<typeof replacementPullRequestSchema>,
    proposal: FactoryExternalPullRequestReplacementDraftProposal,
    headRevision: GitObjectId
  ) {
    return factoryExternalPullRequestReplacementDraftRecordSchema.parse({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-record.v1",
      publicationRunId: proposal.publicationRunId,
      runDigest: proposal.runDigest,
      proposalDigest:
        this.options.documents.externalPullRequestReplacementDraftProposal(proposal).digest,
      qualificationBundleDigest: proposal.qualificationBundleDigest,
      repositoryId: proposal.repositoryId,
      originalPullRequestNumber: proposal.originalPullRequestNumber,
      originalPullRequestUrl: proposal.originalPullRequestUrl,
      replacementPullRequestNumber: pullRequest.number,
      replacementPullRequestUrl: pullRequest.html_url,
      baseBranch: proposal.expectedBaseBranch,
      baseRevision: proposal.expectedBaseRevision,
      branchName: proposal.branchName,
      headRevision,
      brokerId: this.options.brokerId,
      publisherId: `github-user/${String(this.options.publisherUserId)}`,
      draft: true,
      createdAt: new Date(pullRequest.created_at).toISOString()
    });
  }
  async #pullRequestsForBranch(branchName: string) {
    return z
      .array(replacementPullRequestSchema)
      .max(10)
      .parse(
        await this.options.api.request(
          "GET",
          `/repos/${this.options.repositoryId}/pulls?state=all&head=${encodeURIComponent(`${this.#owner}:${branchName}`)}&per_page=10`
        )
      );
  }
  async #pullRequest(number: number) {
    return replacementPullRequestSchema.parse(
      await this.options.api.request(
        "GET",
        `/repos/${this.options.repositoryId}/pulls/${String(number)}`
      )
    );
  }
  async #branch(branchName: string): Promise<z.infer<typeof refSchema> | null> {
    const value = await this.#optional(
      "GET",
      `/repos/${this.options.repositoryId}/git/ref/heads/${encodeURIComponent(branchName)}`
    );
    return value === null ? null : refSchema.parse(value);
  }
  async #optional(method: "GET", path: string): Promise<unknown> {
    try {
      return await this.options.api.request(method, path);
    } catch (error: unknown) {
      if (error instanceof GitHubApiError && error.statusCode === 404) return null;
      throw error;
    }
  }
  async #closeMismatchedCreatedDraft(
    pullRequest: z.infer<typeof replacementPullRequestSchema>,
    proposal: FactoryExternalPullRequestReplacementDraftProposal,
    headRevision: GitObjectId
  ): Promise<void> {
    if (
      pullRequest.state !== "open" ||
      !pullRequest.draft ||
      pullRequest.base.ref !== proposal.expectedBaseBranch ||
      pullRequest.base.sha !== proposal.expectedBaseRevision ||
      pullRequest.head.ref !== proposal.branchName ||
      pullRequest.head.sha !== headRevision
    )
      return;
    const closed = replacementPullRequestSchema.parse(
      await this.options.api.request(
        "PATCH",
        `/repos/${this.options.repositoryId}/pulls/${String(pullRequest.number)}`,
        { state: "closed" }
      )
    );
    if (closed.state !== "closed")
      throw new Error("Mismatched replacement draft could not be closed.");
  }
}

const replacementPullRequestSchema = githubPullRequestSchema.extend({ user: githubAuthorSchema });
function matches(
  pullRequest: z.infer<typeof replacementPullRequestSchema>,
  proposal: FactoryExternalPullRequestReplacementDraftProposal,
  headRevision: GitObjectId,
  publisherUserId: number
): boolean {
  return (
    pullRequest.user?.id === publisherUserId &&
    pullRequest.state === "open" &&
    pullRequest.draft &&
    pullRequest.title === proposal.title &&
    pullRequest.body === proposal.body &&
    pullRequest.base.ref === proposal.expectedBaseBranch &&
    pullRequest.base.sha === proposal.expectedBaseRevision &&
    pullRequest.head.ref === proposal.branchName &&
    pullRequest.head.sha === headRevision
  );
}
function validateToken(token: string): string {
  if (token.length < 1 || token.length > 4_096 || /[\0\r\n]/u.test(token))
    throw new Error("GitHub replacement-draft credential is invalid.");
  return token;
}
function gitAuthorizationHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}
