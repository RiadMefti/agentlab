# ADR 0020: render the daily factory as a content-addressed separated-service chain

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADRs 0016–0019 close the durable canary path from a completed scheduled task through draft PR,
observation, credentialless repair, brokered update, and exact-head re-observation. Each operation
is still an explicit one-shot command. Recurring activation must not combine model and GitHub
credentials in one process, accept shell text from configuration, silently continue after a blocked
step, catch up outside the reviewed start window, or let a generated file install or enable itself.

## Decision

Add a strict owner-only `agentlab.daily-cycle-manifest.v1`. It pins the canonical AgentLab
executable and SHA-256 digest; separate worker and broker UIDs and config paths; exact schedule,
role-identity, and factory-policy digests; worker and broker command timeouts; and a bounded number
of repair rounds. It contains no arbitrary command, environment, credential, authority mutation,
merge, release, or installation field. The loader verifies the stable executable descriptor and the
canonical reviewed schedule and role-policy documents. It rejects an executable owned by either
runtime role or writable by group/other, while the checksum path is fixed under protected `/etc`.
Compilation rejects a worker UID that differs from the role policy, a broker UID equal to either
worker or attestor, repair rounds above the schedule budget, or a timeout that truncates the
reviewed worker wall-clock ceiling.

Expose a read-only `factory orchestration-render` command. It emits one content-addressed JSON
bundle containing fixed system-level systemd units; it writes nothing. A non-persistent UTC timer
starts the credentialless scheduler. Successful one-shot units chain with `OnSuccess=` through
brokered draft creation, a bounded sequence of broker observation → worker repair → broker update,
and one final observation of the last published head. Any nonzero exit stops the chain and activates
an incident target. Every service uses its pinned numeric UID, fixed argv with no shell, explicit
timeout, restrictive umask, empty capabilities, `NoNewPrivileges=`, and conservative systemd
hardening. Only worker units receive their own user-manager socket coordinates. No service loads
both role configurations.

The timer uses `Persistent=false`: a missed activation is not replayed merely because the host
returns later. The existing scheduler independently enforces the exact UTC slot and start deadline,
and every operation independently revalidates authority, policy, lineage, quota, and durable
recovery state. The output binds the manifest, policies, executable, every unit, and bundle by
SHA-256. It also emits an exact GNU `sha256sum` check record at the fixed protected path; every
service runs the fixed `/usr/bin/sha256sum --status --check` argv before AgentLab, so a missing,
changed, or unmaterialized binary stops the chain. Owner provisioning must verify and materialize
the checksum and unit files, run `systemd-analyze verify`, and explicitly enable the timer; AgentLab
has no installer or service-manager write path.

The unit semantics follow the upstream systemd contracts for
[`OnSuccess=`/`OnFailure=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#OnSuccess=),
[`OnCalendar=` and `Persistent=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#OnCalendar=),
and
[service sandboxing](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Sandboxing).

## Consequences

The existing autonomous canary loop now has a deterministic daily activation artifact without
collapsing separation of duties or granting AgentLab host-installation authority. Duplicate or
manually repeated starts remain idempotent at the ledger. A failure target is an observable signal,
not an automatic kill-switch mutation; operations must monitor it and disable scheduler and broker
authority during an incident. Live accounts, files, policies, rates, GitHub App, repository
governance, unit installation, monitoring, and switch enablement remain owner responsibilities. At
this decision's v1 boundary, maintenance discovery was still absent. ADR 0021 adds a compatible v2
manifest that prepends bounded discovery and consumption of existing human cohort authority. Fleet
quotas were still absent at that boundary. ADR 0030 adds a v3 manifest with host-local repository
and organization daily quotas; v1/v2 remain readable for audit but can no longer render an
executable cycle. Cross-host quotas, merge, release, canary telemetry, rollback, and incident
automation remain separate future capabilities.

## Fitness functions

Contract tests reject extra fields, identity collapse, and unit-file injection. Compiler tests prove
the exact role sequence, bounded rounds, final head observation, systemd escaping, policy budgets,
timeouts, quota pinning, legacy-manifest refusal, and stop-on-failure links. Configuration tests
cover owner-only files, canonical paths, stable executable hashing, and policy drift. Public-API and
CLI tests keep rendering isolated from interactive, worker, and broker compositions. The opt-in
factory host suite passes every generated unit together through the installed
`systemd-analyze verify` parser and proves the generated checksum with the installed verifier.
