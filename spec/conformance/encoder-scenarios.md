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

## Local outbound-size failure

An outbound request whose serialized frame would exceed `MAX_REQUEST_BYTES`
must fail locally before any process is spawned or transport is started:

```text
oversized outbound request
  -> local encoder/client failure
  -> process/transport starts: 0
  -> request frames sent: 0
  -> submit classification: none
```

This is not the core's `rejected` submit classification and is not `unknown`:
the transport did not start. A language binding must document whether the
local API throws/rejects or returns a distinct local-failure value. A harness
adapter maps that local failure through its native error boundary without
claiming that the core rejected the signal.

A response encoder in a full codec must likewise fail locally instead of
returning a frame larger than `MAX_FRAME_BYTES`. Fault injectors that need an
oversized inbound frame construct raw contract-violating bytes; they do not use
the production encoder.

## Decoder fixtures

Decoder acceptance, recovered correlation fields, stable failure codes, and
full-codec decode-to-encode round trips remain covered by
[the frame fixture README](README.md). A client that does not implement a
request decoder or response encoder does not run those unused-direction tests.
