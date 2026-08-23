# Releasing

## Versioning

- すべてのpublishable artifactは同一のAizu versionにそろえる（lockstep、[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）
- wire protocol versionとjournal schema versionは独立した整数
- `0.x` の間は最新minorだけをsupport

## 初期状態

- npm workspace rootは `private: true`。child packageもpublish disabled
- Cargo crateは `publish = false`
- GitHub Releaseだけを使う
- registry publishは `v0.1` acceptance後に別ADRで有効化する

## Release gate

少なくとも次がそろうまでregistryへ公開しません。

- [ ] protocol handshake（`hello`）
- [ ] closed protocol fixture
- [ ] Rust / TypeScript conformance
- [ ] metadata-only journal
- [ ] fake harnessによるend-to-end round trip
- [ ] DSH adapterのopt-in smoke（`experiments/dsh-live-smoke/`。手順はoperator側）
- [ ] package contents inspection（`cargo package --list`、`npm pack --dry-run`）
- [ ] SECURITY、LICENSE、CONTRIBUTING
- [ ] clean cloneからの再現性
- [ ] version compatibility文書
- [ ] `@aizu` npm scopeの確保

## 手順（GitHub Release）

1. version bumpのPRを出す（全artifactを同じversionへ。`Cargo.toml` の `workspace.package.version`、root と各 `package.json`、`Cargo.lock` / `package-lock.json`、`docs/reference/compatibility.md`）
2. mainへmerge後、mainのcommitに tag `vX.Y.Z` を打ってpushする（ruleset上、tagはPRなしで作れる）

   ```sh
   git tag -a v0.1.0 -m "Aizu v0.1.0" && git push origin v0.1.0
   ```

3. `.github/workflows/release.yml` が、tagとworkspace versionの一致を検証 → `cargo xtask check`（Rust + TypeScript + conformance + public-audit）→ GitHub Releaseを作成する（generated notes。artifactなし、registry publishなし）
4. Releaseの本文にprotocol version、journal schema version、互換性の変更を追記する

`release.yml` は `contents: write` を持つ唯一のworkflowで、release jobだけがその権限を使います。

## Package contents

- Rust: `cargo package --list --workspace` を `cargo xtask rust-check` が実行する。crateのtestはrepositoryの `spec/` を読むので、packageされたcrate単体ではtestできない（libraryのbuildには影響しない）
- TypeScript: `npm pack --dry-run` を各packageの `pack:check` が実行する（`files` は `lib` とREADMEだけ）

## Toolchainの更新

`rust-toolchain.toml`、`rust-version`、`.node-version`、`packageManager`、lockfileの更新は専用PRで行います。
preview dependency（harness SDKなど）はexact versionへ固定し、更新時は互換性の再検証を記録します。
