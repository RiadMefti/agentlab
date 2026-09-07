# ADR 0013: reserve canary authority before autonomous work

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0012 requires signed, identity-bound evaluation evidence before a human can issue a bounded
R0/R1 cohort. A cohort still names aggregate authority rather than one prepared task. Letting a
scheduler or model interpret that authority would permit stale pins, over-allocation after crashes,
or execution without an auditable task-level grant.

## Decision

Add the credentialless `@agentlab/runtime/factory-canary-admission` composition and
`agentlab.canary-task-reservation.v1`. Its owner-only config pins the exact v2 cohort, evaluated
candidate, schedule policy, factory policy, role policy, runner, public key, and timing policy. For
one scheduled task, admission re-verifies the signature and evaluation/cohort lineage, obtains a
fresh post-verification timestamp, and checks repository/base, policy, complete skill set, R0/R1
risk, preparation authority, validity, and the task's complete budget ceiling.

Schema 15 stores one immutable reservation per task. SQLite relational/projection triggers require
the reservation to exactly match its cohort, evaluation, and preparation records. A transactional
capacity trigger conservatively sums every budget dimension and task count against the cohort. Exact
retries return the stored reservation, including after a prior process committed and exited before
reporting success.

The admission composition has no model/provider, process runner, worktree, GitHub credential,
broker, merge, release, or authority-issuance port. Every reservation fixes `autoMerge:false` and
`release:false`.

## Consequences

A human cohort is no longer sufficient task-level evidence, and quota enforcement survives process
failure. This decision does not itself execute the reserved task or authorize a PR. Scheduled
consumption was subsequently accepted by ADR 0014. Multi-account ledger brokering, revocation,
telemetry/control comparison, merge, release, rollback, and incident automation remain out of scope.

## Fitness functions

Contracts reject malformed, over-risk, merging, releasing, or invalid-lifetime reservations. Service
tests cover reviewed-pin drift, candidate/preparation drift, post-verification expiry, and
crash-safe retry. SQLite tests cover canonical projection, migration from schema 14, immutability,
foreign-key lineage, and atomic aggregate capacity. Public-entry and source-closure checks keep
admission separate from interactive, model-bearing, credential-bearing, and human-authority
compositions.
