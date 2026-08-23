# Getting started

## 前提条件

| Tool | Version | 固定場所 |
|---|---|---|
| Rust toolchain | `rust-toolchain.toml` に記載（rustup経由） | `rust-toolchain.toml`、`Cargo.toml` の `rust-version` |
| cargo-deny | 最新安定版 | CIはaction、localは `cargo install cargo-deny --locked` |
| Node.js | `.node-version` に記載 | `.node-version`、`package.json` の `engines` / `devEngines` |
| npm | `package.json` の `packageManager` に記載 | 同左 |

toolchainは `latest` に追従させません。更新は専用PRで行います（[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）。

### rustupとHomebrewのcargoが両方ある場合

`rust-toolchain.toml` を読むのはrustupのproxy（`~/.cargo/bin/cargo`）だけです。
HomebrewなどのcargoがPATHで先にあると、pinしたversionではなくそのcargoが使われます。
`which cargo` が `~/.cargo/bin/cargo` を指すようにPATHの順序を直してください。

```sh
which cargo
cargo --version   # rust-toolchain.toml の channel と一致すること
```

## 最初の検査

```sh
git clone <this repository> Aizu
cd Aizu
cargo xtask check
```

`cargo xtask` は `.cargo/config.toml` のaliasで、`xtask/` crateを実行します。
`check` は次をまとめて実行します。

| 段階 | 内容 |
|---|---|
| `rust-check` | `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`cargo test --workspace`、`cargo doc --workspace --no-deps`（warning deny）、`cargo deny check` |
| `npm-check` | `npm ci` + `npm run check`（Biome、build、typecheck、`node --test`、pack inspection）。packageがなければskip |
| `conformance` | `spec/conformance/` のfixtureを検査 |
| `public-audit` | 依存境界、`aizu-core` の禁止import、secret / private pathの検査、closed `exports`、entry document、文書link |
| `whitespace` | tracked tree全体に対する `git diff --check`（trailing whitespace、final newline） |

個別に実行することもできます。

```sh
cargo xtask rust-check
cargo xtask npm-check
cargo xtask conformance
cargo xtask public-audit
cargo xtask whitespace
```

## binaryを動かす

```sh
cargo build -p aizu-cli
./target/debug/aizu hello
cat spec/protocol/v1/examples/workflow-signal-submit.request.json | ./target/debug/aizu handle --state ./.aizu-state
```

2回目は別processでも `duplicate` が返ります（journalが正本）。`.aizu-state/` はgitignore済みです。

## TypeScript workspace

root `package.json` は `private: true` のnpm workspace rootで、`packages/*` と `adapters/*` をworkspaceとして宣言しています。
`cargo xtask check` は `npm ci` と `npm run check`（Biome lint、build、typecheck、`node --test`、`npm pack --dry-run`）も実行します。

```sh
npm ci
npm run check            # 全package
npm test -w @aizu/protocol
```

- Node / npmは `.node-version` と `packageManager` に固定。`.npmrc` の `engine-strict=true` で不一致を拒否します
- testは `node --test` で `.ts` を直接実行します（Nodeのtype stripping）。そのため `enum` や parameter property は使いません（`erasableSyntaxOnly`）
- package間はworkspace symlinkで解決され、`exports` が `lib/` を指すので、依存先のpackageを先にbuildします（root `npm run build` が順序を固定）

## 通常の検査で起動しないもの

- 外部model、provider login
- harnessのlive process、browser
- network（registry以外）

live smokeは `experiments/` 配下の再現可能なscriptと、operatorのlocalな手順書で実行します（[experiments/README.md](../../experiments/README.md)）。

## 次に読むもの

- [testing.md](testing.md) — testの置き場と実行
- [../architecture/overview.md](../architecture/overview.md) — 全体像
- [../../CONTRIBUTING.md](../../CONTRIBUTING.md) — 作業の進め方
