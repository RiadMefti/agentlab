# Engineering contract

- Keep the product local-first and provider-neutral.
- Preserve the hierarchy: conversation → one captain → zero or more workers.
- Do not add product features outside the lean MVP without an explicit request.
- Keep domain logic independent from Fastify, React, tmux, and individual providers.
- Validate all external input at process and HTTP boundaries.
- Never construct shell commands from unescaped user input.
- Add focused tests for every behavior change.
- Prefer small cohesive modules over broad utility files.
- Run type checking, linting, tests, and the production build before handoff.
