# ADR-0017: Bind v0.1 classification to current operations

- Status: Accepted
- Date: 2026-08-26
- Acceptance: [Maintainer decision for Issue #75, comment `5421537099`](https://github.com/TakahisaI/Aizign/issues/75#issuecomment-5421537099)
- Related: ADR-0002, ADR-0003, ADR-0013, Issue #75, Issue #87, Issue #88, Issue #89

## Context

The v0.1 documentation and implementations accumulated classifications in
several places. Rust CLI timing, TypeScript clients, benchmark normalization,
and Protocol documentation each carried a table or allowlist. Those copies can
disagree even when each one is internally consistent. In particular, submit
`INTERNAL` was treated as a rejection on one observation surface while the
client contract treated it as unknown.

The same material also described future effect intent, claim, result, and
`EFFECT_*` vocabulary as though those concepts were current. No current
Protocol kind, capability, journal record, consumer, or tested state machine
implements that flow. Keeping speculative names in current recognition would
turn them into compatibility commitments before their authorities exist.

The contract must be narrowed before classification ownership is consolidated.
Issue #75 therefore has a contract-only slice followed by the ownership work in
Issues #87, #88, and #89 and then a separate Issue #75 implementation slice.

## Decision

Current v0.1 operations are exactly:

- `hello`;
- `workflow.signal.submit`; and
- read-only `workflow.signal.reconcile`.

`hello` is the bootstrap operation. A non-hello operation is current only when
Protocol v1 owns its request and response kind/schema and the serving binary
advertises the matching `hello.capabilities` entry. A document must mark any
operation that does not meet those conditions as future or provisional; it
must not describe it as implemented or compatible.

Create an unversioned classification authority under
[`spec/classification/`](../../spec/classification/README.md). The later
implementation slice will add
`spec/classification/current-operations.json` and a sibling JSON Schema. The
unversioned directory is intentional: classification follows the set of
current operations and does not create another public protocol, journal, store,
or package version axis.

Until both JSON files exist, the normative transitional tables in the
classification README are the sole classification-row authority. They
enumerate every current fixed code and the generic well-formed-unrecognized
case for each operation, plus every successful response case. This closes the
authority gap without adding corpus data or changing consumers in the
contract-only slice. The tables define target semantics and do not claim that
current consumers conform.

The future corpus and schema own cross-language classification rows only after
the caller requested a current operation, extracted exactly one bounded frame,
decoded Protocol v1, decoded an operation-specific response body, and passed
all operation-specific correlation checks. `operation` is the requested
operation, not a response field. Each row must identify at least:

- `operation`;
- `responseCase`, a closed discriminator for `error` or for `success` with one
  operation-specific disposition: `hello` `ok`, submit `accepted` or
  `duplicate`, or reconciliation `accepted`, `conflict`, or `absent`;
- `reportedCode`, using an explicit discriminator for no code, one implemented
  fixed code, or the generic well-formed-unrecognized case rather than naming
  a speculative future code;
- `serverDisposition`, with an explicit not-applicable representation where
  the server does not supply one;
- `clientOutcome`;
- `reconciliationDisposition`, with an explicit not-applicable representation
  outside a successful reconciliation;
- `childObservation`, including the source field and value or an explicit
  absence;
- `parentObservation`, including the parent transport field and value or an
  explicit absence for a decoded and correlated response, and not defining a
  public timing schema;
- `timingCodeDisclosure`, a boolean that says whether the reported fixed code
  may cross the metadata-only timing boundary; and
- `automaticRetryAuthorized`, which is `false` for every current row.

Success requires `reportedCode: none`; error requires either one current fixed
code or the generic well-formed-unrecognized discriminator. The exact row key
is `(operation, responseCase.kind,
responseCase.disposition-or-none, reportedCode.kind,
reportedCode.value-or-none)`. Exactly one row must exist for every legal key.
The schema closes every object and rejects duplicate keys, wildcard rows,
illegal operation/disposition/code combinations, and future code names.

The change that adds the corpus and schema must also delete the normative
manual tables or retain them only as an explicitly non-normative projection
generated from the JSON. JSON then becomes the sole row authority, and CI must
reject simultaneous normative Markdown tables and a corpus/schema pair.

Protocol schemas and the Protocol specification continue to own wire shapes,
bounds, kinds, and error-code syntax. The error-code grammar has open
membership: a syntactically valid code need not be registered or recognized.
The classification corpus does not narrow decoder acceptance.

Use source-qualified concepts rather than one universal outcome:

- **server disposition** is the handler/server result, where the operation has
  one;
- **client outcome** is the result exposed after bounded decode and correlation;
- **reconciliation disposition** is the pure `accepted`, `conflict`, or
  `absent` result from a complete trustworthy snapshot;
- **child runtime observation** is what the child process observed and may emit
  as provisional metadata-only timing; and
- **parent transport observation** is what the parent observed about process
  transport, decode, and correlation.

The same word appearing in two sources does not make the sources equivalent.
The corpus is a build/test input, not a runtime outcome service, shared domain
object, or new application boundary.

Classification fails closed. A missing operation row, missing code row,
unsupported combination, or well-formed unrecognized peer code cannot be
promoted to success, deterministic rejection, or retry authorization. For
submit, `INTERNAL` and a well-formed unrecognized code produce client outcome
`unknown` and authorize no retry. For reconciliation, every error response
produces client outcome `unknown`. Submit `EVENT_CONFLICT` remains a client
rejection while its target child and parent timing observations are
source-qualified `conflict`. For a correlated `hello` error, `INTERNAL`,
`HANDLER_TIMEOUT`, `JOURNAL_OUTCOME_UNKNOWN`, and a well-formed unrecognized
code are unknown; the other current fixed codes are client `error`.

No response, undecodable response, oversized response, timeout, abort, spawn
failure, and correlation mismatch are a separate closed transport-fault set,
not semantic corpus rows. Each produces client and parent `unknown`, authorizes
no retry, and permits no server, reconciliation, or child inference. A
correlation mismatch may retain a decoded code as a diagnostic, but timing
disclosure may consult only the safe `(requested operation, fixed code)`
projection and must not apply that code's semantic row. Pre-transport encode
or validation failures, `preflight`, unknown requested operations, and child
`operation_kind: unknown` are also outside the corpus. `hello` remains inside
when all applicability gates pass.

A well-formed unrecognized code is retained only where a control-plane
diagnostic field allows it and is omitted from timing code disclosure. Safe
fixed-code disclosure copies only a bounded string; it proves neither
correlation nor semantic classification.

Future effect operation and `EFFECT_*` names are not current reservations,
recognition entries, examples, timing values, or compatibility commitments.
They may return only through a separately accepted future proposal that names
a consumer and authority and adds a kind or record shape plus tests. This
decision adds neither an effect runtime nor automatic retry.

Timing is provisional operational evidence, not a stable public compatibility
contract. The future corpus may constrain which current fixed codes are safe
to disclose in timing, but it does not stabilize the timing schema, reserve
future vocabulary, or make timing an authority for semantic outcomes.

This ADR partially supersedes ADR-0002 only where that ADR describes effect
intent or effect claim as current scope. ADR-0002's Rust implementation choice,
`no_std`, dependency isolation, functional-core shape, and other accepted
decisions remain in force.

## Consequences

### Positive

- Current compatibility claims are mechanically bounded by existing schemas
  and advertised capabilities.
- One later language-neutral corpus can drive Rust, TypeScript, CLI, timing,
  and benchmark regression tests without inventing a universal outcome model.
- Unknown peer behavior remains non-retryable and cannot silently become
  rejection or success.
- Future effect design remains possible without constraining Protocol v1 or a
  current public API prematurely.

### Negative / Risks

- The contract-only slice intentionally lands before the corpus, schema, and
  consumers. Existing consumers may temporarily duplicate or diverge from the
  new contract until the ordered implementation slice completes.
- The normative transitional table must be removed or demoted to a generated,
  non-normative projection in the same change that introduces the JSON
  authority.
- The corpus must represent source-specific fields explicitly, which is more
  verbose than a single overloaded outcome column.
- The unversioned authority requires contract review when the current operation
  set changes; it cannot be treated as an independently versioned public API.

### Follow-up

Apply the order: Issue #75 contract decision, then Issues #87, #88, and #89,
then the Issue #75 implementation. The implementation slice must add the corpus
and schema, delete or demote the normative transitional table, migrate or
delete manually synchronized language-specific tables, add the one-authority
CI check, and make Rust, TypeScript, CLI, timing, and benchmark tests consume
the same rows.

Required regression evidence must prove that:

- submit `INTERNAL` and the generic well-formed-unrecognized case are unknown
  and non-retryable on every applicable surface;
- every reconciliation error is a client unknown;
- every legal response key has exactly one row and no transport fault selects
  a semantic row;
- an unrecognized code is omitted from timing code disclosure;
- a future effect name fails current-recognition allowlists; and
- no current operation lacks both Protocol schema ownership and, except for
  `hello`, an advertised capability.

Until that implementation lands, documentation must state the temporary
consumer divergence rather than claim corpus-driven runtime behavior.

## Alternatives considered

- **Keep manually synchronized language-specific tables.** Rejected because
  the observed submit `INTERNAL` contradiction is exactly the failure mode of
  duplicated ownership.
- **Add the corpus and consumers in this PR.** Rejected because this is the
  contract-only slice and Issues #87--#89 must first leave single engine,
  observation, and transport owners.
- **Version classification as `v1`.** Rejected because that would create a new
  public version axis unrelated to the Protocol, journal, or store lifecycle.
- **Create a universal outcome service or shared runtime abstraction.**
  Rejected because source-qualified observations have different authorities
  and this decision requires only a language-neutral test corpus.
- **Reserve future effect names now.** Rejected because no current consumer,
  kind, record, authority, or state machine gives those names compatibility
  meaning.
