# ADR-0009: Serialization dependencies for the protocol crate

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0002, ADR-0003, ADR-0004

## Context

Protocol v1（ADR-0003）はNDJSONである。`aizu-protocol` はenvelopeとpayloadをclosed schemaでdecode / encodeする必要があり、
これがAizuで最初のruntime dependency追加になる。ADR-0004はdomain型（`aizu-core`）をそのままserializeしないことを求めている。

## Decision

- `aizu-protocol` は `serde`（`derive` feature）と `serde_json` に依存する。これ以外の外部crateは追加しない。
- protocol DTOは `aizu-protocol` 内でだけ定義し、`#[serde(deny_unknown_fields)]` と `rename_all = "camelCase"` を付ける。`null` は「欠落」と同じ意味にせず拒否する。
- `aizu-core` の型には `serde` deriveを付けない。DTO ↔ domainの変換は `aizu-protocol` が明示的に行う。
- wire上の正本は `spec/protocol/v1/`（JSON Schema draft 2020-12とexample）。Rustの DTO はこれに従う側であり、schemaを生成する側ではない。
- `serde_json` はDTOのdecode / encodeと、`cargo metadata` などtoolingでの読み取りに使う。

## Consequences

### Positive

- closed schemaを `deny_unknown_fields` で機械的に強制できる
- domain型の変更がwireに波及するかどうかを、変換箇所のdiffで判断できる

### Negative / Risks

- DTOとdomain型の二重定義。変換codeはprotocol crateに閉じ、testでexampleとの整合を検査する
- `serde` の依存tree（`serde_derive` → `proc-macro2` → `unicode-ident`）が `cargo deny` の対象になる。`unicode-ident` のために `Unicode-3.0` を `deny.toml` の許可licenseへ追加した

### Follow-up

- `docs/architecture/dependency-rules.md` の表はすでに `aizu-protocol: serde, serde_json` を許可している
- 同じ方針を `aizu-store-jsonl`（journal record）にも適用する（ADR-0007）

## Alternatives considered

- **手書きのJSON parser** — 依存ゼロだが、closed schemaとescapeの正しさを自前で保証するcostが見合わない
- **domain型に `serde` derive** — ADR-0004に反する
