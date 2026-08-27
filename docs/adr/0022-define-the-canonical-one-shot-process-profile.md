# ADR-0022: Define the canonical one-shot process profile

- Status: Accepted
- Date: 2026-08-27
- Related: ADR-0003, ADR-0008, ADR-0017, ADR-0018, ADR-0020, Issue #74, Issue #76
- Accepted direction: [Issue #76 proposal v2](https://github.com/TakahisaI/Aizign/issues/76#issuecomment-5433596995), amended by [`P76-2B5F596-A1`](https://github.com/TakahisaI/Aizign/issues/76#issuecomment-5433690828)
- Acceptance: [Maintainer contract decision](https://github.com/TakahisaI/Aizign/issues/76#issuecomment-5433916066)
- Implementation checkpoint: [`I76-5A6EB92-A`](https://github.com/TakahisaI/Aizign/issues/76#issuecomment-5435352486)
- Readiness: [S1 authorization](https://github.com/TakahisaI/Aizign/issues/76#issuecomment-5435551080)

## Context

ADR-0003 selected a versioned NDJSON one-shot subprocess boundary, but it did
not close the complete adapter process lifecycle. The serving CLI accepts an
EOF-terminated JSON value without LF, while the TypeScript production client
uses direct `aizign hello` without request correlation and uses framed
`handle` for the other operations. Input after LF, stdin close, response
close/exit, watchdog stages, and bootstrap-versus-operation version selection
also lacked one owner.

These gaps allow invalid transport input to reach a durable operation and let
different clients implement incompatible preflight and framing rules. The
process contract must be fixed before outbound validation and broader adapter
work build on it.

## Decision

Adopt [`CLI process profile v1`](../../spec/process/v1/README.md) as the sole
normative adapter/core process profile.

- The configured executable is spawned without a shell and with exactly
  `handle --state <stateDir>` for `hello`, submit, and reconcile.
- Every adapter operation sends one BOM-free UTF-8 JSON body, one LF, and then
  closes stdin. The child proves the LF, the body bound, and immediate EOF
  before Protocol dispatch.
- The body limit is 65,536 bytes and excludes LF. CRLF and every byte after LF
  are outside the profile.
- Framing errors and pre-dispatch read timeouts use the stable bootstrap-v1
  error representation with null correlation and cannot initialize state or
  dispatch an operation.
- A watchdog after dispatch may follow an effect, so it remains `unknown` and
  never authorizes retry.
- The child emits one bounded response body plus LF, closes stdout, and exits.
  Framing, process-close, exit, spawn, signal, timeout, and abort faults remain
  parent transport `unknown`.
- Framed `hello` uses exact request ID and kind correlation and never touches
  the configured state path. Direct `aizign hello` remains provisional
  operator diagnostics only and is not an adapter preflight profile.
- Bootstrap envelope version, advertised operation Protocol version, and CLI
  process-profile version are separate axes. Bootstrap-v1 hello and
  pre-operation errors form a stable subset that future operation versions
  reference rather than redefine.
- A syntactically valid `hello` kind selects the bootstrap version axis. Every
  other syntactically valid kind selects the operation version axis before
  kind membership is checked.
- A correlation value is echoed only when the complete response remains
  bounded. Unsafe long values become null and are not copied into diagnostics.
- Stderr remains payload-free, metadata-only operational diagnostics and has
  no Protocol, correlation, classification, compatibility, or retry authority.

The process profile owns argv and process lifecycle around Protocol JSON
bodies. Protocol schemas continue to own wire bodies and codes. The
classification corpus continues to own operation-qualified semantic outcomes;
this ADR adds no outcome or retry policy.

## Partial supersession of ADR-0003

This ADR supersedes only ADR-0003's direct `hello` adapter-preflight decision
and its incomplete adapter argv, framing, version-selection, and
process-lifecycle portions. ADR-0003's subprocess boundary, independent
language implementations, closed Protocol, stdout/stderr separation, and
no-daemon decisions remain Accepted.

ADR-0003 links back to this bounded supersession. Its historical decision text
is not silently rewritten.

## Current implementation transition

This ADR and the process specification establish the target contract. The
current CLI, DSH client, adapter-testkit fake core, benchmark proxy, and their
tests still contain the old direct-hello and permissive framing behavior.
Issue #76 S2 owns their atomic migration. Until S2 lands, documentation must
not describe those consumers as profile-v1 conforming.

## Implementation note — 2026-08-27

Issue #76 S2 migrated the Rust CLI, Protocol codecs, DSH production client,
adapter-testkit fake executable, benchmark runner v7, and their shared
fixtures to process profile v1. The executable evidence is projected from the
stable case inventory in [`spec/process/v1/fixtures/cases.json`](../../spec/process/v1/fixtures/cases.json);
the Markdown specification remains the sole normative owner.

## Consequences

### Positive

- Adapter preflight and operations share one correlated process path.
- Invalid or unterminated input cannot reach state initialization or dispatch.
- Old bootstrap-v1 clients can decode a stable discovery/error representation
  before rejecting a future operation version.
- Process faults remain source-qualified `unknown` and non-retryable.

### Negative / Risks

- The child must wait for EOF before dispatch, so clients must close stdin and
  the watchdog must include the whole read phase.
- Future operation clients must retain the bootstrap-v1 pre-operation error
  decoder.
- Tightening post-LF and process-close acceptance requires coordinated CLI,
  TypeScript, fake-core, benchmark, fixture, and documentation changes in S2.

## Follow-up

- Issue #76 S2 implements and proves the profile across all current consumers.
- Issue #77 owns outbound value closure and complete cross-language lexical and
  decode precedence without changing this version selector.
- Issue #78 owns its accepted environment and capability boundary. Cwd,
  relative-path qualification, and executable discovery remain unsupported
  until a later accepted contract names an owner.
- Issue #83 owns any stable operator diagnostic taxonomy.
- Issue #86 remains the process-tree ownership boundary.

## Alternatives considered

- **Keep direct hello and framed operations as interchangeable profiles.**
  Rejected because correlation, version handling, and lifecycle would retain
  two production authorities.
- **Dispatch after LF without waiting for EOF.** Rejected because trailing
  input or a second frame could be discovered only after an effect.
- **Treat every version as one axis.** Rejected because an old client could be
  unable to decode the error or discovery response needed to report
  incompatibility.
- **Add a daemon, socket, or universal runtime.** Rejected as unrelated scope
  that would expand lifecycle and ownership before the one-shot profile is
  closed.
