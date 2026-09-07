import { createHash } from "node:crypto";

import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryExternalPullRequestFeedbackPublisher,
  FactoryExternalPullRequestRemotePublication
} from "../../domain/factory-external-pull-request-feedback-publisher.js";
import {
  githubPullRequestReviewSchema,
  githubPullRequestSchema,
  githubRepositoryIdentitySchema
} from "./github-pull-request-api-contracts.js";
import type { GitHubRestApi } from "./github-rest-client.js";

export interface GitHubExternalPullRequestFeedbackPublisherOptions {
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly publisherId: string;
  readonly publisherUserId: number;
  readonly api: GitHubRestApi;
}

/** Exact-purpose GitHub adapter that can submit only COMMENT reviews on one repository. */
export class GitHubExternalPullRequestFeedbackPublisher implements FactoryExternalPullRequestFeedbackPublisher {
  public constructor(private readonly options: GitHubExternalPullRequestFeedbackPublisherOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub feedback repository must be a lowercase owner/name pair.");
    }
    if (!Number.isSafeInteger(options.repositoryNumericId) || options.repositoryNumericId < 1) {
      throw new Error("GitHub feedback repository numeric ID is invalid.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.publisherId)) {
      throw new Error("GitHub feedback publisher ID is invalid.");
    }
    if (!Number.isSafeInteger(options.publisherUserId) || options.publisherUserId < 1) {
      throw new Error("GitHub feedback publisher user ID is invalid.");
    }
  }

  public identity() {
    return {
      repositoryId: this.options.repositoryId,
      repositoryNumericId: this.options.repositoryNumericId,
      publisherId: this.options.publisherId,
      publisherUserId: this.options.publisherUserId
    };
  }

  public async inspectRepository() {
    const repository = githubRepositoryIdentitySchema.parse(
      await this.options.api.request("GET", `/repos/${this.options.repositoryId}/`)
    );
    if (
      repository.id !== this.options.repositoryNumericId ||
      repository.full_name.toLowerCase() !== this.options.repositoryId
    ) {
      throw new Error("GitHub feedback publisher resolved another repository identity.");
    }
    return {
      repositoryId: this.options.repositoryId,
      repositoryNumericId: repository.id
    };
  }

  public async inspect(input: {
    readonly pullRequestNumber: number;
    readonly headRevision: string;
    readonly marker: string;
    readonly body: string;
    readonly bodyDigest: Sha256Digest;
  }) {
    assertPublicationInput(input.marker, input.body, input.bodyDigest);
    const pullRequest = githubPullRequestSchema.parse(
      await this.options.api.request(
        "GET",
        `/repos/${this.options.repositoryId}/pulls/${String(input.pullRequestNumber)}`
      )
    );
    if (
      pullRequest.number !== input.pullRequestNumber ||
      pullRequest.html_url !==
        `https://github.com/${this.options.repositoryId}/pull/${String(input.pullRequestNumber)}`
    ) {
      throw new Error("GitHub feedback inspection returned another pull request.");
    }
    const reviews = z
      .array(githubPullRequestReviewSchema)
      .max(100)
      .parse(
        await this.options.api.request(
          "GET",
          `/repos/${this.options.repositoryId}/pulls/${String(input.pullRequestNumber)}/reviews?per_page=100`
        )
      );
    if (reviews.length === 100) {
      throw new Error("GitHub feedback exceeds the bounded reconciliation page.");
    }
    const marked = reviews.filter(
      (review) =>
        review.user?.id === this.options.publisherUserId && review.body?.includes(input.marker)
    );
    if (marked.length > 1) {
      throw new Error("GitHub contains duplicate AgentLab feedback publications.");
    }
    const existing = marked[0];
    if (
      existing !== undefined &&
      (existing.body !== input.body ||
        existing.commit_id !== input.headRevision ||
        existing.state !== "COMMENTED" ||
        existing.submitted_at === null)
    ) {
      throw new Error("GitHub contains conflicting AgentLab feedback for this evidence digest.");
    }
    return {
      repositoryId: this.options.repositoryId,
      pullRequestNumber: pullRequest.number,
      url: pullRequest.html_url,
      state: pullRequest.state,
      draft: pullRequest.draft,
      merged: pullRequest.merged ?? false,
      baseRevision: pullRequest.base.sha,
      headRevision: pullRequest.head.sha,
      existingPublication:
        existing === undefined
          ? null
          : remotePublication(existing, input.bodyDigest, input.headRevision)
    };
  }

  public async publish(input: {
    readonly pullRequestNumber: number;
    readonly headRevision: string;
    readonly marker: string;
    readonly body: string;
    readonly bodyDigest: Sha256Digest;
  }): Promise<FactoryExternalPullRequestRemotePublication> {
    assertPublicationInput(input.marker, input.body, input.bodyDigest);
    const review = githubPullRequestReviewSchema.parse(
      await this.options.api.request(
        "POST",
        `/repos/${this.options.repositoryId}/pulls/${String(input.pullRequestNumber)}/reviews`,
        { body: input.body, event: "COMMENT", commit_id: input.headRevision }
      )
    );
    if (
      review.user?.id !== this.options.publisherUserId ||
      review.body !== input.body ||
      review.commit_id !== input.headRevision ||
      review.state !== "COMMENTED" ||
      review.submitted_at === null
    ) {
      throw new Error("GitHub returned feedback evidence with a different remote identity.");
    }
    return remotePublication(review, input.bodyDigest, input.headRevision);
  }
}

function remotePublication(
  review: z.infer<typeof githubPullRequestReviewSchema>,
  bodyDigest: Sha256Digest,
  headRevision: string
): FactoryExternalPullRequestRemotePublication {
  if (review.submitted_at === null) throw new Error("GitHub feedback has no submission time.");
  return {
    reviewId: String(review.id),
    state: "commented",
    url: review.html_url,
    headRevision,
    bodyDigest,
    submittedAt: normalizeTimestamp(review.submitted_at)
  };
}

function assertPublicationInput(marker: string, body: string, bodyDigest: Sha256Digest): void {
  sha256DigestSchema.parse(bodyDigest);
  if (
    !/^<!-- agentlab-external-review:sha256:[a-f0-9]{64} -->$/u.test(marker) ||
    !body.startsWith(`${marker}\n`) ||
    Buffer.byteLength(body, "utf8") > 16_000 ||
    digest(body) !== bodyDigest
  ) {
    throw new Error("GitHub feedback publication body failed its immutable digest boundary.");
  }
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("GitHub returned an invalid timestamp.");
  return new Date(milliseconds).toISOString();
}
