# Current-operation classification

This directory defines the language-neutral contract for classifying Aizign's
current operations across Protocol handlers, clients, child observations,
parent transport observations, and metadata-only timing.

It does not define wire shapes. Protocol v1 schemas and
[`spec/protocol/v1/`](../protocol/v1/README.md) own request/response shapes,
kinds, bounds, and error-code syntax. It also does not define a runtime service
or a universal outcome type.

## Current operations

The current v0.1 operation set is exactly:

| Operation | Protocol ownership | Capability requirement |
|---|---|---|
| `hello` | Protocol v1 `hello` request and response schemas | Bootstrap operation; it does not advertise itself |
| `workflow.signal.submit` | Protocol v1 submit request and response schemas | The server advertises `workflow.signal.submit` |
| `workflow.signal.reconcile` | Protocol v1 reconcile request and response schemas | The server advertises `workflow.signal.reconcile` |

A non-hello operation is current only if both its Protocol kind/schema and its
advertised capability exist. A name that fails either condition is not a
current operation. Documentation may discuss it only with an explicit future
or provisional marker.

## Source-qualified vocabulary

Classification keeps these concepts separate:

| Concept | Authority and meaning |
|---|---|
| Server disposition | The handler/server result where an operation supplies one |
| Client outcome | The result exposed after bounded response extraction, decode, and correlation |
| Reconciliation disposition | The pure `accepted`, `conflict`, or `absent` result from a complete trustworthy committed snapshot |
| Child runtime observation | The operation result observed inside the child runtime and optionally emitted as provisional metadata-only timing |
| Parent transport observation | The process, transport, decode, and correlation result observed by the parent |

An identical value such as `accepted` or `unknown` in two columns does not
merge their authorities. Consumers must not derive one source's value from a
different source unless a corpus row explicitly defines that mapping.

## Planned corpus ownership

The Issue #75 implementation slice will add:

- `current-operations.json`, containing only rows for currently implemented
  operations, current implemented fixed codes, and the generic
  well-formed-unrecognized case; and
- a sibling JSON Schema that closes and validates every row.

Those files are intentionally absent from this contract-only slice. Until the
implementation slice lands, current Rust, TypeScript, CLI, timing, and
benchmark consumers may still contain duplicated classification logic and may
temporarily diverge. This document defines the target contract; it does not
claim that runtime consumers are already corpus-driven.

Each future corpus row must contain at least these fields:

| Field | Required meaning |
|---|---|
| `operation` | One of the exact current operations above |
| `reportedCode` | An explicit discriminator for no code, one implemented fixed code, or the generic well-formed-unrecognized case; never a speculative future code name |
| `serverDisposition` | The source-qualified server value, or an explicit not-applicable value |
| `clientOutcome` | The source-qualified semantic result exposed by the client |
| `reconciliationDisposition` | `accepted`, `conflict`, or `absent` for successful reconciliation, or an explicit not-applicable value |
| `childObservation` | The child source field and value, or explicit absence |
| `parentObservation` | The parent transport source field and value, or explicit absence |
| `timingCodeDisclosure` | Whether that exact current fixed code may be disclosed in metadata-only timing |
| `automaticRetryAuthorized` | Whether the row authorizes automatic retry; this is `false` for every current row |

The schema may add validation metadata needed to close the representation, but
it must not turn the corpus into a general classification framework or add a
new public version axis. The unversioned location follows current operation
support; Protocol, journal, store, and package versions retain their existing
independent lifecycles.

## Fail-closed rules

- A missing operation row, missing code row, unsupported combination, or
  unrecognized peer code cannot imply success, deterministic rejection, or
  retry authorization.
- Every current row sets `automaticRetryAuthorized` to `false`.
- Submit `INTERNAL` has client outcome `unknown` and is non-retryable.
- A syntactically valid but unrecognized submit code has client outcome
  `unknown`, is non-retryable, and may be retained only as a bounded
  control-plane `reportedCode` diagnostic.
- Every reconciliation error response has client outcome `unknown`.
- Missing, malformed, oversized, timed-out, aborted, or uncorrelated responses
  have client outcome `unknown` and authorize no retry.
- A well-formed unrecognized code is omitted from timing code disclosure.
  Timing may disclose a code only when an exact current row explicitly permits
  it.

Protocol error-code membership remains open. The syntax
`^[A-Z][A-Z0-9_]{0,63}$` permits a peer to report a well-formed code that this
revision does not recognize. Decoder acceptance does not confer classification
meaning.

## Current/future boundary

Future effect operations and `EFFECT_*` names are not current reservations,
recognition entries, examples, timing values, or compatibility commitments.
Adding one requires a separately accepted proposal with a consumer, canonical
authority, Protocol kind or journal record shape as applicable, and tests. No
current document or corpus row may imply that such a runtime exists.

This classification contract adds no effect runtime, automatic retry, or
universal outcome service.

## Timing lifecycle

Timing is provisional operational evidence, not a stable public compatibility
contract. The corpus may constrain safe disclosure of current fixed codes, but
it does not own timing field shape, stabilize a timing schema, reserve future
vocabulary, or override client semantics. A child or parent timing observation
is evidence from that named source only.

## Delivery order

The required order is:

1. Issue #75 contract decision and this ADR/specification slice.
2. Issue #87 engine ownership work.
3. Issue #88 observation ownership work.
4. Issue #89 transport ownership work.
5. Issue #75 corpus, consumers, and cross-language regression tests.

The final slice migrates or deletes manually synchronized tables and proves
that every supported consumer reads/tests the same language-neutral rows.
