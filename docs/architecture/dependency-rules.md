# Dependency rules

依存方向の正本です。`cargo xtask public-audit` がこの表と同じ規則を機械的に検査します
（検査の実装は `xtask/src/audit/dependencies.rs`。表と実装がずれたら実装を直すのではなく、両方を同じPRで更新してください）。

## 方向

```text
aizu-cli ─────┬──────────────┬──────────────┬─────────────┐
              ▼              ▼              ▼             ▼
       aizu-protocol  aizu-store-jsonl  aizu-engine  aizu-testkit
              │              │              │             │
              │              └──────┬───────┘             │
              ▼                     ▼                     ▼
           aizu-core ◄──────────────┴─────────────────────┘
```

矢印の向きにだけ依存できます。逆方向、および表にない依存は禁止です。

## Rust crates

| Crate | 依存してよいworkspace crate | dev-dependencyでのみ追加可 | 依存してよい外部crate | 備考 |
|---|---|---|---|---|
| `aizu-core` | なし | なし | **なし**（dev-dependenciesも含む） | `#![no_std]`、`#![forbid(unsafe_code)]`。追加にはADR |
| `aizu-engine` | `aizu-core` | `aizu-testkit` | なし | portを定義する側 |
| `aizu-protocol` | `aizu-core` | `aizu-testkit` | `serde`、`serde_json` | DTOはここで定義。domain型をderiveしない（ADR-0009） |
| `aizu-store-jsonl` | `aizu-core`、`aizu-engine` | `aizu-testkit` | `serde`、`serde_json` | engineの `Journal` portを実装 |
| `aizu-testkit` | `aizu-core`、`aizu-engine`、`aizu-protocol` | なし | `serde_json` | memory journal、journal contract、signal helper、fixture loader |
| `aizu-cli` | 上記すべて | `aizu-testkit` | `serde_json`（引数parseは標準libraryで十分な範囲に留める） | composition root。ここ以外でworkspace全体を束ねない |
| `xtask` | なし（workspace crateに依存しない） | なし | `serde_json` | repository tooling。公開artifactではない |

外部crateの追加は「新しいruntime dependency」としてADRを要します（[CONTRIBUTING.md](../../CONTRIBUTING.md#adrが必要な変更)）。
dev-dependencyの追加もこの表の更新を要します（`aizu-core` には追加しない）。`aizu-testkit` はtest専用で、runtime依存にはしません。

## `aizu-core` で禁止するもの

source中に次が現れたら `public-audit` が失敗します。

| 禁止 | 理由 |
|---|---|
| `std::fs`、`std::process`、`std::net`、`std::env`、`std::io` | I/Oはshellが所有 |
| `std::time`、`std::thread`、`std::sync::mpsc` | clockとschedulingはshellが所有。時刻はbounded timestampとして値で渡す |
| `async`、`tokio`、`futures` | async runtimeを持ち込まない |
| `serde`、`serde_json` | serializationはprotocol / storeが所有（ADR-0004） |
| `unsafe` | `forbid(unsafe_code)` |
| harness / providerの固有名（`dsh`、`codex`、`hermes`、`deepseek`、`openai`、`anthropic`） | coreは固有名を知らない |

| 規則 | 適用されるcrate |
|---|---|
| harness / providerの固有名の禁止 | `crates/` 配下のすべて（`xtask` を除く） |
| I/O、clock、scheduling、asyncの禁止 | `aizu-core`、`aizu-engine`、`aizu-protocol`（functional coreの内側） |
| `serde` の禁止 | `aizu-core`、`aizu-engine` |

`aizu-store-jsonl` と `aizu-cli` はshellなのでI/Oを所有します。`aizu-testkit` はfixtureを読むためにfilesystemを使ってよいが、固有名は持ち込みません。

## TypeScript packages

| Package | 依存してよいworkspace package | 外部依存 |
|---|---|---|
| `@aizu/protocol` | なし | なし（validatorは自前。`node:` 組み込みも使わない） |
| `@aizu/adapter-testkit` | `@aizu/protocol` | なし（`node:child_process` / `node:fs` / `node:assert` の組み込みのみ） |
| `@aizu/adapter-<harness>` | `@aizu/protocol`、`@aizu/adapter-testkit`（devのみ） | そのharnessのSDK（exact version、peer + dev。ADR-0010） |

- package間はworkspace依存だけを使い、相対pathで別packageのsourceをimportしない
- 開発toolchain（`typescript`、`@biomejs/biome`、`@types/node`）はroot `package.json` にexact versionで置き、各packageには置かない
- `exports` mapはclosed。`./*` のようなwildcardを許さない
- adapterから `aizu-core` / `aizu-engine` の型を参照しない。契約は `@aizu/protocol` だけ

## Port ownership

| Port | 定義する側 | 実装する側 | 状態 |
|---|---|---|---|
| `Journal` | `aizu-engine` | `aizu-store-jsonl`、`aizu-testkit`（`MemoryJournal`） | 実装済み |
| `Clock` | `aizu-engine` | `aizu-cli`（system）、`aizu-testkit`（`FixedClock`） | 実装済み |
| `EffectSink` | `aizu-engine` | `aizu-cli`（protocol responseとして返す） | 後続 |
| Harness adapter contract | `@aizu/protocol` / `spec/protocol` | 各adapter |

## 横断的な置き場の禁止

`common`、`utils`、`shared`、`ports`（巨大な単一package）、`AppContext`、`GlobalState`、`Services`、`Container`、`Dependencies` を作らない。
共有は、二つ以上のcontextで実際に必要になり、方向を壊さないことを確認してから `identity` のような最小語彙に限って行う。
