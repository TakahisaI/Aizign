# Error codes

This is the index of implemented stable short error codes. The wire syntax is
`^[A-Z][A-Z0-9_]{0,63}$`. A released code is never reused or silently given a
different meaning.

Protocol schema and decoder membership remains open: a well-formed code does
not have to appear in this index to decode. An unrecognized code has no stable
classification meaning, remains client `unknown`, authorizes no retry, and may
be retained only as a bounded control-plane `reportedCode` diagnostic. It is
omitted from timing code disclosure.

[`spec/protocol/v1/`](../../spec/protocol/v1/README.md#error-codes) owns wire
syntax and fixed-code meaning. The
[current-operation classification contract](../../spec/classification/README.md)
owns the machine-readable source-qualified semantic rows. This file is a
non-normative implemented-code index whose Protocol, Workflow, and Journal
entries are checked for exact equality with the corpus/schema and Rust and
TypeScript fixed-membership registries. This index does not reserve names for future operations. In particular,
future `EFFECT_*` vocabulary is not a current reservation or compatibility
commitment.

## Protocol

Rust の `aizign-protocol::CURRENT_FIXED_ERROR_CODES` と TypeScript の
`@aizign/protocol` `codes` が完全なcurrent membershipを公開します。個々の
実装ownerとwire上の意味は [spec/protocol/v1](../../spec/protocol/v1/README.md#error-codes) を参照してください。

| Code | 意味 | Status |
|---|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | envelopeの `version` をこのbinaryが扱えない | implemented（`aizign-protocol`） |
| `INVALID_ENVELOPE` | envelopeがclosed schemaに合わない（JSONでない、`protocol` 違い、欠落、型違い、未知field、`requestId` 不正） | implemented（`aizign-protocol`） |
| `UNKNOWN_KIND` | `kind` が未登録 | implemented（`aizign-protocol`） |
| `INVALID_PAYLOAD` | payloadがkindのclosed schemaに合わない（欠落、型違い、未知field、`null`） | implemented（`aizign-protocol`） |
| `REQUEST_TOO_LARGE` | request sizeがboundを超えた | implemented（`aizign-protocol`） |
| `CAPABILITY_UNSUPPORTED` | 要求された操作をこのbinaryまたはadapterが提供しない。初期storeの未検証platformでsubmit / reconcileを直接要求した場合を含む | implemented（`aizign-cli`） |
| `INTERNAL` | 分類できない内部error。詳細はstderr。submit clientは確定的rejectionへ縮約せず`unknown`にする | implemented（`aizign-cli`: clock失敗） |
| `HANDLER_TIMEOUT` | 処理が時間boundを超えた。進行中のappendまたはreconciliationの結果は不明。再送しない。uncorrelated watchdog responseから得たcodeはreconciliation clientが診断用`reportedCode`として保持する | implemented（`aizign-cli`） |

## Workflow

`aizign-core` の `workflow::WorkflowError::code()` が返すcodeです。

| Code | 意味 | Status |
|---|---|---|
| `INVALID_SIGNAL` | signalがkindごとの制約（role、`findingCount`、`artifactRef`、`shortErrorCode`）に合わない | implemented（`aizign-core`） |
| `INVALID_EXPECTATION` | `expected` の形は正しいが値が不正（識別子の文字種・長さ、またはcandidate digestのhex形式）。coreでは型により表現不能なため、protocol境界で返す | implemented（`aizign-protocol`） |
| `WORKFLOW_MISMATCH` | `workflowId` が期待と異なる | implemented（`aizign-core`） |
| `ASSIGNMENT_MISMATCH` | `assignmentId` が期待と異なる | implemented（`aizign-core`） |
| `ATTEMPT_MISMATCH` | `attemptId` が期待と異なる | implemented（`aizign-core`） |
| `ROLE_MISMATCH` | `role` が期待と異なる | implemented（`aizign-core`） |
| `REVISION_MISMATCH` | `artifactRevision` が期待と異なる | implemented（`aizign-core`） |
| `CANDIDATE_DIGEST_MISMATCH` | `candidateDigest` が期待と異なる | implemented（`aizign-core`） |
| `EVENT_CONFLICT` | 同一 `eventId` で内容が異なる | implemented（`aizign-core`） |

照合順はworkflow → assignment → attempt → role → revision identifier → candidate digestで、expectationの照合がduplicate / conflict判定より先に行われます。異なるevent間のrevision-to-digest registryは持ちません。

## Journal

`aizign-engine` の `JournalError::code()`。record formatの意味は [spec/journal/v1](../../spec/journal/v1/README.md)、writer-published commit pointの意味は [spec/store/v1](../../spec/store/v1/README.md)。

| Code | 意味 | Status |
|---|---|---|
| `JOURNAL_UNAVAILABLE` | 必要なstate directory / lock / journal / commit metadataを開けない、または権限・platform contractを満たさない。reconciliationではmissingを`absent`へ縮約しない | implemented（`aizign-engine`、`aizign-store-jsonl`） |
| `JOURNAL_CORRUPT` | journal recordまたはcommit metadataをclosed schemaで読めない、もしくはpublished byte length / entry count / digestと実fileが一致しない | implemented（同上） |
| `JOURNAL_SCHEMA_UNSUPPORTED` | journal record schema versionまたはstore metadata versionをこのbinaryが扱えない | implemented（同上） |
| `JOURNAL_LOCKED` | incompatibleなwriter / reader lockが既に取得されている | implemented（同上） |
| `JOURNAL_OUTCOME_UNKNOWN` | appendのfile / metadata / directory barrierが確定しない、またはpublished boundaryを越えるtailがある。自動再送・reader側のpromote / repairをしない | implemented（同上） |
| `JOURNAL_BOUND_EXCEEDED` | cold readのboundを超えた | implemented（同上） |

## Harness-facing（adapterが投げる）

protocolのcodeではなく、adapterがharnessへ返す `HarnessError.code`。各adapterのREADMEが正本で、ここは索引。

| Code | 意味 | Adapter |
|---|---|---|
| `AIZIGN_UNAVAILABLE` | preflightでbinaryに到達できない | `@aizign/adapter-dsh` |
| `AIZIGN_INCOMPATIBLE` | protocol version / capabilityが合わない | `@aizign/adapter-dsh` |
| `AIZIGN_OUTCOME_UNKNOWN` | 提出の結果が不明。再送しない | `@aizign/adapter-dsh` |

## Adding a code

1. Establish the current operation, owner, wire meaning, and classification in
   an accepted contract. Do not reserve a name for a future operation here.
2. Add the implementation and Protocol fixture/schema evidence.
3. Add the implemented code to this non-normative index and add every required
   source-qualified row to the shared corpus in the same accepted change.
