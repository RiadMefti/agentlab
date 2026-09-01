# ADR 0031: Query-only operations health

Status: accepted, implemented, dormant

## Context

The daily factory already journals authority, schedules, tasks, and conservative UTC-day quota
reservations, but operators had no single validated projection for detecting overdue autonomous
runs, stalled tasks, recent failures/quarantines, or quota saturation. Querying materialized SQLite
columns directly would make an operational monitor trust data that the application had not
revalidated. Giving a monitor worker, broker, provider, or kill-switch authority would also violate
separation of duties.

## Decision

Add `agentlab.operations-health-policy.v1`, `agentlab.operations-health-report.v1`, and a separate
`@agentlab/runtime/factory-operations-health` composition. The composition opens an existing durable
ledger read-only, enables SQLite `query_only`, requires the exact supported schema version, and
validates every selected canonical document and digest against its materialized columns. It has no
writer lease, provider, model, GitHub client, credential, agent executor, control repository, tmux,
terminal, merge, release, or deployment port.

One owner-only config pins the health-policy and daily-quota-policy digests. The policy bounds the
lookback, tolerated schedule overrun, autonomous-task silence, quota warning threshold, and maximum
records per section. The report covers both authority switches, recent or open schedule runs, recent
or active tasks, and current UTC-day repository/organization quota utilization. Disabled authority
is reported as safe dormant state, not an outage.

Deterministic reasons classify the report as:

- `healthy`: no reason;
- `degraded`: recent failed/needs-attention work or reviewed quota warning;
- `critical`: truncation, multiple or overdue open schedules, overdue/stalled scheduled work,
  quarantine, or impossible quota over-capacity state.

The CLI emits the canonical report plus its SHA-256 digest only after the database closes. Exit 0
means healthy, 2 degraded, and 3 critical; operational errors exit through the normal failure path.
A critical report recommends incident containment but cannot perform it. Operators retain the
existing separate disable-only ceremony and preserve the ledger for investigation.

## Consequences

The repository now has a provider-neutral, scriptable scheduler health/alert source without adding
authority. Architecture fitness rules constrain the entire command closure to its small read-only
module set. Focused tests cover strict contracts, policy drift, canonical-column substitution,
schema drift, severity decisions, quota aggregation, cleanup, and CLI exit codes.

No monitor unit, alert transport, dashboard, report archive/signature, automatic kill-switch
mutation, incident controller, cross-host aggregation, telemetry canary, rollback, merge, or release
is installed or authorized. Joining this command to a production timer and defining automated
disable-only containment require separate reviewed provisioning and policy.
