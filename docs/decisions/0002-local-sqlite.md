# ADR 0002: SQLite stores app-owned metadata

**Status:** Accepted

## Decision

Use Node's built-in SQLite module for conversation metadata. Provider transcripts and credentials
remain in provider-owned storage; live terminal state remains in tmux.

## Consequences

- No database service or native database dependency is required.
- The schema is small, transactional, and local.
- The app stores session references, not duplicated provider transcripts.
