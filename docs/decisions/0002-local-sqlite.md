# ADR 0002: SQLite stores app-owned metadata

**Status:** Accepted

## Decision

Use the `node:sqlite`-compatible API provided by the local runtime for project/conversation
metadata, including each project's canonical folder path. Provider transcripts and credentials
remain in provider-owned storage; live terminal state remains in tmux.

The default database follows XDG data conventions. An explicit `AGENTLAB_DATABASE_PATH` always wins
and may point to any local path the user chooses.

## Consequences

- No database service or external native database package is required.
- The schema is small, transactional, local, and enforces one project per canonical folder.
- The app stores session references, not duplicated provider transcripts.
