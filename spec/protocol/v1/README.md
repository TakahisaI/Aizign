# Aizign Protocol v1

Protocol v1 owns the JSON request/response bodies, shapes, kinds, and codes.
The surrounding argv, LF, stdin/stdout/EOF/exit/watchdog lifecycle, bootstrap
selection, and process faults are owned by the
[CLI process profile v1](../../process/v1/README.md).

Each request/response JSON body is at most `65536` bytes
(`MAX_FRAME_BYTES`). The constant excludes the required terminating LF. The
canonical process stream is one body + one LF + immediate EOF/close; CRLF and
every byte after LF are outside process profile v1.

- the child validates the complete request stream through EOF before Protocol
  dispatch; framing failure creates no state artifact or append
- the parent accepts process framing only after one bounded response body, LF,
  stdout close, and process close; any framing or lifecycle fault is `unknown`
- the client correlates response `requestId` / `kind` / (for signal success)
  `eventId`; mismatch is `unknown`

The current CLI and TypeScript consumers implement this framing and use the
same canonical correlated `handle` path for hello and operations.

```text
adapter ──(request frame)──▶ aizign handle --state <dir> ──(response frame)──▶ adapter
                                     │ stderr: payload-free, metadata-only diagnostics
```

## Bootstrap subset and version selection

These version axes are independent even though their current values are all
`1`:

- CLI process profile v1 owns the process lifecycle and is not a wire field;
- bootstrap envelope v1 owns framed hello and pre-operation error
  representation; and
- operation Protocol v1 is advertised by hello and used by accepted submit and
  reconcile operations.

The bootstrap-v1 envelope, hello, and pre-operation error schemas in this
directory form an independently stable subset. A future operation Protocol
version references rather than redefines that subset, so a bootstrap-v1 client
can decode discovery or an incompatibility response before it attempts a
future operation payload.

After process framing succeeds, exact syntactically valid `kind: "hello"`
selects the bootstrap version axis. Every other syntactically valid kind
selects the operation version axis before registry membership is checked. An
unsupported version returns a bootstrap-v1 `PROTOCOL_VERSION_UNSUPPORTED`;
an accepted operation version plus an unknown kind returns that operation
version's `UNKNOWN_KIND`. The complete response-version and correlation table
is normative in the [process profile](../../process/v1/README.md).

## Version-independent lexical and decode pipeline

[ADR-0023](../../../docs/adr/0023-define-protocol-lexical-and-outbound-validation-boundaries.md)
makes the number-token rule a Protocol-family compatibility invariant rather
than a current-v1 parser detail. Every JSON number token anywhere in a frame
must use exactly `0` or `-?[1-9][0-9]*`. Decimal notation, exponent notation,
and `-0` are rejected even in an otherwise unsupported future-version frame.
A future version must use another representation or supersede ADR-0023 before
accepting another number spelling.

After the process-profile stream gate, request and response decoding proceeds
in this order:

```text
0. process-profile body + LF + immediate-EOF gate (outside Protocol decoding)
1. direction-specific frame-body byte bound
2. BOM-free UTF-8 and complete JSON lexical grammar
3. one source-order raw-token scan for duplicate members, Unicode scalars,
   and canonical integer tokens
4. minimal top-level envelope and correlation probe
5. process-profile request kind-axis or response-version selector
6. envelope-version decision and request-failure response-version selection
7. accepted-version closed envelope and kind-specific body decoding
```

No typed bootstrap/current-operation request or response envelope may be
decoded before the applicable version is accepted. The raw-token scan retains
canonical integer source text losslessly: it must not pass through `f64`,
JavaScript `Number`, or another imprecise representation before version
selection. An arbitrarily long canonical payload integer is therefore
lexically valid. Current-v1 bounds apply only after current v1 is accepted.

Failure precedence at this layer is normative:

- a non-canonical number in an envelope field or outside the top-level
  `payload` is `INVALID_ENVELOPE`;
- a non-canonical number below the top-level `payload` is `INVALID_PAYLOAD`;
- those lexical failures precede `PROTOCOL_VERSION_UNSUPPORTED`;
- a canonical envelope version outside `0..=4294967295` is
  `INVALID_ENVELOPE` before selection;
- a canonical in-range unsupported selected-axis version is
  `PROTOCOL_VERSION_UNSUPPORTED`; and
- a canonical payload integer receives its field-specific range error only
  after the applicable version is accepted. Under an unsupported version the
  same token does not receive a current-v1 payload error.

Within the single raw scan, the first offending duplicate, member/string
Unicode defect, or non-canonical number in source order fixes the code. A
best-effort correlation probe may still recover diagnostic values when the
token stream is readable enough, but it cannot replace that earlier failure.

The minimal request probe requires only a top-level object, exact
`protocol: "aizign"`, a present Unicode-scalar string `kind`, a canonical
`u32` version token, and best-effort `requestId` recovery. Registry membership
is later: `hello` selects the bootstrap axis and every other syntactically
valid kind selects the operation axis. The minimal response probe does not
require current-version `ok`, payload/error shape, closed membership, or a
non-null kind before the process-profile selector accepts bootstrap v1 or the
applicable operation version.

Correlation recovery uses the final readable top-level spelling. `requestId`
is retained only when it is a Unicode-scalar string matching its Protocol
pattern. `kind` is retained when it is a Unicode-scalar string; registration
is not required, and response `null` remains `null`. A duplicate-member failure
still uses the final readable spelling as its diagnostic candidate. A Unicode
defect confined to ignored nested payload/error data does not suppress valid
top-level correlation, but a defect in a top-level key or probed field does.
Bound, BOM/UTF-8, and wholly unreadable JSON failures recover neither value.

A future/unregistered non-hello kind with an unsupported operation version is
`PROTOCOL_VERSION_UNSUPPORTED`; the same kind under an accepted operation
version is `UNKNOWN_KIND`. Lexically valid future-version frames are not
current-v1-decoded merely to find missing `ok`, unknown fields, invalid current
payloads, or malformed nested errors. Unsupported version wins over those
version-specific defects. Lexical defects still win over unsupported version.

## Envelope

| Field | Request | Response |
|---|---|---|
| `protocol` | `"aizign"` | `"aizign"` |
| `version` | `1`（許容rangeは `0..=4294967295`。範囲外は `INVALID_ENVELOPE`） | 同左 |
| `requestId` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | requestの値をecho（同じpattern）。復元できなければ `null` |
| `kind` | 登録済みkind | requestの値をecho。復元できなければ `null` |
| `payload` | kindごとのclosed object | `ok: true` のときだけ |
| `ok` | — | `true` / `false` |
| `error` | — | `ok: false` のときだけ。`{ "code", "message" }` |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `INVALID_ENVELOPE` / `INVALID_PAYLOAD`
- **受理集合はJSON Schemaが正**: [`schemas/`](schemas/) とRust / TS decoderは同じ集合を受理する。一致は `spec/conformance` の全fixture（`.expect.json` の `schema` 判定）とexampleをschemaに通すgate（[`spec/test/schema.test.mjs`](../../test/schema.test.mjs)）がCIで検証する
- schemaが表現できず **decoderだけが拒否する規則は4つ**（fixtureでは `schema: true` と記録する）
  - frameのsize bound（`MAX_FRAME_BYTES`）→ `REQUEST_TOO_LARGE` / `INVALID_ENVELOPE`
  - **整数の字句表現**（下記）
  - **duplicate member**（下記）
  - **well-formed Unicode**（下記）
- frame bytesは **BOMなしUTF-8** とする。不正UTF-8と先頭のUTF-8 BOM（`EF BB BF`）はJSONとして解釈せず `INVALID_ENVELOPE`。string入力も先頭のU+FEFFを許さない。process clientはstdoutをframe抽出・decode完了までbyte列として保持し、canonical process profileでは終端LF後のbyteを一切許さず、stdout closeとprocess closeまで確認する
- 整数fieldのwire表現は上記のversion-independentなcanonical tokenだけを許す。JSON SchemaはJSON data modelしか見ないためこのsource-spelling規則を表現できず、両decoderはtyped decode前のraw-token層で検査する
- envelope `version` の整数rangeは `0..=4294967295`（`PROTOCOL_VERSION` の型 `u32` に由来）。canonical source textをlosslessにrange-checkし、range外は `PROTOCOL_VERSION_UNSUPPORTED` ではなく **`INVALID_ENVELOPE`**
- **同一object内でmember名の重複は拒否**（`INVALID_ENVELOPE`、journalは `JOURNAL_CORRUPT`）。`"a"` と `"\u0061"` のようにescape表記が違っても、decode後の名前が同じなら重複とする。streaming parserとfolding parserで意味が分れるため、どの階層でも契約の外。schema外のlexical ruleとして両decoderが走査し、相関データ（`requestId` / `kind`）は最後の表記から復元する
- object member名とstring valueは **Unicode scalar sequence** でなければならない。`"\uD800"` のようなlone UTF-16 surrogateは `INVALID_ENVELOPE`。JSON SchemaはJavaScript上のill-formed stringを区別しないため、両decoderが全string tokenを検査する
- optional fieldは **省略** する。`null` は許可しない
- `message` は人向けの説明で、request本文を含めない。機械判定は `code` だけで行う
- 互換性はpackage versionではなく `version` と `hello` の `capabilities` で判定する

## Outbound frame contract

For each direction and language, the public production frame encoder is the
only API that both validates an outbound Protocol value and returns a JSON
body. The current names are Rust `encode_request` / `encode_response` and
TypeScript `encodeRequest` / `encodeResponse`. Payload mappers are internal
implementation helpers and are not supported production exports.

An encoder validates the complete source value before serialization,
constructs exactly one fresh closed wire graph, serializes that graph once,
checks that the result is one non-empty BOM-free UTF-8 JSON object with no raw
CR/LF, and finally checks the direction-specific body bound. It returns only
the body. The process profile owns the terminating LF and all transport and
process lifecycle.

Request encoding accepts exactly `hello`, submit, and reconcile and selects
bootstrap v1 for `hello` and the current operation version for the two
operations. Response encoding consumes and validates the response-version
context selected by the process-profile path. It must not infer a stage from
the response body or assume bootstrap and operation constants stay numerically
equal. Success kind/body pairs are exactly hello/`HelloInfo`, submit/
`SignalResult`, and reconcile/`ReconciliationResult`. An error kind may be
`null` or any Unicode-scalar string; registry membership is not required.

The request source mappings are exact: `hello` has no source payload member;
submit has exactly one submit payload; and reconcile has exactly one reconcile
payload. For success responses, `kind` is the exact registered kind matching
the body variant. A non-null response `requestId` and `kind` are validated here,
but equality with a sent request remains client correlation because the frame
encoder has no sent-request context. The same applies to equality between a
success result event ID and the sent signal.

The response encoder does not repair source data. It never truncates a kind,
request ID, or message; replaces correlation with `null`; substitutes a code;
manufactures a fallback; changes the selected version; or retries through
another serializer. A bounded fallback, including an ADR-0022 null-kind
fallback, is constructed by the process-profile producer first and then passes
through this same encoder as supplied.

Local outbound failures use only existing stable codes:

| Failure | Local code |
|---|---|
| invalid request ID; invalid response correlation syntax; success kind/body mismatch; invalid response-version context; malformed error object/code/message; other envelope-source failure | `INVALID_ENVELOPE` |
| unregistered request kind or unregistered successful-response kind | `UNKNOWN_KIND` |
| known-kind payload shape; invalid `HelloInfo`; invalid success result shape/value; payload non-finite/non-integer/out-of-range value | `INVALID_PAYLOAD` |
| semantically invalid expected assignment value | `INVALID_EXPECTATION` |
| semantically invalid signal value or conditional-field matrix | `INVALID_SIGNAL` |
| encoded request body exceeds 65,536 bytes | `REQUEST_TOO_LARGE` |
| encoded response body exceeds 65,536 bytes | `INVALID_ENVELOPE` |

`HelloInfo` validation includes both version bounds, capability syntax, byte
length and uniqueness, closed package shape, and well-formed strings. Error-
code validation remains syntactic and does not require fixed-code membership.

### TypeScript source-value closure

Static TypeScript types are not runtime validation evidence. A closed DTO
object must have exactly `Object.prototype` or `null` as its prototype. Its
complete own-key set, including non-enumerable strings and symbols, is checked;
known present fields must be own data properties. Unknown keys, symbols,
accessors, inherited required fields, and present optional fields whose value
is `undefined` are rejected without invoking code.

A closed DTO array must have exactly `Array.prototype`; own only `length` and
canonical indexes `0..length - 1`; and contain an own data property at every
index. Holes, accessors, undefined elements, extra string/non-enumerable/symbol
properties, and array subclasses are rejected. Elements are checked in
ascending index order. Source `toJSON` properties and custom-prototype
serialization behavior have no authority and are never invoked; only the
fresh internal wire graph is serialized.

At every Protocol integer source field, `NaN`, infinities, non-integers,
out-of-range values, and `Object.is(value, -0)` are rejected before
serialization. `bigint`, functions, symbols, cycles, other non-JSON values,
and lone UTF-16 surrogates are also rejected rather than omitted or coerced.
Negative zero receives the location-specific code: `INVALID_ENVELOPE` for an
envelope field and `INVALID_PAYLOAD` for payload, result, or `HelloInfo`.

The sole non-plain TypeScript source exception is one authentic, non-subclass
`ProtocolError` created through the package public construction boundary. A
plain `{ code, message }` lookalike, another `Error`, a subclass, or a custom-
prototype imitation is rejected. The encoder revalidates `code` then `message`
as present own data properties without invoking accessors; missing, inherited,
wrongly typed, malformed, or accessor-backed values fail with
`INVALID_ENVELOPE`. Only those fields enter the wire error object. `name`,
`stack`, `cause`, custom metadata, and source `toJSON` are ignored as runtime
metadata and never copied or invoked. The authenticity/branding mechanism is
implementation-private, but a structural or `instanceof`-only check must not
broaden the accepted set.

### `ProtocolError` construction

A successfully constructed `ProtocolError` contains the exact syntactically
valid caller/peer code matching `^[A-Z][A-Z0-9_]{0,63}$`; current fixed-code
membership is not required. Malformed raw construction fails locally and is
never normalized to `INTERNAL`. Rust raw-text construction is fallible and an
already validated short code may use an infallible path. TypeScript
`new ProtocolError(code, message)` throws `TypeError` for malformed code. A
wire decoder or response encoder validates an observable raw/forged code
before constructing the error and reports `INVALID_ENVELOPE` when malformed.

### Total local failure order

At each reached object/array node, validate container/prototype, complete key
set, and data-property descriptors before child fields. Arrays use ascending
index order. Earlier stages win independently of insertion order, Rust layout,
or serializer traversal.

Request order:

1. root closure;
2. `requestId` presence, type, Unicode, syntax, and bound;
3. `kind` presence/type, then registry membership;
4. kind/source-variant mapping;
5. payload structural closure;
6. payload semantics;
7. fresh wire construction and encoded postconditions; and
8. request body bound (`REQUEST_TOO_LARGE`).

Response order:

1. root closure;
2. selected response-version context, then `requestId`, then `kind` syntax;
3. body discriminant; for success, kind membership then exact kind/body
   mapping (error kind does not require membership);
4. body structure (`INVALID_ENVELOPE` for error object/code/message,
   `INVALID_PAYLOAD` for success data);
5. body semantics;
6. fresh wire construction and encoded postconditions; and
7. response body bound (`INVALID_ENVELOPE`).

Known nested fields are checked in this fixed order:

- submit payload: `expected`, `signal`;
- expected assignment: `workflowId`, `assignmentId`, `attemptId`, `role`,
  `artifactRevision`, `candidateDigest`;
- signal: `eventId`, `workflowId`, `assignmentId`, `attemptId`, `role`,
  `artifactRevision`, `candidateDigest`, `kind`, `findingCount`, `artifactRef`,
  `shortErrorCode`;
- digest: `algorithm`, `hex`;
- `HelloInfo`: `protocolVersion`, `journalSchemaVersion`, `capabilities`,
  `package`;
- package: `name`, `version`;
- submit/reconcile result: `disposition`, `eventId`; and
- error: `code`, `message`.

Signal semantic order is field value checks; role/kind compatibility;
`findingCount` presence; its kind-specific value; `artifactRef` presence; then
`shortErrorCode` presence. Submit completes expected-assignment semantics
before signal semantics. Array element validity precedes uniqueness, and the
first duplicate is the lowest second-occurrence index.

Local failures use existing codes only. Shape/type precedes semantics,
serialization, and size. Message text is non-normative. A request failure
occurs before process creation, parent timing, stdin acquisition, or any write,
so it creates no peer outcome or `reportedCode`. A response failure occurs
before the first stdout/transport byte. The encoder does not classify either
local failure as `rejected` or `unknown`.

## Issue #77 implementation transition

The lexical and outbound sections above are the target authority established
by Issue #77 S1. The current Rust/TypeScript codecs, constructors, package
exports, clients, producers, fault paths, and fixtures still contain known
divergence, including typed current-version decoding before complete selection,
incomplete source-graph validation, malformed-code normalization, payload-
encoder bypass exports, caller-local prevalidation, and response failures that
do not retain all recovered correlation. Issue #77 S2 owns their atomic
migration. Until S2 lands, no consumer may be described as fully conforming to
these new sections.

## Kinds

The current v0.1 operation set is exactly `hello`,
`workflow.signal.submit`, and read-only `workflow.signal.reconcile`. `hello` is
the bootstrap operation. A non-hello operation is current only when this
specification owns its request and response kind/schema and the serving binary
advertises the matching capability. See the
[current-operation classification contract](../../classification/README.md).

| Kind | Request payload | Response payload |
|---|---|---|
| `hello` | `{}` | [`hello.response.schema.json`](schemas/hello.response.schema.json) |
| `workflow.signal.submit` | [`workflow-signal-submit.request.schema.json`](schemas/workflow-signal-submit.request.schema.json) | [`workflow-signal-submit.response.schema.json`](schemas/workflow-signal-submit.response.schema.json) |
| `workflow.signal.reconcile` | [`workflow-signal-reconcile.request.schema.json`](schemas/workflow-signal-reconcile.request.schema.json) | [`workflow-signal-reconcile.response.schema.json`](schemas/workflow-signal-reconcile.response.schema.json) |

### `hello`

versionとcapabilityの事前確認。stateを要求しない。

- `protocolVersion` / `journalSchemaVersion` は `1..=4294967295`
- capabilityは `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`（128 bytes以下）、重複なし。**一覧はopen**: 未知のcapabilityもdecodeは通り、互換判定（`checkCompatibility`）が拒否を決める。v1が定義するのは `workflow.signal.submit` と `workflow.signal.reconcile`
- kindがProtocol v1に定義されていても、build targetでそのoperationを提供できない場合は該当capabilityをadvertiseしない。直接送られたrequestは `CAPABILITY_UNSUPPORTED`

### `workflow.signal.submit`

structured workflow signalを、shellがbindされている `expected` assignmentに対して提出する。

- `expected` と `signal` は `workflowId`、`assignmentId`、`attemptId`、`role`、`artifactRevision`、`candidateDigest` を持つ。`candidateDigest` は `{ "algorithm": "sha256", "hex": "<64 lowercase hex>" }`
- `candidateDigest` はcandidate bytesを読めるcontrol plane / artifact authorityが計算する。coreはshapeを検証してcarry / compareするだけで、hashを再計算しない
- `artifactRef` の既存規則は変更しない。external artifact digestとreview / repair causationはv1のこのsliceには含めない
- `ok: true` の `disposition` は `accepted`（durable appendの **後** に返る）または `duplicate`（同一 `eventId`・attempt / candidate pairを含む同一内容）
- `ok: false` の `error.code` はprotocol code、`INVALID_EXPECTATION`、workflow code（`INVALID_SIGNAL`、各`*_MISMATCH`、`EVENT_CONFLICT`）、またはjournal code。codeの構文集合はopenだが、clientが`rejected`へ分類する集合は下記のoperation別規則でclosed
- 照合順はworkflow → assignment → attempt → role → revision identifier → candidate digest → duplicate / conflict。異なるevent間のrevision-to-digest registryは持たない
- Protocol v1は未releaseのためADR-0012でin-place更新した。旧shapeは互換受理しない

### `workflow.signal.reconcile`

restart後に、問い合わせたsignalがwriter-published committed snapshotへ存在するかをboundedかつread-onlyに照合する。

- requestはsubmitと同じclosed `signal` DTOをそのまま持つ。`expected` は持たず、含めたrequestは `INVALID_PAYLOAD`
- successの `disposition` は、同一`eventId`・同一内容なら `accepted`、同一`eventId`・異内容なら `conflict`、eventがなければ `absent`
- `absent` は既存のstore commit metadataが公開した完全なsnapshotからだけ返す。state directory、lock、journal、commit metadataの欠落は `JOURNAL_UNAVAILABLE` であり、semantic outcomeは `unknown`
- journalにpublished boundaryを越えるtailがある場合は、完全なJSONL recordに見えても `JOURNAL_OUTCOME_UNKNOWN`。reconciliationはtailをsync、promote、truncate、repairしない
- response error、transport / decode failure、timeout、abort、相関不一致はTypeScript clientで必ず `unknown`。syntactically validな `error.code` は `reportedCode` として診断用に保持できる
- clientはerror responseをdecodeして `reportedCode` を保存してから `requestId` / `kind` / `eventId` の相関を検査する。`requestId: null`、`kind: null` のwatchdog responseは `correlation_mismatch` のまま `reportedCode: HANDLER_TIMEOUT`
- これはcontrol-plane / operator APIであり、model-visible toolや自動retry / 自動reconcileを追加しない

## Error codes

`error.code` のwire構文は `^[A-Z][A-Z0-9_]{0,63}$` であり、schemaとdecoderは
登録簿membershipを要求しない。clientは意味を認識したcodeだけを強いsemantic
classificationへ使う。正形式だが未認識のcodeを確定的な成功・拒否へ推測しない。

### Operation-specific client classification

The source-qualified semantic rules are owned by the
[current-operation classification contract](../../classification/README.md).
This Protocol specification continues to own wire syntax and fixed-code
meaning; it does not maintain a second semantic classification table.

The required fail-closed cases are: submit `INTERNAL` and a syntactically valid
unrecognized submit code are client `unknown` and non-retryable; every
reconciliation error is client `unknown`; and an unrecognized code is omitted
from timing code disclosure. Transport, decode, timeout, abort, and correlation
failures remain `unknown` and do not authorize retry. Timing is provisional
operational evidence rather than a stable Protocol compatibility surface.

| Code | いつ |
|---|---|
| `REQUEST_TOO_LARGE` | request frameが上限を超える。`requestId` / `kind` は `null` |
| `INVALID_ENVELOPE` | JSONでない、不正UTF-8・BOM・lone surrogate、`protocol` が違う、`version` が整数でない・range外、未知field、member重複、`requestId` が不正、stdinに2つ目のframe。response側では上限超過もこれ |
| `PROTOCOL_VERSION_UNSUPPORTED` | `version` が `1` 以外。`requestId` / `kind` は復元できれば返る |
| `UNKNOWN_KIND` | `kind` が未登録 |
| `INVALID_PAYLOAD` | payloadの形がkindのschemaに合わない（欠落、型違い、未知field、`null`） |
| `INVALID_EXPECTATION` | `expected` の値が不正（識別子の文字種・長さ、またはcandidate digestのhex形式） |
| `INVALID_SIGNAL` ほかworkflow code | `signal` の値や制約、expectationとの不一致、conflict |
| `JOURNAL_*` | journalまたはstore commit metadataを開けない・検証できない・書けない。`JOURNAL_OUTCOME_UNKNOWN` は再送せず、reconciliationでもpublished boundaryを越えるtailを確定しない |
| `CAPABILITY_UNSUPPORTED` | kindは既知だが、このbuildではoperationを提供できない。verified storeを持たないtargetへsubmit / reconcileを直接送った場合など |
| `HANDLER_TIMEOUT` | process profileのwatchdogが成立。required EOF前を含むpre-dispatch timeoutはstate effectなし。dispatch開始後はappendまたはreconciliationの結果が不明になり得る。bootstrap-v1 errorで`requestId` / `kind` は `null` |
| `INTERNAL` | 分類不能。詳細はstderr |

登録簿は [docs/reference/error-codes.md](../../../docs/reference/error-codes.md)。

## Files

- `schemas/` — JSON Schema draft 2020-12
- `examples/` — `*.request.json` / `*.response.json`。`crates/aizign-protocol/tests/examples.rs` がdecode → encodeの往復で検証する
- [`spec/conformance/`](../../conformance/README.md) — decoder acceptance fixture
  とfull-codec round trip
- [`encoder-scenarios.md`](../../conformance/encoder-scenarios.md) —
  production decoderを要求しないdirectional encoder scenario
