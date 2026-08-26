# ADR 0003: use a single-process native terminal compositor

**Status:** Accepted

## Context

The product needs the same three-part workspace everywhere it runs: saved projects on the left, one
exact interactive agent in the center, and a pinned captain plus workers on the right.
Responsiveness under sustained agent output is more important than browser compatibility.

## Decision

Use OpenTUI's React reconciler for declarative layout and its native embedded terminal for VT
parsing/rendering. Use Bun for the native PTY, `node:sqlite` compatibility, source execution, and
standalone compilation. Compose the framework-independent runtime directly in the same process.

There is no HTTP/WebSocket transport, browser renderer, or desktop shell. The UI owns exactly one
terminal attachment and renders a deliberate minimum-size state below 90×18.

## Consequences

- The left/center/right workspace is the only product UI.
- Terminal output avoids browser, DOM, IPC, and socket hops.
- Native ANSI, cursor, selection, paste, mouse, resize, and bounded scrollback behavior come from
  one terminal implementation.
- Retained history is seeded before buffered live output, while user input remains byte-exact from
  the embedded terminal to the PTY.
- Selection handoff keeps the previous frame visible until the replacement history is ready, then
  commits reset and replay atomically; per-conversation session caches avoid sidebar blanking.
- Alt-key chords own application navigation while control-key input remains available to the focused
  agent terminal; the Kitty keyboard protocol disambiguates shifted keys where supported.
- Bun is a source/build dependency and is embedded in release executables.
- Linux x64 glibc and macOS arm64 are the initial release targets.
- Performance budgets and real tmux/PTY integration run in CI.
- Runtime shutdown is asynchronous: it stops command admission and drains in-flight mutations before
  releasing persistence and ephemeral PTY clients.
