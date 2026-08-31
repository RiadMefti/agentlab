import {
  factoryPullRequestObservationSchema,
  factoryPullRequestRecordSchema,
  type FactoryPullRequestCheckObservation,
  type FactoryPullRequestFeedbackAuthor,
  type FactoryPullRequestObservation
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryDocumentCodec } from "../../domain/factory-documents.js";
import type {
  FactoryPullRequestBrokerIdentity,
  FactoryPullRequestObserver,
  ObserveFactoryPullRequestInput
} from "../../domain/factory-pull-request-broker.js";
import {
  githubAuthorAssociationSchema,
  githubAuthorSchema,
  githubCheckRunsSchema,
  githubCheckRunSchema,
  githubPullRequestConversationCommentSchema,
  githubPullRequestReviewCommentSchema,
  githubPullRequestReviewSchema,
  githubPullRequestSchema
} from "./github-pull-request-api-contracts.js";
import type { GitHubReadApi } from "./github-rest-client.js";
import {
  githubTrustedStatusCheckBindings,
  type GitHubTrustedStatusCheck
} from "./github-trusted-status-checks.js";

export interface GitHubFactoryPullRequestObserverOptions {
  readonly repositoryId: string;
  readonly brokerId: string;
  readonly api: GitHubReadApi;
  readonly documents: Pick<FactoryDocumentCodec, "pullRequestRecord">;
  readonly trustedStatusChecks: readonly GitHubTrustedStatusCheck[];
  readonly now?: () => string;
}

/** GitHub read adapter: exact durable PR identity, bounded pages, and trusted-head checks. */
export class GitHubFactoryPullRequestObserver implements FactoryPullRequestObserver {
  readonly #repositoryId: string;
  readonly #brokerId: string;
  readonly #trustedStatusChecks: ReadonlyMap<string, number>;

  public constructor(private readonly options: GitHubFactoryPullRequestObserverOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub factory repository must be a lowercase owner/name pair.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.brokerId)) {
      throw new Error("GitHub factory broker ID is invalid.");
    }
    this.#repositoryId = options.repositoryId;
    this.#brokerId = options.brokerId;
    this.#trustedStatusChecks = githubTrustedStatusCheckBindings(options.trustedStatusChecks);
  }

  public identity(): FactoryPullRequestBrokerIdentity {
    return { brokerId: this.#brokerId, repositoryId: this.#repositoryId };
  }

  public async observe(
    input: ObserveFactoryPullRequestInput
  ): Promise<FactoryPullRequestObservation> {
    const record = factoryPullRequestRecordSchema.parse(input.record);
    this.#assertRepository(record.repositoryId);
    if (record.brokerId !== this.#brokerId) {
      throw new Error("GitHub observer is not bound to this pull-request record.");
    }
    const pullRequest = await this.#pullRequest(record.number);
    if (
      pullRequest.number !== record.number ||
      pullRequest.html_url !== record.url ||
      pullRequest.head.ref !== record.branchName
    ) {
      throw new Error("Remote pull request no longer matches its durable broker identity.");
    }
    const [reviewValue, reviewCommentValue, conversationCommentValue, checkValue] =
      await Promise.all([
        this.options.api.request(
          "GET",
          `/repos/${this.#repositoryId}/pulls/${String(record.number)}/reviews?per_page=100`
        ),
        this.options.api.request(
          "GET",
          `/repos/${this.#repositoryId}/pulls/${String(record.number)}/comments?per_page=100`
        ),
        this.options.api.request(
          "GET",
          `/repos/${this.#repositoryId}/issues/${String(record.number)}/comments?per_page=100`
        ),
        this.options.api.request(
          "GET",
          `/repos/${this.#repositoryId}/commits/${pullRequest.head.sha}/check-runs?filter=latest&per_page=100`
        )
      ]);
    const reviews = z.array(githubPullRequestReviewSchema).max(100).parse(reviewValue);
    const reviewComments = z
      .array(githubPullRequestReviewCommentSchema)
      .max(100)
      .parse(reviewCommentValue);
    const conversationComments = z
      .array(githubPullRequestConversationCommentSchema)
      .max(100)
      .parse(conversationCommentValue);
    const checkRuns = githubCheckRunsSchema.parse(checkValue);
    if (
      reviews.length === 100 ||
      reviewComments.length === 100 ||
      conversationComments.length === 100
    ) {
      throw new Error("GitHub PR feedback exceeds the broker's single-page observation limit.");
    }
    if (checkRuns.total_count !== checkRuns.check_runs.length || checkRuns.total_count === 100) {
      throw new Error("GitHub check runs exceed or contradict the bounded observation page.");
    }
    const confirmedPullRequest = await this.#pullRequest(record.number);
    if (!sameObservedPullRequest(pullRequest, confirmedPullRequest)) {
      throw new Error("Remote pull request changed during its bounded observation.");
    }
    return factoryPullRequestObservationSchema.parse({
      schemaVersion: "agentlab.pull-request-observation.v1",
      taskId: record.taskId,
      contractDigest: record.contractDigest,
      proposalDigest: record.proposalDigest,
      pullRequestRecordDigest: this.options.documents.pullRequestRecord(record).digest,
      repositoryId: record.repositoryId,
      pullRequestNumber: record.number,
      url: record.url,
      brokerId: record.brokerId,
      authorizedBaseRevision: record.baseRevision,
      recordedHeadRevision: record.headRevision,
      remoteBaseRevision: pullRequest.base.sha,
      remoteHeadRevision: pullRequest.head.sha,
      branchName: pullRequest.head.ref,
      state: pullRequest.state,
      draft: pullRequest.draft,
      merged: pullRequest.merged ?? false,
      trustedChecks: this.#trustedChecks(checkRuns.check_runs, pullRequest.head.sha),
      reviews: reviews
        .map(reviewObservation)
        .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
      reviewComments: reviewComments
        .map(reviewCommentObservation)
        .sort((left, right) => left.commentId.localeCompare(right.commentId)),
      conversationComments: conversationComments
        .map(conversationCommentObservation)
        .sort((left, right) => left.commentId.localeCompare(right.commentId)),
      observedAt: normalizeTimestamp(this.options.now?.() ?? new Date().toISOString())
    });
  }

  #trustedChecks(
    runs: readonly z.infer<typeof githubCheckRunSchema>[],
    headRevision: string
  ): readonly FactoryPullRequestCheckObservation[] {
    return [...this.#trustedStatusChecks.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, appId]) => trustedCheck(runs, headRevision, name, appId));
  }

  #pullRequest(number: number): Promise<z.infer<typeof githubPullRequestSchema>> {
    return this.options.api
      .request("GET", `/repos/${this.#repositoryId}/pulls/${String(number)}`)
      .then((value) => githubPullRequestSchema.parse(value));
  }

  #assertRepository(repositoryId: string): void {
    if (repositoryId.toLowerCase() !== this.#repositoryId) {
      throw new Error("GitHub observer is not authorized for this repository.");
    }
  }
}

function trustedCheck(
  runs: readonly z.infer<typeof githubCheckRunSchema>[],
  headRevision: string,
  name: string,
  appId: number
): FactoryPullRequestCheckObservation {
  const matches = runs.filter(
    (run) => run.name === name && run.app.id === appId && run.head_sha === headRevision
  );
  if (matches.length > 1) {
    throw new Error(`GitHub returned ambiguous trusted check runs for ${name}.`);
  }
  const run = matches[0];
  const producerId = `github-app/${String(appId)}`;
  if (run === undefined) {
    return {
      name,
      producerId,
      status: "missing",
      runId: null,
      conclusion: null,
      url: null,
      startedAt: null,
      completedAt: null
    };
  }
  if (run.status !== "completed") {
    return {
      name,
      producerId,
      status: run.status === "in_progress" ? "in-progress" : "queued",
      runId: String(run.id),
      conclusion: null,
      url: run.details_url,
      startedAt: nullableTimestamp(run.started_at),
      completedAt: null
    };
  }
  if (run.conclusion === null || run.completed_at === null) {
    throw new Error(`GitHub completed trusted check ${name} without a conclusion or time.`);
  }
  return {
    name,
    producerId,
    status: "completed",
    runId: String(run.id),
    conclusion: normalizeCheckConclusion(run.conclusion),
    url: run.details_url,
    startedAt: nullableTimestamp(run.started_at),
    completedAt: normalizeTimestamp(run.completed_at)
  };
}

function sameObservedPullRequest(
  first: z.infer<typeof githubPullRequestSchema>,
  second: z.infer<typeof githubPullRequestSchema>
): boolean {
  return (
    first.number === second.number &&
    first.html_url === second.html_url &&
    first.state === second.state &&
    first.draft === second.draft &&
    (first.merged ?? false) === (second.merged ?? false) &&
    first.base.ref === second.base.ref &&
    first.base.sha === second.base.sha &&
    first.head.ref === second.head.ref &&
    first.head.sha === second.head.sha
  );
}

function reviewObservation(review: z.infer<typeof githubPullRequestReviewSchema>) {
  return {
    reviewId: String(review.id),
    author: feedbackAuthor(review.user, review.author_association, `review-${String(review.id)}`),
    decision: review.state.toLowerCase().replaceAll("_", "-") as
      "approved" | "changes-requested" | "commented" | "dismissed" | "pending",
    headRevision: review.commit_id,
    untrustedBody: review.body ?? "",
    submittedAt: nullableTimestamp(review.submitted_at),
    url: review.html_url
  };
}

function reviewCommentObservation(comment: z.infer<typeof githubPullRequestReviewCommentSchema>) {
  return {
    commentId: String(comment.id),
    reviewId:
      comment.pull_request_review_id === null ? null : String(comment.pull_request_review_id),
    author: feedbackAuthor(
      comment.user,
      comment.author_association,
      `comment-${String(comment.id)}`
    ),
    headRevision: comment.commit_id,
    path: comment.path,
    line: comment.line,
    side: comment.side === null ? null : (comment.side.toLowerCase() as "left" | "right"),
    untrustedBody: comment.body,
    createdAt: normalizeTimestamp(comment.created_at),
    updatedAt: normalizeTimestamp(comment.updated_at),
    url: comment.html_url
  };
}

function conversationCommentObservation(
  comment: z.infer<typeof githubPullRequestConversationCommentSchema>
) {
  return {
    commentId: String(comment.id),
    author: feedbackAuthor(
      comment.user,
      comment.author_association,
      `conversation-comment-${String(comment.id)}`
    ),
    untrustedBody: comment.body,
    createdAt: normalizeTimestamp(comment.created_at),
    updatedAt: normalizeTimestamp(comment.updated_at),
    url: comment.html_url
  };
}

function feedbackAuthor(
  author: z.infer<typeof githubAuthorSchema>,
  association: z.infer<typeof githubAuthorAssociationSchema>,
  unknownSuffix: string
): FactoryPullRequestFeedbackAuthor {
  return {
    externalId:
      author === null ? `github-user/unknown-${unknownSuffix}` : `github-user/${String(author.id)}`,
    login: author?.login ?? "unknown",
    kind: author?.type === "User" ? "human" : author?.type === "Bot" ? "bot" : "unknown",
    association: association
      .toLowerCase()
      .replaceAll("_", "-") as FactoryPullRequestFeedbackAuthor["association"]
  };
}

function normalizeCheckConclusion(
  conclusion: NonNullable<z.infer<typeof githubCheckRunSchema>["conclusion"]>
) {
  return conclusion.replaceAll("_", "-") as NonNullable<
    FactoryPullRequestCheckObservation["conclusion"]
  >;
}

function nullableTimestamp(value: string | null): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("GitHub returned an invalid timestamp.");
  return new Date(milliseconds).toISOString();
}
