# ADR 0015: bind scheduled draft-PR dispatch to canary authority

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0014 bound scheduled model work to an immutable canary reservation, but its authority ended at
the local `pr-proposed` checkpoint. The manual broker command used a per-task human confirmation and
did not prove that a scheduled proposal came from the exact completed scheduler claim or that its
cohort authorized the `brokered-draft-pr` stage. A retry could also outlive the reservation unless
the broker rechecked it at every durable phase.

## Decision

Scheduled and manual draft creation remain separate authority paths. A non-scheduled task uses the
existing `agentlab.pull-request-dispatch.v1` record and literal manual confirmation. A scheduled
task cannot use that path. It must enter through `broker-open-canary-draft` with the exact
reservation, schedule-policy, role-identity-policy, and factory-policy digests loaded by broker
config v3. A non-scheduled task cannot present canary coordinates.

Before dispatch and before every resumable broker phase, the broker independently reloads the task,
preparation, reservation, and completed scheduler handoff. It requires an unexpired R1 reservation
for `brokered-draft-pr` that binds the exact task, request, preparation authority, contract,
repository/base, complete budget, and policy digests. The handoff must be a completed v2 schedule
run whose exact v2 `task-finished` event reports `ready-for-broker`, `prepared`, `pr-proposed`, and
the same contract and reservation.

`agentlab.pull-request-dispatch.v2` immutably stores those canary and policy coordinates before any
remote side effect. SQLite schema 17 materializes the reservation digest and rejects a scheduled v1
dispatch, substitution, missing or non-broker stage authority, expired authority at creation, or a
dispatch without the exact completed scheduler handoff. The application repeats current-validity
checks across crash recovery. Authenticated PR evidence carries the reservation digest.

The evaluated reservation replaces only per-task confirmation for this exact initial draft. It does
not enable the broker switch, relax cost or repository governance, grant merge/release authority, or
give the scheduler a GitHub credential.

## Consequences

One exact scheduled task can now cross the credential boundary without an additional human click
while remaining tied to evaluated, human-issued, expiring authority. Manual behavior remains
compatible. If authority expires during a remote call, the observed result is journaled but later
progress remains blocked and recoverable.

AgentLab still installs no broker queue, discovery loop, timer, live config, account, key, policy,
or authority. Activation and any merge or release autonomy remain separate decisions.

## Fitness functions

Contract and application tests cover manual/scheduled separation, missing or substituted digests,
wrong stage, expiry, scheduler-handoff divergence, and repeated phase checks. SQLite tests cover
version-16 migration, immutable v2 storage, relational rejection, and exact materialization. Config,
composition, CLI, and evidence tests prove the v3 policy pins and reservation claim without exposing
broker credentials to the worker.
