# aizign-core

Pure, deterministic decisions for Aizign software-change workflows.

| | |
|---|---|
| **Responsibility** | Workflow-signal state, identity and binding, command validation, accepted-event application, duplicate/conflict decisions, and pure recovery disposition |
| **Non-responsibility** | I/O、clock、process、network、environment、async runtime、harness / provider SDK、Git、serialization（wire / journal）、harness固有名 |
| **Inputs** | `State`、`Command`、`Event`、shellが与えるbounded timestamp |
| **Outputs** | `Decision` (accepted event, duplicate, or explainable rejection) and replayed `State` |
| **Hard invariants** | [docs/architecture/invariants.md](../../docs/architecture/invariants.md) の12項目。特に 1、4、5、8、12 はこのcrateが直接担う |
| **Allowed dependencies** | なし（`dependencies`、`dev-dependencies` ともに空。`#![no_std]` + `core` / `alloc` のみ） |
| **Test command** | `cargo test -p aizign-core` |
| **Related ADR** | [0002](../../docs/adr/0002-implement-the-deterministic-core-in-rust.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md) |

## Security boundary

The core validates shapes, compares configured identity/digests, and makes
deterministic decisions. It does not possess candidate bytes or prove that a
well-formed value came from the intended control plane. That provenance is a
trusted outer-boundary assumption; see the
[v0.1 threat model](../../docs/security/threat-model.md).

## 基本形

```text
State + Command -> Decision
State + Event   -> State
```

## Layout

bounded context単位でmoduleを置きます。配置の正本は
[docs/architecture/context-map.md](../../docs/architecture/context-map.md) です。

```text
src/
├── lib.rs           意図した型だけを公開する（wildcard re-exportなし）
├── identity.rs      stable ID、digest、bounded timestamp、short error codeの最小語彙
├── workflow/
│   ├── mod.rs       contextの公開面
│   ├── signal.rs    Role、SignalKind、WorkflowSignal（validate）、ExpectedAssignment
│   ├── command.rs   Command::SubmitSignal
│   ├── event.rs     WorkflowEvent::SignalAccepted
│   ├── state.rs     WorkflowState（BTreeMap）、apply / replay
│   ├── decision.rs  decide(state, command) -> Decision
│   └── error.rs     WorkflowError（short error code付き）、InvalidSignal
├── recovery/
│   └── mod.rs       replay済みstateとfull signalのpureなaccepted / conflict / absent分類
└── ...              execution / evidence / workspace / authorization / integration / usage は後続
```

```text
tests/workflow_signal.rs    cross-module: accepted / duplicate / conflict / mismatch順 / replay
tests/workflow_recovery.rs  exact content / conflict / absentのpure reconciliation
```

## Workflow contextの契約

- `decide` はstateを変更しない。`Decision::Accepted { event }` を受け取ったshellは、**eventをdurableにappendしてから** 受理を報告する
- `Decision::Duplicate` は同一 `event_id` ・同一内容。appendしない
- `Decision::Rejected { error }` は `error.code()` のshort error codeで説明できる。appendしない
- `WorkflowState::apply` / `replay` は同一 `event_id` の再適用を `ApplyError::DuplicateEvent` にする。journalの不整合をshellが黙って吸収しないため
- expectationはworkflow → assignment → attempt → role → revision identifier → candidate digestの順で照合する
- candidate pairはcommandとaccepted event contentへbindする。stateは異なるevent間のrevision-to-digest registryを持たない

## Recovery contextの契約

- `reconcile_workflow_signal(state, signal)` はreplay済みstateを変更せず、同一`eventId`の保存済みsignalとoptional fieldを含むexact contentを比較する
- exact matchは`Accepted`、同一IDで内容差は`Conflict`、IDが存在しなければ`Absent`
- durability、I/O failure、storage missingはcoreの語彙に含めず、engine / storeがcoreを呼ぶ前に処理する

## Current/future boundary

This crate currently has no external-effect intent, claim state, dispatch
decision, result, or effect-reconciliation operation. Those names are not part
of its public API. A future contract must first satisfy the consumer, owner,
Protocol kind/capability, durable record/authority/state shape,
failure/reconciliation, and test trigger in the
[architecture overview](../../docs/architecture/overview.md#futureprovisional-inventory).

## 依存規則の検査

`cargo xtask public-audit` が、このcrateに依存がないこと、禁止されたstd moduleや固有名がsourceに現れないことを検査します。
`#![no_std]` により `std::fs` / `std::process` / `std::net` / `std::env` / `std::time` はcompile時点で使えません。
