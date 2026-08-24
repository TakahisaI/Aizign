# Aizign journal schema v1

control journalのdurable format。**metadata-only、append-only**（ADR-0007）。初期実装はJSONL（`aizign-store-jsonl`）。

```text
<state dir>/            owner-only（0700）
├── workflow.jsonl      1行 = 1 record。owner-only（0600）
└── workflow.lock       writer ownershipのadvisory lock。owner-only（0600）
```

## Record

| Field | 型 | 意味 |
|---|---|---|
| `schemaVersion` | `1` | このschemaのversion。package versionと独立 |
| `seq` | integer `1..=10000` | storeが付与する連番。欠番・逆順は `JOURNAL_CORRUPT` |
| `at` | integer | shellが与えたUnix秒。`2020-01-01` 〜 `2100-01-01` の範囲 |
| `kind` | `"workflow.signal.accepted"` | record kind。新しいkindは追加できるが既存の意味は変えない |
| `signal` | object | 受理されたstructured signal（closed。attemptとcandidate pairをdurableに含む。protocol v1の `signal` と同じ形だが別schemaとして所有） |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `JOURNAL_CORRUPT`
- **同一object内でmember名の重複は `JOURNAL_CORRUPT`**（escape表記ではなくdecode後の名前で比較するprotocolと同じlexical rule。schemaでは表現できない）
- `signal` は `attemptId` とtyped `candidateDigest`を必須にする。external evidence digestとrepair causationは保存しない
- `signal` の条件規則（kindとroleの対応、`findingCount` / `artifactRef` / `shortErrorCode` の必須・禁止）は [`record.schema.json`](schemas/record.schema.json) がprotocol v1のrequest schemaと同じ形で持つ
- **schemaとruntime decoder（`aizign-store-jsonl`）の受理集合は同一**。`spec/conformance/{valid,invalid}/journal` の同じfixtureを、runtimeは `decode_record`（`crates/aizign-store-jsonl/tests/conformance.rs`）、schemaは [`spec/test/schema.test.mjs`](../../test/schema.test.mjs) が読み、`.expect.json` の `schema` 判定で両者を突き合わせる
- `seq` の範囲はschemaとruntimeで一致させる: `1..=10000`（`MAX_JOURNAL_ENTRIES`。cold readがこの件数でboundされるため、これを超えるseqを持つdurable fileは読めない）
- 整数の字句表現はprotocolと同じくcanonical token（`1.0` などは `JOURNAL_CORRUPT`）。schemaでは表現できないのでfixtureに `schema: true` と記録する
- optional fieldは省略する。`null` は `JOURNAL_CORRUPT`
- 本文、credential、harness ID（`prompt`、`output`、`reasoning`、`token`、`sessionId`、`threadId` など）にあたるfieldは存在しない。record schemaがclosedなので、そのようなfieldを持つrecordは読み込めない

## 読み取りの規則（bounded cold read）

- fileは改行で終わる。最後のrecordが途中で切れていれば `JOURNAL_CORRUPT`（黙って捨てない。直前のappendの結果は `unknown` だったことを意味する）
- `schemaVersion` が違えば `JOURNAL_SCHEMA_UNSUPPORTED`
- record数が `10000` を超えれば `JOURNAL_BOUND_EXCEEDED`
- `signal` はcoreの検証（kind / role、`findingCount` などの制約）を通らなければ `JOURNAL_CORRUPT`
- replayは各accepted eventのattempt / candidate pairを復元する。同じrevision identifierを持つ別event間のdigestは比較しない
- Journal schema v1は未releaseのためADR-0012でin-place更新した。旧shapeは読み込まない

## 書き込みの規則

- `seq` は直前のrecord + 1。**10000件に達した後のappendは書き込まず `JOURNAL_BOUND_EXCEEDED`**。fileを変えず、acceptedにもしない（成功を返した直後に次回cold readが読めないjournalを作らないため）。encoder（`encode_record`）もrange外の `seq` を生成できない
- 1行を `write` し `fsync` して初めてdurable。`write` または `fsync` が失敗したら `JOURNAL_OUTCOME_UNKNOWN`。再送しない
- lockを取れなければ `JOURNAL_LOCKED`

## Files

- `schemas/record.schema.json` — JSON Schema draft 2020-12
- `examples/workflow.jsonl` — 3 recordの例
