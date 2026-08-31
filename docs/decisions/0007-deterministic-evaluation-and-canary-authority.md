# ADR 0007: separate deterministic evaluation from canary authority

**Status:** Accepted; implemented but dormant

**Date:** 2026-08-31

> [ADR 0009](0009-isolated-eval-attestation.md) later adds isolated DSSE signing and immutable
> verification records. The cohort remains dormant and unconsumed.

## Context

The daily scheduler and governed worker can produce reviewed local proposals, and the broker can
open only an explicitly confirmed draft PR. That is not enough to promote a changed model, provider
configuration, harness, skill set, schedule policy, or factory policy. An agent must never certify
its own replacement, and a passing average from one run must not become remote-write authority.

Primary-source guidance converges on a measured, staged boundary:

- [OpenAI's eval guide](https://developers.openai.com/api/docs/guides/evals) treats an eval as a
  versioned data source plus explicit testing criteria, run repeatedly against configurations. The
  documented workflow uses representative test data, human ground truth, graders, and recorded runs.
- [Anthropic's agent-eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  recommends tasks, multiple trials, transcripts/outcomes, deterministic and model graders, and
  human calibration because agent outcomes are variable and partially correct.
- [Google SRE's canary guidance](https://sre.google/workbook/canarying-releases/) compares a small
  candidate population with a control using explicit metrics and supports rapid rollback rather than
  treating deployment as proof of quality.

AgentLab needs those controls without introducing a hosted control plane, a provider-specific eval
API, or a path from an eval process to GitHub, merge, or release.

## Decision

Add two exact, short-lived local compositions and keep them separate from the interactive runtime,
model-bearing worker, intake process, scheduler authority, and GitHub broker.

`@agentlab/runtime/factory-evaluator` is a credentialless ledger writer. It accepts one complete
owner-only `agentlab.eval-run.v1` report from a pinned trusted runner identity, validates canonical
candidate/suite digests and the exact ordered case/trial matrix, computes policy metrics from raw
samples, and atomically records the run plus one `agentlab.eval-assessment.v1`. It has no provider,
process executor, repository workspace, GitHub client, authority switch, merge, or release port.

`@agentlab/runtime/factory-canary-authority` is a human-only authority writer. It loads a separate
owner-only `agentlab.canary-request.v1`, resolves one passing assessment digest, and records one
human `agentlab.canary-approval.v1` plus one `agentlab.canary-cohort.v1`. It has no model, process,
GitHub, broker, scheduler, merge, or release port. The operator ID is audit metadata; the dedicated
owner-only operating-system account and file permissions are the local authorization boundary.

The process order is:

```text
versioned candidates + suite + matched raw trials
                       │
                       ▼
credentialless deterministic assessment ── pass/deny
                       │ pass
                       ▼
human sample review + exact expiring request
                       │
                       ▼
bounded non-executing cohort authority
```

A cohort can name only `read-only-shadow`, `local-proposal`, or `brokered-draft-pr`. It covers
exactly one repository, at most R0 or R1, a bounded task count, a complete aggregate factory budget,
and a positive lifetime capped by the suite; the suite's configured maximum may range from one hour
to seven days. `read-only-shadow` is R0; the other stages are R1. Both `autoMerge` and `release` are
literal `false` in the v1 schema. A cohort authorizes no task by itself; a future consumer must
independently bind it to intake, task, policy, usage, and broker checks.

## Evaluation contract and policy

Each candidate pins repository/base revision, factory-policy digest, optional schedule-policy
digest, harness digest, provider-configuration digest, skill-package digests, version, and creation
time. A suite pins the case-bank digest, ordered unique case IDs, trials per case, thresholds,
maximum stage, and maximum canary limits. Every matched sample pins the case/trial coordinate, seed,
fixture, grader evidence, outputs, traces, cost, latency, task success, safety, critical violation,
and false-positive result for both baseline and challenger.

The run must contain the complete ordered Cartesian case/trial matrix. Seeds are unique and each
case keeps one fixture across trials. Baseline and challenger use the same repository, base commit,
and time window. Summaries supplied by the runner are ignored.

Deterministic policy derives:

- baseline and challenger success, challenger safety, and conservative Wilson 95% lower bounds;
- success regression, false-positive rate, critical safety violations, and case-level flake rate;
- total baseline/challenger micro-USD, cost ratio, and challenger p95 latency.

Any critical safety violation denies promotion. Every configured threshold must pass. Rates that
represent bad outcomes round upward; good outcomes and confidence bounds round downward. Zero-cost
baseline with nonzero challenger cost fails closed at the maximum ratio. Reason codes are sorted and
the assessment is recomputed on every read.

## Durability and recovery

SQLite schema 12 stores eval runs, assessments, human approvals, and cohorts in four append-only
tables. Database triggers bind JSON identity columns, assessment-to-run coordinates,
approval-to-passing-assessment coordinates, cohort-to-approval coordinates, timestamps, stage, and
the literal non-merge/non-release flags. Update and delete triggers reject mutation. Each process
holds the existing exclusive writer lease; commands are serialized and bounded.

Run ID and assessment digest retries are idempotent only when immutable data matches. A changed run
under the same ID, a second authority request for the same assessment, a widened budget/stage, an
expired request, policy tampering, missing predecessor, or partial sample matrix fails closed. The
run/assessment and approval/cohort pairs are each inserted in one `BEGIN IMMEDIATE` transaction, so
an interruption cannot commit half a pair. Operators preserve the database and input reports during
an incident; they do not edit ledger rows.

## Deliberate exclusions

This decision does not implement the eval harness that executes cases, stores grader artifacts, or
signs its report. The current process trusts an owner-only report from the configured runner ID and
then independently recomputes only deterministic aggregate policy. It also does not consume a
cohort, schedule shadow tasks, sample production, open PRs automatically, merge, release, observe an
SLO, roll back, or page an incident owner. Those are separate future authority surfaces.

Until a tested harness producer and cohort consumer exist, this feature is a dormant promotion
ledger and human authorization boundary—not an autonomous canary controller. No configuration is
provisioned by the repository and no authority is enabled by default.

## Consequences and fitness functions

Configuration promotion is provider-neutral and auditable, but operators must supply representative
case banks, trusted grader evidence, human sampling, and explicit limits. A passing assessment is
necessary but never sufficient for a remote write.

Fitness functions require strict contract tests, deterministic-policy vectors, canonical-integrity
tests, schema-11 migration and append-only trigger tests, service idempotency/conflict tests,
owner-only file tests, runtime drain/lease tests, exact public-API contracts, and source-graph rules
that prevent either composition from reaching providers, GitHub, broker, merge, release, tmux, or
the interactive runtime.
