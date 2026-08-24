# Harness adapter contract

This document is the normative, language-neutral contract for an Aizign
harness adapter. It defines observable behavior and ownership boundaries, not a
package layout, programming language, harness event format, or shared adapter
runtime.

The authorities are deliberately separate:

| Concern | Authority |
|---|---|
| Harness adapter behavior and capability boundaries | This document |
| Core--adapter wire format, schemas, kinds, and stable codes | [`spec/protocol/v1/`](../../spec/protocol/v1/README.md) |
| Shared decoder acceptance fixtures | [`spec/conformance/`](../../spec/conformance/README.md) |
| Harness-native behavior | The adapter's README, source, and native tests |
| TypeScript reference APIs and runner behavior | [`packages/protocol/`](../../packages/protocol/README.md) and [`packages/adapter-testkit/`](../../packages/adapter-testkit/README.md) |

The [adapter implementation guide](../development/adding-adapter.md) explains
how to apply this contract. It is not a second behavioral authority.

## Capability layers

Keep these three layers separate. A token or field in one layer does not
silently acquire meaning in another.

| Layer | Authority and use | v0.1 representation |
|---|---|---|
| Core protocol capability | An operation understood by the Aizign binary | Request kinds advertised by `hello.capabilities` |
| Harness adapter capability | An operation or evidence source an adapter can safely execute and verify on its harness | Adapter documentation and harness-native tests; no universal runtime manifest or Protocol v1 field |
| Workflow requirement | A capability required by a particular workflow | Provisional; no v0.1 consumer, negotiation field, or dispatch runtime |

`hello.capabilities` reports core protocol operations. It is not a manifest of
DSH or another harness's features.

## Current minimum

A v0.1 signal-submission adapter must:

1. perform protocol health, version, and capability checks before exposing its
   submission path;
2. submit a scope-bound structured workflow signal;
3. obtain workflow, assignment, attempt, role, artifact revision, and candidate
   digest from trusted control-plane configuration;
4. keep those stable identity fields out of model-visible arguments;
5. keep harness session, call, thread, provider, and delivery identifiers out
   of Aizign identity and the complete protocol envelope, including
   `requestId`;
6. validate response `requestId`, `kind`, and, where applicable, `eventId`
   correlation;
7. preserve the submit classification as `accepted`, `duplicate`, `rejected`,
   or `unknown`;
8. never infer success, rejection, or absence from `unknown`, and never blindly
   retry an unknown submission;
9. keep raw prompts, model output, reasoning, credentials, and other
   conversation content out of the protocol and control journal; and
10. enforce request and response frame limits, reject extra response frames,
    and place a wall-clock bound on caller wait. If cancellation cannot prove
    that remote work stopped, the outcome remains `unknown`.

An adapter need not persist outcomes, expose harness-native evidence, implement
core reconciliation, or provide lifecycle operations to satisfy this minimum.
Optional capabilities do not weaken any minimum requirement.

## Protocol and transport

Protocol v1 currently uses one BOM-free UTF-8 NDJSON request and one NDJSON
response over a one-shot process. The schemas, maximum sizes, version, kinds,
capabilities, and stable error codes are owned by `spec/protocol/v1/`.

An adapter may use a different transport only when it preserves the same
Protocol v1 envelope, closed decoding, size and frame-count bounds, correlation,
and outcome semantics. A transport bridge is not permission to define another
Aizign protocol or to treat MCP, a harness SDK, or a provider API as the wire
authority.

Each request uses an adapter-owned nonce for `requestId`. Native harness
identifiers must not be repurposed as correlation or workflow identity.

## Source-qualified outcomes

Similar words from different sources do not carry the same authority.

| Source | Outcome vocabulary | Meaning |
|---|---|---|
| Signal submission | `accepted`, `duplicate`, `rejected`, `unknown` | Result of the attempted core submit operation |
| Core journal reconciliation | `accepted`, `conflict`, `absent`, `unknown` | Read-only classification of the exact full signal against the committed Aizign journal |
| Harness-native observation | Adapter-specific | Classification of native records under that adapter's documented evidence contract |

Submission classifications have these meanings:

- `accepted`: the core reports that the exact signal was accepted and durably
  recorded under the journal contract;
- `duplicate`: the same `eventId` and exact accepted event content already
  exist, so no second event is appended;
- `rejected`: the core definitively refused this request and returned a stable
  rejection code; and
- `unknown`: the client cannot establish whether this request took effect.

`unknown` is terminal knowledge about the observation, not permission to retry.
A caller may perform a separately defined read-only reconciliation or another
safe observation, but must not collapse the original result.

An operation can also fail before producing an outcome value. Unless an
adapter explicitly defines a closed outcome for that failure, callers must
treat the observation as unavailable and must not infer success, rejection, or
absence from the thrown error.

## Core reconciliation

`workflow.signal.reconcile` is a core protocol capability over the Aizign
control journal. It is independent of harness persistence and is not a
harness-evidence mode.

A client claiming reconciliation support must:

- query with the same complete `WorkflowSignal`, including optional fields;
- check that the binary advertises the reconciliation capability;
- preserve `accepted`, `conflict`, `absent`, and `unknown` without collapsing
  them;
- retain a syntactically valid reported stable code as diagnostic information
  before applying correlation checks, without treating an uncorrelated code as
  a fact about the request; and
- make no append, initialization, synchronization, repair, or tail-promotion
  request as part of reconciliation.

Only an existing, completely decoded, committed snapshot can produce
`accepted`, `conflict`, or `absent`. Missing or inconsistent storage, an active
writer, corruption, an unpublished tail, transport failure, timeout, and
correlation failure remain `unknown`. The detailed storage guarantee is owned
by [ADR-0013](../adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)
and the store specification.

Submission must not become unavailable merely because reconciliation is
unavailable.

## Completion authority and harness evidence

The Aizign control journal is authoritative for workflow signal acceptance.
Natural-language claims, idle state, UI state, and process exit alone are not
completion evidence.

Durability and attribution are independent properties of harness-native
evidence. An adapter may rely on a native record only when:

1. the source has a documented durability and retention contract; and
2. the adapter verifies attribution to the requested binding and, if it claims
   payload integrity, to the requested payload.

A durable-looking error without verifiable binding metadata is not proof that
the requested binding was rejected. Conversely, binding verification does not
prove crash durability or retention. The adapter owns its native evidence
interpretation and must document its limits.

The DSH adapter currently demonstrates only these optional integrations:

- harness-persisted success metadata integration;
- caller-wait timeout with a post-read event-count classification guard; and
- binding-digest verification with payload-digest recording.

These integrations do not establish the durability or retention of real DSH
persistence, bound source-side I/O, allocation, event byte size, or work after
ignored cancellation, and do not verify payload digest content on cold read.
DSH event shapes and Cordis lifecycle are not generic adapter contracts; see
the [DSH adapter README](../../adapters/dsh/README.md) for its native boundary.

## Data boundary

Adapters may send only stable identity, bounded opaque handles, digests,
structured evidence, dispositions, and stable short error codes across the
core boundary. They must not send raw conversation data or credentials.

The adapter maps native inputs to protocol DTOs but does not expose core or
engine internal types to its harness. The core, protocol, and journal likewise
must not acquire harness or provider names. See
[data-boundary.md](data-boundary.md) for the complete repository boundary.

## Conformance ownership

Conformance has three independent parts.

### Wire conformance

Every implementation must match the Protocol v1 schemas and decoder acceptance
set. `spec/conformance/` contains language-neutral valid and invalid frames.
Each language may provide its own runner over those fixtures.

### Core-client conformance

The language-neutral scenario requirements are grouped by claimed behavior.

The minimum signal-submission group covers:

- compatible `hello` and the submit capability;
- valid encode/decode and a single bounded response frame;
- `accepted`, then `duplicate`, then conflicting content;
- expectation mismatch and stable rejection codes;
- timeout, no response, malformed or oversized response, spawn/transport
  failure, and correlation mismatch becoming `unknown`;
- non-collapse of `unknown` and no blind submit retry; and
- metadata-only frames with no harness or provider identifier leakage.

The reconciliation extension group covers:

- capability checking;
- exact-signal `accepted`, changed-content `conflict`, and committed-snapshot
  `absent`;
- unavailable/corrupt/inconsistent storage and transport failures remaining
  `unknown`;
- diagnostic `reportedCode` handling around correlation failure; and
- proof that the reconciliation path does not modify state.

Scenario requirements are shared; an executable runner is not. A language may
express them with its native test framework. This repository does not define a
stdin/stdout adapter-test protocol or a universal adapter driver.

### Harness-native adapter conformance

Each adapter owns tests for:

- plugin or tool registration;
- native event mapping and model-visible argument schema;
- trusted identity injection;
- native session/call identifiers and persistence reads;
- lifecycle hooks and harness error mapping; and
- any claimed harness-native durability, retention, or evidence semantics.

Those tests may reuse shared assertions, but no common executable harness
interface is required.

## TypeScript reference layer

`@aizign/protocol` is the TypeScript codec, types, compatibility helpers, and a
reference `CoreClient` interface. `@aizign/adapter-testkit` provides a fake core,
reference one-shot client, convenience assertions, and a TypeScript conformance
runner.

The current TypeScript `CoreClient` and `runCoreClientConformance` require both
submission and reconciliation. They are therefore a useful reference-layer
superset of the minimum signal-submission contract, not the minimum itself.
Failing to implement that TypeScript interface does not by itself make a
non-TypeScript submission adapter non-conforming.

TypeScript adapters in this repository follow the Node support policy,
workspace dependency rules, and exact harness SDK pinning. An implementation
in another language need not depend on either npm package; it must satisfy the
same wire fixtures and applicable behavioral scenarios using its own codec and
tests.

## Provisional operations

Interrupt, effect dispatch, resource release, session or agent ownership,
general lifecycle hooks, remote reconnect, and an adapter-owned durable sidecar
have no generic v0.1 contract. Do not publish stable capability tokens,
placeholder dispatch, or shared runtime abstractions for them. A dedicated
Issue or ADR must first define the consumer, authority, failure and absence
semantics, and data boundary.

## Negative constraints

- Do not introduce harness or provider names into core, engine, protocol, or
  journal identity.
- Do not promote a native event shape into a generic adapter event schema.
- Do not require TypeScript, Node, npm packages, or a particular plugin model
  for all adapters.
- Do not make MCP or another external protocol the Aizign wire authority.
- Do not create a universal adapter runtime, executable test driver, adapter
  process protocol, or speculative `common`, `shared`, or runtime package.
- Do not require a second adapter before this contract can stand on its own.
