# ADR-0005: Organize the core by bounded context

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0002

## Context

Aizuの目的の一つは、変更時にLLMと人が読む必要のあるcontextを局所化することである。
`models/`、`services/`、`repositories/` のような横断layer構造は、一つの機能変更で複数directoryを読ませ、
`common/` や `utils/` は時間とともにrepository全体の依存先になる。

## Decision

- `aizu-core` と `aizu-engine` は **bounded context単位** でmoduleを置く。workflowに関するcommand、event、state、decision、errorはすべて `workflow/` に置く。

  ```text
  workflow/
  ├── mod.rs
  ├── command.rs
  ├── event.rs
  ├── state.rs
  ├── decision.rs
  └── error.rs
  ```

- `common`、`utils`、`shared` moduleを作らない。共有化は少なくとも二つのcontextで実際に必要になり、依存方向を壊さないことを確認してから行う。当面の共有語彙はID、digest、bounded timestampなどの最小限（`identity`）だけ。
- Portは利用側が所有する。巨大な `ports/` packageを作らない。engineがjournalを必要とするなら、journal traitはengineが定義し、storeが実装する。
- `AppContext`、`GlobalState`、`Services`、`Container`、`Dependencies` のような汎用objectを渡さない。use caseには必要な小さなcapabilityだけを渡す。composition rootは `aizu-cli` だけに置く。
- public APIは明示する。Rustは `pub(crate)` を既定にし、`lib.rs` で意図した型だけを公開する。wildcard re-exportをしない。TypeScriptは `exports` mapをclosedにし、deep importを許さない。
- testは所有contextの近くに置く。Rust unit testは対象module、cross-module testはcrateの `tests/`、adapter conformanceは `test/conformance/`、protocol fixtureだけをrepository共通の `spec/conformance/` に置く。
- 各crate、adapter、主要contextには、Responsibility、Non-responsibility、Inputs、Outputs、Hard invariants、Allowed dependencies、Test command、関連ADRを記載した `README.md` を置く。`AGENTS.md` はnavigationと編集制約だけを書き、新しい仕様書にしない。

## Consequences

### Positive

- 一つのcontextの変更で読む範囲が一か所に閉じる
- 依存方向が `cargo xtask public-audit` と `unreachable_pub` lintで検査できる

### Negative / Risks

- contextの切り方を誤ると、moduleを跨ぐ変更が増える。context mapを維持し、跨ぐ変更はPR本文で理由を書く

### Follow-up

- 現在のcontext一覧は [docs/architecture/context-map.md](../architecture/context-map.md)

## Alternatives considered

- **layer構造（models / services / repositories）** — 一機能の変更が全layerに散り、contextの局所化に反する。
- **単一の巨大な `ports` crate** — 外部実装の都合がcore interfaceを決めるようになり、利用側所有の原則に反する。
