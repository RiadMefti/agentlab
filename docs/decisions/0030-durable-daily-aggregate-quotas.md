# ADR 0030: Durable daily aggregate quotas

**Status:** Accepted; implemented but not provisioned or activated

## Context

The scheduler already bounded one tick, canary authority bounded one cohort, and every task carried
a complete worst-case budget. Those controls did not bound total work across repeated ticks or
across repositories using one local AgentLab control plane. A restart could therefore restore task
safety without proving remaining repository/day or organization/day capacity. The credential-bearing
broker also needed independent proof that the daily reservation existed before a scheduled proposal
crossed the remote-write boundary.

## Decision

Add a separately reviewed `agentlab.daily-quota-policy.v1`. It names one organization, UTC as the
only accounting time zone, exact authorized repository profiles, and repository/day plus
organization/day ceilings for task count, draft-PR count, and every `FactoryBudget` dimension.
Worker and broker config v4 pin the same canonical policy digest. A v3 daily-cycle manifest pins its
path and digest; legacy manifests remain readable but cannot render an executable autonomous cycle.

Before a scheduled task can be claimed or invoke a model, the worker reserves one immutable
`agentlab.daily-quota-reservation.v1`. The reservation binds the exact policy, organization,
repository, task, schedule-run digest, canary-reservation digest, full worst-case task budget, one
possible draft PR, UTC-day window, timestamp, and durable task correlation. A retry for the same
task recovers the original reservation and correlation. Reservations are conservative and never
released: a crash may consume unused headroom but cannot manufacture new authority.

SQLite schema 27 stores reservations in one append-only local organization ledger. Insert triggers
atomically enforce repository and organization ceilings, one policy digest per organization/day, and
exact linkage to the schedule run and canary repository, policy, role, task, and budget. A v3
schedule claim cannot be appended until its exact reservation exists; its v3 finish must carry the
same digest. The single writer lease serializes the host-local control plane.

The broker independently reloads the task reservation and requires the exact v3 schedule completion,
policy digest, canary authority, repository, budget, run, reservation digest, and task correlation
before any scheduled PR create or update. Broker configuration is rejected when its repository is
absent from the daily policy. Manual confirmed worker execution remains available without a daily
policy; aggregate quotas are an autonomous scheduling and broker boundary.

## Consequences

Repeated ticks and restarts cannot exceed reviewed daily capacity inside one AgentLab SQLite control
plane, and a worker cannot fabricate quota evidence for the broker. All governed repositories for
one local organization must use the same database and writer-lease domain. Multiple hosts or
independent databases are separate control planes; globally coordinated cross-host quotas remain a
future broker/coordinator problem and must not be claimed from this implementation.

No policy file, account, timer, authority switch, GitHub credential, or live quota is provisioned.
The change grants no merge, release, deployment, rollback, or incident authority.
