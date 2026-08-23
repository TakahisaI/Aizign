# spec

機械可読な契約の正本です。文書（`docs/`）はこれを説明する側で、実装（`crates/`、`packages/`）はこれに従う側です。

| Directory | 内容 | 実装 |
|---|---|---|
| `protocol/vN/` | wire contract。JSON Schema（draft 2020-12）と example | `crates/aizu-protocol`、`packages/protocol` |
| `journal/vN/` | durable format。journal recordのschema | `crates/aizu-store-jsonl`（未作成） |
| `conformance/` | 全実装が同じ判定をすべきfixture（`.frame` + `.expect.json`） | `cargo xtask conformance`（構造）、`crates/aizu-protocol/tests/conformance.rs`（Rust）、`packages/protocol`（TypeScript、後続） |

- `vN` はprotocol version / journal schema versionで、package versionとは独立（ADR-0008）
- release後に既存schemaのshapeを変えない。新機能は新しいkindまたはrecord kindとして追加し、破壊的変更はversionを上げる
- exampleは架空のnon-confidentialな値だけを使う
