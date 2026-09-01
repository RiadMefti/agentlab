# ADR 0021: journal autonomous maintenance discovery before canary consumption

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

The v1 daily cycle begins at the scheduler. It can process only an already registered scheduled
request with an exact canary reservation, so it cannot originate maintenance and the manual
reservation ceremony remains an operational gap. Giving a scout execution or cohort-issuance
authority would let model output manufacture both work and permission. Reusing the execution worker
or broker composition would also collapse read-only discovery, repository mutation, and remote
credentials.

## Decision

Add a separate credentialless `@agentlab/runtime/factory-maintenance-discovery` composition. One
strict repository-owned policy pins the scout skill package, provider/model profile, resource and
usage budgets, R1-only change classes, confidence floor, exact include/exclude/protected paths, and
per-slot finding/admission ceilings. The skill is scheduled, single-worker, read-only Git and
filesystem, offline, secretless, and has zero changed-file, changed-line, and repair authority.
Provider-neutral adapters run it in an exact-base disposable worktree and the model returns only a
strict untrusted finding proposal.

Trusted admission independently requires every affected/evidence path to exist in the exact Git
tree, rejects excluded or protected paths and unsupported classes, sorts candidates
deterministically, and applies the confidence and count ceilings. It derives task IDs, timestamps,
deduplication keys, policy authority, and journal events itself. Accepted findings enter the
existing preparation ledger as scheduled intake under the already reviewed R1 grant. The grant must
cover every discovery path and protected path and its lifetime bounds the issued authority. The
scout cannot reserve, execute, open a PR, merge, or release.

SQLite schema 18 stores one immutable run per policy/day slot and an append-only event chain:
`registered → agent-started → agent-finished|agent-failed → finding dispositions → completed`. Run,
policy, schedule, factory-policy, preparation-grant, role-policy, repository/base, execution, usage,
output, and finding coordinates are content-addressed. Retries recover the open journal; uncertain
process/worktree state blocks rather than rerunning.

Extend credentialless canary admission with a v2 config that loads the exact schedule policy and a
bounded `canary-admission-tick`. It scans only scheduled preparations, reserves at most the schedule
task ceiling, and routes every candidate through the existing signature/cohort/evaluation/task and
aggregate-budget checks. Cohort authority remains separately attested and human-issued with
`autoMerge:false` and `release:false`; the consumer cannot widen or mint it.

Add `agentlab.daily-cycle-manifest.v2`. It pins separate discovery and canary-admission configs plus
the discovery policy, preparation grant, cohort, and candidate digests. The read-only renderer
prepends `maintenance-discovery → canary-admission` to the existing
`scheduler → draft → observe/repair/update` stop-on-failure chain. V1 remains parseable and renders
the prior scheduler-first sequence. Rendering still writes, installs, enables, and starts nothing.

## Consequences

The dormant factory can now create a bounded daily maintenance request and make it eligible for the
existing scheduler without giving model output authority. Activation still requires owner-created
accounts/configs/policies/rates, an external evaluated candidate and fresh human cohort, repository
governance, monitoring, and explicit switches/timer installation. The current loop ends at an open
draft PR and bounded repair updates. The separately dormant offline eval-harness producer is defined
by [ADR 0022](0022-sandboxed-eval-evidence-production.md). ADR 0030 subsequently adds host-local
repository and organization daily quotas. Hosted-provider eval brokerage, cross-host quotas, merge,
release, telemetry canaries, rollback, revocation, and incident automation remain future
capabilities.

## Fitness functions

Contracts reject write/network/secret/multi-worker discovery and R2+ findings. Provider tests prove
read-only Codex and Claude harnesses. Service tests admit one evidenced path, reject a protected
path, and prove exact retry idempotency. SQLite tests prove slot uniqueness, lineage, terminal
recovery, and immutability. Consumer tests prove scheduler-switch and per-tick ceilings. Daily-cycle
tests preserve legacy readability and prove fixed v3 quota-bound ordering, separate configs, exact
pins, no shell, and stop-on-failure systemd links. Architecture rules keep discovery separate from
interactive, execution-worker, broker, GitHub, authority, terminal, and tmux closures.
