# ADR 0019: publish canary repairs through a recovery-first broker consumer

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0018 can turn an exact maintenance authorization into a gated, independently reviewed local
repair proposal, but publishing that proposal still required a human to copy its task and
authorization into `broker-update-draft`. Automating the handoff must not give GitHub credentials to
the worker, create a second mutable execution queue, publish a manually authorized or stale repair,
skip recovery after an uncertain remote write, or acquire merge and release authority.

## Decision

Add a broker-side read-only desired/observed projection with two classes. Recoverable work is an
existing nonterminal schema-v1 update journal for the configured repository and broker. Fresh work
is an exact completed repair journal joined to its actionable maintenance observation and
authorization, current schema-v2 canary PR lineage, completed scheduler handoff, current
reservation, scheduled R1 task, and exact schedule, role, and factory-policy digests. An existing
update journal removes fresh authority from the projection. The existing append-only update journal
remains the only mutable remote-write checkpoint.

Expose one credential-bearing, non-interactive `broker-pr-update-tick` command. Broker config v3 and
caller-pinned schedule, role-identity, and factory-policy digests are mandatory. Recoverable
journals sort before fresh work and enter the existing update service before fresh readiness is
considered; that service still checks the broker kill switch before every unfinished phase. Fresh
publication additionally requires current repository governance, configured cost policy, enabled
broker authority, unexpired task and reservation, exact canary authority, and the existing update
service's full repair, patch, usage, policy, and PR-lineage replay. The schedule policy bounds both
candidates and actions.

The existing update service writes the immutable proposal and journal before GitHub mutation,
performs only a deterministic non-force child update of the authenticated head, reconciles a lost
response, verifies the live draft, records broker-authenticated evidence, and returns the task to
`pr-open`. A later maintenance tick therefore observes the new exact head. The command cannot run a
model, issue repair authority, change control switches, merge, release, deploy, or install a timer.

## Consequences

The scheduled canary loop can now progress from PR observation through credentialless repair and
credentialed republishing without coordinate copying while preserving worker/broker separation and
crash durability. Re-observation can repeat until facts are clear or policy, lifetime, attempt, or
action ceilings stop the loop. Live identities, policies, timers, governance, quotas, monitoring,
merge, release, and incident automation remain dormant.

## Fitness functions

Application tests cover fresh publication, recovery-first ordering, governance and authority
blocking, expiry, immutable policy identity, and per-tick ceilings. SQLite tests prove exact fresh
lineage projection and recovery precedence. CLI and architecture tests enforce config-v3 policy
pins, cleanup-before-output, report identity, broker-only reachability, and the absence of model,
authority-mutation, merge, and release commands.
