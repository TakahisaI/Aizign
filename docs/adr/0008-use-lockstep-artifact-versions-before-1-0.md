# ADR-0008: Use lockstep artifact versions before 1.0

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0003, ADR-0004

## Context

Aizuは複数のRust crateとTypeScript packageを公開artifactとして持つ。contractが発展段階にある間、
artifactごとに独立したversionを持つと、どの組み合わせが検証済みかが分からなくなる。
一方で、wire protocolとjournal formatの互換性はpackage versionとは別の軸で判定する必要がある。

## Decision

- 当面はすべてのpublishable artifactを **同一のAizu version** にそろえる（lockstep）。

  ```text
  aizu-core            0.1.0
  aizu-protocol        0.1.0
  aizu                 0.1.0
  @aizu/protocol       0.1.0
  @aizu/adapter-dsh    0.1.0
  ```

- wire protocol versionとjournal schema versionは、package versionと独立した整数として管理する。

  ```text
  Aizu package version: 0.4.2
  Aizu protocol version: 1
  Journal schema version: 1
  ```

- adapterはpackage versionの完全一致ではなく、`hello` で得たprotocol versionとcapabilityで互換性を判定する。
- 公開versionは `0.x`。初期状態ではnpm workspace rootは `private: true`、child packageもpublish disabled、Cargo crateも `publish = false`。GitHub Releaseだけを使い、registry publishは `v0.1` acceptance後に別ADRで有効化する。
- toolchainは `latest` に追従させず、`rust-toolchain.toml`、`rust-version`、Node version、lockfileへ固定し、専用PRで更新する。preview dependencyはexact versionへ固定する。
- `@aizu/*` はworkspace上の論理名であり、npm registryへ出す前にscopeを確保できていることをrelease gateで確認する。

## Consequences

### Positive

- 「Aizu 0.x.y」という一つの番号で検証済みの組み合わせを指せる
- protocol / journalの互換性が、package versionの変更に引きずられない

### Negative / Risks

- 変更のないcrateもversionが上がる。1.0以降に独立versionへ移行する場合は新しいADRで決める

### Follow-up

- release手順とgateは [docs/development/releasing.md](../development/releasing.md)
- 互換性の判定は [docs/reference/compatibility.md](../reference/compatibility.md)

## Alternatives considered

- **artifactごとの独立version** — 検証済み組み合わせの追跡costが契約の安定前には見合わない。
- **protocol versionをpackage major versionと一致させる** — 0.xの間はmajorが0で固定され、protocol進化を表現できない。
