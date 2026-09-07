# ADR 0023: Read-only external pull-request discovery

**Status:** Accepted; implemented but not provisioned or activated

## Context

The canary maintenance loop observes only pull requests created from AgentLab's own immutable task
and dispatch lineage. The software-factory goal also requires awareness of pull requests opened by
humans, bots, and external contributors. Reusing the PR broker for that inventory would place a
write-capable GitHub token in the discovery process. Treating contributor titles, bodies, branches,
or paths as instructions would also let untrusted repository input influence authority.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-discovery` composition and two
one-shot commands. Its GitHub App token request is repository-selected and limited to `checks:read`,
`contents:read`, and `pull_requests:read`; token minting rejects missing, extra, or write
permissions. The application sees only a `GET`-only port. Architecture fitness rules forbid this
composition from reaching model/provider execution, the write broker, authority mutation, process
execution, merge, release, tmux, or the interactive runtime.

One owner-reviewed policy pins the repository, allowed base branches, contributor associations,
draft handling, protected paths, age, changed-file, changed-line, and per-tick ceilings. The
existing daily UTC schedule policy supplies the idempotent slot and deadline. A tick:

1. registers an immutable run before remote access;
2. reads at most 25 oldest-updated open PRs and at most 100 changed files per PR;
3. reads every selected PR before and after its file page and fails the entire slot if any captured
   PR detail changes;
4. excludes exact PR numbers already rooted in a durable AgentLab dispatch;
5. deterministically classifies the remainder as an agent review candidate, human-review required,
   or deferred; and
6. atomically records a canonical content-addressed snapshot, immutable candidate projection, and
   append-only completion event.

The canonical fields are deliberately named `untrustedTitle` and `untrustedBody`. Classification
uses only bounded authenticated metadata, path policy, and size/age limits. An
`agent-review-candidate` means only that a later credentialless reviewer may inspect it. It is not a
task, repair authorization, branch capability, approval, merge decision, or release authority.

SQLite schema 20 enforces immutable runs/snapshots/candidates, append-only event chains, legal
transitions, one run per repository/schedule/slot, and materialized JSON identity. A crash while
fetching can be recovered because the only uncertain remote operation was a read. A recorded
snapshot resumes at completion without rereading GitHub. Repeated uncertain-read recovery is bounded
and then fails closed.

## Consequences

AgentLab can now inventory external PR heads without combining untrusted input, a model, and remote
write credentials. It still cannot review the code, submit a GitHub review or comment, repair an
external branch, create a replacement repair branch, merge, or release. Those require separate
credentialless review execution and a later explicit repair-admission design. Same-repository and
fork repair must remain distinct because a fork contributor's branch is not AgentLab-owned write
authority.
