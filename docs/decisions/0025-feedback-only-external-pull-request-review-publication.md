# ADR 0025: Feedback-only external pull-request review publication

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0024 produces immutable independent-review evidence without a GitHub credential. Publishing that
evidence is a remote mutation and cannot be added to the model-bearing reviewer, the read-only
discovery App, or the branch-writing draft/update broker. GitHub's review-creation operation is not
an idempotent queue: a process may lose its response after GitHub accepts the review, so blind retry
can duplicate feedback.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-feedback` composition. It runs under
an explicitly pinned non-root POSIX UID and uses a dedicated selected-repository GitHub App. Its
installation token requests only `pull_requests:write`; `metadata:read` may be returned implicitly.
It has no provider, model, process runner, checkout, Git content-write, branch push, draft-PR,
repair, merge, release, deployment, terminal, or tmux capability. The existing default-off
`pr-broker` switch gates every new publication.

One canonical policy pins the repository, exact ADR-0024 review-policy digest, publisher ID, GitHub
App bot user ID, literal `comment-only` mode, per-tick ceiling, evidence age, body bytes, operation
deadline, and bounded reconciliation attempts. The strict owner-only config separately pins that
policy digest, repository numeric ID, process UID, storage paths, and App key identity.

A tick consumes only a completed schema-v21 review bundle that has never entered a feedback run. The
publication body is deterministic, omits contributor title/body, neutralizes mentions and Markdown
control characters from model-produced summaries/findings, states that it is advisory, and contains
`<!-- agentlab-external-review:<bundle-digest> -->`. The adapter submits only `event: COMMENT`
against the exact reviewed head; it cannot express `APPROVE` or `REQUEST_CHANGES`. The live PR must
remain open, unmerged, and at the exact reviewed base/head.

SQLite schema v22 records immutable runs, append-only events, and authenticated publication records.
The normal state path is:

`ready -> remote-verified -> publication-active -> recorded -> completed`

The intent is durable before POST. If authority is revoked after intent but before POST, the run is
cancelled without a remote call. If the POST outcome is uncertain, later ticks perform bounded
read-only reconciliation using the exact marker, body, head, and configured App user ID. They never
blindly repeat the POST. An exact existing publication is recorded as `reconciled`; conflicting,
duplicate, or persistently absent evidence becomes operator attention.

## Consequences

AgentLab can now publish completed external-review evidence as one auditable advisory GitHub review
without giving credentials to an agent. The publisher cannot approve, repair, push, merge, deploy,
or release. No App, account, policy, config, timer, or authority activation is shipped. External PR
repair admission and safe fork/contributor branch handling remain a separate future decision.
