# ADR-0002: Implement the deterministic core in Rust

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0003, ADR-0005, ADR-0017

> **Partial supersession:** [ADR-0017](0017-bound-v0-1-classification-to-current-operations.md)
> supersedes only this ADR's effect-intent and effect-claim statements as
> descriptions of current v0.1 scope. The Rust implementation choice,
> `no_std`, dependency isolation, functional-core shape, and every other
> decision below remain Accepted. Effect material is future design unless a
> later accepted contract supplies its consumer, authority, shape, and tests.

## Context

Aizuのcoreは、workflow state、identityとbinding、command validation、event application、duplicateとconflict、
next actionの決定、effect intent、authorization state、recovery dispositionという **純粋な判断** だけを持つ。
前身の実装では、この判断がharness SDK、Node API、filesystem、clock、process起動と同じpackageに同居し、
「coreがharnessに依存しない」という原則をreviewでしか守れなかった。

## Decision

- coreを **Rust** で実装し、crate `aizu-core` とする。
- `aizu-core` は次に依存しない。
  - filesystem、process、network、environment variable
  - clockの直接参照（時刻は外部からbounded timestampとして渡す）
  - async runtime
  - harness SDK、provider SDK、Git command
  - JSON / NDJSONをwire contractとして直接扱うこと（serializationはADR-0004）
  - DSH、Codex、Hermesなどのharness / providerの固有名
- `aizu-core` はcrate依存を持たない（dependencies、dev-dependenciesともに空から始め、追加にはADRを要する）。
- `aizu-core` は `#![no_std]` でbuildし、`core` と `alloc` だけを使う。これにより `std::fs`、`std::process`、`std::net`、`std::env`、`std::time` への依存はcompile時点で不可能になり、
  `HashMap` の代わりに決定論的な `BTreeMap` を使うことになる。`std` が必要になった場合は新しいADRで理由を示す。
- `#![forbid(unsafe_code)]` を設定する。
- 基本形は `State + Command -> Decision` と `State + Event -> State`。`Decision` は、追加するdomain event、外部へ要求するeffect intent、説明可能なrejectionのいずれかを含む。
- application use case（journal load、effect claim、timeout、port呼び出し）は別crate `aizu-engine` に置く。engineもharness固有型を知らない。
- これらの依存規則は `cargo xtask public-audit` で機械的に検査する。

## Consequences

### Positive

- 依存遮断をcompile境界とCIで強制できる。reviewの注意力に頼らない
- 決定論的なcoreはfixture再生、property test、restart reconciliationのtestを容易にする
- adapterの実装言語を固定しない（ADR-0003）

### Negative / Risks

- Node / TypeScriptとの接続にprocess境界が必要になる（ADR-0003）
- RustとTypeScriptの両方を読めるcontributorが必要。ただしcontextの局所化により、片方だけを読む作業を大半にする

### Follow-up

- 最初の縦切り（identity、command、decision）はMilestone `v0.1 — Foundation` のIssue
- 依存規則の一覧は [docs/architecture/dependency-rules.md](../architecture/dependency-rules.md)

## Alternatives considered

- **TypeScriptのままpackageを分ける** — package境界だけではNode APIやharness SDKへの依存を構造的に防げない。lintによる遮断はbypassが容易。
- **Go / その他の言語** — Rustのtype systemと `forbid(unsafe_code)`、crate単位の依存遮断、単一binary配布の組み合わせを優先。
