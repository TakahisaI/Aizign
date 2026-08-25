# ADR-0016: Adopt the conductor-led Boundary change workflow

- Status: Accepted
- Date: 2026-08-25
- Related: Issue #12, Issue #74, Issue #94, ADR-0015

## Context

The first fixed-SHA adversarial review found defects that ordinary green CI and
self-reported completion did not expose. Several failures shared process-level
causes: a contract or claim had more than one owner, implementation and review
reconstructed different context, lifecycle ranges were left implicit, an old
path remained beside a new path, or the same reasoning session effectively
confirmed its own work.

Aizign already uses proposal-first changes, ADRs for architecture and policy,
and exact-SHA release review. It needs a small operational workflow that makes
those boundaries explicit without turning every typo or local refactor into a
large independent review campaign.

The workflow must also remain usable when a specialist model has stronger
technical reasoning than the session coordinating the change. Coordination
should preserve authority, ranges, evidence, and role separation rather than
pretend one coordinator must independently reproduce every specialist result.

## Decision

Adopt a conductor-led workflow for **Boundary changes** and **Milestone
reviews**. Routine changes continue to use the ordinary contribution process.
The rule applies by change class whether the work is manual or AI-assisted.

Keep the existing governance authority unchanged:

- `GOVERNANCE.md` owns Maintainer, merge, and release authority;
- `CONTRIBUTING.md` owns contribution policy;
- [`docs/development/change-workflow.md`](../development/change-workflow.md)
  owns the required operational procedure delegated by `CONTRIBUTING.md`;
- [`docs/development/review-packet.md`](../development/review-packet.md) owns
  the fixed review-context interface and manual review procedure; and
- product and runtime contracts remain owned by their existing specifications,
  architecture documents, accepted ADRs, maintained source, and tests.

Introduce a **Development Conductor** role. The Conductor determines change
class and ranges, identifies canonical and duplicate owners, prepares contract
checkpoints, creates fresh-session handoffs, derives targeted review
perspectives, freezes reviewer packets, and reports transition readiness. The
Conductor does not implement production code, perform Breaker review, perform
source adjudication, approve as a Maintainer, merge, or release.

A Maintainer separately approves policy and ADR decisions, approves a contract
checkpoint where required, and makes merge or release decisions. The same
human may perform both Maintainer and Conductor roles, but the evidence record
must distinguish the Conductor assessment from the Maintainer decision.

For each Boundary change:

1. identify one canonical owner for every changed policy or surface;
2. dispose every old or competing path as deleted, migrated, explicitly
   provisional, or retained for a distinct named responsibility;
3. define commitment, lifecycle, consumer, proof, and review ranges;
4. state a concrete falsification case and the evidence expected to detect it;
5. stop and return to proposal when implementation discovers a contract delta;
6. review one exact target with one frozen shared context;
7. use one fresh Breaker session per assigned perspective; and
8. use a separate fresh Adjudicator to verify findings against source.

Review packets bind the target SHA and tree, base and merge-base, workflow
revision, approved checkpoint, authority set, frozen Issue and pull-request
context, assigned ranges, evidence paths, and known gaps. Reviewers do not
independently reconstruct mutable project context.

Allow optional repository-scoped Codex skills for Conduct, Break, and
Adjudicate after the tracked workflow merges. Each skill must say in its
`description` and body that it is used only through explicit `$skill-name`
invocation. Skills remain non-authoritative and have a tracked manual
equivalent. The initial skills are read-only. Candidate skills do not review or
adjudicate themselves.

Treat R01-R14 as the external review plan for the current pre-v0.1 Foundation
campaign and its required complete rerun only. It is not a normal pull-request
gate, permanent perspective taxonomy, or generic skill payload.

## Consequences

### Positive

- Authority, implementation, proof, review, and approval become separate
  evidence ranges.
- A stronger specialist can contribute without silently replacing repository
  authority or Maintainer decisions.
- Reviewers receive one consistent exact-revision context instead of
  reconstructing mutable metadata independently.
- Duplicate ownership and undisposed old paths are addressed before a change is
  considered complete.
- Routine changes retain a lightweight path.
- The process remains executable without Codex or any skill.

### Negative / Risks

- Boundary changes require more preparation and fresh sessions than ordinary
  pull requests.
- The initial packet and handoff steps are manual and may reveal repetitive
  clerical work.
- Poor change classification can either overburden Routine work or under-review
  a real boundary change.
- Role separation is logical rather than an identity-security boundary; a
  maintainer must still ensure sessions receive the intended inputs.
- A completed template or packet remains evidence metadata, not proof that the
  underlying claim is true.

### Follow-up

- Add the tracked workflow, review-packet interface, and contribution templates
  in the first pull request for Issue #94.
- Add the explicit `$aizign-conduct`, `$aizign-break`, and
  `$aizign-adjudicate` skills in a second pull request after the workflow
  merges.
- Use Issue #84 as the first complete pilot, while preparing contract decisions
  for Issues #72, #75, and #81.
- Run one retrospective after the four contract decisions and another after
  the first three implementation pull requests.
- Add at most one small deterministic automation slice when the pilot shows a
  repeated error that cannot be addressed by simpler wording or templates.

## Alternatives considered

- **Use the existing PR checklist only.** Rejected because a checklist does not
  fix mutable reviewer context, role self-confirmation, or duplicate ownership.
- **Require the full adversarial campaign for every pull request.** Rejected
  because review depth must follow the changed claims and ranges; Routine work
  should remain lightweight.
- **Give an autonomous Conductor approval, merge, or release authority.**
  Rejected because repository governance assigns those decisions to a
  Maintainer and the configured repository mechanisms.
- **Create a permanent review-lens registry.** Rejected because perspectives
  should be derived from each accepted checkpoint and its failure models.
- **Automate the full workflow immediately.** Rejected because the pilot must
  first identify which steps are deterministic and which require Maintainer or
  Conductor judgment.
