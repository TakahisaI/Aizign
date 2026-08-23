# ADR-0004: Separate domain, protocol, journal, and adapter schemas

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0002, ADR-0003, ADR-0007

## Context

一つの型をdomain、wire、永続化の三つで共用すると、wireの都合（後方互換のoptional field）や永続化の都合（schema version）が
domain型へ侵入し、逆にdomain型の変更がrelease済みのwire / 永続形式を黙って壊す。
前身の実装では、同じTypeScript interfaceをtool schema、journal record、in-memory stateに共用していた。

## Decision

- 次の四つのschemaを **別物** として扱い、明示的に変換する。

  | Schema | 所有者 | 正本 |
  |---|---|---|
  | Domain型 | `aizu-core` | Rust source |
  | Protocol DTO | `aizu-protocol` / `@aizu/protocol` | `spec/protocol/vN/` |
  | Journal record | `aizu-store-jsonl`（将来の他store含む） | `spec/journal/vN/` |
  | Adapter固有型 | 各adapter | adapter package内 |

- `aizu-core` の型をそのままserializeしない。`serde` deriveをcoreへ追加する場合は、domain shapeをwireまたは永続形式へ固定しないことを説明する新しいADRが必要。
- protocol DTOとjournal recordはclosed schema。未知fieldは拒否する。
- protocol versionとjournal schema versionは独立した整数で、package versionとも独立（ADR-0008）。
- adapter固有型（harness session ID、native event、delivery receipt）はadapterの外に出さない。coreへはstable identity、bounded opaque handle、digest、structured evidence、disposition、short error code、capabilityだけを渡す。

## Consequences

### Positive

- domainの変更がwire / 永続形式へ波及するかどうかを、変換箇所のdiffで判断できる
- wire fixture（`spec/conformance/`）をRustとTypeScriptの両方で同じものとして検査できる
- journal formatの移行を、coreとadapterを変えずに行える

### Negative / Risks

- 変換codeが増える。ただし変換は各境界の所有crateに閉じ、core側には現れない

### Follow-up

- データ境界の詳細は [docs/architecture/data-boundary.md](../architecture/data-boundary.md)
- `spec/` の配置は最初のprotocol実装とともに追加する

## Alternatives considered

- **domain型にserde deriveを付けて共用** — 簡単だが、wire互換とdomain設計が結合し、release後の変更を黙って壊す。
- **protocol DTOをcoreに置く** — coreがserdeとJSONに依存し、ADR-0002の依存遮断を破る。
