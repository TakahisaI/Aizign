# Releasing

## Versioning

- すべてのpublishable artifactは同一のAizu versionにそろえる（lockstep、[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）。
  lockstepは `cargo xtask public-audit` の version lockstep 検査が enforce する（crateは `version.workspace = true`、`workspace.dependencies` の内部pin、全 `package.json` のversionと `@aizu/*` 依存のexact pin）
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
- [ ] 実装者以外（別maintainer、または別harness・別model）による静的review。最低限: protocol schemaとRust / TypeScript decoderの差分、adapterからprotocolへ越境するfield、response correlation、unbounded input / output / cold read、`unknown` からの暗黙retry、journalとharness evidenceのauthority重複、README / ADR / Issue / 実装の不一致
- [ ] live smokeを実装者以外が固定commit SHAと公開文書だけで再現

## 手順（GitHub Release）

1. version bumpのPRを出す（全artifactを同じversionへ。`Cargo.toml` の `workspace.package.version`、root と各 `package.json`、`Cargo.lock` / `package-lock.json`、`docs/reference/compatibility.md`）
2. mainへmerge後、**mainのtip**に tag `vX.Y.Z` を打ってpushする（ruleset上、tagはPRなしで作れる）。
   release gateはtagged SHAとdefault branchのtipの一致をfail closedで検証するので、古いcommitや別branchへのtagはreleaseにならない（reviewが見ていないtreeをreleaseしないため）。tagとpushの間にmainが進んだ場合は、新しいtipをre-reviewしてからtagを打ち直す

   ```sh
   git tag -a v0.1.0 -m "Aizu v0.1.0" && git push origin v0.1.0
   ```

3. `.github/workflows/release.yml` が、tagged SHA = main tip とtag = workspace versionを検証 → `cargo xtask check`（Rust + TypeScript + conformance + public-audit）→ GitHub Releaseを作成する（generated notes。artifactなし、registry publishなし）
4. Releaseの本文にprotocol version、journal schema version、互換性の変更を追記する

`release.yml` は `contents: write` を持つ唯一のworkflowで、release jobだけがその権限を使います。

## Package contents

- Rust: `cargo package --list --workspace` を `cargo xtask rust-check` が実行する。crateのtestはrepositoryの `spec/` を読むので、packageされたcrate単体ではtestできない（libraryのbuildには影響しない）
- TypeScript: `npm pack --dry-run` を各packageの `pack:check` が実行する（`files` は `lib` とREADMEだけ）

## Toolchainの更新

`rust-toolchain.toml`、`rust-version`、`.node-version`、`packageManager`、lockfileの更新は専用PRで行います。
preview dependency（harness SDKなど）はexact versionへ固定し、更新時は互換性の再検証を記録します。
