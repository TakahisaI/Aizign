# Adding a harness adapter

This is an implementation guide. The normative, language-neutral behavior is
defined by the
[harness adapter contract](../architecture/harness-adapter-contract.md); the
wire contract is defined by [`spec/protocol/v1/`](../../spec/protocol/v1/README.md).
Do not infer generic requirements from the DSH implementation or its native
session model.

## Read first

| Read | Purpose |
|---|---|
| [`harness-adapter-contract.md`](../architecture/harness-adapter-contract.md) | Language-neutral minimum, capability, outcome, evidence, and conformance boundaries |
| [`spec/protocol/v1/`](../../spec/protocol/v1/README.md) | Wire envelope, kinds, schemas, bounds, and examples |
| [`data-boundary.md`](../architecture/data-boundary.md) | Data allowed to cross the adapter/core boundary |
| The target adapter's proposal Issue | Harness choice, native integration, support policy, and live-smoke scope |

Read `packages/protocol/` and `packages/adapter-testkit/` when implementing a
TypeScript/Node adapter. They are a reference and convenience layer, not
runtime or development dependencies required of every adapter.

## Language-neutral implementation path

1. Define the harness integration in a leaf Issue. Record the native entry
   point, supported harness version, trusted configuration source,
   model-visible surface, optional capabilities, and validation plan.
2. Implement Protocol v1 `hello` compatibility and the minimum
   signal-submission behavior from the architecture contract.
3. Inject workflow, assignment, attempt, role, artifact revision, and candidate
   digest from trusted control-plane configuration. Do not accept them from
   model-visible arguments.
4. Generate adapter-owned request nonces. Keep harness session, call, thread,
   provider, and delivery identifiers out of the complete protocol envelope.
5. Enforce request/response bounds and correlation, and preserve all submit
   outcome classifications. Exercise every applicable `unknown` path and prove
   that it does not trigger a blind submit retry.
6. Run the language-neutral wire fixtures and the applicable core-client
   scenario groups described by the architecture contract.
7. Test plugin registration, native input mapping, visible argument schemas,
   persistence, lifecycle, and harness error mapping in harness-native fake
   tests owned by the adapter.
8. Document optional integrations and their actual durability, retention,
   integrity, I/O-bound, and cancellation limits. Do not promote them into the
   generic minimum.
9. Record the supported harness version in
   [`docs/reference/compatibility.md`](../reference/compatibility.md), then run
   the repository checks.

Core reconciliation is a separate extension. If the adapter claims it, check
the advertised `workflow.signal.reconcile` capability and implement the full
read-only reconciliation scenario group. Submission must remain usable when
reconciliation or harness-native evidence is unavailable.

## Conformance split

Keep the following tests separate even if one test command runs all of them:

| Test boundary | Shared requirement | Owned by |
|---|---|---|
| Wire codec | `spec/conformance/` valid/invalid frames and Protocol v1 schemas | Each language's codec tests |
| Core client | Minimum submission scenarios plus any claimed extension scenarios | Each language's client runner/tests |
| Harness-native adapter | Registration, native events, model-visible schema, trusted injection, persistence, lifecycle, native errors | The adapter's fake-harness tests |

The scenarios are language-neutral; the executable runner is not. Do not add a
universal adapter driver or a second process protocol for tests.

## TypeScript/Node reference path

For a TypeScript adapter in this repository, use:

- [`@aizign/protocol`](../../packages/protocol/README.md) for the Protocol v1
  codec, compatibility helpers, types, and reference `CoreClient` interface;
- [`@aizign/adapter-testkit`](../../packages/adapter-testkit/README.md) for the
  fake core, reference client, convenience assertions, and conformance runner;
  and
- the root Node/TypeScript support policy and exact harness SDK pinning from
  ADR-0010.

The reference layout is:

```text
adapters/<harness>/
├── package.json        @aizign/adapter-<harness>; private and unpublished for now
├── README.md           responsibility, boundaries, dependencies, tests, and ADRs
├── AGENTS.md           navigation and editing constraints only
├── src/
│   ├── index.ts        closed export surface
│   ├── config.ts
│   ├── core-client/    Aizign process and protocol boundary
│   ├── mapping/        native input to protocol DTO
│   ├── evidence/       optional harness-native evidence implementation
│   └── lifecycle/      only operations approved for this adapter
└── test/
    ├── unit/
    └── conformance/    TypeScript reference runner plus harness-native tests
```

Do not add empty `evidence/` or `lifecycle/` layers merely to match this tree.
The DSH event shape and lifecycle are not generic interfaces.

The TypeScript `CoreClient` interface and `runCoreClientConformance` runner
require submission and reconciliation, so they are reference-layer supersets
of the minimum signal-submission contract. A TypeScript adapter choosing these
APIs implements the full interface. A non-TypeScript adapter can satisfy only
the minimum or claim the same extension through native types and tests.

TypeScript repository rules:

- Pin a harness SDK to an exact version as peer and development dependency
  (ADR-0010). The root `.npmrc` uses `ignore-scripts=true`.
- Keep the `exports` map closed and disallow deep imports.
- Do not add runtime workspace dependencies beyond `@aizign/protocol`.
  `@aizign/adapter-testkit` is a development dependency.
- Keep normal tests within a fake harness and fake core process. Live smoke is
  opt-in under `experiments/`.

## Non-TypeScript implementations

A non-TypeScript adapter owns its codec, process/transport client, outcome
types, and test runner in its language. It must:

- match the Protocol v1 schemas, frame rules, stable codes, and shared fixture
  acceptance set;
- satisfy the minimum and each claimed extension scenario;
- preserve the architecture and data boundaries; and
- document its package, dependency, runtime, and harness support policy.

It need not reproduce the npm package layout, implement the TypeScript
`CoreClient` interface, or invoke `@aizign/adapter-testkit`. Do not create a new
shared runtime or language SDK until a concrete adapter demonstrates that need.
