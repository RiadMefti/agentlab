# ADR 0014: bind scheduled execution to canary reservations

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0013 created immutable task reservations, but the existing scheduler and worker could still run
a scheduled preparation without reading one. Checking only at admission would also be insufficient:
a process could crash, restart after expiry, or resume a different durable claim.

## Decision

Every new scheduled task claim uses `agentlab.schedule-event.v2` and carries one exact
`canaryReservationDigest`. Before claiming, the scheduler independently verifies canonical task,
request, preparation-authority, repository/base, schedule/factory/role policy, R0/R1, executable
stage, complete budget, and current validity. It skips missing or non-current reservations.

Schema 16 adds database guards without rewriting historical events. SQLite rejects new legacy
claims, reservation or budget substitution, read-only-shadow execution, and a claim that cannot fit
the full task wall-clock ceiling before expiry. The finish event must be v2, carry the same digest,
and occur no later than reservation expiry. Existing v1 events remain readable; an active unbound v1
claim is never resumed.

The worker receives the digest rather than trusting scheduler state. It reloads and revalidates the
reservation before every resumable preparation or execution phase and on every crash retry. Manual
work rejects a canary digest. Worker result v3 returns the consumed digest so the scheduler verifies
the outcome against its claim.

## Consequences

Scheduled model work can no longer begin or resume from cohort authority alone. The scheduler and
worker remain credentialless and still stop at a local `pr-proposed` checkpoint. This does not let
the broker open a PR autonomously: broker dispatch does not yet require the exact reservation or its
`brokered-draft-pr` stage. [ADR 0015](0015-canary-bound-draft-pr-dispatch.md) subsequently closes
that broker-admission gap without activating a live queue or timer. No live configuration, timer,
task, account, or authority is activated.

## Fitness functions

Contract tests distinguish legacy events from canary-bound claims. Scheduler tests cover missing,
insufficient-lifetime, exact-digest, crash-retry, and policy-drift paths. Worker tests cover exact
independent re-verification, expiry, and manual/scheduled separation. SQLite tests prove schema-15
migration, reject legacy claims, enforce relational budget/time binding, preserve immutable event
history, and bind finishes to claims.
