# Aizu Protocol v1

NDJSON over stdin / stdout。**1 request frame in、1 response frame out**。frameは改行で終わる1行のJSON objectで、
request / response とも `65536` bytes（`MAX_FRAME_BYTES`）以下。

- stdinは **frame 1つ + 末尾 whitespace** だけを許す。2つ目のframeや末尾の非whitespaceは `INVALID_ENVELOPE`（何もappendしない）
- stdoutも **frame 1つ + 末尾 whitespace** だけ。clientは2つ目のframe・末尾の非whitespace・boundの超過を `unknown` として扱う（effectが実行済みの可能性があるため、拒否ではなく不明）
- clientはresponseの `requestId` / `kind` / （signalでは）`eventId` を送信したものと照合し、不一致は `unknown`（correlation mismatch）にする

```text
adapter ──(request frame)──▶ aizu handle --state <dir> ──(response frame)──▶ adapter
                                     │ stderr: 構造化log（本文なし）
```

## Envelope

| Field | Request | Response |
|---|---|---|
| `protocol` | `"aizu"` | `"aizu"` |
| `version` | `1` | `1` |
| `requestId` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | requestの値をecho（同じpattern）。復元できなければ `null` |
| `kind` | 登録済みkind | requestの値をecho。復元できなければ `null` |
| `payload` | kindごとのclosed object | `ok: true` のときだけ |
| `ok` | — | `true` / `false` |
| `error` | — | `ok: false` のときだけ。`{ "code", "message" }` |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `INVALID_ENVELOPE` / `INVALID_PAYLOAD`
- **受理集合はJSON Schemaが正**: [`schemas/`](schemas/) とRust / TS decoderは同じ集合を受理する。一致は `spec/conformance` の全fixture（`.expect.json` の `schema` 判定）とexampleをschemaに通すgate（[`spec/test/schema.test.mjs`](../../test/schema.test.mjs)）がCIで検証する
- schemaが表現できず **decoderだけが拒否する規則は2つ**（fixtureでは `schema: true` と記録する）
  - frameのsize bound（`MAX_FRAME_BYTES`）→ `REQUEST_TOO_LARGE` / `INVALID_ENVELOPE`
  - **整数の字句表現**（下記）
- 整数fieldのwire表現は **canonicalな整数token** だけを許す: `0` または `-?[1-9][0-9]*`。`1.0`、`1e0`、`-0` のような表記はJSON data model上は整数1（や0）だが、frameとしては拒否する（`version` は `INVALID_ENVELOPE`、payload内は `INVALID_PAYLOAD`）。JSON Schemaはdata modelしか見ないためこの規則を書けず、両decoderが実装する（Rustは `serde_json` の整数型、TSはparse時のtoken検査）
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

- `protocolVersion` / `journalSchemaVersion` は `1..=4294967295`
- capabilityは `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`（128 bytes以下）、重複なし。**一覧はopen**: 未知のcapabilityもdecodeは通り、互換判定（`checkCompatibility`）が拒否を決める。v1が定義するのは `workflow.signal.submit` だけ

### `workflow.signal.submit`

structured workflow signalを、shellがbindされている `expected` assignmentに対して提出する。

- `ok: true` の `disposition` は `accepted`（durable appendの **後** に返る）または `duplicate`（同一 `eventId`・同一内容）
- `ok: false` の `error.code` はprotocol code、`INVALID_EXPECTATION`、またはworkflow code（`INVALID_SIGNAL`、`WORKFLOW_MISMATCH`、`ASSIGNMENT_MISMATCH`、`ROLE_MISMATCH`、`REVISION_MISMATCH`、`EVENT_CONFLICT`）
- 照合順はworkflow → assignment → role → revision → duplicate / conflict

## Error codes

| Code | いつ |
|---|---|
| `REQUEST_TOO_LARGE` | request frameが上限を超える。`requestId` / `kind` は `null` |
| `INVALID_ENVELOPE` | JSONでない、`protocol` が違う、`version` が整数でない、未知field、`requestId` が不正、stdinに2つ目のframe。response側では上限超過もこれ |
| `PROTOCOL_VERSION_UNSUPPORTED` | `version` が `1` 以外。`requestId` / `kind` は復元できれば返る |
| `UNKNOWN_KIND` | `kind` が未登録 |
| `INVALID_PAYLOAD` | payloadの形がkindのschemaに合わない（欠落、型違い、未知field、`null`） |
| `INVALID_EXPECTATION` | `expected` の値が不正（識別子の文字種や長さ） |
| `INVALID_SIGNAL` ほかworkflow code | `signal` の値や制約、expectationとの不一致、conflict |
| `JOURNAL_*` | journalを開けない・読めない・書けない。`JOURNAL_OUTCOME_UNKNOWN` は再送しない |
| `CAPABILITY_UNSUPPORTED` | kindは既知だがこのbinaryでは無効（v1では未使用） |
| `HANDLER_TIMEOUT` | 処理が時間bound（10秒）を超えた。進行中のappendの結果は不明。`requestId` / `kind` は `null` |
| `INTERNAL` | 分類不能。詳細はstderr |

登録簿は [docs/reference/error-codes.md](../../../docs/reference/error-codes.md)。

## Files

- `schemas/` — JSON Schema draft 2020-12
- `examples/` — `*.request.json` / `*.response.json`。`crates/aizu-protocol/tests/examples.rs` がdecode → encodeの往復で検証する
