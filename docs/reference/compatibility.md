# Compatibility

## 三つのversion

| Version | 現在 | 管理 |
|---|---|---|
| Aizu package version | `0.1.0`（未release） | 全artifact lockstep。`Cargo.toml`、各 `package.json` |
| Protocol version | `1`（`aizu-protocol` が実装。`hello` と `workflow.signal.submit`） | `spec/protocol/v1/`。envelopeの `version` |
| Journal schema version | `1`（未実装） | `spec/journal/v1/`。recordの `schemaVersion` |

adapterはpackage versionの完全一致ではなく、`hello` で得たprotocol versionとcapabilityで互換性を判定します
（[ADR-0003](../adr/0003-use-a-versioned-ndjson-process-boundary.md)、[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）。

## 互換性の規則

- 既存messageのshapeはrelease後に変更しない。新機能は新しい `kind` として追加する
- envelopeや既存payloadの破壊的変更はprotocol versionを上げる
- 既存journal recordの意味を変えない。新しいrecord kindは追加できる。破壊的変更はjournal schema versionを上げ、移行手順を `spec/journal/` に書く
- `0.x` の間は最新minorだけをsupportする

## Toolchain

| Tool | 固定 |
|---|---|
| Rust | `rust-toolchain.toml`、`Cargo.toml` の `rust-version` |
| Node.js | `.node-version`、`package.json` の `engines` / `devEngines` |
| npm | `package.json` の `packageManager` |
| GitHub Actions | commit SHAで固定 |

Node versionはDSH adapterが入る時点で、harness SDKの要求に合わせて再評価します（専用PR）。

## Harness

| Harness | Adapter | Supported version | Status |
|---|---|---|---|
| DSH | `@aizu/adapter-dsh` | 未定（exact versionで固定予定） | 未作成 |
