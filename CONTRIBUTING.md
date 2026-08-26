# Contributing to Aizign

この文書は、人間向けcontribution policyの正本です。
`AGENTS.md` は自動coding agent向けのnavigationであり、人間のcontributorは読む必要がありません。

Aizignは **proposal-first** で開発します。挙動、API、schema、依存境界を変える変更は、
先にIssueで契約を確定してからPRを出してください。未合意の大規模rewriteは受け付けません。

## Public contribution contract

This section is the repository's public contract for proposing and reviewing
changes. It applies regardless of the tools used to prepare a change. No
particular skill, model, agent implementation, or session arrangement is
required; the records below can be prepared with ordinary Issues, pull
requests, and local commands.

### Authority and decisions

[`GOVERNANCE.md`](GOVERNANCE.md) assigns the Maintainer authority to approve
ADRs, review and merge pull requests, handle conflicts, and release. This
contract adds no authority beyond that source. An accepted Issue or ADR is the
authority for a changed contract before implementation begins; a PR cannot
silently widen that decision. A review record is evidence, not approval, and a
Maintainer records the merge decision separately.

### Change classes

Classify the proposal before implementation.

- **Ordinary change:** stays within an accepted owner-local contract and does
  not change a public or repository-level claim. Examples include a typo that
  does not alter a maintained claim, an internal refactor that preserves
  behavior and boundaries, or a bug fix that restores accepted behavior.
- **Higher-risk change:** establishes or changes a public behavior, API,
  protocol, schema, durable format or state, architecture or dependency
  boundary, hard invariant, security or data boundary, support or compatibility
  claim, retry or migration policy, release policy, or contribution/review/
  merge policy. Changes crossing bounded contexts or whose failure could affect
  more than one context are also higher-risk.

When classification is uncertain, use Higher-risk until the Maintainer records
another decision. Ordinary changes use the [Ordinary change Issue
form](.github/ISSUE_TEMPLATE/ordinary.yml), then the usual pull request and CI
path. Higher-risk changes use the [Higher-risk proposal
form](.github/ISSUE_TEMPLATE/proposal.yml) and the records and independent
review requirements below.

### Records before implementation

The accepted Issue or ADR for a higher-risk change records:

- the problem and why it matters;
- the proposed contract or process decision;
- what is in scope and explicitly out of scope;
- the canonical authority and owner;
- the disposition of every overlapping old path (deleted, migrated,
  provisional with an owner and trigger, or retained for a distinct named
  responsibility); and
- at least one concrete failure case and the evidence expected to detect it.

For higher-risk work, the PR links that accepted record. For an allowed
ordinary no-Issue change, it names the owner-local contract and the applicable
exception. Every PR names its change class, affected paths or contexts,
authority, owner, old-path dispositions, commands/tests/inspections, the
concrete failure case checked, and known limitations or evidence gaps.

### Independent review for higher-risk changes

Bind independent review to the exact candidate commit. The PR records the
target SHA, changed paths, accepted decision, and the revisions of the
authorities used by the reviewer. At least one reviewer who did not author the
candidate inspects that exact target against the stated scope and failure case;
additional reviewers or perspectives are added when the impact warrants it.
Each review records its question, findings, supporting evidence, and any
incomplete or unresolved item. A changed target, authority, decision, scope,
owner, or old-path disposition requires a new review record.

No particular review artifact or tool is required: a clear Markdown record,
pull-request review, or equivalent retained project record is sufficient. If an
independent reviewer or required evidence is unavailable, record the gap and
its owner or next action instead of treating the change as complete.

### Contract changes and evidence gaps

Stop and return to the Issue or ADR before continuing when implementation would
change the accepted authority, contract, public claim, scope, support or
compatibility boundary, lifecycle, schema, durable field, canonical owner, or
old-path disposition. Do not make that change silently.

Keep limitations and missing evidence visible in the PR, with an owner or next
action. Passing CI, completing a template, or agreeing in review does not by
itself establish a claim.

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

See [`GOVERNANCE.md#merge-policy`](GOVERNANCE.md#merge-policy) for the
canonical merge and branch rules. This document does not restate or override
those rules.

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
