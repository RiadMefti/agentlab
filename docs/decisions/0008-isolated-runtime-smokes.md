# ADR 0008: Runtime smokes run in disposable sandboxes

**Status:** Accepted

## Context

The native packaging script executes the newly compiled AgentLab binary to check version/help
behavior, renderer diagnostics, terminal signal cleanup, and unsupported-runtime rejection. The Bun
integration suite also executes the source TUI to verify signal cleanup. Both interactive signal
checks reach normal runtime construction. Before this decision those child processes inherited the
operator's complete environment while overriding only `XDG_STATE_HOME` for diagnostics.

Normal runtime construction opens the configured SQLite database and applies forward-only schema
migrations. Consequently, packaging an unreleased build could migrate the operator's ordinary
AgentLab database even though packaging is expected to affect only repository build artifacts. The
same inherited environment could expose provider credentials, provider executable overrides, or an
existing tmux server to a smoke process.

## Decision

Every smoke subprocess that executes the packaged AgentLab binary or source TUI runtime runs with
one exact environment created from a fresh canonical owner-only temporary root:

- `HOME`, `TMPDIR`, every relevant XDG directory, and `TMUX_TMPDIR` point beneath that root;
- `AGENTLAB_DATABASE_PATH` and `AGENTLAB_CACHE_PATH` point explicitly beneath that root, so an
  inherited override cannot win;
- only `PATH`, locale, color, and timezone variables may pass through from the build environment;
- provider credentials and executable overrides, `TMUX`, SSH state, and every other ambient value
  are absent; and
- the root is removed in `finally` after all smoke checks, including failure paths.

The compiler and ordinary unit-test subprocesses are outside this boundary: they build or inspect
reviewed source and continue to use their normal test environment. Production runtime configuration
is also unchanged. This decision governs test subprocesses that execute the real interactive
application runtime.

## Consequences

- `npm run package` and interactive runtime integration tests cannot open or migrate the operator's
  normal AgentLab database.
- Interactive smokes cannot attach to the operator's tmux server or inherit provider/cloud
  credentials.
- Smokes test a clean first-run environment, which is closer to a new installation but deliberately
  does not test an operator's private provider configuration.
- `tmux` must remain discoverable through the inherited `PATH`; release CI already installs it.
- Tests must prove both path confinement and removal of ambient secrets/overrides. The full package
  gate must also run while the ordinary database is treated as an immutable sentinel.

## Rejected alternatives

- **Override only `XDG_DATA_HOME`:** an inherited `AGENTLAB_DATABASE_PATH` would still escape, and
  tmux/provider state would remain ambient.
- **Teach migrations to downgrade:** destructive reverse migrations would hide the test-boundary
  error and endanger user data.
- **Remove interactive runtime smokes:** that would lose release-critical terminal and signal
  coverage instead of containing it.
