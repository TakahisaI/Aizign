# aizu-core

Pure, deterministic decisions for Aizu software-change workflows.

| | |
|---|---|
| **Responsibility** | workflow state、identityとbinding、command validation、event application、duplicateとconflict、next actionの決定、effect intent、authorization state、recovery disposition、usage observationの共通型 |
| **Non-responsibility** | I/O、clock、process、network、environment、async runtime、harness / provider SDK、Git、serialization（wire / journal）、harness固有名 |
| **Inputs** | `State`、`Command`、`Event`、shellが与えるbounded timestamp |
| **Outputs** | `Decision`（追加するevent、effect intent、または説明可能なrejection）、次の `State` |
| **Hard invariants** | root [AGENTS.md](../../AGENTS.md#hard-invariants) の12項目。特に 1、4、5、8、12 はこのcrateが直接担う |
| **Allowed dependencies** | なし（`dependencies`、`dev-dependencies` ともに空。`#![no_std]` + `core` / `alloc` のみ） |
| **Test command** | `cargo test -p aizu-core` |
| **Related ADR** | [0002](../../docs/adr/0002-implement-the-deterministic-core-in-rust.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md) |

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
├── identity.rs      stable ID、digest、bounded timestampの最小語彙
├── workflow/        command.rs / event.rs / state.rs / decision.rs / error.rs
└── ...              execution / evidence / workspace / authorization / integration / recovery / usage は後続
```

現在は殻だけです。最初の縦切り（identity、workflow command、decision）はMilestone `v0.1 — Foundation` のIssueで追加します。

## 依存規則の検査

`cargo xtask public-audit` が、このcrateに依存がないこと、禁止されたstd moduleや固有名がsourceに現れないことを検査します。
`#![no_std]` により `std::fs` / `std::process` / `std::net` / `std::env` / `std::time` はcompile時点で使えません。
