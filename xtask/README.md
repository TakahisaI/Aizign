# xtask

Repository tooling, invoked as `cargo xtask <command>` (alias in `.cargo/config.toml`). Not a published artifact.

| Command | 内容 |
|---|---|
| `check` | PRが通るべき全gate。`rust-check` → `conformance` → `public-audit` → `whitespace` |
| `rust-check` | `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`cargo test --workspace`、`cargo doc --workspace --no-deps`（warning deny）、`cargo deny check` |
| `conformance` | `spec/conformance/` のfixtureの構造検査。decoderを通すのは各protocol実装の責務 |
| `public-audit` | 依存境界（`src/audit/dependencies.rs`）、secretとprivate path（`src/audit/secrets.rs`）、package manifest（`src/audit/packages.rs`）、entry document（`src/audit/entry_docs.rs`）、文書link（`src/audit/links.rs`） |
| `whitespace` | tracked tree全体に対する `git diff --check` |

## 規則の正本との対応

| Audit | 文書 |
|---|---|
| dependency boundaries | [docs/architecture/dependency-rules.md](../docs/architecture/dependency-rules.md) |
| secrets and private paths | [SECURITY.md](../SECURITY.md)、[ADR-0006](../docs/adr/0006-keep-the-legacy-repository-reference-only.md) |
| package manifests | [ADR-0005](../docs/adr/0005-organize-the-core-by-bounded-context.md)、[ADR-0008](../docs/adr/0008-use-lockstep-artifact-versions-before-1-0.md) |
| entry documents | [ADR-0005](../docs/adr/0005-organize-the-core-by-bounded-context.md) |

規則を変えるときは、文書とauditを同じPRで更新します。

## 依存

`serde_json` だけ（`cargo metadata`、fixture、`package.json` の読み取り）。workspace crateには依存しません。
