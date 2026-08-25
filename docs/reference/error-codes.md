# Error codes

stable short error codeの登録簿です。形式は `^[A-Z][A-Z0-9_]{0,63}$`。
一度releaseしたcodeの意味を変えません。不要になったcodeは `deprecated` にし、再利用しません。

wire schemaとdecoderが受理する構文集合はopenであり、この登録簿へのmembershipを
decode時には要求しません。各operation clientは、認識済みの確定的codeだけを強い
semantic outcomeへ分類します。正形式でも未認識のcodeは`unknown`であり、
control-plane向け`reportedCode`としてのみ保持できます。operation別規則は
[Protocol v1](../../spec/protocol/v1/README.md#operation-specific-client-classification)が正本です。

Statusは `reserved`（文書上で予約。実装はまだ）または `implemented`（source / fixtureに存在）。
protocol fixtureが入った後は、`spec/protocol/v1/` が wire上のcodeの正本になり、この文書は索引になります。

## Protocol

`aizign-protocol` の `codes::*`。wire上の意味は [spec/protocol/v1](../../spec/protocol/v1/README.md#error-codes)。

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

## Effect

| Code | 意味 | Status |
|---|---|---|
| `EFFECT_NOT_CLAIMED` | claimなしにeffect resultが報告された | reserved |
| `EFFECT_OUTCOME_UNKNOWN` | effectの結果が確定できない。自動再送しない | reserved |

## Harness-facing（adapterが投げる）

protocolのcodeではなく、adapterがharnessへ返す `HarnessError.code`。各adapterのREADMEが正本で、ここは索引。

| Code | 意味 | Adapter |
|---|---|---|
| `AIZIGN_UNAVAILABLE` | preflightでbinaryに到達できない | `@aizign/adapter-dsh` |
| `AIZIGN_INCOMPATIBLE` | protocol version / capabilityが合わない | `@aizign/adapter-dsh` |
| `AIZIGN_OUTCOME_UNKNOWN` | 提出の結果が不明。再送しない | `@aizign/adapter-dsh` |

## 追加の手順

1. この表に `reserved` で追加する
2. 実装とfixtureを追加し、`implemented` にする
3. protocol上のcodeは `spec/protocol/v1/` にも登録する
