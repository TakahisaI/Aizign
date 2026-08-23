# AGENTS.md — aizu-core

このcrateを編集するときのnavigationと制約です。仕様は [README.md](README.md) と
[docs/architecture/](../../docs/architecture/overview.md) を参照してください。

## 読む順

1. [README.md](README.md) — 責務、非責務、不変条件
2. [docs/architecture/context-map.md](../../docs/architecture/context-map.md) — どのmoduleに置くか
3. [docs/architecture/data-boundary.md](../../docs/architecture/data-boundary.md) — 受け取ってよい値
4. 編集対象のcontext directory（例: `src/workflow/`）だけ

adapter、protocol、storeの実装を読む必要はありません。

## 制約

- `#![no_std]` と `#![forbid(unsafe_code)]` を外さない。`std` を使わない
- crate依存を追加しない（追加にはADRと `docs/architecture/dependency-rules.md` の更新が必要）
- `serde` derive、JSON、NDJSONをこのcrateへ持ち込まない
- 現在時刻、乱数、環境変数を取得しない。必要な値は引数で受け取る
- harness / providerの固有名（DSH、Codex、Hermesなど）をidentifier、comment、docに書かない
- 新しいmoduleは必ずbounded contextとして `context-map.md` に行を足してから作る。`common` / `utils` / `shared` を作らない
- `pub` は `lib.rs` から意図的に公開する型だけ。既定は `pub(crate)`。`unreachable_pub` lintを無視しない
- 同一identity・同一内容は `duplicate`、異内容は `conflict`。`unknown` を成功や失敗へ縮約しない
- testは対象moduleの `#[cfg(test)]`、cross-moduleは `tests/`

## 検査

```sh
cargo test -p aizu-core
cargo xtask public-audit
```
