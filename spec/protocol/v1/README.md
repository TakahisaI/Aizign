# Aizu Protocol v1

NDJSON over stdin / stdout。**1 request frame in、1 response frame out**。frameは改行で終わる1行のJSON objectで、
request frameは改行を含めて `65536` bytes以下。

```text
adapter ──(request frame)──▶ aizu handle --state <dir> ──(response frame)──▶ adapter
                                     │ stderr: 構造化log（本文なし）
```

## Envelope

| Field | Request | Response |
|---|---|---|
| `protocol` | `"aizu"` | `"aizu"` |
| `version` | `1` | `1` |
| `requestId` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | requestの値をecho。復元できなければ `null` |
| `kind` | 登録済みkind | requestの値をecho。復元できなければ `null` |
| `payload` | kindごとのclosed object | `ok: true` のときだけ |
| `ok` | — | `true` / `false` |
| `error` | — | `ok: false` のときだけ。`{ "code", "message" }` |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `INVALID_ENVELOPE` / `INVALID_PAYLOAD`
- optional fieldは **省略** する。`null` は許可しない
- `message` は人向けの説明で、request本文を含めない。機械判定は `code` だけで行う
- 互換性はpackage versionではなく `version` と `hello` の `capabilities` で判定する

## Kinds

| Kind | Request payload | Response payload |
|---|---|---|
| `hello` | `{}` | [`hello.response.schema.json`](schemas/hello.response.schema.json) |
| `workflow.signal.submit` | [`workflow-signal-submit.request.schema.json`](schemas/workflow-signal-submit.request.schema.json) | [`workflow-signal-submit.response.schema.json`](schemas/workflow-signal-submit.response.schema.json) |

### `hello`

versionとcapabilityの事前確認。stateを要求しない。

### `workflow.signal.submit`

structured workflow signalを、shellがbindされている `expected` assignmentに対して提出する。

- `ok: true` の `disposition` は `accepted`（durable appendの **後** に返る）または `duplicate`（同一 `eventId`・同一内容）
- `ok: false` の `error.code` はprotocol code、`INVALID_EXPECTATION`、またはworkflow code（`INVALID_SIGNAL`、`WORKFLOW_MISMATCH`、`ASSIGNMENT_MISMATCH`、`ROLE_MISMATCH`、`REVISION_MISMATCH`、`EVENT_CONFLICT`）
- 照合順はworkflow → assignment → role → revision → duplicate / conflict

## Error codes

| Code | いつ |
|---|---|
| `REQUEST_TOO_LARGE` | frameが上限を超える。`requestId` / `kind` は `null` |
| `INVALID_ENVELOPE` | JSONでない、`protocol` が違う、`version` が整数でない、未知field、`requestId` が不正 |
| `PROTOCOL_VERSION_UNSUPPORTED` | `version` が `1` 以外。`requestId` / `kind` は復元できれば返る |
| `UNKNOWN_KIND` | `kind` が未登録 |
| `INVALID_PAYLOAD` | payloadの形がkindのschemaに合わない（欠落、型違い、未知field、`null`） |
| `INVALID_EXPECTATION` | `expected` の値が不正（識別子の文字種や長さ） |
| `INVALID_SIGNAL` ほかworkflow code | `signal` の値や制約、expectationとの不一致、conflict |
| `CAPABILITY_UNSUPPORTED` | kindは既知だがこのbinaryでは無効（v1では未使用） |
| `INTERNAL` | 分類不能。詳細はstderr |

登録簿は [docs/reference/error-codes.md](../../../docs/reference/error-codes.md)。

## Files

- `schemas/` — JSON Schema draft 2020-12
- `examples/` — `*.request.json` / `*.response.json`。`crates/aizu-protocol/tests/examples.rs` がdecode → encodeの往復で検証する
