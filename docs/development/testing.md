# Testing

## 置き場

| 種類 | 場所 |
|---|---|
| Rust unit test | 対象moduleの `#[cfg(test)] mod tests` |
| Rust cross-module test | crateの `tests/` |
| TypeScript unit test | 対象sourceに近接（`src/**/*.test.ts`、`node --test`） |
| language-neutral adapter scenario authority | `docs/architecture/harness-adapter-contract.md` |
| decoder fixture / full-codec round trip | `spec/conformance/valid/`、`spec/conformance/invalid/` |
| directional encoder conformance | `spec/conformance/encoder-scenarios.md` + `spec/protocol/v1/examples/` |
| shared TypeScript core-client runner | `packages/adapter-testkit/` の `runCoreClientConformance` |
| adapter-specific core-client invocation | `adapters/<harness>/test/conformance/core-client.*` |
| harness-native behavior | adapterの `test/unit/` または責務が明示されたnative-conformance test |

rootに巨大なtest directoryを作りません。
directory名だけでtest authorityを判断しません。例えばDSHの
`test/conformance/core-client.test.ts`はshared runnerをadapter実装へ適用する場所で、
harness-native persistenceやregistrationのauthorityではありません。

## 実行

```sh
cargo xtask quick              # repository-wide development baseline
cargo xtask quick protocol     # protocol, journal, fixture, and schema checks
cargo xtask quick adapter-dsh  # DSH adapter with a freshly built real binary
cargo xtask check              # full Rust and TypeScript gate before a PR
cargo test --workspace         # Rustだけ
cargo test -p aizign-core        # crate単位
npm run check                  # TypeScriptだけ
npm test -w @aizign/protocol     # package単位
cargo xtask performance-baseline # x86_64 GNU/Linux上のmanual performance observation
```

The `quick` profiles use the existing Cargo cache and `node_modules` without installing from the network.
See [`xtask/README.md`](../../xtask/README.md#quick-profiles) for each profile's order, guarantees, and exclusions from the full gate.

## 検査の境界

- 通常のtestはfake harnessとfake core processで完結する。実harness、browser、providerを起動しない
- core CI（`Rust` job）はNodeやDSHがなくても単独で成功する
- `TypeScript` jobは実 `aizign` binaryをbuildし、TypeScript client → binary → JSONL journal の往復を `@aizign/adapter-testkit` の `runCoreScenarios` で検査する
- live smokeは `workflow_dispatch` またはlocal opt-inだけ。成否を通常releaseのrequired checkにしない
- runtime performance baselineはscheduledまたはmanualだけで実行し、pull request gateにしない。契約とsamplingは[`benchmarks/runtime/README.md`](../../benchmarks/runtime/README.md)を参照する

## 何をtestするか

Aizignのtestは「成功件数」だけでなく **守る境界を一度壊して検出できること** を確認します。

- closed schema: 未知fieldを持つrequest / recordが拒否される
- duplicate / conflict: 同一identity・同一内容は `duplicate`、異内容は `conflict`
- unknown: 結果不明の操作が成功や失敗へ縮約されない
- data boundary: harness IDや本文がprotocol requestやjournalへ漏れない
- dependency boundary: `public-audit` が違反を検出する（違反を仕込んだfixtureで検査）

## Fixture

protocol fixtureは [`spec/conformance/`](../../spec/conformance/README.md) に置きます。

- `valid/{request,response}/<name>.frame` — 受理すべきframe。decode → encodeでJSONとして等しいこと
- `invalid/{request,response}/<name>.frame` + `<name>.expect.json` — 拒否すべきframeと、期待するcode（requestは復元されるべき `requestId` / `kind` も）
- `cargo xtask conformance` が構造を検査し、`crates/aizign-protocol/tests/conformance.rs`（Rust）と `packages/protocol/src/conformance.test.ts`（TypeScript）が同じfileで全件を通す
- 新しい拒否経路を実装したら、fixtureも同じPRで追加する

fixtureはnon-confidentialな架空の値だけを使い、実際のpath、ID、本文を含めません。
