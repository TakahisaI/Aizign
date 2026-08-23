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
- [ ] DSH adapterのopt-in smoke
- [ ] package contents inspection（`cargo package --list`、`npm pack --dry-run`）
- [ ] SECURITY、LICENSE、CONTRIBUTING
- [ ] clean cloneからの再現性
- [ ] version compatibility文書
- [ ] `@aizu` npm scopeの確保

## 手順（GitHub Release）

1. version bumpのPRを出す（全artifactを同じversionへ。`Cargo.toml`、各 `package.json`、`docs/reference/compatibility.md`）
2. mainへmerge後、tag `v0.x.y` を作る
3. GitHub Releaseを作り、protocol version、journal schema version、互換性の変更を記載する

release workflowの自動化は `v0.1` readiness reviewのIssueで追加します。

## Toolchainの更新

`rust-toolchain.toml`、`rust-version`、`.node-version`、`packageManager`、lockfileの更新は専用PRで行います。
preview dependency（harness SDKなど）はexact versionへ固定し、更新時は互換性の再検証を記録します。
