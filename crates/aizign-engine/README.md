# aizign-engine

Application engine around `aizign-core`: use cases, and the ports the shell must supply.

| | |
|---|---|
| **Responsibility** | journalのload、coreへのcommand適用、eventのappend、effectのclaim、effect resultのcoreへの還元、timeoutとbounded operation、portの定義 |
| **Non-responsibility** | 判断（`aizign-core`）、wire format（`aizign-protocol`）、I/Oの実装（store、cli）、harness固有型 |
| **Inputs** | `Command`、portの実装（`Journal` など） |
| **Outputs** | use caseのoutcome（accepted / duplicate / rejected / unknown） |
| **Hard invariants** | `accepted` を報告するのはappendがdurableになった後だけ（2）、`JournalError::OutcomeUnknown` を成功にも失敗にも縮約せず再送しない（3、4）、journalの不整合を黙って吸収しない |
| **Allowed dependencies** | `aizign-core`。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-engine` |
| **Related ADR** | [0002](../../docs/adr/0002-implement-the-deterministic-core-in-rust.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md)、[0007](../../docs/adr/0007-use-metadata-only-control-journals.md) |

## Ports（engineが定義し、外側が実装する）

| Port | 実装 | 状態 |
|---|---|---|
| `Journal` | `aizign-store-jsonl::JsonlJournal`、`aizign-testkit::MemoryJournal` | 実装済み |
| `Clock` | `aizign-cli`（system clock）、`aizign-testkit::FixedClock` | 実装済み |
| `EffectSink` | `aizign-cli` | 後続（最初のeffect intentとともに） |

## Layout

```text
src/
├── lib.rs       意図した型だけを公開
├── journal.rs   Journal trait、JournalEntry、JournalError（stable code付き）、MAX_JOURNAL_ENTRIES
├── clock.rs     Clock trait、ClockError
└── handle.rs    handle_workflow_signal、SignalOutcome、HandleError
tests/
└── handle_workflow_signal.rs   accepted / duplicate / rejected / journal失敗 / ACK喪失 / corrupt / clock失敗
```

## Use case: `handle_workflow_signal`

```text
journal.load() → WorkflowState::replay → decide
  Accepted  → clock.now() → journal.append → SignalOutcome::Accepted { entry }
  Duplicate → SignalOutcome::Duplicate（appendしない）
  Rejected  → HandleError::Rejected（appendしない）
```

- `JournalError::OutcomeUnknown` は `HandleError::Journal` としてそのまま返す。engineは再送しない
- replayの不整合（同一 `event_id` の再適用、digest再binding、不正または再消費されたrepair source）は `HandleError::Replay` → code `JOURNAL_CORRUPT`
