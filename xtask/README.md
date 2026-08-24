# xtask

Repository tooling, invoked as `cargo xtask <command>` (alias in `.cargo/config.toml`). Not a published artifact.

| Command | 内容 |
|---|---|
| `check` | Full pull-request gate: `rust-check` → `npm-check` → `conformance` → `public-audit` → `whitespace` |
| `quick` | Network-free inner loop; the default profile checks the Rust and TypeScript workspaces |
| `quick protocol` | Default profile plus protocol, journal, shared-fixture, and schema checks |
| `quick adapter-dsh` | Default profile plus DSH adapter checks with a freshly built real binary |
| `rust-check` | `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`cargo test --workspace`、`cargo doc --workspace --no-deps`（warning deny）、`cargo deny check` |
| `conformance` | `spec/conformance/` のfixtureの構造検査。decoderを通すのは各protocol実装の責務 |
| `public-audit` | 依存境界（`src/audit/dependencies.rs`）、secretとprivate path（`src/audit/secrets.rs`）、package manifest（`src/audit/packages.rs`）、entry document（`src/audit/entry_docs.rs`）、文書link（`src/audit/links.rs`） |
| `whitespace` | tracked tree全体に対する `git diff --check` |

## Quick profiles

`quick` reuses the existing Cargo cache and `node_modules` for development checks.
The developer selects a profile explicitly; `quick` does not infer affected crates or packages from the git diff.

| Profile | Order | Guarantees |
|---|---|---|
| `quick` | npm dependency preflight → `cargo fmt` → workspace `cargo check --frozen` → workspace library tests → TypeScript build → lint → typecheck | Compilation of every Rust target and feature, Rust library unit tests, and every TypeScript package's build, lint, and type checks |
| `quick protocol` | default → fixture structure → Rust protocol and journal tests → TypeScript protocol tests → schema and example tests | Rust and TypeScript decoders, the journal decoder, language-neutral fixtures, and JSON Schema acceptance sets |
| `quick adapter-dsh` | default → `cargo build --frozen -p aizign-cli` → DSH lint and typecheck → protocol tests → adapter-testkit tests → DSH adapter tests | The default guarantees, targeted DSH checks, and fake-core and freshly built real-binary round trips |

No profile runs `npm ci`, `npm install`, or a toolchain install.
Cargo child commands use `--frozen`, and npm child commands receive the offline setting.
If `node_modules` or a required package is missing, the command fails with an actionable `npm ci --no-audit --no-fund` setup instruction.
Each profile compares the tracked diff before and after the run and fails if a tracked file changes.

`quick` does not run cargo doc, cargo deny, package-content inspection, the public audit, full workspace integration tests, or clean-install reproducibility checks.
Success does not imply pull-request or release readiness; run `cargo xtask check` before a push or pull request.

The initial profile design used these warm-cache measurements.
They are observations, not duration guarantees or a performance budget.

| Environment | Command | Elapsed |
|---|---|---:|
| Apple M1, Rust 1.97.1, 2026-08-24 | `cargo check --workspace --all-targets --all-features --locked` | 0.16 s |
| Same | `cargo test --workspace --lib --locked` | 0.20 s |
| Node 24.19.0, npm 12.0.2, same date | `npm run build` | 3.29 s |
| Same | `npm run lint` | 0.98 s |
| Same | `npm run typecheck` | 2.50 s |

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
