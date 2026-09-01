import type {
  FactoryExternalPullRequestChangedFile,
  FactoryPullRequestFeedbackAuthor
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryExternalPullRequestPage,
  FactoryExternalPullRequestSource,
  FactoryExternalPullRequestSourceIdentity
} from "../../domain/factory-external-pull-request-source.js";
import {
  githubAuthorAssociationSchema,
  githubAuthorSchema,
  githubExternalPullRequestListItemSchema,
  githubExternalPullRequestSchema,
  githubPullRequestFileSchema,
  githubRepositoryIdentitySchema
} from "./github-pull-request-api-contracts.js";
import type { GitHubReadApi } from "./github-rest-client.js";

export interface GitHubExternalPullRequestSourceOptions {
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly observerId: string;
  readonly api: GitHubReadApi;
}

/** Bounded GitHub inventory adapter with before/after head consistency checks. */
export class GitHubExternalPullRequestSource implements FactoryExternalPullRequestSource {
  public constructor(private readonly options: GitHubExternalPullRequestSourceOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub PR reader repository must be a lowercase owner/name pair.");
    }
    if (!Number.isSafeInteger(options.repositoryNumericId) || options.repositoryNumericId < 1) {
      throw new Error("GitHub PR reader repository numeric ID is invalid.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.observerId)) {
      throw new Error("GitHub PR reader observer ID is invalid.");
    }
  }

  public identity(): FactoryExternalPullRequestSourceIdentity {
    return { repositoryId: this.options.repositoryId, observerId: this.options.observerId };
  }

  public async inspectRepository() {
    const value = githubRepositoryIdentitySchema.parse(
      await this.options.api.request("GET", `/repos/${this.options.repositoryId}/`)
    );
    if (
      value.id !== this.options.repositoryNumericId ||
      value.full_name.toLowerCase() !== this.options.repositoryId
    ) {
      throw new Error("GitHub PR reader resolved a different repository identity.");
    }
    return {
      repositoryId: this.options.repositoryId,
      repositoryNumericId: value.id,
      defaultBranch: value.default_branch
    };
  }

  public async listOpen(limit: number): Promise<FactoryExternalPullRequestPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("External PR discovery limit must be between 1 and 25.");
    }
    const list = z
      .array(githubExternalPullRequestListItemSchema)
      .max(26)
      .parse(
        await this.options.api.request(
          "GET",
          `/repos/${this.options.repositoryId}/pulls?state=open&sort=updated&direction=asc&per_page=${String(limit + 1)}`
        )
      );
    const selected = list.slice(0, limit);
    const items = [];
    for (const listed of selected) items.push(await this.#readExact(listed.number));
    return { items, truncated: list.length > limit };
  }

  async #readExact(number: number) {
    const first = await this.#pullRequest(number);
    if (
      first.state !== "open" ||
      first.number !== number ||
      first.html_url !== `https://github.com/${this.options.repositoryId}/pull/${String(number)}` ||
      first.base.repo.full_name.toLowerCase() !== this.options.repositoryId
    ) {
      throw new Error("GitHub pull request changed state during discovery.");
    }
    const fileValue = await this.options.api.request(
      "GET",
      `/repos/${this.options.repositoryId}/pulls/${String(number)}/files?per_page=100`
    );
    const files = z.array(githubPullRequestFileSchema).max(100).parse(fileValue);
    const second = await this.#pullRequest(number);
    if (!samePullRequest(first, second)) {
      throw new Error("GitHub pull request changed during bounded discovery.");
    }
    const changedFiles = files
      .map(changedFile)
      .sort((left, right) => left.path.localeCompare(right.path));
    const headRepositoryId = first.head.repo?.full_name.toLowerCase() ?? null;
    return {
      repositoryId: this.options.repositoryId,
      pullRequestNumber: number,
      url: first.html_url,
      untrustedTitle: first.title,
      untrustedBody: first.body ?? "",
      author: feedbackAuthor(first.user, first.author_association, number),
      base: { branchName: first.base.ref, revision: first.base.sha },
      head: {
        repositoryId: headRepositoryId,
        branchName: first.head.ref,
        revision: first.head.sha
      },
      fromFork: headRepositoryId !== null && headRepositoryId !== this.options.repositoryId,
      draft: first.draft,
      createdAt: normalizeTimestamp(first.created_at),
      updatedAt: normalizeTimestamp(first.updated_at),
      totalChangedFiles: first.changed_files,
      filesComplete: changedFiles.length === first.changed_files,
      changedFiles,
      additions: first.additions,
      deletions: first.deletions,
      changedLines: first.additions + first.deletions
    };
  }

  #pullRequest(number: number) {
    return this.options.api
      .request("GET", `/repos/${this.options.repositoryId}/pulls/${String(number)}`)
      .then((value) => githubExternalPullRequestSchema.parse(value));
  }
}

function changedFile(
  file: z.infer<typeof githubPullRequestFileSchema>
): FactoryExternalPullRequestChangedFile {
  return {
    path: file.filename,
    previousPath: file.status === "renamed" ? (file.previous_filename ?? null) : null,
    status: file.status,
    revision: file.sha,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes
  };
}

function feedbackAuthor(
  author: z.infer<typeof githubAuthorSchema>,
  association: z.infer<typeof githubAuthorAssociationSchema>,
  pullRequestNumber: number
): FactoryPullRequestFeedbackAuthor {
  return {
    externalId:
      author === null
        ? `github-user/unknown-pr-${String(pullRequestNumber)}`
        : `github-user/${String(author.id)}`,
    login: author?.login ?? "unknown",
    kind: author?.type === "User" ? "human" : author?.type === "Bot" ? "bot" : "unknown",
    association: association
      .toLowerCase()
      .replaceAll("_", "-") as FactoryPullRequestFeedbackAuthor["association"]
  };
}

function samePullRequest(
  left: z.infer<typeof githubExternalPullRequestSchema>,
  right: z.infer<typeof githubExternalPullRequestSchema>
): boolean {
  return (
    left.number === right.number &&
    left.html_url === right.html_url &&
    left.title === right.title &&
    left.body === right.body &&
    left.state === right.state &&
    left.draft === right.draft &&
    left.merged === right.merged &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    left.changed_files === right.changed_files &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    sameAuthor(left.user, right.user) &&
    left.author_association === right.author_association &&
    left.base.ref === right.base.ref &&
    left.base.sha === right.base.sha &&
    left.base.repo.full_name === right.base.repo.full_name &&
    left.head.ref === right.head.ref &&
    left.head.sha === right.head.sha &&
    left.head.repo?.full_name === right.head.repo?.full_name
  );
}

function sameAuthor(
  left: z.infer<typeof githubAuthorSchema>,
  right: z.infer<typeof githubAuthorSchema>
): boolean {
  return left?.id === right?.id && left?.login === right?.login && left?.type === right?.type;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("GitHub returned an invalid timestamp.");
  return new Date(milliseconds).toISOString();
}
