# Testing

## 置き場

| 種類 | 場所 |
|---|---|
| Rust unit test | 対象moduleの `#[cfg(test)] mod tests` |
| Rust cross-module test | crateの `tests/` |
| TypeScript unit test | 対象sourceに近接（`src/**/*.test.ts`） |
| adapter conformance | `adapters/<harness>/test/conformance/` |
| protocol fixture | `spec/conformance/valid/`、`spec/conformance/invalid/`（repository共通。RustとTypeScriptの両方が同じfileを読む） |

rootに巨大なtest directoryを作りません。

## 実行

```sh
cargo xtask check          # PR前の全検査
cargo test --workspace     # Rustだけ
cargo test -p aizu-core    # crate単位
```

## 検査の境界

- 通常のtestはfake harnessとfake core processで完結する。実harness、browser、providerを起動しない
- core CIはNodeやDSHがなくても単独で成功する
- live smokeは `workflow_dispatch` またはlocal opt-inだけ。成否を通常releaseのrequired checkにしない

## 何をtestするか

Aizuのtestは「成功件数」だけでなく **守る境界を一度壊して検出できること** を確認します。

- closed schema: 未知fieldを持つrequest / recordが拒否される
- duplicate / conflict: 同一identity・同一内容は `duplicate`、異内容は `conflict`
- unknown: 結果不明の操作が成功や失敗へ縮約されない
- data boundary: harness IDや本文がprotocol requestやjournalへ漏れない
- dependency boundary: `public-audit` が違反を検出する（違反を仕込んだfixtureで検査）

## Fixture

protocol fixtureは [`spec/conformance/`](../../spec/conformance/README.md) に置きます。

- `valid/{request,response}/<name>.frame` — 受理すべきframe。decode → encodeでJSONとして等しいこと
- `invalid/{request,response}/<name>.frame` + `<name>.expect.json` — 拒否すべきframeと、期待するcode（requestは復元されるべき `requestId` / `kind` も）
- `cargo xtask conformance` が構造を検査し、`crates/aizu-protocol/tests/conformance.rs` がRust decoderで全件を通す。loaderは `aizu_testkit::conformance`
- 新しい拒否経路を実装したら、fixtureも同じPRで追加する

fixtureはnon-confidentialな架空の値だけを使い、実際のpath、ID、本文を含めません。
