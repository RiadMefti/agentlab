# Contributing

Install Node.js 24+, Bun 1.4+, and tmux 3.2+, then run:

```bash
npm install
npm run verify
```

Keep changes inside the product's intentionally lean boundary:

- conversation → one captain → zero or more workers;
- one local terminal process with left chats, center selected agent, and right agents;
- exactly one live PTY attachment, while tmux owns durable session state;
- captains communicate with workers through raw tmux and provider CLI commands;
- domain and application code do not import UI or concrete infrastructure;
- cross-package imports use public entry points and the product source graph remains acyclic;
- external input is validated at application, terminal, persistence, and process boundaries;
- shell values cross only the tested quoting boundary;
- every behavior change includes focused tests.

Do not add a network server, browser renderer, desktop shell, remote mode, multipane terminal,
unread state, or provider abstraction beyond the defined launch/capability adapters without explicit
product scope. Prefer small cohesive modules and update an ADR when a durable architectural decision
changes.

`npm run verify` is the handoff gate: formatting, architecture boundaries and cycles, strict
TypeScript, linting, unit/component tests, real tmux and Bun PTY integration, the production build,
and standalone executable packaging. Use the version/tag process in [Releasing](docs/releasing.md);
do not bypass exact asset validation, checksums, provenance, SBOM attestation, or immutable
publication.
