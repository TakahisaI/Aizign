# ADR-0016: Pilot a conductor-led Boundary change workflow

- Status: Accepted
- Date: 2026-08-25
- Related: Issue #12, Issue #74, Issue #94, ADR-0015

## Context

The first fixed-SHA adversarial review exposed process failures that green CI
and self-reported completion did not catch: authority drift, duplicate
ownership, silent contract changes, incomplete lifecycle evidence, reviewer
context drift, and one reasoning session effectively confirming its own work.

Aizign is still before v0.1 and has one Maintainer. It does not yet have a
running Aizign workflow engine, review bot, packet generator, or stable body of
dogfood evidence. The practical operating tools available now are ordinary
coding sessions and three optional personal/workspace skills:

- `$aizign-conduct`
- `$aizign-break`
- `$aizign-adjudicate`

The process must address the observed failures without designing an automation
platform before the manual workflow has been exercised.

## Decision

Pilot a conductor-led workflow for Boundary changes and Milestone reviews.
Routine changes continue to use the ordinary contribution process.

Keep existing authority unchanged:

- `GOVERNANCE.md` owns Maintainer, merge, milestone, and release authority;
- `CONTRIBUTING.md` owns contribution policy;
- [`docs/development/change-workflow.md`](../development/change-workflow.md)
  owns the pilot operating procedure; and
- product and runtime contracts remain owned by their existing normative
  repository sources.

Use the following execution model during the pilot:

1. an Issue and, when required, an ADR accept the changed contract or process
   decision before implementation;
2. an explicitly invoked Development Conductor prepares scope, ownership,
   evidence, and handoffs;
3. an ordinary fresh coding session implements the candidate;
4. the Conductor prepares one manual Markdown review brief for the exact target;
5. one fresh `$aizign-break` session runs per bounded perspective;
6. a separate `$aizign-adjudicate` session independently verifies the reports;
7. the Conductor assesses readiness; and
8. the Maintainer separately decides merge, milestone, or release.

Only the three named skills are assumed. There is no required Contract Designer
or Implementer skill. Difficult design questions may use an ordinary specialist
session, and implementation remains ordinary coding work.

Retain these rules:

- one canonical owner for each changed policy, contract, or responsibility;
- explicit deletion, migration, provisional treatment, or distinct retention
  for overlapping old paths;
- return to the Issue or ADR when implementation discovers a contract delta;
- review of one exact target against named authorities;
- one bounded perspective per fresh Breaker session;
- separate source adjudication; and
- visible evidence gaps and limitations.

Use proportional independent review:

- normal Boundary change: one Breaker and one Adjudicator;
- high-impact Boundary change: two or three Breakers and one Adjudicator; and
- Milestone review: two to four Breakers and one Adjudicator.

Security/data boundaries, wire or durable formats, compatibility/release
policy, cross-context changes, repository governance, and repeated escaped
failures are high-impact by default.

Use a manual Markdown review brief instead of a closed JSON packet interface.
The brief records the Issue/PR, exact target SHA, base and merge-base, changed
paths, controlling authorities, accepted decision, scope, owner, old paths,
claims, failure cases, evidence, gaps, and perspective assignments.

A target or material context change creates a new brief version. No checkpoint
digest, approval envelope, full mutable-body snapshot, packet schema, packet
generator, batch validator, or validator test suite is required during the
pilot. The exact commit, accepted Issue/ADR record, unedited brief version, and
separate Maintainer decision provide the needed traceability at this stage.

For the initial PR #95 review, use base-revision governance and contribution
policy plus the accepted direction in Issue #94. Candidate workflow files are
evidence under review. The three explicit skills may be used. Review the exact
head with two perspectives—authority/role separation and
proportionality/executability—then run separate adjudication and the normal
Maintainer merge decision. Earlier checkpoint/digest/batch records are not
reused, and no replacement formal batch is required.

Review the pilot after the Issue #84 dogfood exercise and two subsequent
Boundary pull requests, or before the v0.1 Milestone review, whichever comes
first. Add automation only for an observed repeated failure that the manual
brief did not control.

## Consequences

### Positive

- The workflow can be used immediately with the tools that actually exist.
- Independent review and adjudication still prevent simple self-confirmation.
- Exact target, authority, scope, ownership, old paths, evidence, and gaps stay
  visible.
- Routine changes remain lightweight.
- Review depth follows risk instead of a permanent fixed campaign.
- The repository does not acquire more than 1,600 lines of packet schema,
  validator, and validator tests before a pilot demonstrates their value.
- Skill use remains explicit and outside repository authority.
- Future automation can be based on observed operational failure data.

### Negative / risks

- Manual briefs can contain omissions or formatting drift.
- The Conductor and Maintainer must notice when a brief needs a new version.
- Role separation is procedural rather than an identity-security boundary.
- Review quality still depends on good perspective selection and exact source
  inspection.
- Deferring mechanical validation may allow an avoidable context mismatch; the
  retrospective must record whether this actually occurs.

## Follow-up

- Merge the pilot workflow and manual review brief.
- Replace the personal/workspace skill instructions with versions that consume
  the manual brief.
- Use Issue #84 as the first full dogfood pilot.
- Run the required retrospective after the trigger in this ADR.
- Propose schema, validator, packet generation, or bot work only when linked to
  a repeated observed failure.

## Alternatives considered

- **Adopt the closed packet schema and batch validator now.** Deferred because
  the interface is larger than the current operating system and has not been
  justified by dogfood data.
- **Use the PR checklist only.** Rejected because it does not provide exact
  shared context, fresh independent review, or separate adjudication.
- **Require dedicated Designer and Implementer skills.** Rejected because those
  skills do not exist and ordinary specialist/coding sessions are sufficient
  for the pilot.
- **Run the full R01-R14 campaign for every change.** Rejected because review
  depth should follow the current change and risk.
- **Give the Conductor approval or merge authority.** Rejected because
  `GOVERNANCE.md` assigns those decisions to the Maintainer.
