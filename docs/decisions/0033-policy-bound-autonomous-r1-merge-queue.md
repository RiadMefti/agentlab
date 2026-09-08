# ADR 0033: Policy-bound autonomous R1 merge queue

Status: accepted service design; implemented, dormant, cross-UID deployment blocked

## Context

The daily factory can create, observe, repair, requalify, and update a scheduled canary draft, but
ADR 0032 deliberately stopped before merge. Closing that loop must not give a worker or the existing
PR broker standing merge authority, trust a mutable branch name, treat a model verdict as approval,
or bypass repository rules. Recovery must also distinguish an intent that was recorded before a
remote mutation from an effect whose response was lost.

GitHub documents merge queues as the protected-branch mechanism that validates queued changes
against the latest target branch and documents the GraphQL `expectedHeadOid` guard on
`enqueuePullRequest`:

- [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [EnqueuePullRequestInput](https://docs.github.com/en/graphql/reference/input-objects#enqueuepullrequestinput)
- [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

## Decision

Add one narrow automatic-merge policy variant for scheduled R1 work. Factory policy v3 can compile
`merge.mode=automatic` only for R1 plus `trigger=scheduled`; release remains forbidden. A separate
canonical `agentlab.autonomous-merge-policy.v1` binds one repository, the schedule/daily-quota/role
policy digests, distinct PR-broker and merger POSIX identities, exact trusted `verify` and
`factory-sandbox` producer identities, an independent-review floor, observation and authorization
age limits, per-tick and per-UTC-day ceilings, and literal
merge-queue-only/no-direct-merge/no-release values. Worker, PR-broker, admission, merger, and
orchestration config v5 pin the same policy set and compiled factory-policy digest.

Credentialless admission runs under the reviewed worker UID and has no GitHub or provider port. It
accepts only an immutable scheduled R1 task whose contract opted into automatic merge, a live canary
reservation, complete usage and patch evidence, current broker-authenticated exact-head observation,
the exact trusted successful check set, the independent-review floor, a fresh merge policy decision,
and all three enabled authority switches. It publishes one short-lived, single-use authorization
binding the task, contract, proposal, PR record, evidence bundles, policy decision, reservation,
repository, PR number/URL, base/head revisions, policy digests, and expiry, then transitions
`pr-open → merge-ready`. A bounded tick derives these inputs from canonical local evidence; callers
cannot supply remote state to the daily cycle.

The merger is a separate non-root process and GitHub App installation, distinct from worker,
evaluation attestor, incident controller, and PR broker. Its adapter exposes only observe,
ready-for-review, enqueue, and exact readback; it contains no direct-merge or release operation. It
rechecks all three authority switches before every unfinished mutation, sends the authorized head as
`expectedHeadOid`, and quarantines any repository, URL, base, head, queue-entry, or merge-result
drift. Short-lived installation tokens are restricted to the selected repository and the fixed
contents-write/pull-requests-write profile.

SQLite schema 29 adds an append-only merge authority journal. Schemas 30 and 31 add the immutable
authorization projection, one run per task/authorization, append-only legal event chain, immutable
record, daily completion/capacity projections, and containment bindings. Each immutable run reserves
capacity in the same `BEGIN IMMEDIATE` transaction that registers it, before any remote effect.
Capacity is repository-wide, not reset by a policy digest change. It counts each run once for a
registration or confirmed merge during the UTC day, or for unresolved carryover. Completed work
releases capacity on the day after its merge; terminal failures before enqueue release on the next
day. An enqueue intent remains charged across days even after quarantine, because that terminal
label does not prove the remote effect was absent. The recovery state machine is:

```text
ready → ready-intent-recorded → ready-for-review → enqueue-intent-recorded → enqueued
  → merged → merge-evidence-recorded → completed

pre-merge states → stale | quarantined
```

Intent is durable before each GitHub mutation. Recovery reconciles remote state rather than blindly
repeating an ambiguous mutation. A merge becomes task state `merged` only after exact GitHub
readback, authenticated content-addressed merge evidence, and the journal record agree.

Daily-cycle manifest/bundle v5 adds separate admission and merger configs, the merger UID, the merge
policy path/digest, and bounded admission/merger timeouts. After the final exact-head observation it
runs credentialless admission and then the merger as fixed-argv, stop-on-failure services. Critical
incident containment atomically disables merge broker, PR broker, and scheduler before recording the
same canonical health evidence. Human authority commands retain separate compare-and-set switches
and exact enable/disable confirmations.

CI also subscribes to `merge_group: checks_requested`, so the required `verify` and
`factory-sandbox` checks evaluate GitHub's combined queue candidate rather than only the original PR
head. Both retain read-only repository permissions and checkout without persisted credentials. This
workflow change does not itself enable or enforce a merge queue in repository settings.

## Consequences

The live two-UID proof added on 2026-09-07 contradicts deployment readiness: the worker, broker,
merger, and incident roles cannot share the owner-only SQLite/lease/artifact adapters. A successful
same-user service test or systemd unit verification does not establish this handoff. See
[ADR 0034](0034-single-owner-factory-ledger-boundary.md) for the proposed correction. Keep automatic
operation disabled; this blocker is separate from GitHub merge-queue eligibility and credentials.

AgentLab contains a dormant scheduled R1 implementation from governed intake to queue-backed merge,
with policy continuity, role separation, finite authority, intent-before-effect recovery, and
content-addressed evidence. End-to-end readiness is not yet proven. Tests use the real merger
adapter against a stateful fake GitHub GraphQL API and prove that intents precede mutations,
`expectedHeadOid` is carried, and no direct-merge operation is reachable.

`tests/runtime/factory-autonomous-merge.integration.test.ts` exercises real admission, deterministic
merge policy, task transitions, SQLite merge persistence, and authenticated content-addressed
evidence through a simulated GitHub queue. It verifies normal completion, journal reopening,
completion after contract expiry, and recovery after evidence publication but before task-ledger
completion, without repeated mutations. Upstream worker/gate evidence, completed PR dispatch, and
canary authority are fixture inputs; this test does not prove live worker execution, canary
promotion, or GitHub governance enforcement.

Contract expiry still denies new work. The control plane permits only an expired automatic task's
`merge-queued → merged` readback when the latest authenticated merger record matches the exact
authorization attached to its queued task event. An authorization alone, another merger identity, or
mismatched evidence cannot use that exception. Quarantined enqueue ambiguity retains capacity and
requires incident handling; no automatic expiry or manual counter reset substitutes for proof of the
remote outcome.

This decision does not install a unit, create an OS account or GitHub App, enable any authority,
change repository rules, push, merge a real PR, release, deploy, evaluate telemetry, or roll back.
Production activation still requires owner-provisioned identities/configuration/credentials, a
non-empty reviewed cost policy, enforced required checks and merge queue, monitoring and alerting,
an evaluated canary cohort, and an explicit human enablement ceremony. Shipping after merge remains
a separate release/deployment decision.
