# ADR-0006: Keep the legacy repository reference-only

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0001

## Context

Aizuの前身はprivateな実験repositoryで、structured evidence、claim-before-effect、`unknown` の非縮約、provider固有IDのadapter内封じ込めなど、
残すべき原則をすでに確立している。一方で、履歴にはprivate path、Issue番号に依存した設計文書、単一package構造、preview harnessへの密結合が含まれる。

## Decision

- 旧repositoryは **privateなreference archive** として残し、Aizu bootstrap完了後はreference-onlyとしてfreezeする。
- AizuへGit historyをimportしない。source treeを一括copyしない。
- 旧repositoryのIssue / PR番号をAizuの現行文書へ持ち込まない。private URLをAizuへ書かない。
- Aizuと旧repositoryの二重開発をしない。
- 旧実装から採用するものは、Aizu側でIssueまたはADRを作り、`Adopt / Reject / Defer` を明示する。採用する契約は新しいtestとして書き直す。
- literal codeやpresetを持ち込む場合だけ、licenseとattributionを個別に監査する。
- `cargo xtask public-audit` は、旧repository名とprivate pathがtracked treeに現れないことを検査する。

## Consequences

### Positive

- 公開repositoryに非公開情報が混入しない
- 旧実装の各契約を、Aizuの境界に合わせて再評価する機会になる

### Negative / Risks

- 旧repositoryで動いていた機能（workspace、repair、integration、restart supervisor、usage）がAizuで使えるまでに時間がかかる。
  最初のstructured workflow signalを縦に通した後、context単位で再評価して追加する

### Follow-up

- 採用候補はMilestone `v0.1 — Foundation` 完了後にcontext単位でIssue化する

## Alternatives considered

- **履歴ごとimportしてpublic化** — private情報の完全な除去を保証できず、単一package構造も引き継いでしまう。
- **必要なfileだけcopy** — 境界の再設計なしに依存が持ち込まれる。採用はtestの書き直しを伴う形に限定する。
