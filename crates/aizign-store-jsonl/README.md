# aizign-store-jsonl

Append-only, metadata-only JSONL control journal with a writer-published committed prefix. Implements `aizign_engine::JournalReader` and `Journal`.

The sole current/target layout authority is
[`spec/store/v2/`](../../spec/store/v2/README.md), accepted by ADR-0028. This
crate still implements historical store v1 after S1; the v2 witness,
crash-monotonic publication, exact ext4 profile, and `rustix` dependency are
ordered S2 work and are not claimed as current runtime behavior here.

| | |
|---|---|
| **Responsibility** | Current runtime: `spec/journal/v1` recordをhistorical `spec/store/v1` commit metadataで公開。Accepted S2 target: `spec/store/v2` PREPARED/CLEAN witnessとexact profileによるcrash-monotonic publication。owner-only permission、shared / exclusive advisory lock、bounded cold read |
| **Non-responsibility** | 判断（duplicate / conflictは `aizign-core`）、wire format、state directoryの選択（`aizign-cli`） |
| **Inputs** | state directory、writerでは`WorkflowEvent` + `BoundedTimestamp` |
| **Outputs** | committed `JournalEntry` snapshot、appendした`JournalEntry`、`JournalError`（stable code付き） |
| **Hard invariants** | attempt / candidate digestをmetadata-onlyのclosed field setへ残す（5、10。allowed opaque valueのcontent semanticsはproducer責務）、write開始後のbarrier / publish失敗は `OutcomeUnknown` で再送しない（3）、readerはwrite / sync / initialize / repair / tail promotionを一切しない（9）、published prefix以外をacceptedの根拠にしない、既存recordを書き換えない、state artifactはregular file・single link・state directoryと同一ownerに固定してsymlinkを追跡しない |
| **Allowed dependencies** | Current S1/runtime rule remains `aizign-core`、`aizign-engine`、`serde`、`serde_json`、`sha2`。dev: `aizign-testkit`。ADR-0028 accepts exact `rustix = 1.1.4` for store-only S2 addition; it is not yet a current dependency or allowlist entry. |
| **Test command** | `cargo test -p aizign-store-jsonl` |
| **Related ADR** | [0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0007](../../docs/adr/0007-use-metadata-only-control-journals.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0014](../../docs/adr/0014-use-rustcrypto-sha2-for-committed-prefix-hashing.md)、[0028](../../docs/adr/0028-define-crash-monotonic-jsonl-publication.md) |

## Security boundary

The current v1 runtime enforces private modes, no-follow/path-shape checks,
single-link ownership, bounds, advisory locking, and a writer-published prefix
on `x86_64-unknown-linux-gnu`. The accepted S2 target additionally requires
`linux-x86_64-gnu-ext4-local-v1` fd-bound qualification and v2 publication.
The configured path and local account remain trusted. Advisory locks and
SHA-256 do not authenticate state against a
malicious same-user process that can rewrite every artifact consistently. See
the [v0.1 threat model](../../docs/security/threat-model.md).

record formatの正本は [`spec/journal/v1/`](../../spec/journal/v1/README.md)、current/target store layoutの正本は [`spec/store/v2/`](../../spec/store/v2/README.md)。historical v1はcompatibility rejectionとS2までのruntime debtとして[`spec/store/v1/`](../../spec/store/v1/README.md)に残る。`decode_record` / `encode_record` は
`spec/conformance/{valid,invalid}/journal` のfixtureを回すための入口で、同じfixtureを `spec/test/schema.test.mjs` が
JSON Schemaに通すため、schemaとruntimeの受理集合はCIで突き合わされる。

## Layout

```text
src/
├── lib.rs
├── journal.rs   JsonlJournal / JsonlJournalReader、durable initialization、lock、committed read、append / publish
├── observation.rs  Store-owned physical stage and journal-size observations
├── commit.rs    workflow.commit.json DTO、closed decoder、bounded SHA-256
├── json_member.rs member重複の事前検査（内部実装）
└── record.rs    record DTO（private）、encode_entry / decode_line、JOURNAL_SCHEMA_VERSION
tests/
└── jsonl_journal.rs   commit point、read-only、crash layout、tail、lock、permission、corrupt、bound、metadata-only
```

## Observation ownership

The engine owns only use-case stages. This crate owns the physical JSONL
stages (`JournalOpen`, committed-prefix read/hash/decode, and publish-prefix
hash) and the optional post-open journal byte count. `StoreStage`,
`StoreObservation`, and `StoreObserver` are store-qualified metadata-only
interfaces; they do not change journal results, durability, or the provisional
timing record.

`JsonlJournal::open_observed` and `JsonlJournalReader::open_observed` return
store-owned wrappers that implement the ordinary engine `Journal` and
`JournalReader` ports while retaining a best-effort observer. The raw
`open`, `load_committed`, and `append` paths do not emit store observations and
do not perform any observation-only I/O.

## Current runtime v1 behavior (S2 migration debt)

- `JsonlJournal::open(state_dir)`: exclusive non-blocking lockを取り、fresh storeならowner-only directory / lock / journal / zero-entry commit pointをwriter側でdurableに初期化する。途中までのempty initializationはexclusive lock下で完了できるが、non-empty journal without commit metadataは採用しない
- `JsonlJournalReader::open(state_dir)`: 既存artifactだけをread-onlyで開き、shared non-blocking lockを取る。missing artifactを作らず `Unavailable`、active writerは `Locked`
- `load_committed()`: `workflow.commit.json` が示すexact prefixだけをbounded decodeする。byte length / entry count / SHA-256の不一致やshort fileは `Corrupt`、extra tailは `OutcomeUnknown`。read pathはwrite、sync、initialization、repair、tail promotionをしない
- `append(event, at)`: 現commit pointとphysical fileの一致を確認し、次の `seq` の1行を`write_all`、journal `sync_all`、owner-only temporary commit metadataのwrite + `sync_all`、atomic replace、state directory barrierの順に実行する。最後まで成功して初めてappend成功。journal write開始後の失敗は `OutcomeUnknown`
- **10000件に達した後のappendは書き込まず `BoundExceeded`**（journal / metadata不変）。encoderもrange外の `seq` を生成できない
- 初期実装はCIとopen-flag ABIを検証した `x86_64-unknown-linux-gnu` 専用。x86_64 GNU/Linux CIでfile / directory barrier、atomic replace、lock、owner-only mode、artifact type / linkを検証する。x32を含む別ABIや別architecture / libcのLinux、macOS、BSD、Windowsなどの未検証targetは `Unavailable` でfail closedし、CLIもstore capabilityをadvertiseしない
- x32は64-bit targetとの誤認を防ぐcompile-only negative boundaryであり、durability実装、runtime test、release artifact、support claimは追加しない
- lock / journal / commit / temporary commitは検証済みtargetの`O_NOFOLLOW`で開き、open前後のdevice / inode、regular file、link count 1、state directoryと同じowner、exact `0600` modeを検査する。新規fileは作成fdから`0600`へ正規化する。temporary commitは検査済みのstale regular fileだけを除去し、`create_new`で作る。state directoryも`0700`へ正規化する
- 同じstate directoryを旧binaryで開くdowngradeはunsupportedであり、技術的には防止しない。旧binaryはcommit metadataを無視してjournalを変更できるため、operatorはstate directoryを分離する
