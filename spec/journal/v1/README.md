# Aizu journal schema v1

control journalのdurable format。**metadata-only、append-only**（ADR-0007）。初期実装はJSONL（`aizu-store-jsonl`）。

```text
<state dir>/            owner-only（0700）
├── workflow.jsonl      1行 = 1 record。owner-only（0600）
└── workflow.lock       writer ownershipのadvisory lock。owner-only（0600）
```

## Record

| Field | 型 | 意味 |
|---|---|---|
| `schemaVersion` | `1` | このschemaのversion。package versionと独立 |
| `seq` | integer ≥ 1 | storeが付与する連番。欠番・逆順は `JOURNAL_CORRUPT` |
| `at` | integer | shellが与えたUnix秒。`2020-01-01` 〜 `2100-01-01` の範囲 |
| `kind` | `"workflow.signal.accepted"` | record kind。新しいkindは追加できるが既存の意味は変えない |
| `signal` | object | 受理されたstructured signal（closed。protocol v1の `signal` と同じ形だが別schemaとして所有） |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `JOURNAL_CORRUPT`
- optional fieldは省略する。`null` は `JOURNAL_CORRUPT`
- 本文、credential、harness ID（`prompt`、`output`、`reasoning`、`token`、`sessionId`、`threadId` など）にあたるfieldは存在しない。record schemaがclosedなので、そのようなfieldを持つrecordは読み込めない

## 読み取りの規則（bounded cold read）

- fileは改行で終わる。最後のrecordが途中で切れていれば `JOURNAL_CORRUPT`（黙って捨てない。直前のappendの結果は `unknown` だったことを意味する）
- `schemaVersion` が違えば `JOURNAL_SCHEMA_UNSUPPORTED`
- record数が `10000` を超えれば `JOURNAL_BOUND_EXCEEDED`
- `signal` はcoreの検証（kind / role、`findingCount` などの制約）を通らなければ `JOURNAL_CORRUPT`

## 書き込みの規則

- `seq` は直前のrecord + 1
- 1行を `write` し `fsync` して初めてdurable。`write` または `fsync` が失敗したら `JOURNAL_OUTCOME_UNKNOWN`。再送しない
- lockを取れなければ `JOURNAL_LOCKED`

## Files

- `schemas/record.schema.json` — JSON Schema draft 2020-12
- `examples/workflow.jsonl` — 3 recordの例
