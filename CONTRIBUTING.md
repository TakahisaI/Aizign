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
contract adds no authority beyond that source. Governance's broad rule that
architecture, boundary, and policy changes require an ADR controls; the ADR
examples below are illustrative, not exhaustive.

A Higher-risk change requires an accepted Issue before implementation
preparation and an ADR whenever Governance or this contract requires one.
Proposal acceptance authorizes repository inspection and planning only. Before
candidate artifacts change, a Maintainer must separately mark an exact-base
implementation checkpoint `Ready for implementation`. An accepted decision
cannot be silently widened by a checkpoint or pull request. A readiness record
is not a review or merge decision, review evidence is not approval, and a
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
form](.github/ISSUE_TEMPLATE/ordinary.yml) except for the allowed no-Issue
cases listed in [the allowed no-Issue cases section](#受け付けるもの). Those
cases proceed directly to the usual pull request and CI path while the PR
records the accepted owner-local contract and applicable exception. Higher-risk
changes use the [Higher-risk proposal
form](.github/ISSUE_TEMPLATE/proposal.yml) and the records, readiness, and
independent-review requirements below.

### Proposal acceptance

The accepted Issue for a Higher-risk change records:

- the problem and why it matters;
- the proposed contract or process decision;
- what is in scope and explicitly out of scope;
- the canonical authority direction and owner;
- the disposition policy for overlapping old paths (deleted, migrated,
  provisional with an owner and trigger, or retained for a distinct named
  responsibility); and
- at least one concrete failure case and the evidence expected to detect it.

When Governance or this contract requires an ADR, the ADR accompanies the
Issue and records the durable architecture or policy decision; it does not
replace the Issue. A planned ADR path may be recorded when the contract-setting
ADR is part of the first authorized slice.

Proposal acceptance does not make the change ready for implementation.
File-level owners, duplicate paths, and pull-request slices that require current
repository inspection should remain unresolved until implementation
preparation rather than being guessed during proposal creation.

### Implementation preparation and readiness

Before changing any source, normative document, template, schema, automation,
configuration, or other artifact intended for a Higher-risk candidate, inspect
the repository at one exact `main` commit and record an implementation
checkpoint in the accepted Issue. The checkpoint records:

- a stable checkpoint identifier and the exact planning-base commit;
- the accepted Issue decision and any required ADR/specification references,
  including a planned ADR path when that ADR belongs to the first authorized
  slice;
- each changed decision or invariant and its normative authority;
- the single implementation owner for each changed invariant;
- consumers that may apply or test the authority but may not redefine it;
- every overlapping or duplicate path and its disposition;
- the reviewable implementation slices, whether they are independent or
  ordered, and the predecessor condition for each ordered slice;
- for each slice, what changes, what is deleted or migrated, what is preserved,
  what evidence proves it, and what remains out of scope;
- unresolved decisions and evidence gaps; and
- stop conditions that require returning to the Issue or ADR instead of making
  a new contract decision in code.

A Maintainer then records a separate `Ready for implementation` decision that
names the accepted checkpoint and the authorized slice or slices. Preparation
may be performed manually in an Issue comment; no separate planning document,
schema, bot, model, skill, or session arrangement is required.

An independent slice may begin when the readiness decision authorizes it. An
ordered slice must not begin until its checkpoint's predecessor condition is
satisfied. That condition must state whether the predecessor must be merged
into `main` or whether stacked work against one exact predecessor commit is
allowed; the implementer does not choose that mode during implementation.
Before an ordered slice begins, the checkpoint must record whether the current
`main`, or the exact stacked predecessor when expressly authorized, still
preserves the accepted authority, owner, scope, old-path dispositions, evidence
requirements, and slice boundary.

Movement of `main` alone does not invalidate readiness. A materially changed
planning base, authority, owner, scope, old-path disposition, evidence
requirement, or slice boundary does. When any inspection identifies such a
change, implementation stops until the Issue or ADR is revised as required,
the checkpoint is updated, the necessary inspection is repeated, and a
Maintainer records renewed readiness.

For Higher-risk work, each PR links the accepted Issue, any required ADR, the
accepted implementation checkpoint, and the readiness decision. It identifies
one authorized slice and records its planning base, affected paths or contexts,
authority, owner, old-path dispositions, commands/tests/inspections, concrete
failure case, and known limitations or evidence gaps. For an allowed Ordinary
no-Issue change, the PR names the owner-local contract and the applicable
exception.

### Independent review for higher-risk changes

Bind independent review to the exact candidate commit. The PR records the
target SHA, changed paths, accepted decision, implementation checkpoint, and
the revisions of the authorities used by the reviewer. At least one reviewer
who did not author the candidate inspects that exact target against the stated
scope, slice, and failure case; additional reviewers or perspectives are added
when the impact warrants it. Each review records its question, findings,
supporting evidence, and any incomplete or unresolved item. A changed target,
authority, decision, scope, owner, old-path disposition, or authorized slice
requires a new review record.

No particular review artifact or tool is required: a clear Markdown record,
pull-request review, or equivalent retained project record is sufficient. If an
independent reviewer or required evidence is unavailable, record the gap and
its owner or next action instead of treating the change as complete.

### Contract changes and evidence gaps

Stop and return to the accepted Issue and, when required, its ADR before
continuing when implementation would change the accepted authority, contract,
public claim, scope, support or compatibility boundary, lifecycle, schema,
durable field, canonical owner, old-path disposition, or authorized slice.
Revise the implementation checkpoint and obtain a new
`Ready for implementation` decision before resuming. Do not make that change
silently.

Keep limitations and missing evidence visible in the Issue checkpoint and PR,
with an owner or next action. Passing CI, completing a template, receiving a
readiness decision, or agreeing in review does not by itself establish a claim
or authorize merge.

## 受け付けるもの

- Issue、bug report、設計提案
- Issueで合意済みのscopeに対するPR
- typo、軽微な文書修正、自動dependency update（Issueなしで可）

## Work units

- **1 PR = 1 reviewable slice.**
- An Issue owns a problem and its outcome-level completion evidence; it may
  require multiple implementation slices and multiple pull requests.
- A leaf Issue is not automatically an implementation unit.
- Each Higher-risk PR identifies one authorized slice from the accepted
  implementation checkpoint.
- Use `Refs #<number>` for an intermediate slice. Use `Closes #<number>` only
  when that PR satisfies the Issue's remaining outcome-level completion
  evidence.
- Use an umbrella Issue for a large objective and bounded child Issues when the
  child problems have independent outcomes; do not create child Issues merely
  to mirror file or pull-request boundaries.
- Do not push a giant change into one Issue or PR. When a PR changes two or more
  bounded contexts, state why the slice must change them atomically.

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

Governance's broad rule controls: architecture, boundary, and policy changes
require an ADR. The following examples are illustrative, not exhaustive. For a
Higher-risk change, keep the accepted Issue and add an ADR whenever this rule
requires one.

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
