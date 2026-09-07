# ADR 0016: derive and reconcile bounded canary broker work

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0015 allowed one exact scheduled task to cross the draft-PR credential boundary, but an operator
still had to supply its task and authority coordinates. Adding a second mutable queue would create
another source of truth beside immutable scheduler handoffs and the crash-durable dispatch journal.

## Decision

Add a read-only desired/observed projection. Desired work is an exact completed v2
`ready-for-broker` scheduler handoff with an R1 `brokered-draft-pr` reservation. Observed work is
the absence or incomplete state of its dispatch journal. A completed dispatch is no longer pending.

The credential-bearing broker exposes one non-interactive `broker-canary-tick` command. It requires
config v3 and caller-pinned schedule, role-identity, and factory-policy digests. Broker preflight
runs before discovery. The application rechecks those pins and every projected item's immutable
policy and time identity. Current reservations sort before expired records; within each class,
recoverable dispatches sort before undispatched work. The schedule policy limits both candidates
inspected and credentialed write attempts. Expired work is reported without a write; clock
regression or a deterministic denial stops further attempts. Every attempted task enters the
existing canary-bound draft service, so its reservation, scheduler handoff, governance, cost,
authority switch, evidence, and durable checkpoints remain authoritative.

The command is one-shot. It does not install or own an OS timer, enable the broker, alter a
schedule, create another queue journal, merge, release, or deploy.

## Consequences

An owner-managed timer can safely invoke one fixed, policy-pinned command. Duplicate invocation and
process interruption reconcile through the existing immutable dispatch and append-only event chain.
Attention output exposes expired or denied work instead of silently skipping it. Activation still
requires separately reviewed accounts, config, policies, credentials, repository governance,
authority enablement, monitoring, and incident procedures.

## Fitness functions

Application tests cover ceilings, recovery priority, expiry, clock regression, policy substitution,
denial, empty cost policy, and idle behavior. SQLite tests prove undispatched, recoverable, and
completed projection states. CLI tests prove strict pins, config-v3 gating, preflight-before-queue,
cleanup-before-output, forged-result rejection, and deterministic exit status. Architecture tests
keep the command inside the broker-only public composition.
