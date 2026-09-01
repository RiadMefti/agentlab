# ADR 0029: Brokered external pull-request replacement drafts

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0028 deliberately ends with local qualification evidence. A contributor-safe publication path
must not push to a contributor or fork branch, and a model-bearing worker must never possess the
credential that can create repository branches or pull requests. Retrying a network call without a
durable intent can duplicate PRs; accepting a PR by branch name alone can adopt a conflicting
actor's write. Publishing after the original PR or protected base moved would detach the repair from
the evidence that qualified it.

## Decision

Add a seventh external-PR plane,
`@agentlab/runtime/factory-external-pull-request-replacement-draft`. It runs under a policy-pinned
non-root broker UID distinct from worker and eval-attestor UIDs, with a separately configured GitHub
App installation. Its fixed installation-token profile is `checks:read`, `contents:write`, and
`pull_requests:write` for one numeric repository. Architecture closure excludes every provider,
agent executor, gate executor, tmux, terminal, approval, merge, deployment, and release adapter.

The canonical policy pins repository, broker and remote publisher identities, qualification and
role-policy digests, exact trusted check names, patch and per-tick ceilings, and an operation
deadline. R1, draft-only publication, no contributor-branch write, no force push, no approval, no
auto-merge, and no release are structural constants. Both `scheduler` and `pr-broker` switches must
be enabled before selecting fresh work and immediately before each remote mutation.

Only a completed schema-v25 bundle whose decision is `qualified` is eligible. One bundle creates one
immutable schema-v26 publication run. The broker re-reads the original PR and requires its exact
open URL, base branch/revision, and head revision plus enforced administrators, at least one
approval, stale-review dismissal, code-owner review, last-push approval, no force push/deletion, and
the exact App-bound `verify` and `factory-sandbox` checks. Any original movement is terminally stale
before another mutation.

The branch is deterministically named `agentlab/external-repair/pr-<number>-<qualification-prefix>`
in the base repository. A fresh local Git repository authenticates the qualified patch digest and
change set, rejects filters and submodules, and creates one deterministic commit whose sole parent
is the qualified original head. Git uses a normal non-force push. The contributor's branch name is
never an input to push.

SQLite records a branch-publish intent before push and a PR-open intent before POST. Exact retries
recompute the same commit, accept only the exact branch SHA, and reconcile PR creation only by exact
base, head, title, body marker, draft state, and pinned GitHub App user ID. Conflicting branches,
multiple PRs, wrong publishers, or remote drift quarantine the run. A mismatched newly created draft
is closed only when its exact branch/head/base proves it is the broker's just-created object; the
branch is retained for incident evidence. Successful records link original and replacement PRs,
qualification bundle, proposal, base/head revisions, broker, and publisher. Final verification is
required before completion.

## Consequences

AgentLab can safely reach a brokered draft PR without granting a worker remote credentials or
modifying a contributor fork. The replacement remains subject to normal human review, protected
checks, and merge policy. No account, App, key, policy, switch, timer, or live workflow is
provisioned by this change. Automatic incorporation into the daily cycle, exact-head observation of
the replacement, merge authority, release, deployment, telemetry canaries, rollback, and incident
automation remain separate future work.
