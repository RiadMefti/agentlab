import { createHash } from "node:crypto";

import {
  factoryPullRequestProposalSchema,
  factoryPullRequestRecordSchema,
  gitObjectIdSchema,
  type FactoryPullRequestProposal,
  type FactoryPullRequestRecord
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryDocumentCodec } from "../../domain/factory-documents.js";
import type {
  FactoryDraftPullRequestBroker,
  FactoryPullRequestBrokerIdentity,
  FactoryRemoteRepositorySnapshot,
  OpenFactoryDraftPullRequestInput,
  OpenFactoryDraftPullRequestResult,
  VerifyFactoryDraftPullRequestInput
} from "../../domain/factory-pull-request-broker.js";
import type { CommandRunner } from "../process/command-runner.js";
import { GitBrokerWorkspace, type PreparedGitBrokerCommit } from "./git-broker-workspace.js";
import { githubPullRequestSchema } from "./github-pull-request-api-contracts.js";
import {
  GitHubApiError,
  type GitHubRestApi,
  type GitHubTokenSource
} from "./github-rest-client.js";
import {
  githubTrustedStatusCheckBindings,
  type GitHubTrustedStatusCheck
} from "./github-trusted-status-checks.js";

const repositorySchema = z.object({ default_branch: z.string().min(1).max(128) });
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
      contexts: z.array(z.string().min(1).max(256)).max(1_000).optional(),
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

export interface GitHubFactoryPullRequestBrokerOptions {
  readonly repositoryId: string;
  readonly brokerId: string;
  readonly tokenSource: GitHubTokenSource;
  readonly api: GitHubRestApi;
  readonly documents: Pick<FactoryDocumentCodec, "pullRequestProposal">;
  readonly gitExecutable: string;
  readonly temporaryRoot: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly maximumPatchBytes?: number;
  readonly trustedStatusChecks: readonly GitHubTrustedStatusCheck[];
}

/** GitHub authority adapter: exact-base commit, non-force push, draft PR, and compensating close. */
export class GitHubFactoryPullRequestBroker implements FactoryDraftPullRequestBroker {
  readonly #repositoryId: string;
  readonly #owner: string;
  readonly #brokerId: string;
  readonly #maximumPatchBytes: number;
  readonly #trustedStatusChecks: ReadonlyMap<string, number>;
  readonly #workspace: GitBrokerWorkspace;

  public constructor(
    runner: CommandRunner,
    private readonly options: GitHubFactoryPullRequestBrokerOptions
  ) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub factory repository must be a lowercase owner/name pair.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.brokerId)) {
      throw new Error("GitHub factory broker ID is invalid.");
    }
    this.#repositoryId = options.repositoryId;
    this.#owner = options.repositoryId.split("/", 1)[0] ?? "";
    this.#brokerId = options.brokerId;
    this.#maximumPatchBytes = options.maximumPatchBytes ?? 64 * 1_024 * 1_024;
    if (!Number.isSafeInteger(this.#maximumPatchBytes) || this.#maximumPatchBytes < 1) {
      throw new Error("GitHub factory patch limit must be a positive integer.");
    }
    this.#trustedStatusChecks = githubTrustedStatusCheckBindings(options.trustedStatusChecks);
    this.#workspace = new GitBrokerWorkspace(runner, {
      root: options.temporaryRoot,
      gitExecutable: options.gitExecutable,
      authorName: options.authorName ?? "AgentLab PR Broker",
      authorEmail: options.authorEmail ?? "agentlab-broker@users.noreply.github.com"
    });
  }

  public identity(): FactoryPullRequestBrokerIdentity {
    return { brokerId: this.#brokerId, repositoryId: this.#repositoryId };
  }

  public async inspect(repositoryId: string): Promise<FactoryRemoteRepositorySnapshot> {
    this.#assertRepository(repositoryId);
    const repository = repositorySchema.parse(
      await this.options.api.request("GET", `/repos/${this.#repositoryId}`)
    );
    const baseBranch = repository.default_branch;
    const reference = refSchema.parse(
      await this.options.api.request(
        "GET",
        `/repos/${this.#repositoryId}/git/ref/heads/${encodeURIComponent(baseBranch)}`
      )
    );
    const protectionValue = await this.#optional(
      "GET",
      `/repos/${this.#repositoryId}/branches/${encodeURIComponent(baseBranch)}/protection`
    );
    const protection = protectionValue === null ? null : protectionSchema.parse(protectionValue);
    const reviews = protection?.required_pull_request_reviews ?? null;
    const checks = protection?.required_status_checks ?? null;
    return {
      repositoryId: this.#repositoryId,
      baseBranch,
      baseRevision: reference.object.sha,
      governance: {
        requiresPullRequest: reviews !== null,
        requiredApprovals: reviews?.required_approving_review_count ?? 0,
        dismissesStaleReviews: reviews?.dismiss_stale_reviews ?? false,
        requiresCodeOwnerReviews: reviews?.require_code_owner_reviews ?? false,
        requiresLastPushApproval: reviews?.require_last_push_approval ?? false,
        enforcesAdmins: protection?.enforce_admins?.enabled ?? false,
        allowsForcePushes: protection?.allow_force_pushes?.enabled ?? true,
        allowsDeletions: protection?.allow_deletions?.enabled ?? true,
        requiredStatusChecks: (checks?.checks ?? [])
          .filter((check) => this.#trustedStatusChecks.get(check.context) === check.app_id)
          .map(({ context }) => context)
          .filter((context, index, values) => values.indexOf(context) === index)
      }
    };
  }

  public async openDraft(
    input: OpenFactoryDraftPullRequestInput
  ): Promise<OpenFactoryDraftPullRequestResult> {
    const proposal = factoryPullRequestProposalSchema.parse(input.proposal);
    this.#assertRepository(proposal.repositoryId);
    if (proposal.branchName !== deduplicationBranch(proposal)) {
      throw new Error("GitHub broker branch does not match the immutable deduplication key.");
    }
    this.#assertPatch(proposal, input.patch);
    const remote = await this.inspect(proposal.repositoryId);
    assertRemoteStillAuthorized(remote, proposal);
    const prepared = await this.#workspace.prepare({
      repositoryRoot: input.repositoryRoot,
      baseRevision: proposal.baseRevision,
      patch: input.patch,
      patchMaximumBytes: this.#maximumPatchBytes,
      expectedChangeSet: proposal.changeSet,
      title: proposal.title,
      timestamp: proposal.createdAt
    });
    let result: OpenFactoryDraftPullRequestResult | null = null;
    try {
      result = await this.#publishPrepared(prepared, proposal);
      return result;
    } finally {
      await this.#closePrepared(prepared, result);
    }
  }

  public async verifyDraft(input: VerifyFactoryDraftPullRequestInput): Promise<void> {
    const proposal = factoryPullRequestProposalSchema.parse(input.proposal);
    const record = factoryPullRequestRecordSchema.parse(input.record);
    this.#assertRepository(proposal.repositoryId);
    assertRecordMatchesProposal(record, proposal, this.#brokerId, this.options.documents);
    const [reference, pullRequest] = await Promise.all([
      this.#branchReference(record.branchName),
      this.#pullRequest(record.number)
    ]);
    if (
      reference?.object.sha !== record.headRevision ||
      pullRequest.number !== record.number ||
      pullRequest.html_url !== record.url ||
      new Date(pullRequest.created_at).toISOString() !== record.createdAt ||
      !matchesProposal(pullRequest, proposal, record.headRevision)
    ) {
      throw new Error("Remote draft PR no longer matches its exact broker record and proposal.");
    }
  }

  public async closeDraft(recordInput: FactoryPullRequestRecord, reason: string): Promise<void> {
    const record = factoryPullRequestRecordSchema.parse(recordInput);
    this.#assertRepository(record.repositoryId);
    if (
      record.brokerId !== this.#brokerId ||
      !/^agentlab\/[0-9a-f]{64}$/u.test(record.branchName) ||
      reason.length < 1 ||
      reason.length > 500
    ) {
      throw new Error("Broker may compensate only its own identified draft PR.");
    }
    const reference = await this.#branchReference(record.branchName);
    if (reference !== null && reference.object.sha !== record.headRevision) {
      throw new Error("Refusing to delete a broker branch that moved after creation.");
    }
    const pullRequest = await this.#pullRequest(record.number);
    if (
      pullRequest.html_url !== record.url ||
      pullRequest.base.sha !== record.baseRevision ||
      pullRequest.head.ref !== record.branchName ||
      pullRequest.head.sha !== record.headRevision
    ) {
      throw new Error("Refusing to compensate a PR that does not match its broker record.");
    }
    if (pullRequest.state === "open") {
      if (!pullRequest.draft) throw new Error("Refusing to close a broker PR promoted from draft.");
      await this.#closePullRequest(record.number);
    }
    if (reference !== null) await this.#deleteBranch(record.branchName);
  }

  async #publishPrepared(
    prepared: PreparedGitBrokerCommit,
    proposal: FactoryPullRequestProposal
  ): Promise<OpenFactoryDraftPullRequestResult> {
    const headRevision = prepared.headRevision;
    if (headRevision === null) throw new Error("Broker commit preparation returned no head.");
    const priorReference = await this.#branchReference(proposal.branchName);
    const existing = await this.#pullRequestsForBranch(proposal.branchName);
    if (existing.length > 1) throw new Error("Broker branch maps to multiple pull requests.");
    const prior = existing[0];
    if (prior !== undefined) {
      if (
        priorReference?.object.sha !== headRevision ||
        prior.state !== "open" ||
        !prior.draft ||
        prior.title !== proposal.title ||
        prior.body !== proposal.body ||
        prior.base.ref !== proposal.baseBranch ||
        prior.base.sha !== proposal.baseRevision ||
        prior.head.ref !== proposal.branchName ||
        prior.head.sha !== headRevision
      ) {
        throw new Error("Existing broker PR does not match the idempotent proposal.");
      }
      return { record: this.#record(prior, proposal), created: false };
    }
    if (priorReference === null) {
      const token = validateToken(await this.options.tokenSource.token(this.#repositoryId));
      const authorizationHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      try {
        await prepared.push({
          repositoryUrl: `https://github.com/${this.#repositoryId}.git`,
          branchName: proposal.branchName,
          authorizationHeader
        });
      } catch (error: unknown) {
        this.options.tokenSource.invalidate?.(this.#repositoryId, token);
        throw error;
      }
    } else if (priorReference.object.sha !== headRevision) {
      throw new Error("Broker branch exists with a different head revision.");
    }
    let created: z.infer<typeof githubPullRequestSchema>;
    try {
      created = githubPullRequestSchema.parse(
        await this.options.api.request("POST", `/repos/${this.#repositoryId}/pulls`, {
          title: proposal.title,
          body: proposal.body,
          head: proposal.branchName,
          base: proposal.baseBranch,
          draft: true,
          maintainer_can_modify: false
        })
      );
    } catch (error: unknown) {
      let found: readonly z.infer<typeof githubPullRequestSchema>[];
      try {
        found = await this.#pullRequestsForBranch(proposal.branchName);
      } catch (inspectionError: unknown) {
        throw new AggregateError(
          [error, inspectionError],
          "GitHub PR creation status is unknown; the broker branch was retained for recovery."
        );
      }
      if (found.length > 1) {
        throw new AggregateError(
          [error, new Error("Broker branch maps to multiple pull requests.")],
          "GitHub PR creation status is ambiguous; the exact branch was retained for recovery."
        );
      }
      const recovered = found[0];
      if (recovered !== undefined && matchesProposal(recovered, proposal, headRevision)) {
        return { record: this.#record(recovered, proposal), created: false };
      }
      throw new Error(
        "GitHub PR creation was not confirmed; the exact broker branch was retained for recovery.",
        { cause: error }
      );
    }
    if (!matchesProposal(created, proposal, headRevision)) {
      const mismatch = new Error(
        "GitHub created a PR that does not match the exact broker proposal."
      );
      try {
        await this.#compensateCreated(created.number, proposal.branchName, headRevision);
      } catch (compensationError: unknown) {
        throw new AggregateError(
          [mismatch, compensationError],
          "GitHub created a mismatched PR and compensation was incomplete."
        );
      }
      throw mismatch;
    }
    return { record: this.#record(created, proposal), created: true };
  }

  async #closePrepared(
    prepared: PreparedGitBrokerCommit,
    result: OpenFactoryDraftPullRequestResult | null
  ): Promise<void> {
    try {
      await prepared.close();
    } catch (cleanupError: unknown) {
      if (result?.created === true) {
        try {
          await this.#compensateCreated(
            result.record.number,
            result.record.branchName,
            result.record.headRevision
          );
        } catch (compensationError: unknown) {
          throw new AggregateError(
            [cleanupError, compensationError],
            "Broker workspace cleanup failed and its new PR could not be compensated."
          );
        }
      }
      throw new Error("Broker workspace cleanup could not be confirmed.", {
        cause: cleanupError
      });
    }
  }

  #record(
    pullRequest: z.infer<typeof githubPullRequestSchema>,
    proposal: FactoryPullRequestProposal
  ): FactoryPullRequestRecord {
    return factoryPullRequestRecordSchema.parse({
      schemaVersion: "agentlab.pull-request-record.v1",
      taskId: proposal.taskId,
      contractDigest: proposal.contractDigest,
      proposalDigest: this.options.documents.pullRequestProposal(proposal).digest,
      repositoryId: proposal.repositoryId,
      number: pullRequest.number,
      url: pullRequest.html_url,
      baseRevision: pullRequest.base.sha,
      headRevision: pullRequest.head.sha,
      branchName: proposal.branchName,
      draft: true,
      brokerId: this.#brokerId,
      createdAt: new Date(pullRequest.created_at).toISOString()
    });
  }

  async #pullRequestsForBranch(branchName: string) {
    const value = await this.options.api.request(
      "GET",
      `/repos/${this.#repositoryId}/pulls?state=all&head=${encodeURIComponent(`${this.#owner}:${branchName}`)}&per_page=10`
    );
    return z.array(githubPullRequestSchema).max(10).parse(value);
  }

  async #pullRequest(number: number): Promise<z.infer<typeof githubPullRequestSchema>> {
    return githubPullRequestSchema.parse(
      await this.options.api.request("GET", `/repos/${this.#repositoryId}/pulls/${String(number)}`)
    );
  }

  async #branchReference(branchName: string): Promise<z.infer<typeof refSchema> | null> {
    const value = await this.#optional(
      "GET",
      `/repos/${this.#repositoryId}/git/ref/heads/${encodeURIComponent(branchName)}`
    );
    return value === null ? null : refSchema.parse(value);
  }

  async #deleteBranchIfExact(branchName: string, headRevision: string): Promise<void> {
    const reference = await this.#branchReference(branchName);
    if (reference === null) return;
    if (reference.object.sha !== headRevision) {
      throw new Error("Refusing to compensate a broker branch with a different head.");
    }
    await this.#deleteBranch(branchName);
  }

  async #deleteBranch(branchName: string): Promise<void> {
    await this.options.api.request(
      "DELETE",
      `/repos/${this.#repositoryId}/git/refs/heads/${encodeURIComponent(branchName)}`
    );
  }

  async #compensateCreated(
    pullRequestNumber: number,
    branchName: string,
    headRevision: string
  ): Promise<void> {
    await this.#closePullRequest(pullRequestNumber);
    await this.#deleteBranchIfExact(branchName, headRevision);
  }

  async #closePullRequest(pullRequestNumber: number): Promise<void> {
    const closed = githubPullRequestSchema.parse(
      await this.options.api.request(
        "PATCH",
        `/repos/${this.#repositoryId}/pulls/${String(pullRequestNumber)}`,
        { state: "closed" }
      )
    );
    if (closed.state !== "closed") throw new Error("GitHub did not confirm draft PR closure.");
  }

  async #optional(method: "GET", path: string): Promise<unknown> {
    try {
      return await this.options.api.request(method, path);
    } catch (error: unknown) {
      if (error instanceof GitHubApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  #assertPatch(proposal: FactoryPullRequestProposal, patch: string): void {
    if (Buffer.byteLength(patch, "utf8") > this.#maximumPatchBytes) {
      throw new Error("GitHub broker patch exceeds its configured limit.");
    }
    const digest = `sha256:${createHash("sha256").update(patch, "utf8").digest("hex")}`;
    if (digest !== proposal.patchArtifactDigest) {
      throw new Error("GitHub broker patch bytes do not match the authorized artifact.");
    }
  }

  #assertRepository(repositoryId: string): void {
    if (repositoryId.toLowerCase() !== this.#repositoryId) {
      throw new Error("GitHub broker is not authorized for this repository.");
    }
  }
}

function assertRecordMatchesProposal(
  record: FactoryPullRequestRecord,
  proposal: FactoryPullRequestProposal,
  brokerId: string,
  documents: Pick<FactoryDocumentCodec, "pullRequestProposal">
): void {
  if (
    record.taskId !== proposal.taskId ||
    record.contractDigest !== proposal.contractDigest ||
    record.proposalDigest !== documents.pullRequestProposal(proposal).digest ||
    record.repositoryId !== proposal.repositoryId ||
    record.baseRevision !== proposal.baseRevision ||
    record.branchName !== proposal.branchName ||
    record.brokerId !== brokerId ||
    record.headRevision === record.baseRevision
  ) {
    throw new Error("Draft PR record does not match its exact broker proposal.");
  }
}

function matchesProposal(
  pullRequest: z.infer<typeof githubPullRequestSchema>,
  proposal: FactoryPullRequestProposal,
  headRevision: string
): boolean {
  return (
    pullRequest.state === "open" &&
    pullRequest.draft &&
    pullRequest.title === proposal.title &&
    pullRequest.body === proposal.body &&
    pullRequest.base.ref === proposal.baseBranch &&
    pullRequest.base.sha === proposal.baseRevision &&
    pullRequest.head.ref === proposal.branchName &&
    pullRequest.head.sha === headRevision
  );
}

function assertRemoteStillAuthorized(
  remote: FactoryRemoteRepositorySnapshot,
  proposal: FactoryPullRequestProposal
): void {
  if (
    remote.repositoryId !== proposal.repositoryId ||
    remote.baseBranch !== proposal.baseBranch ||
    remote.baseRevision !== proposal.baseRevision
  ) {
    throw new Error("GitHub base changed after policy authorization.");
  }
  const governance = remote.governance;
  if (
    !governance.requiresPullRequest ||
    governance.requiredApprovals < 1 ||
    !governance.dismissesStaleReviews ||
    !governance.requiresCodeOwnerReviews ||
    !governance.requiresLastPushApproval ||
    !governance.enforcesAdmins ||
    governance.allowsForcePushes ||
    governance.allowsDeletions ||
    !governance.requiredStatusChecks.includes("verify") ||
    !governance.requiredStatusChecks.includes("factory-sandbox")
  ) {
    throw new Error("GitHub governance weakened after policy authorization.");
  }
}

function validateToken(token: string): string {
  if (token.length < 1 || token.length > 4_096 || /[\0\r\n]/u.test(token)) {
    throw new Error("GitHub broker credential is invalid.");
  }
  return token;
}

function deduplicationBranch(proposal: FactoryPullRequestProposal): string {
  return `agentlab/${proposal.deduplicationKey.slice("sha256:".length)}`;
}
