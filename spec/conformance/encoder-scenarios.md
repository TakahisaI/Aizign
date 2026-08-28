# Language-neutral encoder scenarios

This document defines encoder conformance without requiring a production
decoder. The frame files under `valid/` and `invalid/` remain decoder acceptance
fixtures; they are not typed encoder inputs.

The wire format, schemas, bounds, and stable codes are owned by
[Protocol v1](../protocol/v1/README.md). The protocol
[examples](../protocol/v1/examples/) provide structured JSON inputs and
expected wire values for these scenarios.

## Example-driven encoding

For each direction and kind an implementation encodes:

1. Load an applicable `*.request.json` or `*.response.json` example with a
   generic JSON parser in the test harness. This parser is fixture plumbing,
   not the production Protocol v1 decoder.
2. Construct the language's outbound DTO from the example's known envelope and
   payload/error fields.
3. Encode the DTO with the production encoder.
4. Assert that the output is one BOM-free UTF-8 JSON object with no raw newline
   and no more than `MAX_FRAME_BYTES` bytes.
5. Parse the output with the test harness's generic JSON parser and compare it
   with the example as a JSON value. Object member order and insignificant
   whitespace are not contractual.
6. Validate the encoded value against the applicable Protocol v1 schema.

A submission-only client applies this procedure to the request kinds it sends.
A client claiming reconciliation also applies the reconciliation request
example. A binding claiming a full Protocol v1 codec applies the procedure to
every request and response example.

## Required valid matrix

The language-neutral valid matrix covers every current source/wire mapping:

| Direction | Source variant | Required version context |
|---|---|---|
| request | `hello` | bootstrap v1 selected by the request encoder |
| request | `workflow.signal.submit` | current operation version |
| request | `workflow.signal.reconcile` | current operation version |
| response | hello success | bootstrap v1 |
| response | submit success | accepted operation version |
| response | reconcile success | accepted operation version |
| response | correlated current error | the already selected bootstrap or accepted-operation context |
| response | null-correlation bounded fallback | the context supplied by the process-profile producer |

Valid error scenarios include both every current fixed code applicable to the
producer and a syntactically valid unrecognized code. The exact code is
preserved. A TypeScript response uses an authentic non-subclass
`ProtocolError`; only its revalidated `code` and `message` appear on the wire.
Changing `name`, `stack`, `cause`, custom metadata, or a source `toJSON` cannot
change the output or cause the hook to run.

Each valid scenario proves that the supplied response-version context is
preserved rather than inferred from `kind`, body type, or the current numeric
equality of bootstrap and operation versions. A process-profile producer's
bounded/null-correlation fallback is encoded exactly as supplied.

## Required invalid outbound matrix

Every invalid source fails through the production frame encoder before
serialization can omit, coerce, normalize, invoke, or repair it. Tests pin the
stable local code and the
[normative total order](../protocol/v1/README.md#total-local-failure-order).
Where both public value models can express a multi-defect input, Rust and
TypeScript select the same code. TypeScript-only descriptor/prototype cases
remain TypeScript evidence.

### Request root, kind, and mapping

- invalid or inherited `requestId`, including malformed Unicode and bounds;
- missing/wrongly typed/unregistered kind;
- forged discriminant/source-variant or kind/payload combination;
- unknown root keys, symbols, accessors, non-enumerable keys, inherited
  required fields, and present optional `undefined`; and
- a multi-defect request containing an invalid request ID, unregistered kind,
  invalid payload, and oversized value, which selects `INVALID_ENVELOPE` at
  request stage 2.

### Payload, `HelloInfo`, and success result

- malformed expected IDs, role, revision, and digest fields;
- every invalid signal conditional-field matrix and each semantic failure in
  the fixed field order;
- invalid result disposition/event ID and success kind/body mismatch;
- invalid `HelloInfo` version bounds, capability syntax/length/uniqueness,
  package shape, and Unicode strings;
- `NaN`, infinities, non-integers, out-of-range integers, and specifically
  `findingCount: -0`;
- `bigint`, functions, symbols, cycles, non-JSON values, and lone surrogates;
  and
- a sparse capabilities array, an undefined element, an array subclass,
  accessor element, or custom own array property.

### TypeScript closed source graph

- an unknown symbol key or unknown non-enumerable property;
- an accessor-backed required field, with evidence that the accessor was not
  invoked;
- an own `toJSON` property, with evidence that it was not invoked;
- a class instance, custom-prototype DTO, array subclass, and custom-prototype
  array;
- a missing required own data property or inherited substitute; and
- a present optional property equal to `undefined`.

### Error responses and version context

- invalid/inconsistent response-version context and response correlation;
- unregistered success kind before success-body interpretation;
- registered success kind paired with the wrong body variant;
- malformed error object, code, or message in `code`-then-`message` order;
- post-construction mutation of an authentic `ProtocolError` to a malformed,
  missing, inherited, wrongly typed, or accessor-backed code/message;
- a plain `{ code, message }` lookalike, another `Error`, a custom
  `ProtocolError` subclass, and a custom-prototype imitation; and
- an unsafe source that would require truncation, nulling, code substitution,
  fallback construction, or response-version repair. It is rejected, not
  repaired or serialized through an alternate path.

Focused mutation sentinels fail if source-graph validation is removed; an
accessor or `toJSON` is invoked; a structural error lookalike/subclass is
accepted; runtime error metadata reaches the wire; a valid unrecognized code
is discarded; bootstrap/operation constants are recoupled; or encoder-side
correlation repair is introduced.

## Local failure and zero-side-effect evidence

An outbound request whose serialized frame would exceed `MAX_REQUEST_BYTES`
must fail locally before any process is spawned or transport is started:

```text
oversized outbound request
  -> local ProtocolError
  -> process/transport starts: 0
  -> request frames sent: 0
  -> peer outcome/classification: none
```

This is not the core's `rejected` submit classification and is not `unknown`:
the transport did not start. A harness adapter maps that local failure through
its native error boundary without claiming that the core rejected the signal.

A response encoder in a full codec must likewise fail locally instead of
returning a frame larger than `MAX_FRAME_BYTES`. Fault injectors that need an
oversized inbound frame construct raw contract-violating bytes; they do not use
the production encoder.

Every invalid request scenario asserts zero process spawns, zero parent-timing
starts, zero stdin acquisitions, and zero request bytes written. Every invalid
response scenario asserts zero stdout/transport bytes written. This applies to
all invalid-source stages, not only size failure.

Response encoding proves the exact body boundary with an otherwise-valid
65,536-byte response (accepted) and 65,537-byte response
(`INVALID_ENVELOPE`); the process-profile LF is excluded. Current-v1 request
DTO bounds make an otherwise-valid request at either size unreachable. Request
encoding instead proves all of the following without widening a schema or
delaying an earlier validation failure:

- a maximal valid DTO for every current request kind encodes below 65,536
  bytes;
- invalid overlong fields and unknown padding fields fail at their normative
  earlier validation stage, with zero spawn/write; and
- the final request-body guard remains `REQUEST_TOO_LARGE` and is covered by
  an implementation-internal seam or focused mutation sentinel explicitly
  authorized by the S2 checkpoint. That seam is test-only evidence behind the
  sole production frame encoder; it is not a serializer, public DTO, wire
  shape, package export, or second production path.

The raw request-frame boundary at exactly 65,536 and 65,537 bytes remains
decoder/process-profile fixture evidence rather than typed request-encoder
evidence.

Malformed raw `ProtocolError` construction is also focused evidence. Rust raw
text construction fails through `Result`; TypeScript construction throws
`TypeError`. A valid unrecognized code constructs and round-trips unchanged.
No helper or compatibility alias may restore malformed-code-to-`INTERNAL`
normalization.

## Decoder fixtures

Decoder acceptance, recovered correlation fields, stable failure codes, and
full-codec decode-to-encode round trips remain covered by
[the frame fixture README](README.md). A client that does not implement a
request decoder or response encoder does not run those unused-direction tests.

Issue #77 S2 implements this matrix in the Rust and TypeScript encoder suites,
with focused mutation sentinels and caller/producer zero-side-effect evidence.
The suites remain decoder-independent and use the production frame encoders.
