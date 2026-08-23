# aizu-testkit

Test doubles and shared contract checks for Aizu crates. Not a published artifact.

| | |
|---|---|
| **Responsibility** | engineのportのin-memory実装（fault injection付き）、port実装が共有するcontract check、testで使う正しいsignalの生成 |
| **Non-responsibility** | 本番で使われるcode。runtime依存として参照されること |
| **Inputs** | — |
| **Outputs** | `MemoryJournal`、`journal_contract::run`、`signals::*` |
| **Hard invariants** | doubleは本物のportと同じ契約を満たす（contractで検査）。`unknown` を注入できること |
| **Allowed dependencies** | `aizu-core`、`aizu-engine`（`aizu-protocol` は後続） |
| **Test command** | `cargo test -p aizu-testkit` |
| **Related ADR** | [0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md) |

## Layout

```text
src/
├── lib.rs
├── memory_journal.rs     MemoryJournal: fail_next_load / fail_next_append / lose_next_append_acknowledgement
├── journal_contract.rs   run(&mut impl Journal): 空、append順、seq連番、read-after-append、重複除去しないこと
└── signals.rs            expected() / implementation_ready(id) / blocked(id, code) / at(offset)
```

`lose_next_append_acknowledgement` は「書けたがACKが失われた」crashを再現します。engineはこれを `unknown` として扱い、再送してはいけません。
