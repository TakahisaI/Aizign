# Dependency rules

依存方向の正本です。`cargo xtask public-audit` がこの表と同じ規則を機械的に検査します
（検査の実装は `xtask/src/audit/dependencies.rs`。表と実装がずれたら実装を直すのではなく、両方を同じPRで更新してください）。

## 方向

```text
aizign-cli ─────┬──────────────┬──────────────┬─────────────┐
              ▼              ▼              ▼             ▼
       aizign-protocol  aizign-store-jsonl  aizign-engine  aizign-testkit
              │              │              │             │
              │              └──────┬───────┘             │
              ▼                     ▼                     ▼
           aizign-core ◄──────────────┴─────────────────────┘
```

矢印の向きにだけ依存できます。逆方向、および表にない依存は禁止です。

## Rust crates

| Crate | 依存してよいworkspace crate | dev-dependencyでのみ追加可 | 依存してよい外部crate | 備考 |
|---|---|---|---|---|
| `aizign-core` | なし | なし | **なし**（dev-dependenciesも含む） | `#![no_std]`、`#![forbid(unsafe_code)]`。追加にはADR |
| `aizign-engine` | `aizign-core` | `aizign-testkit` | なし | portを定義する側 |
| `aizign-protocol` | `aizign-core` | `aizign-testkit` | `serde`、`serde_json` | DTOはここで定義。domain型をderiveしない（ADR-0009） |
| `aizign-store-jsonl` | `aizign-core`、`aizign-engine` | `aizign-testkit` | `serde`、`serde_json`、`sha2`（ADR-0014） | engineの `JournalReader` / `Journal` portを実装。SHA-256はcommitted-prefix metadata専用 |
| `aizign-testkit` | `aizign-core`、`aizign-engine`、`aizign-protocol` | なし | `serde_json` | memory journal、journal contract、signal helper、fixture loader |
| `aizign-cli` | 上記すべて | `aizign-testkit` | `serde_json`（引数parseは標準libraryで十分な範囲に留める） | composition root。ここ以外でworkspace全体を束ねない |
| `xtask` | なし（workspace crateに依存しない） | なし | `serde_json` | repository tooling。公開artifactではない |

外部crateの追加は「新しいruntime dependency」としてADRを要します（[CONTRIBUTING.md](../../CONTRIBUTING.md#adrが必要な変更)）。
dev-dependencyの追加もこの表の更新を要します（`aizign-core` には追加しない）。`aizign-testkit` はtest専用で、runtime依存にはしません。

## `aizign-core` で禁止するもの

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
| I/O、clock、scheduling、asyncの禁止 | `aizign-core`、`aizign-engine`、`aizign-protocol`（functional coreの内側） |
| `serde` の禁止 | `aizign-core`、`aizign-engine` |

`aizign-store-jsonl` と `aizign-cli` はshellなのでI/Oを所有します。`aizign-testkit` はfixtureを読むためにfilesystemを使ってよいが、固有名は持ち込みません。

## TypeScript packages

この節はrepository内のTypeScript / Node packageだけに適用します。言語中立のadapter
contractの正本は[`harness-adapter-contract.md`](harness-adapter-contract.md)です。
非TypeScript adapterにnpm packageやこのworkspace依存を要求しません。

| Package | 依存してよいworkspace package | 外部依存 |
|---|---|---|
| `@aizign/protocol` | なし | なし（validatorは自前。`node:` 組み込みも使わない） |
| `@aizign/adapter-testkit` | `@aizign/protocol` | なし（`node:child_process` / `node:fs` / `node:assert` の組み込みのみ） |
| `@aizign/adapter-<harness>` | `@aizign/protocol`、`@aizign/adapter-testkit`（devのみ） | そのharnessのSDK（exact version、peer + dev。ADR-0010） |

- package間はworkspace依存だけを使い、相対pathで別packageのsourceをimportしない
- 開発toolchain（`typescript`、`@biomejs/biome`、`@types/node`、`ajv`）はroot `package.json` にexact versionで置き、各packageには置かない。`ajv` は `spec/` のJSON Schema gate（`spec/test/`）専用で、publishされるpackageからは参照しない（`@aizign/protocol` の外部依存は引き続き **なし**）
- `exports` mapはclosed。`./*` のようなwildcardを許さない
- TypeScript adapterから `aizign-core` / `aizign-engine` の型を参照しない。wire型は
  `@aizign/protocol` を使う。全adapterのbehavioral contractは
  `docs/architecture/harness-adapter-contract.md`、wire contractは `spec/protocol/` が所有する

## Port ownership

| Port | 定義する側 | 実装する側 | 状態 |
|---|---|---|---|
| `JournalReader` | `aizign-engine` | `aizign-store-jsonl`、`aizign-testkit`（`MemoryJournal`） | 実装済み |
| `Journal` | `aizign-engine` | `aizign-store-jsonl`、`aizign-testkit`（`MemoryJournal`） | 実装済み（`JournalReader`を拡張） |
| `Clock` | `aizign-engine` | `aizign-cli`（system）、`aizign-testkit`（`FixedClock`） | 実装済み |
| `EngineObserver` | `aizign-engine` | `aizign-cli`（opt-in timing） | 実装済み。engineは時計とI/Oを持たず、callback panicをbest-effort境界で隔離する |
| Harness adapter behavioral contract | `docs/architecture/harness-adapter-contract.md` | 各adapter |
| Core--adapter wire contract | `spec/protocol/` | Rust / TypeScript codec、各adapter |

There is no current external-effect port. A future port or executor dependency
is provisional and is not reserved to `aizign-engine`, `aizign-cli`, or any
other package. Promotion requires an accepted Issue and any required ADR that
name the consumer and owner; define the Protocol kind/capability; define the
durable record, authority, and state shape; define failure, unknown, retry, and
reconciliation semantics; and identify tests. This rule preserves dependency
direction without deciding #87.

## 横断的な置き場の禁止

`common`、`utils`、`shared`、`ports`（巨大な単一package）、`AppContext`、`GlobalState`、`Services`、`Container`、`Dependencies` を作らない。
共有は、二つ以上のcontextで実際に必要になり、方向を壊さないことを確認してから `identity` のような最小語彙に限って行う。
