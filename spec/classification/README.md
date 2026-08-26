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

## Transitional row authority

The tables in this section are the sole normative classification-row authority
while both `current-operations.json` and its sibling JSON Schema are absent.
They define target semantics; they do not claim that current Rust, TypeScript,
CLI, timing, or benchmark consumers already conform. Those consumers may still
contain duplicated logic and temporary divergences until the Issue #75
implementation slice.

This transitional authority applies only after all of these gates succeed:

1. the caller requested one of the three current operations;
2. exactly one bounded response frame was extracted;
3. the frame decoded as Protocol v1;
4. its body decoded as a response for the requested operation; and
5. every operation-specific correlation check succeeded.

`operation` therefore means the requested operation, not an untrusted response
field. `parentObservation` below is the source-qualified expectation for a
decoded, correlated response. It is not a public timing-schema definition.

Every row in these tables sets `automaticRetryAuthorized` to `false`.
`n/a` means that the named source supplies no such disposition or observation;
it must not be inferred from another column.

### Successful responses

| Operation and response case | Server disposition | Client outcome | Reconciliation disposition | Child observation | Parent observation | Timing code disclosure |
|---|---|---|---|---|---|---|
| `hello` / success `ok` | n/a | `ok` | n/a | `outcome: ok` | `outcome: ok` | n/a (no code) |
| `workflow.signal.submit` / success `accepted` | `accepted` | `accepted` | n/a | `outcome: accepted` | `outcome: accepted` | n/a (no code) |
| `workflow.signal.submit` / success `duplicate` | `duplicate` | `duplicate` | n/a | `outcome: duplicate` | `outcome: duplicate` | n/a (no code) |
| `workflow.signal.reconcile` / success `accepted` | n/a | `accepted` | `accepted` | `outcome: accepted` | `outcome: accepted` | n/a (no code) |
| `workflow.signal.reconcile` / success `conflict` | n/a | `conflict` | `conflict` | `outcome: conflict` | `outcome: conflict` | n/a (no code) |
| `workflow.signal.reconcile` / success `absent` | n/a | `absent` | `absent` | `outcome: absent` | `outcome: absent` | n/a (no code) |

### Error responses and fixed codes

The following list is exhaustive for the 23 implemented stable codes in this
revision. For `workflow.signal.submit`, the first 20 rows are deterministic
client rejections. A Protocol error response supplies no submit server
disposition. `EVENT_CONFLICT` remains client `rejected`, while the
target child and parent timing observations use `conflict`. The final three
rows are unknown outcomes. For `workflow.signal.reconcile`, every error row is
client, child, and parent `unknown`; no reconciliation disposition exists.
Safe timing disclosure is `true` for every fixed code listed here. Disclosure
means only that the bounded code string may be copied to metadata-only timing;
it proves neither correlation nor any semantic classification.

| Fixed code | Submit server | Submit client | Submit child | Submit parent | Reconcile client / child / parent | Timing disclose |
|---|---|---|---|---|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `INVALID_ENVELOPE` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `UNKNOWN_KIND` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `INVALID_PAYLOAD` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `REQUEST_TOO_LARGE` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `CAPABILITY_UNSUPPORTED` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `INVALID_EXPECTATION` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `INVALID_SIGNAL` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `WORKFLOW_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `ASSIGNMENT_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `ATTEMPT_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `ROLE_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `REVISION_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `CANDIDATE_DIGEST_MISMATCH` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `EVENT_CONFLICT` | n/a | `rejected` | `conflict` | `conflict` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_UNAVAILABLE` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_CORRUPT` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_SCHEMA_UNSUPPORTED` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_LOCKED` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_BOUND_EXCEEDED` | n/a | `rejected` | `rejected` | `rejected` | `unknown` / `unknown` / `unknown` | `true` |
| `INTERNAL` | n/a | `unknown` | `unknown` | `unknown` | `unknown` / `unknown` / `unknown` | `true` |
| `HANDLER_TIMEOUT` | n/a | `unknown` | `unknown` | `unknown` | `unknown` / `unknown` / `unknown` | `true` |
| `JOURNAL_OUTCOME_UNKNOWN` | n/a | `unknown` | `unknown` | `unknown` | `unknown` / `unknown` / `unknown` | `true` |

For a decoded and correlated `hello` error, `INTERNAL`, `HANDLER_TIMEOUT`,
`JOURNAL_OUTCOME_UNKNOWN`, and a well-formed unrecognized code produce client,
child, and parent `unknown`. Any of the other 20 fixed codes produces client
`error` and child and parent `error`. There is no server or reconciliation
disposition for a `hello` error.

A well-formed unrecognized error code supplies no submit server disposition and
produces `unknown` for the submit client, child, and parent. It also produces
client, child, and parent `unknown` for reconciliation. It may be retained as a
bounded control-plane
`reportedCode`, but `timingCodeDisclosure` is `false`. A no-code success row
has no code to disclose (`false`/not applicable). A future name, including any
`EFFECT_*` name, has no row.

Protocol error-code membership remains open. The syntax
`^[A-Z][A-Z0-9_]{0,63}$` permits a peer to report a well-formed code that this
revision does not recognize. Decoder acceptance does not confer classification
meaning.

## Future corpus shape and row selection

The Issue #75 implementation slice will add `current-operations.json` and a
sibling JSON Schema. The corpus applies only after the five gates above. It
must encode the transitional rows without changing their semantics.

Each row must contain at least these fields:

| Field | Required meaning |
|---|---|
| `operation` | The requested current operation |
| `responseCase` | A closed success or error discriminator as defined below |
| `reportedCode` | A closed no-code, fixed-code, or well-formed-unrecognized discriminator |
| `serverDisposition` | The source-qualified server value, or explicit not applicable |
| `clientOutcome` | The source-qualified semantic result exposed by the client |
| `reconciliationDisposition` | `accepted`, `conflict`, or `absent` for successful reconciliation, or explicit not applicable |
| `childObservation` | The child source field and value, or explicit absence |
| `parentObservation` | The decoded, correlated parent source field and value, or explicit absence; not a public timing schema |
| `timingCodeDisclosure` | Whether that exact current fixed code may be copied to metadata-only timing |
| `automaticRetryAuthorized` | `false` for every current row |

`responseCase` is a closed tagged object. It is either `success` plus exactly
one operation-specific disposition (`hello`: `ok`; submit: `accepted` or
`duplicate`; reconcile: `accepted`, `conflict`, or `absent`) or `error` with no
disposition. `reportedCode` is a closed tagged object: `none`, `fixed` plus one
of the 23 exact codes above, or `wellFormedUnrecognized` with no code value.
A success case requires `none`; an error case requires `fixed` or
`wellFormedUnrecognized`.

The exact uniqueness key is
`(operation, responseCase.kind, responseCase.disposition-or-none,
reportedCode.kind, reportedCode.value-or-none)`. Exactly one row must exist for
every legal key and duplicate keys are forbidden. The schema must close all
objects, reject wildcard rows, reject illegal operation/disposition/code
combinations, and reject future code names.

The schema may add validation metadata needed to close the representation, but
it must not turn the corpus into a general classification framework or add a
new public version axis. The unversioned location follows current operation
support; Protocol, journal, store, and package versions retain their existing
independent lifecycles.

### Transport faults outside the corpus

The semantic corpus does not select rows for these parent-observed faults:

| Closed fault | Client outcome | Parent observation | Inference allowed |
|---|---|---|---|
| `no_response` | `unknown` | `unknown / no_response` | none |
| `undecodable_response` | `unknown` | `unknown / undecodable_response` | none |
| `oversized_response` | `unknown` | `unknown / oversized_response` | none |
| `timeout` | `unknown` | `unknown / timeout` | none |
| `aborted` | `unknown` | `unknown / aborted` | none |
| `spawn_failed` | `unknown` | `unknown / spawn_failed` | none |
| `correlation_mismatch` | `unknown` | `unknown / correlation_mismatch` | none |

Every fault authorizes no retry and permits no server disposition,
reconciliation disposition, or child observation to be inferred. A correlation
mismatch may retain a code decoded from the uncorrelated response as a bounded
diagnostic. Code disclosure for that diagnostic may consult only the safe
projection `(requested operation, fixed code)` from the table above; it must
never apply the semantic row for that code.

A pre-transport encode or local validation failure produces no client outcome
under this contract and is outside the corpus. `preflight`, an unknown
requested operation, and a child `operation_kind: unknown` are also outside.
`hello` is inside when all applicability gates succeed.

## Authority sunset and fail-closed rules

The change that adds both JSON files must also either delete the normative
tables above or mark a retained Markdown rendering explicitly non-normative and
generated from the JSON corpus. At that point the JSON corpus is the sole row
authority. CI must reject any revision containing both a normative Markdown
row table and the corpus/schema pair.

- A missing operation row, missing code row, unsupported combination, or
  unrecognized peer code cannot imply success, deterministic rejection, or
  retry authorization.
- Every semantic row and every transport fault sets
  `automaticRetryAuthorized` to `false`.
- Timing may disclose a code only when the exact fixed code appears in the safe
  disclosure projection. Disclosure never supplies correlation or semantics.

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
