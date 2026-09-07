# ADR 0032: Durable disable-only incident containment

Status: accepted, implemented, dormant

## Context

ADR 0031 deliberately made operations health query-only. That separation is still required for
ordinary monitoring, but a daily autonomous cycle must not begin new work after independently
detecting a critical ledger condition. Calling the human authority operator from automation would
expose an enable path and would not bind both kill-switch changes to one immutable health report.

## Decision

Add `agentlab.incident-containment.v1` and a separate
`@agentlab/runtime/factory-incident-containment` composition. It runs under a reviewed non-root
incident-controller UID, has no credentials, provider, model, GitHub, worker, broker, merge,
release, deployment, terminal, or tmux capability, and exposes only `containIfCritical`. There is no
enable operation in its application or persistence ports.

Each invocation recomputes operations health internally from the canonical ledger and pinned health
and daily-quota policies. Healthy reports return without a write. Degraded reports return exit 2
without a write. A critical report with both controls already off reports `already-contained`.
Otherwise SQLite schema 28 performs one `BEGIN IMMEDIATE` compare-and-disable transaction: append
the PR-broker disable event first, append the scheduler disable event second, then append one
canonical containment record embedding the report and naming both event digests. Any authority race,
invalid document, duplicate, or failed insert rolls the entire transaction back. Database triggers
make the journal append-only, bind materialized columns to canonical JSON, and require the
referenced events to be incident-commander disables at the containment timestamp.

Daily-cycle manifest and bundle v4 add the isolated incident UID, exact policy pins, and a bounded
incident timeout. The incident command is the first fixed-argv stage. Its command-line policy
digests must equal its owner-only config. Only exit 0 continues to discovery; degraded or critical
health stops the `OnSuccess=` chain, and critical health has already removed any observed autonomous
authority atomically. Legacy manifests remain readable for audit but cannot compile an executable
cycle.

## Consequences

Critical host-local evidence can now stop both autonomous mutation planes without granting
automation any way to restore them. Broker-first ordering is visible in the control journal while
the transaction remains all-or-nothing. Re-enablement stays a separate human-only compare-and-set
ceremony after investigation.

Nothing is installed, enabled, scheduled, pushed, deployed, or provisioned by this change. Alert
delivery, cross-host coordination, signed external archival, merge, release, deployment rollback,
and incident communications remain outside this controller. Operators must preserve the SQLite
ledger and containment output and independently provision monitoring before activation.

ADR 0033 subsequently adds an independent merge switch and merger. SQLite schema 31 extends the same
atomic containment transaction to disable merge broker first, then PR broker, then scheduler, and
binds all three event digests to the canonical critical-health record. Legacy schema-28 records
remain readable.
