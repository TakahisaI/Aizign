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
| [`threat-model.md`](../security/threat-model.md) | Trusted configuration, guarantee levels, known limitations, and test scope |
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
   digest from trusted control-plane configuration. Obtain `eventId` from that
   trusted configuration or generate and retain it in the adapter/control
   plane for the same logical submission. Do not accept any of these fields
   from model-visible arguments.
4. Generate adapter-owned request nonces. Keep harness session, call, thread,
   provider, and delivery identifiers out of the complete protocol envelope.
5. Enforce request/response bounds and correlation, and preserve all submit
   outcome classifications. An outbound oversize failure happens locally
   before transport and produces no submit classification. Exercise every
   applicable `unknown` path and prove that it does not trigger a blind submit
   retry.
6. Run the language-neutral wire fixtures and the applicable core-client
   scenario groups described by the architecture contract.
7. Test the native entrypoint/registration where applicable, native input
   mapping, trusted identity injection, any model-visible schema, and harness
   error mapping in harness-native fake tests owned by the adapter. Test
   persistence, native session/call handling, lifecycle, and evidence semantics
   only when the adapter claims them.
8. Document optional integrations and their actual durability, retention,
   integrity, I/O-bound, and cancellation limits. Do not promote them into the
   generic minimum.
9. Record the supported harness version in
   [`docs/reference/compatibility.md`](../reference/compatibility.md), then run
   the repository checks.

Core reconciliation is a separate extension. If the adapter claims it, check
the advertised `workflow.signal.reconcile` capability and implement the full
read-only reconciliation scenario group. Submission must remain usable when
reconciliation or harness-native evidence is unavailable. A reconciliation
result of `absent` is a snapshot observation, not permission to resubmit; prove
that the adapter does not automatically or implicitly submit after `absent`.

## Conformance split

Keep the following tests separate even if one test command runs all of them:

| Test boundary | Shared requirement | Owned by |
|---|---|---|
| Decoder / full-codec wire checks | Applicable `spec/conformance/` frame fixtures | Each language's decoder/full-codec tests |
| Directional encoder | Applicable Protocol examples and `spec/conformance/encoder-scenarios.md` | Each language's encoder/client tests |
| Core client | Minimum submission scenarios plus any claimed extension scenarios | Each language's client runner/tests |
| Harness-native adapter | Native entrypoint, mapping, trusted identity, visible schema, and errors; optional persistence/lifecycle only when claimed | The adapter's fake-harness tests |

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
include submission and reconciliation operations. They exercise the
core-client boundary only; implementing the interface or passing the runner
does not establish harness-adapter conformance. A TypeScript adapter choosing
these APIs implements the full interface and still needs harness-native tests
for preflight, identity provenance, model-visible input isolation, documented
result disclosure, and other owned behavior. A non-TypeScript adapter can
implement the minimum or claim the same extension through native types and
tests.

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
