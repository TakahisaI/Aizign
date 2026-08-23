# ADR-0001: Start Aizu as a fresh public monorepo

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0006, ADR-0008

## Context

Aizuの前身はprivateな実験repositoryで、概念上はcore、execution、recovery、harness adapter、workspace、integration、usageを分けていたが、
物理的には一つのnpm packageと一つの公開面に集約されていた。
公開にあたり、core、protocol、journal、adapterの境界を物理的に分離し、LLMが編集時に読む必要のあるcontextを局所化したい。

coreとadapterの契約はまだ発展段階にある。最初から別repositoryにすると、protocol変更のたびに複数repositoryへ跨るPR、release順序、fixture同期が必要になる。

## Decision

- Aizuを **新規のpublic repository** として最初から作成する。Git履歴はimportしない。
- **RustとTypeScriptを含むpolyglot monorepo** にする。repositoryは一つ、packageと依存境界は複数。
- Rust crateは `crates/`、harness adapterは `adapters/<harness>/`、共有TypeScript packageは `packages/` に置く。
- adapterを別repositoryへ切り出すのは、次がすべて揃った場合だけとする。
  - Protocol v1が安定している
  - coreと独立したrelease cadenceが必要
  - 別maintainerがownershipを持つ
  - Aizu本体と異なるsecurityまたはdistribution境界を持つ
- 単にディレクトリを小さくしたいという理由ではrepositoryを分割しない。
- licenseは `Apache-2.0 OR MIT`。contributionはproposal-first。当面はnon-confidentialデータだけを扱う。

## Consequences

### Positive

- protocol、fixture、testkit、adapterを一つのPRで整合させられる
- 公開前提の履歴だけが残り、private path、credential、実データの混入を構造的に避けられる
- crate / packageの境界を `cargo xtask public-audit` で機械的に検査できる

### Negative / Risks

- RustとTypeScriptの二つのtoolchainを一つのCIで維持する必要がある
- 旧repositoryの機能をすぐには使えない。context単位で再評価して移す作業が要る

### Follow-up

- 旧repositoryの扱いはADR-0006
- version運用はADR-0008
- 初期milestoneは GitHub Milestone `v0.1 — Foundation`

## Alternatives considered

- **旧repositoryをpublicへ切り替える** — 履歴にprivate path、Issue番号依存の設計文書、単一package構造が残り、境界の再設計ができない。
- **最初からcoreとadapterを別repositoryにする** — 契約が安定する前に跨りPRとrelease順序のcostを払うことになる。
- **TypeScriptだけのmonorepo** — coreの決定論性と依存遮断をADR-0002の理由でRustに求めるため不採用。
