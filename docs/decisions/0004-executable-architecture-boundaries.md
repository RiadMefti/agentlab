# ADR 0004: enforce architecture boundaries as fitness functions

**Status:** Accepted

## Context

Directory names and prose describe the intended dependency direction, but neither prevents a future
change from reaching across a package boundary, importing a concrete adapter into a use case,
creating a source cycle, or bypassing a package's public API. Those failures make architecture
progressively harder to understand even when each individual change appears harmless.

## Decision

Keep the existing contracts, domain, application, infrastructure, composition, presentation, and
launcher responsibilities. Treat their allowed dependency graph as a tested product invariant:

- contracts and launcher remain independent workspace roots;
- domain depends only on domain and contracts;
- application depends inward on domain and contracts;
- infrastructure implements domain ports without importing application;
- `local-runtime.ts` is the concrete runtime composition boundary;
- the TUI imports runtime capabilities only through `@agentlab/runtime`;
- cross-package relative imports, deep workspace imports, unresolved local imports, and source
  cycles are rejected.

`scripts/check-architecture.ts` treats the root workspace manifest as inventory and validates an
exhaustive architecture registry against every discovered workspace, package name, declared
dependency, public export, and production source root. Unknown workspaces and unclassified source
files fail closed. Workspace entries must be real directories rather than symlinks. The
product-source graph and package-manifest graph must agree and remain acyclic.

The checker derives each workspace's complete production file set from its effective tsconfig and
requires every source file—including `.d.ts`, `.d.mts`, and `.d.cts` declarations—to have exactly
one non-overlapping registered root and one compiling workspace. `rootDir`, public source entries,
and build exports must agree. Symbolic links are forbidden anywhere inside a registered production
root so inventory cannot classify a linked file under an apparent owner. TypeScript path/root
aliases and package import maps are prohibited so an allowed spelling cannot resolve across a
forbidden layer.

The checker inspects every supported TypeScript module extension and every allowed static dependency
form, including triple-slash path/type/lib references and string-literal module augmentations.
Non-literal dynamic imports, CommonJS loaders (including aliases and computed `module` access),
`process.getBuiltinModule`, dynamic acquisition of `node:module`, the `node:vm`/`vm` code-generation
modules, direct or destructured reflective constructor access, loader-capable `Object`/`Reflect`
introspection, runtime `eval`/`Function` code generation, import-equals declarations, or other forms
that cannot be included in the graph are rejected in product source. Computed property names are
resolved through the TypeScript checker; ambiguous computed `Object`/`Reflect` access and
loader-capable global aliases fail closed. Inner-layer use of outward runtime globals, including
direct, destructured, aliased, and computed `Math.random`, is resolved through TypeScript symbols;
ambient declarations do not count as emitted local shadows. Diagnostics include the source location
and a traversable cycle path.

External capabilities are an explicit layer policy, not an unchecked escape hatch:

- contracts may use only their schema library;
- domain may use contracts, domain modules, and its declared schema library;
- application may use contracts, domain/application modules, and its declared validation library;
- Node filesystem/process/database APIs, tmux/provider SDKs, React, and OpenTUI are allowed only in
  their named outward layers. Server frameworks are forbidden in every current product layer; adding
  a server or transport requires explicit product scope and a new architecture decision;
- composition may construct adapters but contains no product policy;
- launcher dependencies remain isolated from runtime and presentation.

Build/release scripts and tests are not product layers. Their intentional internal imports are
documented and checked by their own type, test, packaging, and release gates; the architecture
documentation never describes those tooling edges as part of the product graph.

Pure rule/parser/resolver tests prove allowed and forbidden edges, while repository tests prove
exhaustive workspace/source coverage and repository-wide Bun-test discovery without magic
minimum-count thresholds. Included Bun-test paths fail closed on symbolic links; generated, vendor,
fixture, and duplicate tool-alias trees remain explicit exclusions. A compiled consumer contract
imports every public runtime value/type by name and compares it with independently declared DTO and
port shapes, exact key sets, and exact function parameter tuples and return types after removing
TypeScript method bivariance. Negative sentinels prove that removed optional members/parameters and
narrowed method inputs cannot bless drift. The checks run in `npm run verify` alongside strict
TypeScript and ESLint.

Application commands depend on the explicit `ConversationOperations` use-case port. They do not
derive their contract from the concrete `ConversationService` implementation.

## Consequences

- The dependency map is machine-enforced and cannot silently drift.
- Package entry points remain meaningful encapsulation boundaries.
- Infrastructure and presentation frameworks stay replaceable around the inner product rules.
- Deliberate architecture changes require updating the rule, its tests, this decision, and the
  architecture map together.
- The checker covers statically knowable product and manifest dependencies. Runtime protocol
  behavior, data validation, side-effect ownership, and security properties remain the
  responsibility of focused tests and boundary-specific controls.
