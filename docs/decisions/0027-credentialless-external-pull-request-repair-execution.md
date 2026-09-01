# ADR 0027: Credentialless external pull-request repair execution

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0026 creates one expiring selectors-only repair authorization from exact completed external-PR
review and feedback evidence. Executing that capability inside a GitHub broker would combine
untrusted model input, workspace mutation, and remote credentials. Retrying after a crash once an
agent may have run could also spend the one-attempt authority twice and produce ambiguous evidence.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-repair-execution` composition. It
may use pinned provider adapters, a systemd-isolated process, local Git objects, one detached
worktree, immutable artifacts, and SQLite. It has no GitHub client, App credential, remote write,
broker, merge, deployment, release, tmux, or interactive path. Architecture tests enforce that
closure.

The canonical execution policy pins repository, cost, role, gate, ordered skill, provider/model,
capability, budget, resource, protected-path, change, patch, prompt, deadline, queue, and recovery
limits. The schema hard-codes R1, one repair attempt, `replacement-draft`, and false remote-write,
auto-merge, and release flags. Admission pins the execution-policy digest; the authorization binds
both policy digests, avoiding a circular policy hash.

One valid schema-v23 authorization creates one schema-v24 run. The worker never fetches: it proves
the authorized local base/head object graph and original patch, resolves selected finding IDs from
the exact review bundle, marks all evidence prose as untrusted data, and starts one repairer with
network off, no secrets or command allowlist, and no remote-repository capability. The controller
independently collects the bounded patch, rejects protected paths, closes the worktree, and records
the canonical patch bundle.

SQLite stores immutable runs, append-only legal event chains, and immutable bundles rooted in the
completed feedback and admission rows. Workspace recovery may return to ready only before
`repairer-started`. An inactive or uncertain post-start run is quarantined and the authorization is
never retried. The scheduler is rechecked before new work and again before agent execution. Existing
journals reconcile before scheduler or provider-readiness blockers stop fresh work.

## Consequences

AgentLab can now turn one admitted external-PR finding set into an auditable local patch without
placing credentials near a model. The output is not a quality attestation or remote-write
capability. Strict post-repair gates, independent review, authenticated contributor/fork branch
strategy, replacement-draft creation, re-observation, merge, deployment, release, and rollback
remain separate future decisions.
