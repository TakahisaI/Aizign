# aizign-store-jsonl

Append-only, metadata-only JSONL control journal. Implements `aizign_engine::Journal`.

| | |
|---|---|
| **Responsibility** | `spec/journal/v1` のrecordをJSONL fileへdurableにappendし、bounded cold readで読み戻す。owner-only permission、writer ownership（advisory lock）、`seq` の連番、closed schema |
| **Non-responsibility** | 判断（duplicate / conflictは `aizign-core`）、wire format、state directoryの選択（`aizign-cli`） |
| **Inputs** | state directory、`WorkflowEvent` + `BoundedTimestamp` |
| **Outputs** | `JournalEntry`、`JournalError`（stable code付き） |
| **Hard invariants** | attempt / candidate digestをmetadata-only recordへ残す（5）、本文・credential・harness IDを書かない（10）、`write` / `fsync` 失敗は `OutcomeUnknown` で再送しない（3）、途中で切れたrecordや欠番を黙って捨てない、既存recordを書き換えない |
| **Allowed dependencies** | `aizign-core`、`aizign-engine`、`serde`、`serde_json`。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-store-jsonl` |
| **Related ADR** | [0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0007](../../docs/adr/0007-use-metadata-only-control-journals.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md) |

formatの正本は [`spec/journal/v1/`](../../spec/journal/v1/README.md)。`decode_record` / `encode_record` は
`spec/conformance/{valid,invalid}/journal` のfixtureを回すための入口で、同じfixtureを `spec/test/schema.test.mjs` が
JSON Schemaに通すため、schemaとruntimeの受理集合はCIで突き合わされる。

## Layout

```text
src/
├── lib.rs
├── journal.rs   JsonlJournal::open / load / append、permission、lock、bound
├── json_member.rs member重複の事前検査（内部実装）
└── record.rs    record DTO（private）、encode_entry / decode_line、JOURNAL_SCHEMA_VERSION
tests/
└── jsonl_journal.rs   contract、reopen後のduplicate検出、lock、permission、corrupt、bound、metadata-only
```

## 挙動

- `open(state_dir)`: directoryを `0700` で作成（既存なら権限を検査）、`workflow.lock` を `0600` で開き `try_lock`、`workflow.jsonl` を `0600` で開く
- `load()`: file全体を読み、1行ずつclosed decode。最後の行が改行で終わっていなければ `Corrupt`。member重複も `Corrupt`。`seq` は1からの連番
- `append(event, at)`: 次の `seq` を付与して1行を `write_all` + `sync_data`。失敗は `OutcomeUnknown`。**10000件に達した後のappendは書き込まず `BoundExceeded`**（file不変）。encoderもrange外の `seq` を生成できない
- 非Unixでは権限検査を行いません（作成は通常のmode）
