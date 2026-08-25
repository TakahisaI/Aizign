# Aizign Protocol v1

NDJSON over stdin / stdout。**1 request frame in、1 response frame out**。frameは改行で終わる1行のJSON objectで、
request / response とも `65536` bytes（`MAX_FRAME_BYTES`）以下。

- stdinは **frame 1つ + 末尾 whitespace** だけを許す。2つ目のframeや末尾の非whitespaceは `INVALID_ENVELOPE`（何もappendしない）
- stdoutも **frame 1つ + 末尾 whitespace** だけ。clientは2つ目のframe・末尾の非whitespace・boundの超過を `unknown` として扱う（effectが実行済みの可能性があるため、拒否ではなく不明）
- clientはresponseの `requestId` / `kind` / （signalでは）`eventId` を送信したものと照合し、不一致は `unknown`（correlation mismatch）にする

```text
adapter ──(request frame)──▶ aizign handle --state <dir> ──(response frame)──▶ adapter
                                     │ stderr: 構造化log（本文なし）
```

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
- frame bytesは **BOMなしUTF-8** とする。不正UTF-8と先頭のUTF-8 BOM（`EF BB BF`）はJSONとして解釈せず `INVALID_ENVELOPE`。string入力も先頭のU+FEFFを許さない
- 整数fieldのwire表現は **canonicalな整数token** だけを許す: `0` または `-?[1-9][0-9]*`。`1.0`、`1e0`、`-0` のような表記はJSON data model上は整数1（や0）だが、frameとしては拒否する（`version` は `INVALID_ENVELOPE`、payload内は `INVALID_PAYLOAD`）。JSON Schemaはdata modelしか見ないためこの規則を書けず、両decoderが実装する（Rustは `serde_json` の整数型、TSはparse時のtoken検査）
- envelope `version` の整数rangeは `0..=4294967295`（`PROTOCOL_VERSION` の型 `u32` に由来）。range外は `PROTOCOL_VERSION_UNSUPPORTED` ではなく **`INVALID_ENVELOPE`**。両decoderとも同じ判定（Rustはtyped field、TSは数値比較。JSON numberは2^53まで厳密なので差は出ない）
- **同一object内でmember名の重複は拒否**（`INVALID_ENVELOPE`、journalは `JOURNAL_CORRUPT`）。`"a"` と `"\u0061"` のようにescape表記が違っても、decode後の名前が同じなら重複とする。streaming parserとfolding parserで意味が分れるため、どの階層でも契約の外。schema外のlexical ruleとして両decoderが走査し、相関データ（`requestId` / `kind`）は最後の表記から復元する
- object member名とstring valueは **Unicode scalar sequence** でなければならない。`"\uD800"` のようなlone UTF-16 surrogateは `INVALID_ENVELOPE`。JSON SchemaはJavaScript上のill-formed stringを区別しないため、両decoderが全string tokenを検査する
- optional fieldは **省略** する。`null` は許可しない
- `message` は人向けの説明で、request本文を含めない。機械判定は `code` だけで行う
- 互換性はpackage versionではなく `version` と `hello` の `capabilities` で判定する

## Kinds

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
- `ok: false` の `error.code` はprotocol code、`INVALID_EXPECTATION`、またはworkflow code（`INVALID_SIGNAL`、各`*_MISMATCH`、`EVENT_CONFLICT`）
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
| `HANDLER_TIMEOUT` | 処理が時間bound（10秒）を超えた。進行中のappendまたはreconciliationの結果は不明。`requestId` / `kind` は `null` |
| `INTERNAL` | 分類不能。詳細はstderr |

登録簿は [docs/reference/error-codes.md](../../../docs/reference/error-codes.md)。

## Files

- `schemas/` — JSON Schema draft 2020-12
- `examples/` — `*.request.json` / `*.response.json`。`crates/aizign-protocol/tests/examples.rs` がdecode → encodeの往復で検証する
- [`spec/conformance/`](../../conformance/README.md) — decoder acceptance fixture
  とfull-codec round trip
- [`encoder-scenarios.md`](../../conformance/encoder-scenarios.md) —
  production decoderを要求しないdirectional encoder scenario
