# Adding a harness adapter

This guide defines the current v0.1 behavioral minimum for a harness adapter and
the implementation path used by the repository's TypeScript adapter. It does not
require every harness to provide DSH-style persistence or lifecycle operations.

Read only the following material before starting an adapter. Reading the DSH
Session implementation or browser smoke is not required.

| Read | Purpose |
|---|---|
| `spec/protocol/v1/` | Wire contract: envelope, kinds, schemas, and examples |
| `packages/protocol/` | TypeScript codec, compatibility helpers, and current `CoreClient` types |
| `packages/adapter-testkit/` | TypeScript fake core, reference client, conformance runner, and metadata-only assertions |
| This document | Current minimum behavior and capability boundaries |
| `adapters/<your-harness>/` | The adapter being implemented |

## Capability layers

Do not put the following three concepts in one field, manifest, or token
registry.

| Layer | Authority and use | v0.1 representation |
|---|---|---|
| Core protocol capability | An operation understood by the Aizign binary. The adapter uses it for protocol compatibility. | Advertised by `hello.capabilities`; currently `workflow.signal.submit` and `workflow.signal.reconcile` |
| Harness adapter capability | An operation or evidence source that an adapter can safely execute and verify on its harness. | Documented and tested by that adapter; no universal runtime manifest or Protocol v1 field |
| Workflow requirement | A capability that a particular workflow would require from an adapter. | Provisional; there is no v0.1 consumer, negotiation field, or dispatch runtime |

The same spelling must not silently change meaning between layers. In
particular, `hello.capabilities` reports core protocol operations, not DSH or
other harness features.

## Current minimum behavior

A v0.1 signal-submission adapter must provide the following behavior:

- perform protocol health and compatibility checks before exposing the
  submission path;
- submit a scope-bound structured workflow signal;
- inject workflow, assignment, attempt, and candidate identity from trusted
  control-plane configuration rather than model-visible input;
- keep harness session, call, provider, and delivery identities out of the
  Aizign protocol envelope, including `requestId`;
- validate response `requestId`, `kind`, and `eventId` correlation;
- preserve accepted, duplicate, rejected, and unknown outcomes without
  collapsing one classification into another;
- never infer success or rejection from `unknown`, and never blindly retry an
  unknown submission;
- keep raw prompts, model output, reasoning, and credentials out of the
  protocol and control journal; and
- bound request size, response size, frame count, and processing time.

The minimum does **not** require an adapter to persist outcomes. Persistence
authority and binding verification differ by harness. An adapter without
harness-native persistence or cold read remains a valid signal-submission
adapter when it satisfies the behavior above.

## Durable evidence and absence semantics

The Aizign control journal is authoritative for workflow signal acceptance. An
adapter may call harness-native evidence durable only when it can verify
metadata that attributes the record to the requested binding.

A durable error record without verifiable binding metadata is not evidence that
the requested binding was rejected. It remains `unknown` with an adapter-owned
diagnostic such as `unverified_error`. Absence of an optional harness capability
must never weaken identity isolation, the metadata-only boundary, correlation
checks, bounds, or the non-collapse of `unknown`.

## Optional capabilities demonstrated today

The DSH adapter currently demonstrates these harness adapter capabilities:

- harness-native durable success evidence;
- bounded harness session cold read; and
- harness result verification with binding and payload digests.

These are examples, not the generic shape of harness evidence. Another adapter
does not need to expose DSH `tool/call`, `tool/result`, or
`SessionPersistence.readFrom` events. When it offers native evidence, it owns
the translation from its native records to the common dispositions described
above.

## Core reconciliation is not harness evidence

`workflow.signal.reconcile` is a core protocol operation over the Aizign
journal. It is not a `core-journal-only` harness evidence mode and is independent
of whether the harness offers persistence or cold read.

An adapter or control-plane client that invokes reconciliation must check its
core protocol capability independently and preserve the bounded read-only
`accepted`, `conflict`, `absent`, and `unknown` semantics. It must not merge a
core journal lookup and a harness-native evidence lookup into one evidence enum,
and it must not make submission unavailable merely because reconciliation or
harness-native evidence is unavailable.

## Provisional operations

The following inventory may become useful, but there is no accepted operation
contract, absence semantics, implementation, or consumer for it yet:

- interrupt;
- effect dispatch;
- resource release;
- session or agent ownership;
- general lifecycle hooks; and
- remote reconnect.

Do not publish stable capability tokens or add placeholder dispatch for these
operations. Define the consumer, operation contract, and absence semantics in a
dedicated Issue or ADR when an implementation slice exists.

An adapter-owned durable sidecar is also out of scope. It requires a separate
decision covering authority, crash consistency, permissions, retention,
metadata boundaries, tampering, and disagreement with the Aizign journal.

## Data boundary

Follow [data-boundary.md](../architecture/data-boundary.md). In particular:

- do not use harness session or call IDs as core identity or envelope
  `requestId`; generate an adapter-owned nonce;
- treat a response correlation mismatch, multiple frames, or an exceeded bound
  as `unknown`;
- pass only stable identity, bounded opaque handles, digests, structured
  evidence, dispositions, and stable short error codes across the boundary; and
- use durable structured evidence as completion authority, never prose, idle
  state, or screen state.

## TypeScript package reference

The current TypeScript adapter layout is:

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
The DSH event shape and lifecycle are not generic adapter interfaces.

- Pin a TypeScript harness SDK to an exact version (peer and dev; ADR-0010).
  The root `.npmrc` uses `ignore-scripts=true`.
- Keep the `exports` map closed and disallow deep imports.
- Do not add runtime workspace dependencies beyond `@aizign/protocol`.
  `@aizign/adapter-testkit` is a development dependency.
- Keep normal tests within a fake harness and fake core process. Live smoke is
  opt-in under `experiments/`.

## Procedure

1. Agree on the harness, current minimum behavior, optional capabilities, data
   boundary, and live-smoke approach in an Adapter proposal Issue.
2. Add the package to `docs/architecture/dependency-rules.md`.
3. Implement the core client and exercise every applicable unknown path with
   the protocol fixtures and conformance scenarios.
4. Map native input to `WorkflowSignalSubmitPayload`, and prove that harness
   identities and content do not enter the full protocol envelope or journal.
5. Test optional harness capabilities with native fake-harness tests; do not add
   them to the generic minimum.
6. Record the supported harness version in
   `docs/reference/compatibility.md`.
