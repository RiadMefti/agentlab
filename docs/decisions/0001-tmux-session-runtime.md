# ADR 0001: tmux owns interactive session state

**Status:** Accepted

## Context

Codex, Claude Code, and OpenCode are real interactive CLIs. The product must preserve their exact
terminal sessions, let the captain supervise workers, and let the user enter any session directly
without inventing a common agent protocol.

## Decision

The app starts the captain in a tagged tmux session. The captain starts and communicates with
workers using raw tmux and provider CLI commands. On explicit user request, the app may also start
or stop a strictly named worker session; that lifecycle action does not mediate later
captain-to-worker communication.

The terminal compositor attaches one Bun PTY client to the exact selected tmux session. Switching
selection closes only that client. Provider-specific launch definitions build initial captain and
explicit worker invocations but are not a communication protocol.

## Consequences

- Provider behavior is not flattened behind a custom API.
- Sessions survive UI restarts while tmux remains alive.
- The UI can replay retained output and then attach live.
- Only one selected session consumes live PTY/rendering work.
- tmux is a required local dependency.
- Machine-reboot restoration is a separate provider-resume concern.
