# ADR 0024: Credentialless external pull-request review evidence

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0023 deliberately stops at authenticated external pull-request inventory. An
`agent-review-candidate` is not reviewed code and grants no execution or GitHub authority. The next
stage must inspect an exact patch without combining contributor-controlled repository content,
GitHub credentials, mutable provider selection, an unbounded model process, or remote-write tools.
It must also recover safely after a crash and preserve enough evidence to audit disagreement.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-review` composition. It receives no
GitHub App key, token source, HTTP client, broker, tmux, merge, or release port. It may call only
administrator-pinned Codex or Claude executables through the existing provider-neutral adapter and
systemd user-scope isolator. Every reviewer capability is exactly filesystem read, Git read, no
remote repository, no network, no secrets, no command allowlist, and no workspace write.
Architecture fitness rules enforce this closed capability graph.

One canonical policy pins the repository, ADR-0023 discovery-policy digest, ordered independent
reviewer profiles, models, reasoning settings, reviewed skill-package digests, per-reviewer and
aggregate budgets, cgroup ceilings, patch/prompt byte ceilings, per-tick candidate count, quorum,
and recovery limit. The owner-only config separately pins the review, cost, and worker-identity
policy digests, executable hashes/versions, exact skill inventory, local repository, database,
artifact, and worktree roots. The review process must run under the reviewed non-root worker UID.

A tick consumes only immutable `agent-review-candidate` rows from schema 20. It requires both exact
base and head objects to already exist locally and never fetches. A detached head worktree computes
the merge base, reconstructs the bounded binary patch, and rejects any changed-path set that differs
from authenticated discovery. Prompts treat repository data and the patch as untrusted data, omit
the untrusted title/body, include reviewed reusable skill instructions, and require strict JSON. The
configured quorum runs in distinct provider sessions. Missing exact-model cost accounting,
incomplete usage, invalid output, exhausted budgets, uncertain process cleanup, path mismatch, or
workspace mutation fails closed; mutation quarantines the run. Split verdicts become
`human-review-required`, never implicit approval.

SQLite schema 21 records an immutable run and append-only transitions:

`ready -> workspace-active -> reviewing -> reviewer-active -> reviewing -> recorded -> completed`

Interrupted active states first prove all journal-owned systemd scopes inactive and remove only the
exact journal-owned worktree before returning to `ready`. Recovery is bounded. Canonical request,
prompt, output schema, raw stdout/stderr/final output, reviewer record, review result, patch, and
aggregate bundle are content-addressed. The bundle binds the candidate, exact heads and patch,
policy/cost lineage, ordered reviewer quorum, distinct sessions, complete aggregate usage, workspace
non-mutation, and deterministic aggregate decision.

## Consequences

AgentLab can now produce durable local code-review evidence for a bounded external PR without any
remote-write authority. Preflight does not run a model. A tick does not fetch, comment, submit a
GitHub review, approve, repair, push, open a replacement PR, merge, deploy, or release. No live
configuration, provider rate card, skill inventory, local PR-object mirror, timer, or account is
shipped. Feedback publication and external-repair admission remain separate future decisions.
