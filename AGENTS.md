# Engineering contract

- Keep the product local-first and provider-neutral.
- Preserve the hierarchy: conversation → one captain → zero or more workers.
- Do not add product features outside the defined scope without an explicit request.
- Keep domain logic independent from Fastify, React, tmux, and individual providers.
- Preserve the dependency direction documented in `docs/architecture.md`: inner runtime layers never
  import outward, cross-package imports use public entry points, and the source graph stays acyclic.
- Validate all external input at process and HTTP boundaries.
- Never construct shell commands from unescaped user input.
- Add focused tests for every behavior change.
- Prefer small cohesive modules over broad utility files.
- Run type checking, linting, tests, and the production build before handoff.
