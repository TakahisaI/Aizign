# Architecture Decision Records

設計判断の履歴です。**現在のarchitectureの正本ではありません**。現在の構成は [docs/architecture/](../architecture/overview.md) を参照してください。

- 番号は4桁の連番。file名は `NNNN-short-title.md`
- StatusはProposed / Accepted / Superseded by ADR-NNNN / Deprecated
- Accepted ADRはsilent rewriteしない。変更時は新しいADRでsupersedeし、両方にlinkを書く
- ADRが必要な変更の一覧は [CONTRIBUTING.md](../../CONTRIBUTING.md#adrが必要な変更)

| ADR | Title | Status |
|---|---|---|
| [0000](0000-template.md) | Template | — |
| [0001](0001-start-aizu-as-a-fresh-public-monorepo.md) | Start Aizu as a fresh public monorepo | Accepted |
| [0002](0002-implement-the-deterministic-core-in-rust.md) | Implement the deterministic core in Rust | Accepted |
| [0003](0003-use-a-versioned-ndjson-process-boundary.md) | Use a versioned NDJSON process boundary | Accepted |
| [0004](0004-separate-domain-protocol-journal-and-adapter-schemas.md) | Separate domain, protocol, journal, and adapter schemas | Accepted |
| [0005](0005-organize-the-core-by-bounded-context.md) | Organize the core by bounded context | Accepted |
| [0006](0006-keep-the-legacy-repository-reference-only.md) | Keep the legacy repository reference-only | Accepted |
| [0007](0007-use-metadata-only-control-journals.md) | Use metadata-only control journals | Accepted |
| [0008](0008-use-lockstep-artifact-versions-before-1-0.md) | Use lockstep artifact versions before 1.0 | Accepted |
| [0009](0009-serialization-dependencies-for-the-protocol-crate.md) | Serialization dependencies for the protocol crate | Accepted |
| [0010](0010-harness-sdk-dependencies-and-node-policy.md) | Harness SDK dependencies and the Node support policy | Accepted |
| [0011](0011-rename-aizu-to-aizign-before-first-release.md) | Rename Aizu to Aizign before the first release | Accepted |
| [0012](0012-bind-workflow-evidence-to-attempts-and-candidate-content.md) | Bind workflow evidence to attempts and candidate content | Accepted |
| [0013](0013-add-bounded-read-only-workflow-signal-reconciliation.md) | Add bounded read-only workflow signal reconciliation | Accepted |
| [0014](0014-use-rustcrypto-sha2-for-committed-prefix-hashing.md) | Use RustCrypto sha2 for committed-prefix hashing | Accepted |
