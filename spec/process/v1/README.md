# CLI process profile v1

This document is the sole normative owner of the adapter/core one-shot process
profile. It owns argv, framing around Protocol JSON bodies, stdin/stdout/EOF
and exit lifecycle, watchdog stages, response-version selection before an
operation version is accepted, and parent process-fault treatment.

It does not duplicate the [Protocol v1](../../protocol/v1/README.md) payload
schemas or error-code meanings, and it does not replace the
[classification corpus](../../classification/README.md). “Compatibility
error” below describes a decoded/correlated stage, not a new client outcome.

The Rust CLI, current Protocol codecs, DSH production client,
adapter-testkit fake executable, and benchmark runner implement this profile.
Their shared executable evidence is a non-normative projection of the stable
case inventory below.

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
accepted owner. The language-neutral [harness adapter contract](../../../docs/architecture/harness-adapter-contract.md#child-process-environment)
owns child-environment construction and capability-source separation; this
process profile does not own an environment-variable list.

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

[`fixtures/cases.json`](fixtures/cases.json) projects these stable case IDs into
shared executable evidence and focused Rust/TypeScript/fake-core/benchmark
tests. Each case records stage, response
version/code/correlation, dispatch and state-effect eligibility, and parent
treatment.

In the tables below, `B1` means bootstrap envelope v1, `O1` means accepted
operation Protocol v1, and `null/null` means null request ID and kind. “No
dispatch/effect” also forbids state-path inspection or artifact creation.

### Request framing

| ID | Stage | Stimulus | Response version / code | Correlation | Dispatch / state effect | Parent treatment |
|---|---|---|---|---|---|---|
| `req-empty-eof` | Child framing | Empty stream then EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-empty-held` | Child pre-dispatch read watchdog | Zero bytes; stdin held open | B1 / `HANDLER_TIMEOUT` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-partial-held` | Child pre-dispatch read watchdog | Partial body; stdin held open | B1 / `HANDLER_TIMEOUT` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-max-held` | Child pre-dispatch read watchdog | 65,536 bytes; no LF; held open | B1 / `HANDLER_TIMEOUT` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-no-lf-eof` | Child framing | Bounded non-empty body then EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-valid` | Child framing then Protocol decode | Valid body + LF + EOF | Selected version / Protocol result | Protocol rules | Eligible for dispatch/effect | Continue to Protocol correlation and classification |
| `req-exact-bound` | Child framing then Protocol decode | 65,536-byte valid body + LF + EOF | Selected version / Protocol result | Protocol rules | Eligible for dispatch/effect | Continue to Protocol correlation and classification |
| `req-over-bound` | Child framing | 65,537 bytes before LF | B1 / `REQUEST_TOO_LARGE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-crlf` | Child framing | In-bound body + CRLF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-max-crlf` | Child framing | 65,536 JSON bytes + CRLF | B1 / `REQUEST_TOO_LARGE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-json-space` | Child framing then Protocol decode | Valid JSON + space before LF + EOF | Selected version / Protocol result | Protocol rules | Eligible for dispatch/effect | Continue to Protocol correlation and classification |
| `req-post-lf-space` | Child framing | Body + LF + space + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-post-lf-tab` | Child framing | Body + LF + tab + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-post-lf-cr` | Child framing | Body + LF + CR + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-post-lf-second-lf` | Child framing | Body + LF + second LF + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-post-lf-second-frame` | Child framing | Body + LF + second frame + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `req-eof-held` | Child pre-dispatch read watchdog | Body + LF; stdin held open | B1 / `HANDLER_TIMEOUT` | `null/null` | No dispatch/effect | `unknown`; no retry |

### Hello, state, and compatibility

| ID | Stage | Stimulus | Response version / code | Correlation | Dispatch / state effect | Parent treatment |
|---|---|---|---|---|---|---|
| `hello-nonexistent-state` | Bootstrap hello dispatch | Canonical correlated hello with nonexistent state path | B1 / success | Exact request ID and `hello` kind | Hello only; no state access/artifact | Continue to version and capability checks |
| `hello-no-lf-eof` | Child framing | Hello body then EOF without LF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `hello-post-lf-byte` | Child framing | Hello body + LF + one trailing byte + EOF | B1 / `INVALID_ENVELOPE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `hello-over-bound` | Child framing | Hello-shaped body exceeds 65,536 bytes before LF | B1 / `REQUEST_TOO_LARGE` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `hello-held-open` | Child pre-dispatch read watchdog | Hello body + LF while stdin remains open | B1 / `HANDLER_TIMEOUT` | `null/null` | No dispatch/effect | `unknown`; no retry |
| `hello-request-id-mismatch` | Parent correlation | Bounded hello success with wrong or null request ID | B1 / success | Request ID mismatch | Hello only; no state access/artifact | `unknown`; no retry |
| `hello-kind-mismatch` | Parent correlation | Bounded hello success with wrong or null kind | B1 / success | Kind mismatch | Hello only; no state access/artifact | `unknown`; no retry |
| `hello-future-operation` | Parent compatibility after correlation | B1 hello advertises operation Protocol v2 | B1 / success | Exact | Hello only; no operation/state effect | Incompatible; send no operation |
| `hello-missing-capability` | Parent compatibility after correlation | Version matches; required operation capability absent | B1 / success | Exact | Hello only; no operation/state effect | Incompatible; send no operation |

### Version and kind

| ID | Stage | Stimulus | Response version / code | Correlation | Dispatch / state effect | Parent treatment |
|---|---|---|---|---|---|---|
| `version-bootstrap-unsupported` | Minimal probe / bootstrap selection | `hello` with unsupported bootstrap version | B1 / `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered exact request ID and `hello` | No dispatch/effect | Hello `error`; no retry |
| `version-submit-unsupported` | Minimal probe / operation selection | Submit with unsupported operation version | B1 / `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered exact request ID and kind | No dispatch/effect | Submit `rejected`; no retry |
| `version-reconcile-unsupported` | Minimal probe / operation selection | Reconcile with unsupported operation version | B1 / `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered exact request ID and kind | No dispatch/effect | Reconcile `unknown`; no retry |
| `version-future-kind-unsupported` | Minimal probe / operation selection | Unregistered future kind with unsupported operation version | B1 / `PROTOCOL_VERSION_UNSUPPORTED` | Safely recovered exact request ID and kind | No dispatch/effect | `unknown`; no retry; version error wins over membership |
| `kind-future-accepted-version` | O1 kind membership | Unregistered future kind with accepted operation version | O1 / `UNKNOWN_KIND` | Safely recovered exact request ID and kind | No dispatch/effect | `unknown`; no retry |
| `kind-response-unsafe` | O1 kind membership / bounded encoding | Request-bound unknown kind cannot fit an echoed response | O1 / `UNKNOWN_KIND` with fixed safe message | Exact request ID; `kind: null` | No dispatch/effect | `unknown`; no retry |

### Response and process

| ID | Stage | Stimulus | Response version / code | Correlation | Dispatch / state effect | Parent treatment |
|---|---|---|---|---|---|---|
| `res-no-lf` | Parent response framing | Bounded body then stdout close without LF | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-crlf` | Parent response framing | Body + CRLF + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-post-lf-space` | Parent response framing | Body + LF + space + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-post-lf-tab` | Parent response framing | Body + LF + tab + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-post-lf-cr` | Parent response framing | Body + LF + CR + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-post-lf-second-lf` | Parent response framing | Body + LF + second LF + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-post-lf-second-frame` | Parent response framing | Body + LF + second frame + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-exact-bound` | Parent framing then Protocol decode | 65,536-byte body + LF + stdout close + exit zero | Decoded response version/code | Protocol rules | May already have occurred | Continue only if decode and correlation succeed |
| `res-over-bound` | Parent response framing | 65,537 bytes before LF | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-bom` | Parent response decode | BOM-prefixed body + LF + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-invalid-utf8` | Parent response decode | Invalid UTF-8 body + LF + stdout/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-valid-zero` | Parent response, correlation, and exit | Valid correlated frame + stdout close + exit zero | Decoded response version/code | Exact | May already have occurred | Semantic classification may proceed |
| `res-valid-nonzero` | Parent process exit | Valid-looking correlated frame + stdout close + nonzero exit | Response is not accepted | Not authoritative | May already have occurred | Transport `unknown`; no retry |
| `res-empty-zero` | Parent response framing | Empty stdout + exit zero | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `res-valid-stdout-open` | Parent stdout-close watchdog | Valid-looking frame; stdout never closes | Response is not accepted | Not authoritative | May already have occurred | Transport `unknown`; no retry |
| `res-valid-process-open` | Parent process-close watchdog | Valid-looking frame + stdout close; process never closes | Response is not accepted | Not authoritative | May already have occurred | Transport `unknown`; no retry |
| `handler-post-dispatch-timeout` | Child post-dispatch watchdog | Handler watchdog expires after dispatch may have begun | B1 / `HANDLER_TIMEOUT` | `null/null` | Dispatch may have begun; effect may exist | `unknown`; no retry |
| `proc-spawn-failed` | Parent spawn | Configured process cannot be spawned | No response | None | No dispatch/effect | Transport `unknown`; no retry |
| `proc-signal-terminated` | Parent process exit | Child terminates by signal | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `proc-abnormal-termination` | Parent process exit | Child terminates abnormally without a valid frame | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `proc-missing-exit-code` | Parent process exit | Process close is observed without an exit code | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `proc-parent-timeout` | Parent lifecycle watchdog | Parent bound expires before required response/process close | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |
| `proc-caller-abort` | Parent caller lifecycle | Caller aborts before completion | No accepted response | Unusable | May already have occurred | Transport `unknown`; no retry |

## Implementation evidence

The shared fixture projection contains every stable ID above exactly once.
Repository checks reject an unlisted or duplicated projection. Each applicable
Rust, TypeScript, plugin, and benchmark test uses the shared runtime registry;
the registry records an ID only after its executable assertion succeeds and
fails completion unless the executed set exactly matches that owner's fixture
projection. The bootstrap-v1 future-operation hello fixture executes through
both Protocol codecs.
Ignored `lib/` directories are rebuilt only as ephemeral declaration/package
evidence and are never candidate source paths.
