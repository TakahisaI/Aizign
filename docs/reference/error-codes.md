# Error codes

stable short error codeの登録簿です。形式は `^[A-Z][A-Z0-9_]{0,63}$`。
一度releaseしたcodeの意味を変えません。不要になったcodeは `deprecated` にし、再利用しません。

Statusは `reserved`（文書上で予約。実装はまだ）または `implemented`（source / fixtureに存在）。
protocol fixtureが入った後は、`spec/protocol/v1/` が wire上のcodeの正本になり、この文書は索引になります。

## Protocol

`aizu-protocol` の `codes::*`。wire上の意味は [spec/protocol/v1](../../spec/protocol/v1/README.md#error-codes)。

| Code | 意味 | Status |
|---|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | envelopeの `version` をこのbinaryが扱えない | implemented（`aizu-protocol`） |
| `INVALID_ENVELOPE` | envelopeがclosed schemaに合わない（JSONでない、`protocol` 違い、欠落、型違い、未知field、`requestId` 不正） | implemented（`aizu-protocol`） |
| `UNKNOWN_KIND` | `kind` が未登録 | implemented（`aizu-protocol`） |
| `INVALID_PAYLOAD` | payloadがkindのclosed schemaに合わない（欠落、型違い、未知field、`null`） | implemented（`aizu-protocol`） |
| `REQUEST_TOO_LARGE` | request sizeがboundを超えた | implemented（`aizu-protocol`） |
| `CAPABILITY_UNSUPPORTED` | 要求された操作をこのbinaryまたはadapterが提供しない | reserved（定数のみ） |
| `INTERNAL` | 分類できない内部error。詳細はstderr | implemented（`aizu-cli`: clock失敗） |
| `HANDLER_TIMEOUT` | 処理が時間boundを超えた。進行中のappendの結果は不明。再送せずreconcileする | implemented（`aizu-cli`） |

## Workflow

`aizu-core` の `workflow::WorkflowError::code()` が返すcodeです。

| Code | 意味 | Status |
|---|---|---|
| `INVALID_SIGNAL` | signalがkindごとの制約（role、`findingCount`、`artifactRef`、`shortErrorCode`）に合わない | implemented（`aizu-core`） |
| `INVALID_EXPECTATION` | `expected` の形は正しいが値が不正（識別子の文字種や長さ）。coreでは型により表現不能なため、protocol境界で返す | implemented（`aizu-protocol`） |
| `WORKFLOW_MISMATCH` | `workflowId` が期待と異なる | implemented（`aizu-core`） |
| `ASSIGNMENT_MISMATCH` | `assignmentId` が期待と異なる | implemented（`aizu-core`） |
| `ROLE_MISMATCH` | `role` が期待と異なる | implemented（`aizu-core`） |
| `REVISION_MISMATCH` | `artifactRevision` が期待と異なる | implemented（`aizu-core`） |
| `EVENT_CONFLICT` | 同一 `eventId` で内容が異なる | implemented（`aizu-core`） |

照合順はworkflow → assignment → role → revisionで、expectationの照合がduplicate / conflict判定より先に行われます。

## Journal

`aizu-engine` の `JournalError::code()`。formatの意味は [spec/journal/v1](../../spec/journal/v1/README.md)。

| Code | 意味 | Status |
|---|---|---|
| `JOURNAL_UNAVAILABLE` | journalを開けない（directory / fileの権限、作成失敗）。何もappendされていない | implemented（`aizu-engine`、`aizu-store-jsonl`） |
| `JOURNAL_CORRUPT` | journalをclosed schemaで読めない（未知field、`null`、欠番、途中で切れたrecord、不正なsignal） | implemented（同上） |
| `JOURNAL_SCHEMA_UNSUPPORTED` | journal schema versionをこのbinaryが扱えない | implemented（同上） |
| `JOURNAL_LOCKED` | 別writerがownershipを持っている | implemented（同上） |
| `JOURNAL_OUTCOME_UNKNOWN` | appendの結果が確定できない（`write` / `fsync` 失敗）。自動再送しない | implemented（同上） |
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
| `AIZU_UNAVAILABLE` | preflightでbinaryに到達できない | `@aizu/adapter-dsh` |
| `AIZU_INCOMPATIBLE` | protocol version / capabilityが合わない | `@aizu/adapter-dsh` |
| `AIZU_OUTCOME_UNKNOWN` | 提出の結果が不明。再送しない | `@aizu/adapter-dsh` |

## 追加の手順

1. この表に `reserved` で追加する
2. 実装とfixtureを追加し、`implemented` にする
3. protocol上のcodeは `spec/protocol/v1/` にも登録する
