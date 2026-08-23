# Error codes

stable short error codeの登録簿です。形式は `^[A-Z][A-Z0-9_]{0,63}$`。
一度releaseしたcodeの意味を変えません。不要になったcodeは `deprecated` にし、再利用しません。

Statusは `reserved`（文書上で予約。実装はまだ）または `implemented`（source / fixtureに存在）。
protocol fixtureが入った後は、`spec/protocol/v1/` が wire上のcodeの正本になり、この文書は索引になります。

## Protocol

| Code | 意味 | Status |
|---|---|---|
| `PROTOCOL_VERSION_UNSUPPORTED` | envelopeの `version` をこのbinaryが扱えない | reserved |
| `INVALID_ENVELOPE` | envelopeがclosed schemaに合わない（欠落、型違い、未知field） | reserved |
| `UNKNOWN_KIND` | `kind` が未登録 | reserved |
| `INVALID_PAYLOAD` | payloadがkindのclosed schemaに合わない | reserved |
| `REQUEST_TOO_LARGE` | request sizeがboundを超えた | reserved |
| `CAPABILITY_UNSUPPORTED` | 要求された操作をこのbinaryまたはadapterが提供しない | reserved |
| `INTERNAL` | 分類できない内部error。詳細はstderr | reserved |

## Workflow

`aizu-core` の `workflow::WorkflowError::code()` が返すcodeです。

| Code | 意味 | Status |
|---|---|---|
| `INVALID_SIGNAL` | signalがkindごとの制約（role、`findingCount`、`artifactRef`、`shortErrorCode`）に合わない | implemented（`aizu-core`） |
| `INVALID_EXPECTATION` | expected assignmentがclosed schemaに合わない。coreでは型により表現不能なため、protocol境界で返す | reserved（protocol） |
| `WORKFLOW_MISMATCH` | `workflowId` が期待と異なる | implemented（`aizu-core`） |
| `ASSIGNMENT_MISMATCH` | `assignmentId` が期待と異なる | implemented（`aizu-core`） |
| `ROLE_MISMATCH` | `role` が期待と異なる | implemented（`aizu-core`） |
| `REVISION_MISMATCH` | `artifactRevision` が期待と異なる | implemented（`aizu-core`） |
| `EVENT_CONFLICT` | 同一 `eventId` で内容が異なる | implemented（`aizu-core`） |

照合順はworkflow → assignment → role → revisionで、expectationの照合がduplicate / conflict判定より先に行われます。

## Journal

| Code | 意味 | Status |
|---|---|---|
| `JOURNAL_CORRUPT` | journalをclosed schemaで読めない | reserved |
| `JOURNAL_SCHEMA_UNSUPPORTED` | journal schema versionをこのbinaryが扱えない | reserved |
| `JOURNAL_LOCKED` | 別writerがownershipを持っている | reserved |
| `JOURNAL_OUTCOME_UNKNOWN` | appendの結果が確定できない。自動再送しない | reserved |
| `JOURNAL_BOUND_EXCEEDED` | cold readのboundを超えた | reserved |

## Effect

| Code | 意味 | Status |
|---|---|---|
| `EFFECT_NOT_CLAIMED` | claimなしにeffect resultが報告された | reserved |
| `EFFECT_OUTCOME_UNKNOWN` | effectの結果が確定できない。自動再送しない | reserved |

## 追加の手順

1. この表に `reserved` で追加する
2. 実装とfixtureを追加し、`implemented` にする
3. protocol上のcodeは `spec/protocol/v1/` にも登録する
