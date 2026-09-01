import { gitObjectIdSchema } from "@agentlab/contracts";
import { z } from "zod";

const githubNumericIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const githubPullRequestSchema = z.object({
  number: z.number().int().min(1),
  html_url: z.url(),
  title: z.string().trim().min(1).max(120),
  body: z.string().max(16_384).nullable(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean().optional(),
  created_at: z.iso.datetime(),
  base: z.object({ ref: z.string(), sha: gitObjectIdSchema }),
  head: z.object({ ref: z.string(), sha: gitObjectIdSchema })
});

export const githubAuthorSchema = z
  .object({
    id: githubNumericIdSchema,
    login: z.string().trim().min(1).max(256),
    type: z.string().trim().min(1).max(64)
  })
  .nullable();

export const githubAuthorAssociationSchema = z.enum([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER"
]);

export const githubExternalPullRequestListItemSchema = z.looseObject({
  number: z.number().int().positive()
});

export const githubExternalPullRequestSchema = githubPullRequestSchema.extend({
  updated_at: z.iso.datetime(),
  changed_files: z.number().int().min(0).max(10_000),
  additions: z.number().int().min(0).max(10_000_000),
  deletions: z.number().int().min(0).max(10_000_000),
  user: githubAuthorSchema,
  author_association: githubAuthorAssociationSchema,
  base: z.object({
    ref: z.string(),
    sha: gitObjectIdSchema,
    repo: z.object({ full_name: z.string().min(3).max(140) })
  }),
  head: z.object({
    ref: z.string(),
    sha: gitObjectIdSchema,
    repo: z.object({ full_name: z.string().min(3).max(140) }).nullable()
  })
});

export const githubPullRequestFileSchema = z.object({
  sha: gitObjectIdSchema,
  filename: z.string().min(1).max(1_024),
  previous_filename: z.string().min(1).max(1_024).optional(),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  changes: z.number().int().min(0).max(1_000_000)
});

export const githubRepositoryIdentitySchema = z.object({
  id: githubNumericIdSchema,
  full_name: z.string().min(3).max(140),
  default_branch: z.string().min(1).max(255)
});

export const githubPullRequestReviewSchema = z.object({
  id: githubNumericIdSchema,
  user: githubAuthorSchema,
  author_association: githubAuthorAssociationSchema,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  body: z.string().max(16_384).nullable(),
  commit_id: gitObjectIdSchema.nullable(),
  submitted_at: z.iso.datetime().nullable(),
  html_url: z.url().max(2_048).nullable()
});

export const githubPullRequestReviewCommentSchema = z.object({
  id: githubNumericIdSchema,
  pull_request_review_id: githubNumericIdSchema.nullable(),
  user: githubAuthorSchema,
  author_association: githubAuthorAssociationSchema,
  body: z.string().max(16_384),
  path: z.string().min(1).max(1_024),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  commit_id: gitObjectIdSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  html_url: z.url().max(2_048).nullable()
});

export const githubPullRequestConversationCommentSchema = z.object({
  id: githubNumericIdSchema,
  user: githubAuthorSchema,
  author_association: githubAuthorAssociationSchema,
  body: z.string().max(16_384),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  html_url: z.url().max(2_048).nullable()
});

export const githubCheckRunSchema = z.object({
  id: githubNumericIdSchema,
  name: z.string().trim().min(1).max(256),
  head_sha: gitObjectIdSchema,
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
  conclusion: z
    .enum([
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "success",
      "skipped",
      "stale",
      "startup_failure",
      "timed_out"
    ])
    .nullable(),
  app: z.object({ id: githubNumericIdSchema }),
  details_url: z.url().max(2_048).nullable(),
  started_at: z.iso.datetime().nullable(),
  completed_at: z.iso.datetime().nullable()
});

export const githubCheckRunsSchema = z.object({
  total_count: z.number().int().min(0).max(10_000),
  check_runs: z.array(githubCheckRunSchema).max(100)
});
