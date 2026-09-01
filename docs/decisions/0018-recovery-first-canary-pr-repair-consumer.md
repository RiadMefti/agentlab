# ADR 0018: consume canary pull-request repairs through a recovery-first worker

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0017 can observe an evaluated canary PR and create one immutable repair authorization, but model
execution still required a human to copy the task and authorization into `worker-repair-pr`.
Automating that handoff must not give GitHub credentials to a model process, treat evidence claims
as sufficient execution authority, strand interrupted work when a kill switch is off, or bypass the
existing cumulative task and schedule budgets.

## Decision

Add a worker-side read-only desired/observed projection with two classes. Recoverable work is an
existing nonterminal or incompletely terminalized schema-v1 repair journal. Fresh work is an exact
repair authorization joined to an actionable slot-bound maintenance observation, the current
schema-v2 canary PR lineage, its completed scheduler handoff, reservation, broker identity, and
exact schedule, role, and factory policies. An existing repair run removes fresh authority from the
projection. The existing append-only repair journal remains the only mutable execution checkpoint.

Expose one credentialless, non-interactive `worker-pr-repair-tick` command. It requires worker
config v3 and caller-pinned schedule, role-identity, and factory-policy digests. Recovery always
sorts first and remains callable when scheduler, cost, identity, or host readiness blocks new model
work. Fresh work requires a ready worker preflight, an enabled scheduler, current exact canary
authority, an R1 scheduled task, an unexpired contract and reservation, and the existing
authorization reader's full artifact/evidence replay. The schedule policy bounds candidates and
actions; each fresh task conservatively reserves its complete contract budget against the tick
budget before execution.

The existing repair service creates its immutable run before a model starts, uses a fresh exact-base
worktree, exposes only selected feedback as untrusted data, repeats every strict gate, requires a
distinct read-only reviewer, and stops at `pr-proposed`. An interrupted attempt is reconciled and
abandoned rather than retried under the consumed authorization. The command has no GitHub, broker,
authority-mutation, merge, release, deployment, or timer-installation capability.

## Consequences

An owner-managed worker timer can safely turn deterministic canary feedback into a locally reviewed
repair proposal while preserving worker/broker separation. The separate broker consumer in
[ADR 0019](0019-recovery-first-canary-pr-update-consumer.md) can publish that exact proposal, after
which slot-bound observation can repeat on the new head. Live policies, identities, timers,
governance, monitoring, merge, and release remain dormant.

## Fitness functions

Application tests cover fresh execution, recovery under blockers, expiry, policy and clock drift,
aggregate and per-tick ceilings, failure stop, and idle behavior. SQLite tests prove both fresh
authorization and recoverable-journal projections. CLI and architecture tests enforce exact pins,
config-v3 gating, cleanup-before-output, report identity, credentialless reachability, and the
absence of broker or authority controls.
