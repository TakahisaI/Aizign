# AGENTS.md — aizu-engine

このcrateを編集するときのnavigationと制約です。仕様は [README.md](README.md) と
[docs/architecture/](../../docs/architecture/overview.md) を参照してください。

## 読む順

1. [README.md](README.md) — 責務、port、不変条件
2. [docs/architecture/dependency-rules.md](../../docs/architecture/dependency-rules.md) — port ownership
3. `crates/aizu-core/src/workflow/` の公開面（`Command`、`Decision`、`WorkflowState`）
4. 編集対象のuse caseまたはport

store、cli、protocol、adapterの実装を読む必要はありません。

## 制約

- portはこのcrateが定義する。外部実装の都合でport shapeを決めない
- `std::fs` / `std::process` / `std::net` / `std::env` / `std::time` を使わない。時刻は `Clock` port、永続化は `Journal` port
- `serde`、JSON、harness固有名を持ち込まない
- `Decision::Accepted` を受け取ったら **appendがdurableになってから** acceptedを返す。append失敗・不明は `unknown` として返し、再送しない
- `ApplyError` / `JournalError::Corrupt` を握りつぶさない
- 新しいportは `README.md` の表と `dependency-rules.md` のport ownership表に行を足してから作る

## 検査

```sh
cargo test -p aizu-engine
cargo xtask public-audit
```
