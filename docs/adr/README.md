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
| [0015](0015-define-v0-1-trust-boundaries-and-guarantee-levels.md) | Define v0.1 trust boundaries and guarantee levels | Accepted |
| [0016](0016-adopt-a-repository-owned-higher-risk-change-contract.md) | Adopt a repository-owned higher-risk change contract | Accepted |
| [0017](0017-bound-v0-1-classification-to-current-operations.md) | Bind v0.1 classification to current operations | Accepted |
| [0018](0018-require-implementation-readiness-before-higher-risk-implementation.md) | Require implementation readiness before higher-risk implementation | Accepted |
| [0019](0019-separate-engine-and-store-observation-ownership.md) | Separate engine and store observation ownership | Accepted |
| [0020](0020-narrow-typescript-exports-and-own-dsh-transport.md) | Narrow TypeScript exports and own DSH transport | Accepted |
| [0021](0021-pin-cargo-deny-and-source-checkout-installation.md) | Pin cargo-deny and define source-checkout installation | Accepted |
| [0022](0022-define-the-canonical-one-shot-process-profile.md) | Define the canonical one-shot process profile | Accepted |
| [0023](0023-define-protocol-lexical-and-outbound-validation-boundaries.md) | Define Protocol lexical and outbound validation boundaries | Accepted |
| [0024](0024-require-isolated-adapter-child-environments.md) | Require isolated adapter child environments | Accepted |

ADR-0016 partially supersedes ADR-0005's earlier `AGENTS.md` editing-constraint
statement only; ADR-0005's other accepted decisions remain in force.

ADR-0017 partially supersedes only ADR-0002's effect-intent and effect-claim
statements as claims of current v0.1 scope. ADR-0002's Rust, `no_std`,
dependency-isolation, and functional-core decisions remain in force.

ADR-0018 extends ADR-0016 by separating proposal acceptance from exact-base
implementation preparation and a Maintainer `Ready for implementation`
decision. ADR-0016's repository ownership, tool-neutral operation, exact-target
review, visible-gap, and separate merge-decision rules remain in force.

ADR-0022 partially supersedes only ADR-0003's direct `hello` adapter-preflight
decision and incomplete adapter argv, framing, version-selection, and process-
lifecycle portions. ADR-0003's subprocess boundary, independent language
implementations, closed Protocol, stdout/stderr separation, and no-daemon
decisions remain Accepted.

ADR-0023 extends the closed-Protocol and independent-version consequences of
ADR-0003, ADR-0004, ADR-0009, and ADR-0022. It does not supersede their process,
schema-ownership, dependency, or version-axis decisions.

ADR-0024 partially supersedes only ADR-0020's arbitrary caller-provided
production child-environment entries. ADR-0020's single DSH transport owner and
closed experimental subpaths, ADR-0022's process ownership, ADR-0017's
classification ownership, and Issue #80's evidence disposition remain in force.
