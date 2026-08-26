# aizign-engine

Application engine around `aizign-core`: use cases, and the ports the shell must supply.

| | |
|---|---|
| **Responsibility** | Committed journal snapshot load, workflow-signal decision and accepted-event append, read-only workflow-signal reconciliation, metadata-only stage observation, bounded operation, and current journal/clock ports |
| **Non-responsibility** | 判断（`aizign-core`）、wire format（`aizign-protocol`）、I/Oの実装（store、cli）、harness固有型 |
| **Inputs** | `Command` / queried `WorkflowSignal`、portの実装（`JournalReader` / `Journal` など） |
| **Outputs** | `SignalOutcome::Accepted` / `Duplicate` or `HandleError`; reconciliation `Accepted` / `Conflict` / `Absent` or `ReconcileError`. Protocol/client layers own rejected/unknown client mapping. |
| **Hard invariants** | Report a server `accepted` disposition only after the accepted event is durably appended; preserve `JournalError::OutcomeUnknown` without success/failure inference or retry (3, 4); give reconciliation no append or clock dependency (9); never hide journal inconsistency. Invariant 2 is a future-effect principle and is not evidence of a current effect operation. |
| **Allowed dependencies** | `aizign-core`。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-engine` |
| **Related ADR** | [0002](../../docs/adr/0002-implement-the-deterministic-core-in-rust.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md)、[0007](../../docs/adr/0007-use-metadata-only-control-journals.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md) |

## Security boundary

The engine preserves the decision and storage classifications supplied by its
ports. It cannot manufacture durability, repair an uncertain append, establish
configuration provenance, or authorize retry after `unknown`/`absent`. The
enforcement and trust split is recorded in the
[v0.1 threat model](../../docs/security/threat-model.md).

## Ports（engineが定義し、外側が実装する）

| Port | 実装 | 状態 |
|---|---|---|
| `JournalReader` | `aizign-store-jsonl::JsonlJournalReader` / `JsonlJournal`、`aizign-testkit::MemoryJournal` | 実装済み |
| `Journal`（`JournalReader`を拡張） | `aizign-store-jsonl::JsonlJournal`、`aizign-testkit::MemoryJournal` | 実装済み |
| `Clock` | `aizign-cli`（system clock）、`aizign-testkit::FixedClock` | 実装済み |
| `EngineObserver` | `aizign-cli`（opt-in timing） | 実装済み。時計とI/Oはshell側。callback panicは最初の一回で隔離し、そのoperationでは以後無効化 |

## Layout

```text
src/
├── lib.rs       意図した型だけを公開
├── journal.rs   JournalReader / Journal trait、JournalEntry、JournalError（stable code付き）、MAX_JOURNAL_ENTRIES
├── observation.rs EngineObserverとprefix read / hash / decode / replay / decide / append / publish hashのstage境界
├── clock.rs     Clock trait、ClockError
├── handle.rs    handle_workflow_signal、SignalOutcome、HandleError
└── reconcile.rs reconcile_workflow_signal、ReconcileError
tests/
├── handle_workflow_signal.rs   accepted / duplicate / rejected / journal失敗 / ACK喪失 / corrupt / clock失敗
└── reconcile_workflow_signal.rs accepted / conflict / absent / journal・replay failure / append不在
```

非observed APIは通常の`load_committed`と`append`だけを呼び、observer portを通りません。
observed APIとstore実装はcaller-supplied observerを`BestEffortObserver`で包み、callback panicがworkflow outcomeやcommit publicationを変えないようにします。

## Use case: `handle_workflow_signal`

```text
journal.load_committed() → WorkflowState::replay → decide
  Accepted  → clock.now() → journal.append → SignalOutcome::Accepted { entry }
  Duplicate → SignalOutcome::Duplicate（appendしない）
  Rejected  → HandleError::Rejected（appendしない）
```

- `JournalError::OutcomeUnknown` は `HandleError::Journal` としてそのまま返す。engineは再送しない
- replayの不整合（同一 `event_id` の再適用）は `HandleError::Replay` → code `JOURNAL_CORRUPT`

## Use case: `reconcile_workflow_signal`

```text
JournalReader.load_committed() → WorkflowState::replay → pure reconcile
  same eventId + exact content → Accepted
  same eventId + changed content → Conflict
  no eventId → Absent
```

- 引数は`JournalReader`だけで、append、clock、effect、recovery writeを型レベルで利用できない
- journal open / lock / schema / corruption / bound / unpublished tailは`ReconcileError`として返し、shell / clientがsemantic `unknown`へ写像する

## Current/future boundary

The engine has no external-effect dispatch, claim, result recording, or
effect-reconciliation use case or port. No `EffectSink` ownership is reserved.
Promotion requires an accepted Issue and any required ADR that name the
consumer and owner; define the Protocol kind/capability; define the durable
record, authority, and state shape; define failure, unknown, retry, and
reconciliation semantics; and identify executable tests. This does not decide
the executor work in #87.
