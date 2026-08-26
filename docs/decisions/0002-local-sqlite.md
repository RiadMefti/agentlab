# ADR 0002: SQLite stores app-owned metadata

**Status:** Accepted

## Decision

Use the `node:sqlite`-compatible API provided by the local runtime for project/conversation
metadata, including each project's canonical folder path. Provider transcripts and credentials
remain in provider-owned storage; live terminal state remains in tmux.

The default database follows XDG data conventions. If that database is absent, an existing legacy
desktop database may be reused in place so the terminal cutover does not strand user conversations.
An explicit `AO_DATABASE_PATH` always wins.

## Consequences

- No database service or external native database package is required.
- The schema is small, transactional, local, and enforces one project per canonical folder.
- The app stores session references, not duplicated provider transcripts.
- Compatibility lookup never copies or deletes user data.
