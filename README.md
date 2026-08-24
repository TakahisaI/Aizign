# Aizign

**Aizign is a provider-neutral orchestration core for software-change workflows.**
A deterministic Rust core decides; harness-specific adapters act. The two talk over a
versioned NDJSON process boundary, and every decision is backed by a metadata-only,
append-only control journal — never by natural language, idle detection, or screen state.

Aizignは、LLM harnessを使ったソフトウェア変更workflowのための、provider-neutralなorchestration coreです。
判断はRust製の決定論的coreが行い、harness固有の操作は独立したadapter packageが行います。
両者はversion付きNDJSON protocolでprocess境界を越えて接続され、
完了の正本は自然言語やidle検出ではなく、構造化されたdurable evidenceです。

> **Status:** `v0.1 — Foundation` を構築中です。registryへは未公開で、GitHub Releaseも未発行です。
> 現在の到達点と残作業は、GitHub Milestone `v0.1 — Foundation` のIssueを参照してください。

## Aizignが解く問題

LLM agentに実装・レビュー・修正を割り当てると、次の問題が繰り返し起きます。

- agentの「終わりました」という発話やidle状態を完了と誤認する
- 外部作用（prompt送信、commit、ref更新）の結果が不明なまま再送して二重実行する
- harness固有のsession IDや thread IDがworkflowの識別子に混入し、harnessを差し替えられなくなる
- promptやmodel outputが監査logへ漏れ、公開や共有ができなくなる

Aizignは、これらを **core / protocol / journal / adapter の物理的な境界** と、
repository全体で固定した[hard invariants](docs/architecture/invariants.md)で防ぎます。

## 構成

```text
@aizign/adapter-dsh  (TypeScript)      ← harnessごとに独立したpackage
        │
        │ Aizign Protocol v1 — NDJSON over stdin/stdout
        ▼
   aizign  (binary)
     ├── aizign-protocol      wire DTO / version / capability negotiation
     ├── aizign-store-jsonl   append-only, metadata-only control journal
     └── aizign-engine        use case / effect claim / port definitions
             │
             ▼
         aizign-core          pure decisions: State + Command -> Decision
```

| 種類 | 名前 | 場所 |
|---|---|---|
| Rust core | `aizign-core` | `crates/aizign-core` |
| Application engine | `aizign-engine` | `crates/aizign-engine` |
| Protocol implementation | `aizign-protocol` | `crates/aizign-protocol` |
| JSONL store | `aizign-store-jsonl` | `crates/aizign-store-jsonl` |
| CLI package / binary | `aizign-cli` / `aizign` | `crates/aizign-cli` |
| Rust testkit | `aizign-testkit` | `crates/aizign-testkit` |
| TypeScript protocol | `@aizign/protocol` | `packages/protocol` |
| Adapter testkit | `@aizign/adapter-testkit` | `packages/adapter-testkit` |
| DSH adapter | `@aizign/adapter-dsh` | `adapters/dsh` |

ディレクトリは最初の実装が入る時点で追加します。上の表にあってまだ存在しない場所は、
Milestone `v0.1 — Foundation` の未着手Issueです。

## Getting started

```sh
cargo fetch --locked
cargo xtask check
```

前提条件、toolchainの固定方法、各検査の意味は
[docs/development/getting-started.md](docs/development/getting-started.md) を参照してください。

## Documentation authority

| 知りたいこと | 正本 |
|---|---|
| 実際の挙動 | source、test、`spec/conformance/` |
| Wire contract | `spec/protocol/` |
| Durable format | `spec/journal/` |
| 現在のarchitecture | [`docs/architecture/`](docs/architecture/overview.md) |
| Hard invariants | [`docs/architecture/invariants.md`](docs/architecture/invariants.md) |
| 設計判断の履歴 | [`docs/adr/`](docs/adr/) |
| 人間向けcontribution policy | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| package固有の契約 | 各package内の `README.md` |
| 自動coding agent向けnavigation | 最寄りの `AGENTS.md` |
| 作業状況 | GitHub Issue / PR |

## Contributing

Proposal-firstです。挙動、API、schema、依存境界を変える変更は、先にIssueで契約を確定してからPRを出してください。
詳細は [CONTRIBUTING.md](CONTRIBUTING.md)、意思決定の仕組みは [GOVERNANCE.md](GOVERNANCE.md) を参照してください。

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion
in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above,
without any additional terms or conditions.
