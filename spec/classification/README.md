# Current-operation classification

This directory owns Aizign's language-neutral classification contract for the
current operation set.

- [`current-operations.json`](./current-operations.json) is the sole
  normative classification-row authority.
- [`current-operations.schema.json`](./current-operations.schema.json)
  closes the representation and legal composite keys.
- [ADR-0017](../../docs/adr/0017-bound-v0-1-classification-to-current-operations.md)
  records the accepted decision and source-qualified vocabulary.

The corpus is an unversioned build/test input. It is not a runtime service,
shared outcome object, public timing schema, or new compatibility version.

## Current operations

The current v0.1 operation set is exactly:

| Operation | Protocol ownership | Capability requirement |
|---|---|---|
| `hello` | Protocol v1 `hello` request and response schemas | Bootstrap operation; it does not advertise itself |
| `workflow.signal.submit` | Protocol v1 submit request and response schemas | Advertised as `workflow.signal.submit` |
| `workflow.signal.reconcile` | Protocol v1 reconcile request and response schemas | Advertised as `workflow.signal.reconcile` |

A non-hello operation is current only when both its Protocol kind/schema and
advertised capability exist. Anything else must be marked future or
provisional and has no current classification row.

## Source-qualified vocabulary

The corpus keeps these concepts separate:

| Concept | Meaning |
|---|---|
| Server disposition | Handler/server result where an operation supplies one |
| Client outcome | Result exposed after bounded response extraction, decode, and correlation |
| Reconciliation disposition | Pure `accepted`, `conflict`, or `absent` result from a complete trustworthy committed snapshot |
| Child runtime observation | What the child observed and may emit as provisional metadata-only timing |
| Parent transport observation | What the parent observed about the decoded, correlated response |

The same value in two fields does not merge their authorities. A consumer may
use only the projection for its own source.

## Applicability

A semantic row is selected only after all five gates succeed:

1. the caller requested one of the three current operations;
2. exactly one bounded response frame was extracted;
3. the frame decoded as Protocol v1;
4. its body decoded as a response for the requested operation; and
5. every operation-specific correlation check succeeded.

`operation` is the requested operation, not an untrusted response field.

## Closed corpus

The corpus contains exactly 78 rows:

- 6 successful response rows;
- 3 operations × 23 current fixed error codes; and
- 3 operations × one generic well-formed-unrecognized error case.

Each row records:

- `operation`;
- the closed `responseCase`;
- the closed `reportedCode` discriminator;
- source-qualified server, client, reconciliation, child, and parent values;
- `timingCodeDisclosure`; and
- `automaticRetryAuthorized`.

The exact composite key is
`(operation, responseCase.kind, responseCase.disposition-or-none,
reportedCode.kind, reportedCode.value-or-none)`. The schema requires every
legal key exactly once, including when duplicate rows differ in non-key
semantic fields.

All rows set `automaticRetryAuthorized` to `false`. Fixed-code rows permit
metadata-only code disclosure; no-code successes and the generic unrecognized
case do not.

The corpus itself contains the exact row mappings. As a non-normative reading
guide:

- submit recognizes deterministic rejections only for current fixed codes that
  the corpus marks `rejected`; `INTERNAL`, `HANDLER_TIMEOUT`,
  `JOURNAL_OUTCOME_UNKNOWN`, and unrecognized codes remain `unknown`;
- submit `EVENT_CONFLICT` is a client rejection while the child and parent
  observations are source-qualified `conflict`;
- every reconciliation error is `unknown`;
- a correlated hello error is `error` only where its exact row says so; and
- no row authorizes retry.

Protocol short-code syntax remains open:
`^[A-Z][A-Z0-9_]{0,63}$`. Decoder acceptance does not confer fixed membership
or semantic meaning. The non-normative implemented-code index is
[`docs/reference/error-codes.md`](../../docs/reference/error-codes.md).

## Transport faults outside the corpus

These parent-observed faults do not select semantic rows:

| Fault | Client outcome | Parent observation |
|---|---|---|
| `no_response` | `unknown` | `unknown / no_response` |
| `undecodable_response` | `unknown` | `unknown / undecodable_response` |
| `oversized_response` | `unknown` | `unknown / oversized_response` |
| `timeout` | `unknown` | `unknown / timeout` |
| `aborted` | `unknown` | `unknown / aborted` |
| `spawn_failed` | `unknown` | `unknown / spawn_failed` |
| `correlation_mismatch` | `unknown` | `unknown / correlation_mismatch` |

They authorize no retry and permit no server disposition, reconciliation
disposition, or child observation to be inferred. A correlation mismatch may
retain a decoded code as a bounded diagnostic, but disclosure consults only
current fixed-code membership; it never applies that code's semantic row.

Pre-transport encode/local validation failure, `preflight`, an unknown
requested operation, and child `operation_kind: unknown` are also outside the
corpus.

## Consumer rule

Production owners keep only the minimal runtime projection required at their
boundary. Tests in Rust, TypeScript, DSH, CLI, and benchmark normalization read
all 78 language-neutral rows. A consumer must fail closed if fixed membership
or an applicable row is absent; it must not reconstruct a second normative
table.

The Rust and TypeScript Protocol registries own current fixed wire-code
membership only. They do not own operation/outcome mappings and do not narrow
open decoder acceptance.

## Timing lifecycle

Timing is provisional operational evidence, not stable public compatibility.
The corpus constrains safe disclosure and source-qualified observations but
does not own timing field shape, stabilize a schema, reserve vocabulary, or
override client semantics. Observer and sink failures remain isolated from
workflow results.

## Future boundary

Future effect operations and `EFFECT_*` names are not current reservations,
recognition entries, examples, timing values, or compatibility commitments.
Adding one requires a separately accepted proposal with a consumer, authority,
Protocol kind or record shape, and executable tests.

This contract adds no effect runtime, automatic retry, or universal outcome
service.
