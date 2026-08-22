# ADR 0001: tmux owns interactive session state

**Status:** Accepted

## Context

Codex, Claude Code, and OpenCode are real interactive CLIs. The product must preserve their exact
terminal sessions, let the captain supervise workers, and let the user enter any session directly
without inventing a common agent protocol.

## Decision

The app starts the captain in a tagged tmux session. The captain starts and communicates with
workers using raw tmux and provider CLI commands. The browser attaches to a selected tmux session
through a PTY.

Provider-specific captain launchers only build the initial captain invocation. They are not exposed
to the captain and never mediate captain-worker communication.

## Consequences

- Provider behavior is not flattened behind a custom API.
- Sessions survive browser and server restarts while tmux remains alive.
- The UI can replay retained terminal output and then attach live.
- tmux is a required local dependency.
- Machine-reboot restoration requires provider-specific resume support and is outside the MVP.
