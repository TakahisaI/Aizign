# Contributing to Aizign

この文書は、人間向けcontribution policyの正本です。
`AGENTS.md` は自動coding agent向けのnavigationであり、人間のcontributorは読む必要がありません。

Aizignは **proposal-first** で開発します。挙動、API、schema、依存境界を変える変更は、
先にIssueで契約を確定してからPRを出してください。未合意の大規模rewriteは受け付けません。

## Conductor-led Boundary and Milestone changes

Boundary changes and Milestone reviews follow the pilot workflow in
[docs/development/change-workflow.md](docs/development/change-workflow.md).
Routine changes continue to use the ordinary contribution process.

The pilot is deliberately manual. It assumes one Maintainer, ordinary coding
sessions, and only these optional explicit-invocation personal/workspace skills:

- `$aizign-conduct`
- `$aizign-break`
- `$aizign-adjudicate`

No Implementer, Contract Designer, packet-generator, validator, bot, or Aizign
runtime automation is required. The skills are adapters, not repository
authority. `GOVERNANCE.md` continues to define Maintainer, merge, milestone,
and release authority, and product/runtime contracts remain owned by their
existing normative repository sources.

## 受け付けるもの

- Issue、bug report、設計提案
- Issueで合意済みのscopeに対するPR
- typo、軽微な文書修正、自動dependency update（Issueなしで可）

## 作業単位

- **1 PR = 1 reviewable slice**
- PRは原則として一つのleaf Issueをcloseする
- 大きな目的はumbrella Issueにし、複数のleaf Issueへ分割する
- 一つのIssueへ巨大PRを押し込まない
- PRが二つ以上のbounded contextを変更する場合、PR本文に理由を書く

### Branch名

```text
feat/123-protocol-handshake
fix/146-journal-conflict
docs/152-adapter-contract
```

### PR title

squash mergeのcommit messageになるため、[Conventional Commits](https://www.conventionalcommits.org/) 形式にします。
scopeにはcrate / package / contextの名前を使います。

```text
feat(core): add workflow signal decision
fix(adapter-dsh): preserve unknown delivery outcome
docs(architecture): define recovery boundary
chore(ci): pin cargo-deny action
```

## ADRが必要な変更

次の変更はIssueだけでなく、[docs/adr/](docs/adr/) へのADRを要求します。

- crate / package境界
- dependency方向
- protocol shapeまたはversion
- journal format
- core–adapter接続方式
- 新しいruntime dependency
- security / data boundary
- automatic retry policy
- MSRVまたはNode support policy
- contribution / review / merge policy
- release / compatibility policy

Accepted ADRは後からsilent rewriteしません。変更時は新しいADRでsupersedeします。
書き方は [docs/adr/0000-template.md](docs/adr/0000-template.md) を参照してください。

## 検査

Use an explicit profile for the development inner loop that matches the area being changed.

```sh
cargo xtask quick
cargo xtask quick protocol
cargo xtask quick adapter-dsh
```

`quick` reuses existing caches and `node_modules`; it does not install dependencies or run the full release checks.
See [Getting started](docs/development/getting-started.md#quick-development-checks) for the scope of each profile.

PRを出す前にrootで次を通してください。

```sh
cargo xtask check
```

内訳は [docs/development/testing.md](docs/development/testing.md) にあります。
通常の検査は、外部model、harness live process、browser、provider loginを起動しません。

## Merge policy

- default branchは `main`。直接pushは禁止
- squash mergeのみ。merge commitとrebase mergeは無効
- required checksが緑であること
- unresolved conversationがあるPRはmergeしない
- maintainer自身のPRは、green CIとPR checklistを満たせばself-merge可
- 第二maintainer参加後は、non-author approvalを1件必須にする

## 旧実装からの採用

Aizignの前身となるprivate repositoryは、source of truthではなく「設計上の観測資料」です
（[ADR-0006](docs/adr/0006-keep-the-legacy-repository-reference-only.md)）。

- source treeを一括copyしない
- 採用する契約はAizign側のIssueまたはADRで `Adopt / Reject / Defer` を明示する
- 採用する契約は新しいtestとして書き直す
- literal codeやpresetを持ち込む場合だけ、licenseとattributionを個別に監査する

## Language

English is the canonical language for maintained Aizign project artifacts.

- Write code identifiers, error codes, public APIs, rustdoc, branch names, and commit titles in English.
- Write new and substantially revised documentation, source comments, user-facing messages, Issue and PR titles and bodies, and repository templates in English.
- Existing Japanese content may remain until the relevant file or bounded section is otherwise changed.
- When a change touches a small Japanese section, translate it in the same PR only if the additional diff remains reviewable. Use a separate documentation PR when translation would dominate an unrelated change.
- Review comments and real-time discussion may use any language that helps the participants communicate precisely.
- Keep historical material, including closed Issues, merged PR discussions, commit history, and accepted ADRs, in its existing language unless a dedicated migration slice requires otherwise.
- Do not maintain complete Japanese and English copies of the same long-lived document unless ownership and a synchronization process are explicit.
- Prefer plain, consistent technical English and established project terminology.

## License

CLAとDCOは導入していません。Contributionは、repositoryと同じ `Apache-2.0 OR MIT` で提供されたものとして扱います。
