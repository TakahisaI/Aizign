# ADR-0007: Use metadata-only control journals

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0004

## Context

workflowの正本は、durableなappend-only journalに記録されたstructured eventである。
journalにraw prompt、model output、reasoning、credential、environmentが混入すると、
journalを共有・公開・監査できなくなり、harness固有のデータがcore identityへ漏れる経路にもなる。

## Decision

- control journalは **metadata-onlyのappend-only journal** とする。初期実装はJSONL（`aizu-store-jsonl`）。
- journalに保存してよいのは、stable identity（workflow、assignment、attempt、candidate revision）、kind、disposition、
  short error code、digest、bounded opaque handle、bounded timestamp、schema versionだけ。
- journalにraw prompt、model output、reasoning、stdout / stderr、environment、credential、browser profile、
  harness session IDやprovider thread IDを保存しない。recordはclosed schemaとし、これらを拒否する。
- journalの性質:
  - append-only。既存recordを書き換えない
  - owner-only permission
  - bounded cold read
  - schema version付き
  - 同一identity・同一内容はexact duplicate、同一identity・異内容はconflict
  - atomic append、lock、writer ownership
- 将来SQLite実装を追加しても、coreとadapterを変更しない。journal traitはengineが所有し、storeが実装する（ADR-0005）。
- journalの形式は `spec/journal/vN/` を正本とし、schema versionはpackage versionと独立（ADR-0008）。

## Consequences

### Positive

- journalをそのまま共有、公開、監査できる
- restart reconciliationをjournalのcold readだけで行える

### Negative / Risks

- 本文を参照したい場合は、adapter側のharness persistenceやworkspaceのartifactを別途参照する必要がある。journalはそれらへのdigestと参照だけを持つ

### Follow-up

- JSONL storeとmemory test storeはMilestone `v0.1 — Foundation` のIssue
- データ境界の一覧は [docs/architecture/data-boundary.md](../architecture/data-boundary.md)

## Alternatives considered

- **harnessのpersistenceをjournalとして使う** — harness固有形式に依存し、harness差し替え時にjournalが失われる。adapterはharness persistenceをevidence sourceとして読むが、正本にはしない。
- **本文を含むjournal** — 監査性と公開性を失う。
