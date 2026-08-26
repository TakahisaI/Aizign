# Conductor-led Boundary change workflow

## Status and authority

This is the **pilot operating procedure** for Boundary changes and Milestone
reviews. It is intentionally sized for Aizign before v0.1: one Maintainer,
ordinary coding sessions, and three optional personal/workspace skills.

`GOVERNANCE.md` defines Maintainer, merge, milestone, and release authority.
`CONTRIBUTING.md` is the contribution-policy authority. Product and runtime
contracts remain owned by their existing specifications, architecture
documents, accepted ADRs, maintained source, and tests.

This procedure is workflow guidance. An Issue, review brief, skill output,
Breaker report, adjudication, or completed template is evidence; it does not
replace a normative repository authority or a Maintainer decision.

The decision to pilot this procedure is recorded in
[ADR-0016](../adr/0016-adopt-the-conductor-led-boundary-change-workflow.md).
The manual fixed-context format is described in
[Review brief](review-brief.md).

## Current execution model

The pilot assumes only these explicit-invocation skills:

- `$aizign-conduct`
- `$aizign-break`
- `$aizign-adjudicate`

They are optional adapters installed outside the repository. Do not activate
them from an ordinary coding or review request.

There is no required `$aizign-design`, `$aizign-implement`, packet generator,
schema validator, workflow bot, or Aizign runtime automation. Contract design
and implementation use ordinary human or coding-agent sessions. A Conductor
may prepare a handoff for such a session but does not perform the implementation
while acting as Conductor.

## Change classes

### Routine change

A change is Routine only when it stays inside an already accepted owner-local
contract and does not change a public or repository-level claim.

Typical examples:

- typo and prose corrections that do not change a maintained claim;
- internal refactoring that preserves accepted behavior and boundaries; and
- a bounded bug fix that restores already accepted behavior.

Routine work uses the ordinary Issue/PR/CI path. It does not require a
Conductor, review brief, Breaker, or Adjudicator unless the Maintainer requests
one for a concrete risk.

### Boundary change

A change is Boundary work when it changes or establishes any of:

- a normative authority, accepted contract, public claim, Protocol or public
  API, stable code, schema, durable format, or durable state;
- a hard invariant, architecture or package/crate boundary, dependency
  direction, security or data boundary;
- support, compatibility, retry, unknown, lifecycle, release, or migration
  policy; or
- contribution, review, merge, automation, adapter, or repository-governance
  policy.

Boundary work uses the pilot sequence below.

### Milestone review

A Milestone review evaluates one exact candidate such as a Foundation freeze,
dogfood entry point, release candidate, or v0.1 acceptance candidate. It may be
review-only and does not require an artificial implementation session.

A previous review campaign is not automatically reused. The Conductor derives
perspectives from the current candidate, accepted claims, and known risks.

## Pilot sequence

### 1. Accept the decision

Before implementation, the Issue and, when required, an ADR state:

- the problem;
- the changed contract or process decision;
- in-scope and out-of-scope areas;
- the canonical authority or owner;
- the disposition of overlapping old paths; and
- at least one concrete failure case and expected evidence.

The Maintainer records acceptance in the Issue or ADR under the authority in
`GOVERNANCE.md`. No cryptographic checkpoint or approval digest is required
during the pilot.

### 2. Conduct the change

Invoke `$aizign-conduct` explicitly when the change is Boundary or Milestone
work. The Conductor reads the repository and current Issue/PR, classifies the
change, identifies missing decisions, and prepares the smallest useful handoff.

For implementation work, the handoff names:

- accepted authorities and decision;
- files or bounded contexts allowed to change;
- prohibited changes;
- canonical owner and old-path disposition;
- required evidence; and
- known gaps.

If design is still unresolved, use an ordinary specialist session and return
the resulting decision to the Issue or ADR. A separate Contract Designer skill
is not required.

### 3. Implement in an ordinary coding session

Implementation is ordinary repository work. It may be performed by the same
human who maintained the Issue, but not by the same model session that is
currently acting as Conductor.

The Implementer stops and returns to the Issue or ADR when the implementation
would change the accepted contract, authority, support claim, compatibility
decision, lifecycle scope, schema, durable field, stable code, canonical owner,
or old-path disposition.

### 4. Establish evidence

Run the owner-local tests and normal repository checks. Record:

- exact commands and results;
- the concrete failure case exercised;
- source, test, fixture, conformance, or inspection evidence;
- known limitations; and
- unresolved evidence gaps.

Green CI and an Implementer narrative are supporting evidence, not proof by
themselves.

### 5. Freeze a manual review brief

After the candidate is ready for independent review, the Conductor creates one
manual Markdown review brief using
[`docs/development/review-brief.md`](review-brief.md).

The brief binds:

- repository, Issue/PR, exact target SHA, base, merge-base, and changed paths;
- controlling authorities;
- accepted decision, scope, owner, and old-path disposition;
- claims, concrete failure cases, evidence, and gaps; and
- one bounded question per Breaker perspective.

No JSON schema, generated packet, content hash, or batch validator is required.
The exact target commit already binds its tree. Copy the accepted decision text
into the brief when mutable Issue or PR wording would otherwise be ambiguous.

A target, authority, accepted decision, scope, or perspective change creates a
new `brief_id`. Later CI results for the same target may be appended as
observational evidence without replacing the brief.

### 6. Run independent Breakers

Invoke `$aizign-break` in one fresh session per perspective. Each session
receives:

- the same review brief;
- exactly one perspective assignment;
- access to the exact target and named authorities; and
- no other Breaker report.

A Breaker returns findings only and classifies each candidate as
`established`, `not established`, or `incomplete`. It does not implement,
integrate reports, assign final severity, or recommend merge.

### 7. Adjudicate

After all expected Breaker reports arrive, invoke `$aizign-adjudicate` in a
separate fresh session. The Adjudicator independently reinspects the exact
source and authorities, classifies every raw finding as `established`,
`rejected`, or `incomplete`, integrates verified root causes, assigns severity
from impact, and states the required correction or proof.

The Adjudicator may recommend `blocked`, `needs evidence`, or `ready for
Maintainer decision`. It does not approve, merge, release, or implement fixes.

### 8. Decide

The Conductor checks that the exact target is still current, required evidence
exists, adjudicated blockers are closed, and no contract divergence remains.
This is a readiness assessment, not approval.

The Maintainer separately records the merge, milestone, or release decision.
Repository checks and merge policy still apply.

## Proportional review depth

Use the smallest number of perspectives that covers the material failure
models.

| Change | Default independent review |
|---|---|
| Routine | Ordinary review only |
| Normal Boundary change | 1 Breaker + 1 Adjudicator |
| High-impact Boundary change | 2–3 Breakers + 1 Adjudicator |
| Milestone review | 2–4 Breakers + 1 Adjudicator |

Treat a Boundary change as high-impact when it affects security or data
boundaries, wire or durable formats, compatibility or release policy, more than
one bounded context, repository governance, or a failure mode that has already
escaped review.

The Maintainer may reduce or increase the count with a brief reason in the
Issue or review brief. Perspective count is not evidence quality.

## Roles and boundaries

### Maintainer

The Maintainer exercises the authority defined by `GOVERNANCE.md`, including
Issue/ADR decisions, merge, milestone, and release decisions.

When the same human also conducts the change, keep these records visibly
separate:

```text
Conductor readiness assessment:
Maintainer decision:
```

### Development Conductor

The Conductor owns workflow composition and handoffs.

It may:

- classify the change;
- locate authorities;
- summarize accepted scope;
- identify canonical and overlapping owners;
- prepare implementation and review handoffs;
- choose proportional perspectives;
- create the review brief; and
- assess transition readiness.

It must not, while acting as Conductor:

- edit the candidate artifacts that realize the Boundary change;
- perform Breaker review or adjudication;
- invent missing authority or evidence from prior-session memory;
- approve as Maintainer without a separate record; or
- merge, close, tag, publish, or release.

### Implementer

The Implementer is an ordinary coding session, not a required skill. It follows
the accepted Issue/ADR and Conductor handoff, produces candidate artifacts and
evidence, and reports divergence instead of silently changing the decision.

### Breaker

A Breaker receives one bounded perspective in a fresh session, inspects exact
source and authority, constructs counterexamples, and returns findings only.

### Adjudicator

An Adjudicator receives the review brief and all expected raw reports in a
fresh session, independently verifies them, integrates root causes, and
recommends the next state without implementing or approving.

### Optional specialist

A difficult contract, security, compatibility, or architecture question may be
delegated to an ordinary specialist session. Its output becomes evidence for
the Issue/ADR decision; it does not become authority by itself.

## Permanent rules retained during the pilot

### One canonical owner

Each changed policy, contract, classification, or implementation responsibility
has one canonical owner. Other paths consume that owner or have a distinct
named responsibility.

### Dispose old paths

Every overlapping old path is deleted, migrated, provisional with an owner and
trigger, or retained for a distinct named responsibility.

### No silent contract change

Implementation discoveries that change an accepted authority, contract, public
claim, support boundary, compatibility decision, lifecycle scope, schema,
durable field, stable code, owner, or old-path disposition return to the Issue
or ADR before implementation continues.

### Review exact source and authority

Review binds one exact target and the authority revision that controls it.
Missing access or evidence is `incomplete`, not success.

### Keep evidence gaps visible

A gap has an owner or next action. A limitation is not hidden by a green test
count, a completed template, or reviewer agreement.

## Bootstrap for PR #95

PR #95 does not need to prove a future automated workflow by using that
automation before it exists.

For this initial workflow change:

1. base-revision `GOVERNANCE.md` and `CONTRIBUTING.md`, plus the accepted
   direction in Issue #94, control the review;
2. the candidate ADR and workflow are evidence under review, not accepted
   authority;
3. `$aizign-conduct`, `$aizign-break`, and `$aizign-adjudicate` may be used as
   explicit personal/workspace adapters;
4. prepare one manual review brief for the exact PR head;
5. use two Breaker perspectives: authority/role separation and
   proportionality/executability;
6. run one separate Adjudicator session; and
7. obtain the normal Maintainer merge decision.

Earlier digest/checkpoint/batch records for PR #95 are historical and must not
be reused. No replacement v6 digest or generated packet batch is required.

## Pilot exit and retrospective

Review this procedure after the Issue #84 dogfood pilot and two subsequent
Boundary pull requests, or before the v0.1 Milestone review, whichever comes
first.

The retrospective records:

- where context actually drifted;
- where scope or ownership was ambiguous;
- which evidence was repeatedly missing;
- how many sessions and handoffs were useful or wasteful; and
- which checks, if any, deserve automation.

Add a schema, validator, packet generator, or bot only for an observed repeated
failure that the manual review brief did not control. Until then, keep the
manual path canonical.
