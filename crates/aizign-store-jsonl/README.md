# aizign-store-jsonl

Append-only, metadata-only JSONL control journal with a writer-published committed prefix. Implements `aizign_engine::JournalReader` and `Journal`.

| | |
|---|---|
| **Responsibility** | `spec/journal/v1` のrecordをJSONL fileへdurableにappendし、`spec/store/v1` のcommit metadataで公開済みprefixを固定し、bounded read-only cold readで読み戻す。owner-only permission、shared / exclusive advisory lock、`seq` の連番、closed schema |
| **Non-responsibility** | 判断（duplicate / conflictは `aizign-core`）、wire format、state directoryの選択（`aizign-cli`） |
| **Inputs** | state directory、writerでは`WorkflowEvent` + `BoundedTimestamp` |
| **Outputs** | committed `JournalEntry` snapshot、appendした`JournalEntry`、`JournalError`（stable code付き） |
| **Hard invariants** | attempt / candidate digestをmetadata-only recordへ残す（5）、本文・credential・harness IDを書かない（10）、write開始後のbarrier / publish失敗は `OutcomeUnknown` で再送しない（3）、readerはwrite / sync / initialize / repair / tail promotionを一切しない（9）、published prefix以外をacceptedの根拠にしない、既存recordを書き換えない、state artifactはregular file・single link・state directoryと同一ownerに固定してsymlinkを追跡しない |
| **Allowed dependencies** | `aizign-core`、`aizign-engine`、`serde`、`serde_json`、`sha2`（store metadata v1のcommitted-prefix SHA-256専用）。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-store-jsonl` |
| **Related ADR** | [0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0007](../../docs/adr/0007-use-metadata-only-control-journals.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0014](../../docs/adr/0014-use-rustcrypto-sha2-for-committed-prefix-hashing.md) |

record formatの正本は [`spec/journal/v1/`](../../spec/journal/v1/README.md)、commit metadataとstore layoutの正本は [`spec/store/v1/`](../../spec/store/v1/README.md)。`decode_record` / `encode_record` は
`spec/conformance/{valid,invalid}/journal` のfixtureを回すための入口で、同じfixtureを `spec/test/schema.test.mjs` が
JSON Schemaに通すため、schemaとruntimeの受理集合はCIで突き合わされる。

## Layout

```text
src/
├── lib.rs
├── journal.rs   JsonlJournal / JsonlJournalReader、durable initialization、lock、committed read、append / publish
├── commit.rs    workflow.commit.json DTO、closed decoder、bounded SHA-256
├── json_member.rs member重複の事前検査（内部実装）
└── record.rs    record DTO（private）、encode_entry / decode_line、JOURNAL_SCHEMA_VERSION
tests/
└── jsonl_journal.rs   commit point、read-only、crash layout、tail、lock、permission、corrupt、bound、metadata-only
```

## 挙動

- `JsonlJournal::open(state_dir)`: exclusive non-blocking lockを取り、fresh storeならowner-only directory / lock / journal / zero-entry commit pointをwriter側でdurableに初期化する。途中までのempty initializationはexclusive lock下で完了できるが、non-empty journal without commit metadataは採用しない
- `JsonlJournalReader::open(state_dir)`: 既存artifactだけをread-onlyで開き、shared non-blocking lockを取る。missing artifactを作らず `Unavailable`、active writerは `Locked`
- `load_committed()`: `workflow.commit.json` が示すexact prefixだけをbounded decodeする。byte length / entry count / SHA-256の不一致やshort fileは `Corrupt`、extra tailは `OutcomeUnknown`。read pathはwrite、sync、initialization、repair、tail promotionをしない
- `append(event, at)`: 現commit pointとphysical fileの一致を確認し、次の `seq` の1行を`write_all`、journal `sync_all`、owner-only temporary commit metadataのwrite + `sync_all`、atomic replace、state directory barrierの順に実行する。最後まで成功して初めてappend成功。journal write開始後の失敗は `OutcomeUnknown`
- **10000件に達した後のappendは書き込まず `BoundExceeded`**（journal / metadata不変）。encoderもrange外の `seq` を生成できない
- 初期実装はCIとopen-flag ABIを検証した `x86_64-unknown-linux-gnu` 専用。x86_64 GNU/Linux CIでfile / directory barrier、atomic replace、lock、owner-only mode、artifact type / linkを検証する。x32を含む別ABIや別architecture / libcのLinux、macOS、BSD、Windowsなどの未検証targetは `Unavailable` でfail closedし、CLIもstore capabilityをadvertiseしない
- lock / journal / commit / temporary commitは検証済みtargetの`O_NOFOLLOW`で開き、open前後のdevice / inode、regular file、link count 1、state directoryと同じowner、exact `0600` modeを検査する。新規fileは作成fdから`0600`へ正規化する。temporary commitは検査済みのstale regular fileだけを除去し、`create_new`で作る。state directoryも`0700`へ正規化する
