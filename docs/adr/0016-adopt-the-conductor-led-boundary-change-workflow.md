# ADR-0016: Adopt the conductor-led Boundary change workflow

- Status: Accepted
- Date: 2026-08-25
- Related: Issue #12, Issue #74, Issue #94, ADR-0015

## Context

The first fixed-SHA adversarial review found defects that ordinary green CI and
self-reported completion did not expose. Several failures shared process-level
causes: a contract or claim had more than one owner, implementation and review
reconstructed different context, lifecycle scopes were left implicit, an old
path remained beside a new path, or one reasoning session effectively confirmed
its own work.

Aizign already uses proposal-first changes, ADRs for architecture and policy,
and exact-SHA release review. It needs a small operational workflow that makes
those boundaries explicit without turning every typo or owner-local correction
into a large independent campaign.

The workflow must remain usable when a specialist model has stronger technical
reasoning than the session coordinating the change. Coordination should
preserve authority, claims, evidence, and role separation rather than require
one coordinator to reproduce every specialist result.

## Decision

Adopt a conductor-led workflow for **Boundary changes** and **Milestone
reviews**. Routine changes continue to use the ordinary contribution process.
The rule applies by change class whether work is manual or AI-assisted.

Use one canonical Routine predicate:

> Routine is allowed only when the change remains within an accepted
> owner-local contract and satisfies none of the Boundary-change predicates. A
> bug fix may change observed behavior only to restore that accepted contract;
> changing the contract or public claim is Boundary work.

Keep existing governance authority unchanged:

- `GOVERNANCE.md` owns Maintainer, merge, and release authority;
- `CONTRIBUTING.md` owns contribution policy;
- [`docs/development/change-workflow.md`](../development/change-workflow.md)
  owns the required operational procedure delegated by `CONTRIBUTING.md`;
- [`docs/development/review-packet.md`](../development/review-packet.md) owns
  the fixed review-context interface; and
- product and runtime contracts remain owned by their existing specifications,
  architecture documents, accepted ADRs, maintained source, and tests.

Introduce a **Development Conductor** role. The Conductor determines change
class, prepares structured claims and ranges, identifies canonical and duplicate
owners, prepares checkpoint content, creates fresh-session handoffs, freezes
review batches, and reports transition readiness. The Conductor does not edit
the candidate artifacts that realize the Boundary change, perform Breaker
review, perform source adjudication, approve as a Maintainer, merge, or release.
Candidate artifacts include production code, process documents, templates,
schemas, automation, configuration, and skill definitions.

A Contract Designer likewise does not implement or edit those candidate
artifacts in the same Boundary-change session. An Implementer receives approved
checkpoint content and produces the candidate artifacts in a separate session.

A Maintainer separately approves policy and ADR decisions, approves exact
checkpoint content where required, and makes merge, milestone, or release
decisions. The same human may perform both Maintainer and Conductor roles, but
the record distinguishes the Conductor assessment from the Maintainer decision.

Represent the checkpoint as two layers:

1. `checkpoint_content`, containing authorities, owners, claims, ranges,
   evidence requirements, review assignments, and scope; and
2. an external digest and approval envelope.

Hash canonical `checkpoint_content` only. Do not include the digest or approval
metadata in its own hash input. An approved envelope repeats the exact
checkpoint digest. Editing checkpoint content requires a new digest and
approval; adding approval metadata does not change the checkpoint digest.

Use stable IDs for:

- claims;
- commitment, lifecycle, and consumer ranges;
- evidence requirements; and
- review perspectives.

Proof and review are not additional range types. They are represented by
`evidence_requirements` and `review_assignments`. Every claim, every included or
evidence-gap range, and every evidence requirement maps to one or more
perspectives before review begins.

For each Boundary change:

1. identify one canonical owner for every changed policy or surface;
2. dispose every old or competing path as deleted, migrated, explicitly
   provisional, or retained for a distinct named responsibility;
3. define structured claims and commitment/lifecycle/consumer ranges;
4. define concrete falsification and evidence requirements;
5. stop and return to proposal when implementation discovers a contract delta;
6. review one exact target with one frozen shared context;
7. use one fresh Breaker session per perspective; and
8. use a separate fresh Adjudicator to verify findings against source.

A review-only Milestone follows an explicit path from approved checkpoint to
frozen candidate/evidence, review, adjudication, milestone readiness, and a
Maintainer decision. It does not require an artificial Implementer session. A
Milestone that first changes candidate artifacts uses the Boundary path to
produce them and then starts a separate review-only Milestone checkpoint.

Review packets bind the target SHA and tree, base and merge-base, exact changed
paths, controlling authority revisions, checkpoint content/digest/approval,
frozen Issue and pull-request bodies, structured subjects, evidence, and known
gaps. Reviewers do not independently reconstruct mutable project context.

Add one tracked, dependency-free Node validator at
`scripts/validate-review-batch.mjs`. It validates all packet files in one batch,
including the closed field set, nested content/artifact digests, cross-field
constraints, byte-equivalent shared context, unique perspective packets, and
complete stable-ID coverage. Digest agreement alone is not packet validity.

Allow optional personal or workspace Codex skills for Conduct, Break, and
Adjudicate. Each skill says in its `description` and body that it is used only
through explicit `$skill-name` invocation. Skills are installed outside the
repository, remain non-authoritative, and have a tracked manual equivalent.

Treat R01-R14 as the external review plan for the current pre-v0.1 Foundation
campaign and its required complete rerun only. It is not a normal pull-request
gate, permanent perspective taxonomy, or generic skill payload.

## Consequences

### Positive

- Authority, implementation, evidence, review, and approval become separate
  records.
- Checkpoint approval no longer creates a digest or approval self-reference.
- A stronger specialist can contribute without silently replacing repository
  authority or Maintainer decisions.
- Reviewers receive one validated exact-revision context instead of
  reconstructing mutable metadata independently.
- Stable IDs make coverage omissions mechanically detectable for every declared
  subject.
- Review-only Milestones have an executable state path.
- Duplicate ownership and undisposed old paths are addressed before completion.
- Routine changes retain a lightweight path.
- The process remains executable without Codex or any skill.

### Negative / Risks

- Boundary changes require more preparation and fresh sessions than ordinary
  pull requests.
- The batch validator adds a small tracked script and interface that must be
  maintained with the workflow.
- The validator proves internal packet consistency, not the truth or
  completeness of the technical claims selected by the Conductor.
- Poor classification can either overburden Routine work or under-review a real
  Boundary change.
- Role separation is logical rather than an identity-security boundary; a
  Maintainer must still ensure sessions receive the intended inputs.
- A completed template or validated packet remains evidence metadata, not proof
  that the underlying claim is true.

### Follow-up

- Add the tracked workflow, review-packet interface, validator, and contribution
  templates in the pull request for Issue #94.
- Install and smoke-test the personal/workspace `$aizign-conduct`,
  `$aizign-break`, and `$aizign-adjudicate` skills outside the repository.
- Recreate the PR #95 bootstrap batch under a new ID and new, unedited comment
  for the exact corrected head.
- Use Issue #84 as the first complete pilot while preparing contract decisions
  for Issues #72, #75, and #81.
- Run one retrospective after the four contract decisions and another after
  the first three implementation pull requests.

## Alternatives considered

- **Use the existing PR checklist only.** Rejected because a checklist does not
  fix mutable reviewer context, role self-confirmation, or duplicate ownership.
- **Keep digest-only packet verification.** Rejected because malformed or
  mutually inconsistent packet files can still have correct individual hashes.
- **Treat proof and review as free-text ranges.** Rejected because stable
  evidence and assignment IDs provide clearer ownership and mechanical
  coverage checks.
- **Require an Implementer for every Milestone review.** Rejected because a
  review-only exact candidate may need no candidate edit.
- **Require the full adversarial campaign for every pull request.** Rejected
  because review depth must follow the changed claims and ranges; Routine work
  should remain lightweight.
- **Give an autonomous Conductor approval, merge, or release authority.**
  Rejected because repository governance assigns those decisions to a
  Maintainer and configured repository mechanisms.
- **Create a permanent review-lens registry.** Rejected because perspectives
  should be derived from each accepted checkpoint and its failure models.
