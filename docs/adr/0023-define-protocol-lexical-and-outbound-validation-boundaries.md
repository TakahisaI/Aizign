# ADR-0023: Define Protocol lexical and outbound validation boundaries

- Status: Accepted
- Date: 2026-08-27
- Related: ADR-0003, ADR-0004, ADR-0009, ADR-0022, Issue #74, Issue #77
- Accepted direction: [Issue #77 revised proposal](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5433653240), amended by [`P77-2B5F596-A1`](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5434262651) and [`P77-2B5F596-A2`](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5435964383)
- Acceptance: [Maintainer contract decision](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5439183457)
- Implementation checkpoint: [`I77-E782A9B-A`](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5439203268)
- Readiness: [S1 authorization](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5439471197), activated by the [post-predecessor preservation record](https://github.com/TakahisaI/Aizign/issues/77#issuecomment-5440022947)

## Context

ADR-0022 and the CLI process profile close argv, framing, process lifecycle,
bootstrap/operation stage selection, response-version selection, and bounded
correlation fallback. They intentionally do not define the complete lexical
and outbound source-value boundary inside a Protocol frame.

The current Rust and TypeScript codecs can still reach typed current-version
decoding before all version-independent lexical facts have been established.
Their outbound paths do not yet reject every value that JSON serializers can
omit or coerce, their local failure precedence is incomplete, and TypeScript
exposes payload encoders that bypass the frame boundary. Malformed error-code
construction can also normalize a caller value instead of rejecting it.

These gaps can make two independent implementations accept different source
values or choose different failures for the same frame. They are especially
dangerous for future versions: JavaScript number coercion or current-v1 field
bounds must not run before the accepted version supplies field semantics.

## Decision

### Version-independent lexical contract

Every JSON number token anywhere in an Aizign Protocol frame is an integer
token and uses exactly `0` or `-?[1-9][0-9]*`. Decimal notation, exponent
notation, and negative zero are outside the Protocol family, including in an
otherwise unsupported future-version frame.

The raw-token layer runs before request kind-axis routing, response-version
selection, or version-specific payload decoding. It preserves canonical
integer source text losslessly until an accepted version supplies a field
bound. Non-canonical envelope/error-side numbers yield `INVALID_ENVELOPE`;
non-canonical numbers below the top-level `payload` yield `INVALID_PAYLOAD`.
Those failures precede `PROTOCOL_VERSION_UNSUPPORTED`. Changing this family-
level rule requires a superseding ADR and an explicit compatibility decision.

### Sole outbound frame boundaries

Each language has one production request frame encoder and one production
response frame encoder. They validate the complete source value, construct one
fresh closed wire graph, serialize that graph once, verify encoded
postconditions, and enforce the body bound. They return a body only; ADR-0022
continues to own LF, stdin/stdout, EOF, exit, watchdog, and process behavior.

Request encoding selects bootstrap v1 for `hello` and the current operation
version for submit/reconcile. Response encoding consumes and validates the
response-version context already selected by the ADR-0022 path. It does not
infer a stage from the response body, repair correlation, replace unsafe
values, manufacture a fallback, or use another serializer. Any producer-
constructed fallback passes through the same response encoder unchanged.

TypeScript payload mappers cease to be supported package-root production
exports. Codec-internal helpers may be shared by that language's encoder and
decoder, but a production decoder or decode-after-encode round trip is not
encoder validity evidence.

### Closed outbound source values

Rust and TypeScript reject invalid values before serialization. TypeScript
static types are not runtime evidence. Closed DTO objects and arrays are
validated using all own property descriptors, including non-enumerable and
symbol keys, in a fixed field/index order.

- A DTO object is a plain object with exactly `Object.prototype` or `null` as
  its prototype. Known present fields are own data properties. Accessors,
  inherited required fields, unknown string/symbol keys, and a present
  optional field whose value is `undefined` are rejected.
- A DTO array has exactly `Array.prototype`, owns every index from zero through
  `length - 1` as a data property, and has no holes, accessors, undefined
  elements, custom properties, symbols, or nonstandard prototype.
- Source `toJSON` hooks have no authority. The source graph is never serialized
  directly.
- Non-finite numbers, non-integers, out-of-range values, `bigint`, functions,
  symbols, cycles, lone UTF-16 surrogates, and `Object.is(value, -0)` are
  rejected with the field-location code rather than omitted or coerced.

The sole non-plain TypeScript source exception is an authentic, non-subclass
`ProtocolError` constructed through the package's public boundary. A plain
lookalike, another `Error`, a subclass, or custom-prototype imitation is not
accepted. The response encoder revalidates `code` then `message` as own data
properties without invoking accessors. Only those two validated fields enter
the fresh wire graph; `name`, `stack`, `cause`, custom metadata, and `toJSON`
have no wire authority.

### Error construction and deterministic local failure

Every successfully constructed `ProtocolError` preserves one syntactically
valid code matching `^[A-Z][A-Z0-9_]{0,63}$`; fixed-code membership remains
open. Malformed raw construction fails locally. Rust construction from raw
text is fallible, while an already validated short code may use an infallible
path. TypeScript `new ProtocolError(code, message)` throws `TypeError` for a
malformed code. No compatibility helper retains malformed-code-to-`INTERNAL`
normalization.

Outbound validation follows the total field and stage order in
[`spec/protocol/v1/`](../../spec/protocol/v1/README.md). Container/key/
descriptor closure is checked before children; arrays use ascending index
order; request and response roots and every known nested object have a fixed
field order. Shape precedes semantics, serialization/postconditions, and the
body bound. The selected stable code and stage are normative; message text is
not.

A local request failure occurs before process creation, timing start, stdin
acquisition, or any write. It creates no peer outcome, `reportedCode`,
`rejected`, or `unknown`. A local response failure occurs before the first
stdout/transport byte. ADR-0022 owns the peer's treatment of the resulting
process fault, and the classification corpus continues to own semantic
outcomes.

### Decode pipeline and authority

After the ADR-0022 stream gate, both implementations apply one ordered
pipeline: body bound; BOM-free UTF-8 and complete JSON grammar; one raw-token
scan for duplicates, Unicode scalars, and canonical integers; minimal
correlation/envelope probe; the ADR-0022 request-kind axis or response-version
selector; version decision; then closed accepted-version decoding. No typed
bootstrap/current-operation envelope is decoded before its version is
accepted.

`spec/protocol/v1/README.md` is the sole normative owner of these lexical,
probe, and outbound rules. Schemas own JSON-value acceptance where they can
express it. Conformance documents own language-neutral fixture and scenario
evidence. Rust and TypeScript remain independent consumers; no shared runtime
parser, generated universal DTO, or cross-language executable authority is
introduced.

## Implementation transition

This ADR and its S1 specification establish the target contract only. At this
decision point the current codecs, public exports, constructors, clients,
producers, fault paths, and fixtures still contain the behavior named in the
Context. Issue #77 S2 owns their atomic migration and evidence. Until S2 lands,
documentation must not claim that those runtime surfaces fully implement this
ADR.

## Consequences

### Positive

- Future-version precedence is decided from lossless source text instead of a
  current-version numeric model.
- Outbound values cannot exploit serializer omission, coercion, prototypes,
  accessors, or alternate package exports.
- Rust and TypeScript select the same stable failure for multi-defect inputs.
- Local failures are visibly separated from peer outcomes and transport
  uncertainty.

### Negative / Risks

- Both codecs need a raw-token pass in addition to typed accepted-version
  decoding.
- TypeScript validation must inspect descriptors and prototypes rather than
  relying on static types or ordinary key enumeration.
- The public `ProtocolError` constructor becomes stricter before the first
  release, and response decode failures must retain recovered correlation.
- The runtime, caller, export, fixture, and fault-path migration must land
  atomically in S2 to avoid parallel authorities.

### Follow-up

- Issue #77 S2 implements the contract across both codecs and every production
  request caller/response producer.
- S2 removes payload-encoder bypass exports, typed pre-selection decoding,
  duplicate client prevalidation, correlation-dropping response failures, and
  production-encoder use by intentional invalid-frame producers.
- Shared decoder fixtures and decoder-independent encoder scenarios prove the
  full precedence, correlation, source-graph, zero-write, and size boundaries.

## Alternatives considered

- **Allow future versions to introduce decimal or exponent number tokens.**
  Rejected because lexical acceptance would then require version-specific
  parsing before safe version selection.
- **Rely on JSON Schema, serializers, or static TypeScript types.** Rejected
  because they cannot prove source spelling, descriptor/prototype closure, or
  absence of coercion.
- **Validate an encoder by decoding its output.** Rejected because it makes the
  decoder a parallel outbound authority and can hide a shared bug.
- **Keep payload encoders or normalization helpers as compatibility aliases.**
  Rejected because they preserve bypasses around the sole frame boundary.
- **Create a shared cross-language runtime parser.** Rejected because the two
  language implementations remain independent consumers of one repository-
  owned contract.
