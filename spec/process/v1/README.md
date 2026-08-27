# CLI process profile v1

This document is the sole normative owner of the adapter/core one-shot process
profile. It owns argv, framing around Protocol JSON bodies, stdin/stdout/EOF
and exit lifecycle, watchdog stages, response-version selection before an
operation version is accepted, and parent process-fault treatment.

It does not duplicate the [Protocol v1](../../protocol/v1/README.md) payload
schemas or error-code meanings, and it does not replace the
[classification corpus](../../classification/README.md). “Compatibility
error” below describes a decoded/correlated stage, not a new client outcome.

The current CLI and clients do not yet fully implement this target. Issue #76
S2 owns the atomic runtime, fixture, test, package-documentation, and benchmark
migration.

## Version axes

| Axis | Current value | Meaning |
|---|---:|---|
| CLI process profile | 1 | This argv and process-lifecycle contract; not a wire field |
| Bootstrap envelope | 1 | Stable hello and pre-operation error representation |
| Operation Protocol | 1 | Version advertised by hello and used by accepted non-bootstrap operations |

The bootstrap-v1 envelope, hello, and pre-operation error schemas under
[`spec/protocol/v1/`](../../protocol/v1/README.md) are an independently stable
subset. Future operation versions reference rather than redefine this subset.
Support for bootstrap v1 does not imply support for operation Protocol v1 or a
future operation version.

## Canonical invocation

The adapter spawns the configured executable without a shell and supplies
exactly this argument vector for every operation:

```text
["handle", "--state", stateDir]
```

`hello`, `workflow.signal.submit`, and `workflow.signal.reconcile` all use this
path. Prefix/wrapper arguments and `--state=<dir>` are not adapter-profile
spellings. Repository-only fault injection may use a separate executable
wrapper, but that wrapper forwards the exact canonical vector and is not a
supported adapter surface.

The framed hello handler must not create, open, inspect, permission-check,
canonicalize, or otherwise depend on `stateDir`. Direct `aizign hello` is
provisional operator diagnostics only; it is not production preflight,
adapter conformance, or compatibility evidence.

Cwd, relative-path qualification, and executable discovery are intentionally
unsupported and unspecified. A future support claim requires a separate
accepted owner. Environment and capability boundaries remain separate work.

## Request stream

`MAX_FRAME_BYTES` means the JSON body bound and excludes LF. Its value is
65,536 bytes. A canonical request stream is therefore at most 65,537 bytes:

1. one non-empty BOM-free UTF-8 JSON body of at most 65,536 bytes;
2. exactly one LF byte (`0x0A`);
3. immediate stdin close or half-close; and
4. no byte after LF.

JSON whitespace before LF is body content, counts against the bound, and is
handled by the Protocol decoder. A CR immediately before LF is forbidden CRLF,
not accepted trailing JSON whitespace. Every byte after LF is forbidden,
including space, tab, CR, LF, or a second frame.

The child proves the body bound, LF, and immediate EOF before Protocol decode,
state initialization, journal/store access, clock access, or use-case dispatch.

### Framing precedence

1. More than 65,536 bytes before the first LF returns bootstrap-v1
   `REQUEST_TOO_LARGE` with null request ID and kind. This wins over a later
   LF, CRLF, EOF, or another defect.
2. Within the bound, an empty body, EOF before LF, CR immediately before LF,
   or any byte after LF returns bootstrap-v1 framing `INVALID_ENVELOPE` with
   null request ID and kind.
3. Watchdog expiry anywhere while waiting for the first LF or required EOF
   returns bootstrap-v1 pre-dispatch `HANDLER_TIMEOUT` with null request ID and
   kind.
4. Only a non-empty in-bound body, LF, and immediate EOF proceeds to the
   minimal Protocol probe and version-specific decode.

These three framing-layer failures are no-effect: they create no state
artifact and perform no dispatch. A watchdog after Protocol dispatch has begun
may follow a state access or durable effect; it therefore returns bootstrap-v1
`HANDLER_TIMEOUT` with null correlation and remains `unknown` with no retry.

## Version and kind routing

After framing succeeds, a minimal language-neutral envelope probe selects the
version axis before version-specific payload decoding:

1. exact syntactically valid `kind == "hello"` selects bootstrap version;
2. every other syntactically valid kind selects operation version before kind
   registry membership;
3. unsupported bootstrap or operation version returns bootstrap-v1
   `PROTOCOL_VERSION_UNSUPPORTED`;
4. an accepted operation version with an unregistered kind returns that
   operation version's `UNKNOWN_KIND`; and
5. only then does version-specific closed payload decoding run.

| Case | Response envelope version | Correlation |
|---|---|---|
| Framing failure or pre-dispatch read watchdog | Bootstrap v1 | Null request ID and kind |
| Minimal UTF-8/BOM/JSON/envelope failure before a version is accepted | Bootstrap v1 | Only safely recovered bounded fields; otherwise null |
| Hello with unsupported bootstrap version | Bootstrap v1 `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered request ID and `hello` kind |
| Hello after bootstrap v1 is accepted | Bootstrap v1 | Normal Protocol recovery/correlation |
| Non-hello kind with unsupported operation version | Bootstrap v1 `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered request ID and kind |
| Submit/reconcile after operation version acceptance | Accepted operation version | Normal operation correlation |
| Handler watchdog after dispatch may have begun | Bootstrap v1 `HANDLER_TIMEOUT` | Null request ID and kind |

An operation client retains the bootstrap-v1 error decoder. A bounded,
decodable, correlated bootstrap-v1 `PROTOCOL_VERSION_UNSUPPORTED` response is
a compatibility-stage error rather than a transport decode failure; its final
semantic outcome still comes from the operation-qualified classification
corpus. Null or mismatched correlation remains `unknown` and non-retryable.

## Canonical preflight

Preflight performs exactly this order:

1. send a framed bootstrap-v1 hello through canonical `handle`;
2. decode the bounded bootstrap-v1 response;
3. correlate request ID and kind;
4. compare advertised `protocolVersion`;
5. check every required operation capability; and
6. send no operation request on incompatibility or unknown.

A bootstrap-v1 server response may advertise a later operation version using
the closed bootstrap-v1 hello payload. An old bootstrap-v1 client decodes that
shape first, then reports the operation-version incompatibility. The server
does not add future operation-specific fields to the bootstrap-v1 response.

## Response and process lifecycle

A conforming child writes exactly:

1. one non-empty BOM-free UTF-8 JSON body of at most 65,536 bytes;
2. one LF;
3. stdout close; and
4. process close.

JSON whitespace before LF remains bounded body content. CRLF and every byte
after LF are forbidden. Exit zero means exactly one response frame was
emitted, including Protocol and watchdog errors. Usage/configuration or an
unrecoverable stdio failure may exit nonzero only without a response frame.

The parent drains stdout and stderr and waits for process close under its
bound. Each of these is transport `unknown` and never authorizes retry,
regardless of partial or apparently valid stdout:

- missing LF, CRLF, post-LF bytes, or a second frame;
- oversized, empty, BOM-prefixed, or invalid-UTF-8 output;
- a valid-looking frame with nonzero exit or without process close;
- spawn failure, signal or abnormal termination, missing exit code, parent
  timeout, caller abort, or failure to observe close.

Stderr is payload-free, metadata-only operational diagnostics. It has no
Protocol, correlation, compatibility, classification, retry, or workflow
authority.

## Correlation and bounded echo

Framed hello requires exact request ID and kind correlation. Submit and
reconcile success additionally correlate the response-carried event ID.
Missing, null, or mismatched required correlation is `unknown`.

The child echoes a recovered request ID or kind only when the complete encoded
response remains within 65,536 body bytes. A response-unsafe long kind becomes
`kind: null`; a fixed safe error message does not copy its raw contents. The
selected version axis and error code do not change. Null correlation makes the
parent result `unknown` and non-retryable.

## Required fixture inventory

S2 turns these stable case IDs into shared executable fixtures and focused
Rust/TypeScript/fake-core/benchmark tests. Each case records stage, response
version/code/correlation, dispatch and state-effect eligibility, and parent
treatment.

### Request framing

| ID | Stimulus | Required result |
|---|---|---|
| `req-empty-eof` | Empty stream then EOF | Framing `INVALID_ENVELOPE`; no effect |
| `req-empty-held` | Zero bytes; stdin held open | Pre-dispatch `HANDLER_TIMEOUT`; no effect |
| `req-partial-held` | Partial body; stdin held open | Pre-dispatch `HANDLER_TIMEOUT`; no effect |
| `req-max-held` | 65,536 bytes; no LF; held open | Pre-dispatch `HANDLER_TIMEOUT`; no effect |
| `req-no-lf-eof` | Bounded non-empty body then EOF | Framing `INVALID_ENVELOPE`; no effect |
| `req-valid` | Valid body + LF + EOF | Eligible for Protocol dispatch |
| `req-exact-bound` | 65,536-byte body + LF + EOF | Eligible for Protocol dispatch |
| `req-over-bound` | 65,537 bytes before LF | `REQUEST_TOO_LARGE`; no effect |
| `req-crlf` | In-bound body + CRLF | Framing `INVALID_ENVELOPE`; no effect |
| `req-max-crlf` | 65,536 JSON bytes + CRLF | `REQUEST_TOO_LARGE` wins |
| `req-json-space` | Valid JSON + space before LF | Body accepted for Protocol decode |
| `req-post-lf-byte` | Space, tab, LF, arbitrary byte, or second frame after LF | Framing `INVALID_ENVELOPE`; no effect |
| `req-eof-held` | Body + LF; no extra byte; stdin held open | Pre-dispatch `HANDLER_TIMEOUT`; no effect |

### Hello, state, and compatibility

| ID | Stimulus | Required result |
|---|---|---|
| `hello-nonexistent-state` | Correlated hello, nonexistent state path | Success; no state artifact; exact request ID/kind |
| `hello-invalid-profile` | LF-less, trailing, over-bound, or held-open hello | No state artifact or dispatch |
| `hello-bad-correlation` | Wrong/null request ID or kind | Parent `unknown`; no retry |
| `hello-future-operation` | Bootstrap-v1 hello advertises operation v2 | Decode, correlate, then protocol-version incompatibility |
| `hello-missing-capability` | Version matches; required capability absent | Incompatible; no operation sent |

### Version and kind

| ID | Stimulus | Required result |
|---|---|---|
| `version-bootstrap-unsupported` | Hello with unsupported bootstrap version | Bootstrap-v1 `PROTOCOL_VERSION_UNSUPPORTED` |
| `version-operation-unsupported` | Registered operation with unsupported version | Bootstrap-v1 `PROTOCOL_VERSION_UNSUPPORTED` |
| `version-future-kind-unsupported` | Future kind with unsupported operation version | Version error wins |
| `kind-future-accepted-version` | Future kind with accepted operation version | Operation-version `UNKNOWN_KIND` |
| `kind-response-unsafe` | Request-bound unknown kind cannot fit echoed response | `kind: null`, fixed message, bounded frame, parent `unknown` |

### Response and process

| ID | Stimulus | Required parent result |
|---|---|---|
| `res-no-lf` | Body without LF | Transport `unknown`; no retry |
| `res-crlf` | Body + CRLF | Transport `unknown`; no retry |
| `res-post-lf-byte` | Space, tab, LF, arbitrary byte, or second frame after LF | Transport `unknown`; no retry |
| `res-exact-bound` | 65,536-byte body + LF | Framing accepted; Protocol/correlation still required |
| `res-over-bound` | 65,537-byte body | Transport `unknown`; no retry |
| `res-invalid-bytes` | BOM or invalid UTF-8 | Transport `unknown`; no retry |
| `res-valid-zero` | Valid correlated frame + exit zero | Semantic classification may proceed |
| `res-valid-nonzero` | Valid-looking frame + nonzero exit | Transport `unknown`; no retry |
| `res-empty-zero` | Empty stdout + exit zero | Transport `unknown`; no retry |
| `res-valid-no-close` | Valid-looking frame; process does not close | Transport `unknown`; no retry |
| `proc-fault` | Spawn failure, signal, no exit code, timeout, or abort | Transport `unknown`; no retry |

## Current migration debt

At the S1 target, current code still diverges:

- CLI accepts a non-empty EOF-terminated body without LF and ASCII whitespace
  after LF.
- DSH production preflight uses direct `aizign hello`, correlates only kind,
  and exposes prefix `args` in its transport config.
- TypeScript frame collection permits ASCII whitespace after LF and does not
  close every process/exit state under this profile.
- adapter-testkit fake core and benchmark paths retain direct hello and older
  framing/wrapper behavior.

These are explicit S2 debt, not alternate accepted profiles.
