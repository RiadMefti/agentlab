# ADR 0017: reconcile slot-bound canary pull-request maintenance

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0016 can create and recover evaluated canary draft pull requests, but observing CI and review
state and authorizing a deterministic repair still required two per-task human commands. A durable
maintenance consumer must not create another mutable queue, repeatedly read the same head, infer
authority from agent text, or combine GitHub credentials with model execution.

## Decision

Add a read-only desired/observed projection for exact schema-v2 scheduled canary dispatches whose
latest task state is `pr-open`. Desired identity is the completed scheduler handoff, current durable
pull-request record and head, reservation, schedule policy, role policy, factory policy, broker, and
one resolved daily maintenance slot. Observed state is a slot-bound authenticated observation
evidence bundle and, when actionable, its exact repair authorization. These existing append-only
records are the checkpoint; there is no maintenance journal or second mutable queue.

Expose one broker-only, non-interactive `broker-pr-maintenance-tick` command. Broker config v3 and
caller-pinned schedule, role-identity, and factory-policy digests are mandatory. Preflight runs
before discovery. One tick inspects at most `maximumCandidatesPerTick` and attempts at most
`maximumTasksPerTick`, prioritizing current authority and then recovery of already observed
actionable work. Before a new credentialed read and again before repair admission, the application
revalidates the exact canary reservation and policy authority. A crash after evidence publication
resumes admission from the immutable observation without another remote read.

Clear or pending observations create no repair authority. Unsafe facts, deterministic denial, clock
regression, or expired authority produce attention output and fail closed as appropriate. Only the
existing deterministic repair-admission service may issue an authorization. The command cannot run a
provider, interpret feedback text, execute a repair, update a branch, enable authority, merge,
release, deploy, or install a timer.

## Consequences

An owner-managed timer can safely reconcile CI/review facts and repair admission for the evaluated
canary lane without granting GitHub credentials to a worker. Slot identity bounds polling and makes
exact retries auditable. Full autonomous repair still requires separate credentialless repair and
broker-update consumers; merge, release, telemetry, rollback, and incident control remain separate
future authorities.

## Fitness functions

Application tests cover actionable, resumed, clear, pending, unsafe, expired, denied, policy-drift,
head-drift, budget, and idle outcomes. SQLite tests prove the unobserved to observed-actionable to
authorized projection. Boundary tests reject manual maintenance-coordinate smuggling and prove
authority is checked before a remote read. CLI and architecture tests enforce strict pins, config-v3
and preflight gating, deterministic exit status, cleanup, and broker-only reachability.
