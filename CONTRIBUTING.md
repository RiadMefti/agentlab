# Contributing

Use Node.js 24 or newer and install tmux before running:

```bash
npm install
npm run verify
```

Keep changes inside the lean scope in the README and preserve these constraints:

- conversation → one captain → zero or more workers;
- captains use raw tmux and provider CLI commands;
- domain and application code do not import concrete infrastructure;
- external input is validated at HTTP, process, and terminal boundaries;
- shell values cross only the tested quoting boundary;
- every behavior change includes focused tests.

Prefer small cohesive modules. Update an ADR when a change alters a durable architectural decision.

Use the version and tag process in [Releasing](docs/releasing.md) for production artifacts. Do not
publish binaries manually or bypass signing, notarization, checksum, and provenance gates.
