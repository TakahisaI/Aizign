# ADR-0018: Require implementation readiness before higher-risk implementation

- Status: Accepted
- Date: 2026-08-26
- Related: ADR-0016, Issue #97
- Acceptance: [Maintainer decision for Issue #97, comment `5423689890`](https://github.com/TakahisaI/Aizign/issues/97#issuecomment-5423689890)
- Initial readiness: [Checkpoint `I97-7FB4319-A` decision, comment `5423699249`](https://github.com/TakahisaI/Aizign/issues/97#issuecomment-5423699249)

## Context

ADR-0016 established a lightweight, repository-owned Higher-risk change
contract. It requires an accepted Issue, canonical ownership, old-path
dispositions, failure evidence, exact-target review, and a separate Maintainer
merge decision.

The contract did not distinguish acceptance of the problem and target contract
from readiness to change implementation artifacts. Authority, concrete
implementation ownership, duplicate paths, and pull-request boundaries can
therefore still be decided while coding, or the Maintainer must supply
file-level instructions before the current repository has been inspected. The
existing statement that a pull request normally closes one leaf Issue also
encourages problem boundaries, implementation boundaries, and review
boundaries to be treated as identical.

## Decision

Keep [`CONTRIBUTING.md`](../../CONTRIBUTING.md) as the sole repository owner of
the public contribution contract and add a manual implementation-readiness gate
for Higher-risk work.

Separate the lifecycle into three records:

1. **Proposal accepted.** The Issue owns the problem, target contract or process
   decision, scope, authority direction, old-path policy, and falsifying
   evidence. Acceptance authorizes preparation only.
2. **Implementation prepared.** The repository is inspected at one exact
   `main` commit. An Issue checkpoint records the normative authorities, single
   implementation owners, consumers, all overlapping paths and dispositions,
   reviewable slices and dependency order, evidence, unresolved items, and stop
   conditions.
3. **Ready for implementation.** A Maintainer separately accepts the checkpoint
   and names the authorized slice or slices before candidate artifacts change.

A checkpoint may be an ordinary Issue comment. No separate implementation-plan
document, schema, validator, bot, model, skill, or session arrangement is
required. When a contract-setting ADR is part of the authorized slice, the
checkpoint may name its planned path before that ADR exists in `main`.

A materially changed planning base, authority, owner, scope, old-path
disposition, or slice boundary invalidates the affected readiness decision.
Implementation stops until the Issue or ADR is revised as required, the
checkpoint is updated, and a Maintainer records renewed readiness.

An Issue owns a problem and outcome-level completion evidence; it is not
automatically an implementation unit. One Issue may contain multiple
implementation slices and pull requests. One pull request remains one
reviewable slice and references the accepted checkpoint and one authorized
slice. An intermediate pull request references the Issue without closing it.
The Issue closes only when its remaining outcome-level evidence is satisfied.

The Higher-risk Issue Form seeds the initial `Not ready` checklist. The
pull-request template collects checkpoint, planning-base, readiness, and slice
references. Templates collect records only and do not authorize decisions.

This ADR extends ADR-0016. It retains ADR-0016's repository ownership,
tool-neutral operation, exact-target review, visible gaps, and separate
Maintainer merge decision. Readiness is an additional implementation gate; it
is not review evidence, merge approval, milestone approval, or release authority.

## Consequences

Authority and ownership decisions can be proposed from repository evidence
instead of requiring the Maintainer to invent file-level instructions. An
implementer receives a bounded slice and explicit stop conditions before
coding. Duplicate paths must be disposed before activation, while an Issue may
remain open across the multiple reviewable pull requests needed to complete its
outcome.

The process adds one explicit preparation and readiness record for Higher-risk
work. That cost is intentionally limited to changes whose public or
cross-context impact already requires a Higher-risk Issue. Ordinary changes and
allowed no-Issue exceptions remain unchanged.

## Alternatives considered

- **Require the Maintainer to provide the implementation map.** Rejected because
  the map depends on exact-base repository inspection and would make detailed
  file-level design a prerequisite for proposing a problem.
- **Let the implementer decide ownership while coding.** Rejected because it
  recreates duplicate authority, silent contract changes, and unstable
  pull-request boundaries.
- **Keep one leaf Issue equal to one pull request.** Rejected because problem,
  ownership-transition, and review boundaries do not generally coincide.
- **Add a checkpoint schema, bot, or workflow engine.** Deferred. Ordinary Issue
  comments and pull-request records are sufficient until repeated evidence
  proves manual preparation unreliable.
