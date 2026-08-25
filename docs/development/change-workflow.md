# Conductor-led Boundary change workflow

## Status and authority

`GOVERNANCE.md` defines Maintainer, merge, and release authority.
`CONTRIBUTING.md` is the contribution-policy authority. This file is the
required operational procedure delegated by `CONTRIBUTING.md` for Boundary
changes and Milestone reviews.

This procedure does not define product behavior, Protocol contracts, durable
formats, hard invariants, security guarantees, compatibility promises, or
support boundaries. Those remain owned by their existing normative repository
authorities.

An Issue, checkpoint, model response, role handoff, closure note, review packet,
Breaker report, adjudication, or completed template is workflow evidence. It
does not replace a normative authority or a Maintainer decision.

The decision to adopt this procedure is recorded in
[ADR-0016](../adr/0016-adopt-the-conductor-led-boundary-change-workflow.md).
The fixed-context interface and its batch validator are described in
[Fixed review packets](review-packet.md).

## Applicability

Classify the change before implementation.

Use this predicate everywhere this repository asks whether work is Routine:

> Routine is allowed only when the change remains within an accepted
> owner-local contract and satisfies none of the Boundary-change predicates. A
> bug fix may change observed behavior only to restore that accepted contract;
> changing the contract or public claim is Boundary work.

### Routine change

A Routine change satisfies the predicate above.

Examples include:

- a typo or prose correction with no claim change;
- an internal refactor that preserves every accepted boundary; or
- a bounded bug fix that restores already accepted behavior without changing
  the controlling contract or public claim.

Required:

- owner-local tests when behavior changes;
- normal CI; and
- ordinary review where otherwise required.

A standing checkpoint, independent Breaker, or multiple-perspective review is
not required.

### Boundary change

A change is Boundary work when it changes or establishes any of:

- a normative authority, accepted contract, public claim, Protocol or public
  API, stable code, schema, durable format, or durable state;
- a hard invariant, architecture or package/crate boundary, dependency
  direction, security or data boundary;
- support, compatibility, retry, unknown, lifecycle, release, or migration
  policy;
- an adapter or process boundary; or
- contribution, review, merge, automation, or repository-governance policy.

Required:

- Development Conductor assessment;
- checkpoint content prepared by the Conductor and approved by a Maintainer;
- one canonical owner and complete old-path disposition;
- structured claims, ranges, evidence requirements, and review assignments;
- a fresh Implementer session for the candidate artifacts;
- targeted fresh-session Breaker review;
- separate fresh source adjudication;
- Conductor transition-readiness assessment; and
- separate Maintainer merge decision.

### Milestone review

A Milestone review evaluates an exact candidate such as a Foundation freeze,
release candidate, or dogfood entry point. It may be review-only and therefore
does not imply an Implementer session.

Required:

- exact candidate and evidence binding;
- milestone-specific claims, failure models, and review assignments;
- one fresh Breaker session per perspective;
- separate fresh adjudication; and
- Maintainer milestone or release decision.

A previous campaign plan is not automatically reused.

## Permanent rules

### No silent contract change

An Implementer must not change an authority, invariant, public claim, support
boundary, compatibility decision, lifecycle scope, stable code, schema field,
or durable field merely to agree with an implementation discovery. The
affected work stops and returns to `proposed`.

### Single policy owner

Each changed acceptance rule, classification, retry decision, support claim,
or other policy has one canonical owner. Independent implementations consume
that policy; they do not redefine it separately.

### Delete before add

A new path with an existing responsibility requires a disposition for every
old path:

- deleted;
- migrated to the canonical owner;
- provisional with an owner and removal or promotion trigger; or
- retained for a distinct named responsibility.

### Falsification before completion

Each Boundary claim has a stable `claim_id`, a concrete counterexample or
failure sequence, and an evidence requirement that must detect it. A final
result alone does not prove an unobserved mechanism.

### Review exact code and authority

Review uses an exact revision, approved checkpoint content, applicable
normative authorities, declared ranges, and relevant evidence. An Implementer
narrative and green test counts are not substitutes for source evidence.

`No finding` means the assigned evidence was inspected and no counterexample
was established. Missing access or evidence is `INCOMPLETE`.

## Roles

Role separation is logical. A role may be performed by a person, model,
provider, or future Aizign automation. For a Boundary change, one model session
must not both design the contract and edit the candidate artifacts that realize
it, and must not self-complete implementation, Breaker review, and
adjudication.

Candidate artifacts include production code, process documents, templates,
schemas, automation, configuration, and skill definitions.

### Normative authority

Normative authority is the applicable versioned repository source that
determines what is currently true. Use the repository authority map in
`AGENTS.md` to locate it.

A Maintainer, Conductor, specialist model, Issue comment, skill, or review
report does not become product authority merely by making a statement.

### Maintainer

The Maintainer exercises the authority defined by `GOVERNANCE.md`.

Produces:

- policy or ADR decision;
- checkpoint approval or rejection;
- implementation authorization where required;
- merge decision; and
- milestone or release decision.

A Maintainer must not treat a Conductor readiness report, completed template,
or green CI as sufficient proof by itself.

The same human may also act as Conductor, but the record must separate:

```text
Conductor assessment:
Maintainer decision:
```

### Development Conductor

The Development Conductor owns composition, evidence status, role handoffs,
fixed review context, and transition-readiness assessment rather than universal
technical expertise.

Inputs:

- current repository and exact revision;
- current Issue and pull request;
- `GOVERNANCE.md`, `CONTRIBUTING.md`, this procedure, and applicable
  `AGENTS.md` files;
- current normative authorities; and
- known findings and evidence.

Produces:

- change class and current workflow state;
- structured claims;
- commitment, lifecycle, and consumer ranges;
- evidence requirements and review assignments;
- canonical owner and duplicate-owner candidates;
- checkpoint content;
- Contract Designer and Implementer handoffs;
- fixed review batch and packets;
- Adjudicator handoff; and
- transition-readiness report for the Maintainer.

Must not:

- implement or edit the candidate artifacts that realize the Boundary change,
  including production code, process documents, templates, schemas,
  automation, configuration, or skill definitions;
- perform Breaker review;
- perform source adjudication;
- approve in the Maintainer role without a separately recorded decision;
- merge, close, tag, publish, or release; or
- fill missing evidence from prior-session memory.

The Conductor may delegate difficult technical decisions to stronger
specialists. The Conductor does not need to reproduce every specialist argument
from scratch, but must prevent specialist output from silently replacing
repository authority.

### Contract Designer

Inputs:

- problem;
- current authorities;
- existing owners and paths;
- known findings; and
- allowed decision range.

Produces:

- contract delta and non-goals;
- current-versus-future boundary;
- canonical owner;
- duplicate owners and old-path disposition;
- alternatives and trade-offs;
- compatibility or migration decision;
- structured claims and ranges;
- evidence requirements; and
- candidate review assignments.

Must not:

- implement or edit the candidate artifacts that realize the Boundary change
  in the same session, including production code, process documents,
  templates, schemas, automation, configuration, or skill definitions; or
- change a contract merely because one implementation is convenient.

### Implementer

Inputs:

- approved checkpoint content, digest, and approval reference;
- normative authorities;
- bounded contexts or process surfaces;
- allowed implementation freedom;
- prohibited changes;
- evidence requirements; and
- old-path disposition.

Produces:

- candidate artifacts;
- focused tests and lifecycle evidence;
- closure note;
- discovered contract divergence; and
- unresolved evidence gaps.

Must not silently change the checkpoint, add an unauthorized stable claim or
path, retain an old path indefinitely as a precaution, or rewrite authority or
tests merely to make the candidate pass.

### Breaker

One fresh Breaker session receives one validated fixed packet and one assigned
perspective.

Produces findings only:

- claim or range under review;
- candidate counterexample or failure sequence;
- exact repository evidence;
- `established`, `not established`, or `incomplete` status; and
- evidence still required.

Must not implement corrections, view other Breaker reports, integrate findings,
assign final severity, recommend merge, or silently expand the assigned
perspective.

### Adjudicator

A separate fresh Adjudicator receives the validated batch, exact target,
approved checkpoint, raw Breaker reports, normative authorities, and declared
claims/ranges.

Produces:

- source-finding register;
- independently verified `established`, `rejected`, or `incomplete`
  dispositions;
- integrated root causes and severity;
- required correction, deletion, claim reduction, provisional status, or
  bounded defer;
- required proof; and
- next-state recommendation.

Must not use majority vote, treat reports as proof, implement fixes, merge, or
release.

## Structured checkpoint model

A Boundary or Milestone checkpoint uses stable identifiers.

### Claims

Each claim contains:

- `claim_id`;
- exact statement;
- controlling authority references; and
- concrete falsification.

### Ranges

Only three concepts are called ranges:

- commitment;
- lifecycle; and
- consumer.

Each range entry contains:

- `range_id`;
- `kind`;
- `value`;
- `disposition`: `included`, `out_of_range`, or `evidence_gap`;
- reason; and
- owner or follow-up when needed.

Commitment values are:

- `WIRE`;
- `DURABLE`;
- `SUPPORT`;
- `PROVISIONAL`;
- `INTERNAL`; and
- `PROCESS`.

`INTERNAL` or `PROCESS` must not hide an effect that belongs to another class.
`PROVISIONAL` requires an owner and a removal or promotion condition.

Product/runtime lifecycle values include:

- single call;
- concurrent calls;
- child process lifetime;
- model-visible tool lifetime;
- adapter/plugin lifetime;
- process restart;
- operator follow-up; and
- release/tag lifecycle.

Repository/process lifecycle values include:

- proposal and decision;
- checkpoint preparation;
- Maintainer approval;
- role handoff;
- implementation pull request;
- review batch;
- adjudication;
- merge authorization;
- release authorization; and
- post-merge or post-release follow-up.

Product/runtime consumers include:

- normative documents;
- Rust implementation;
- TypeScript implementation;
- CLI;
- adapter;
- testkit/fake;
- benchmark/timing;
- release workflow; and
- public documentation.

Repository/process consumers include:

- Maintainers;
- contributors;
- coding agents;
- repository documentation;
- Issue templates;
- pull-request templates;
- personal or workspace skill adapters;
- CI or release tooling; and
- public contributor documentation.

### Evidence requirements

Proof is represented by `evidence_requirements`, not by a fourth range type.
Each entry contains:

- `evidence_id`;
- the claim and range IDs it supports;
- the test, fixture, mutation, failure sequence, or observation;
- expected detection behavior; and
- owner.

### Review assignments

Review is represented by `review_assignments`, not by a fifth range type. Each
entry contains:

- `perspective_id`;
- one bounded question;
- failure models;
- claim, range, and evidence IDs assigned to it; and
- explicit out-of-range areas.

Every claim, every non-`out_of_range` range, and every evidence requirement must
be assigned to at least one perspective before a review batch can start.

## Checkpoint content and approval envelope

The Conductor prepares `checkpoint_content`. The digest and approval record are
outside that content.

```json
{
  "checkpoint_content": {
    "schema": "aizign.checkpoint/v1",
    "checkpoint_id": "issue-94-checkpoint-v1",
    "workflow_revision": "<exact commit>",
    "change_class": "Boundary change",
    "contract_revision": "<immutable reference>",
    "normative_authorities": [],
    "canonical_owners": [],
    "duplicate_owners_to_remove": [],
    "old_path_dispositions": [],
    "claims": [],
    "ranges": [],
    "evidence_requirements": [],
    "review_assignments": [],
    "implementation_scope": "ADR/specification | implementation | review-only",
    "known_evidence_gaps": []
  },
  "checkpoint_sha256": "sha256:<canonical checkpoint_content digest>",
  "approval": {
    "decision": "awaiting | approved | rejected",
    "approved_checkpoint_sha256": "sha256:<same digest or null while awaiting>",
    "maintainer_identity": "<verified identity or null>",
    "approved_at": "<timestamp or null>",
    "approval_reference": "<permalink or immutable reference or null>"
  }
}
```

Rules:

1. canonicalize and hash `checkpoint_content` only;
2. do not include `checkpoint_sha256` or `approval` in the hash input;
3. an approved envelope must repeat the exact digest in
   `approved_checkpoint_sha256`;
4. changing `checkpoint_content` creates a new digest and requires a new
   approval; and
5. adding or changing approval metadata does not change the checkpoint digest.

For ADR-first work, approve the ADR/specification scope first. Approve
implementation only after the controlling authority merges and the checkpoint
content is updated.

## Workflow states

### Boundary implementation path

```text
proposed
→ checkpoint prepared
→ checkpoint approved
→ implementing
→ evidence complete
→ reviewed
→ adjudicated
→ merge-ready
→ merged
→ released (when applicable)
```

| Transition | Required input | Prepared or performed by | Decision authority | Stop or rollback |
|---|---|---|---|---|
| Enter `proposed` | problem, current authorities, known findings, candidate class | Conductor and Contract Designer | design work only | authority or decision range cannot be bounded |
| `proposed → checkpoint prepared` | checkpoint content with owners, claims, ranges, evidence, review assignments, and ADR decision | Conductor from Contract Designer evidence | none | ambiguous owner, omitted subject, undisposed path, or unresolved decision |
| `checkpoint prepared → checkpoint approved` | checkpoint digest and approval request | Maintainer | Maintainer | disputed authority, range, evidence, or content |
| `checkpoint approved → implementing` | verified approval and fresh Implementer handoff | Conductor prepares; Implementer executes | approved checkpoint | checkpoint, authority, or assigned scope changes |
| `implementing → evidence complete` | fixed candidate revision, required evidence, closure note, limitations | Implementer; Conductor checks completeness | none | contract divergence, missing evidence, or undisposed path |
| `evidence complete → reviewed` | validated batch and exact target/base binding | Conductor freezes; Breakers review | none | target, batch, or required evidence is incomplete |
| `reviewed → adjudicated` | all required uncontaminated reports and fixed context | Adjudicator | none | missing, contaminated, or inconsistent input |
| `adjudicated → merge-ready` | blocking dispositions closed and all subjects covered | Conductor assesses readiness | none | blocker, incomplete finding, changed contract, or stale target |
| `merge-ready → merged` | exact candidate, required CI, repository requirements | configured actor performs | Maintainer | candidate or evidence changed, or blocker remains |
| `merged → released` | exact release candidate and release requirements | configured mechanism performs | Maintainer and release authority | candidate, approval, or release evidence mismatch |

### Review-only Milestone path

```text
proposed
→ checkpoint prepared
→ checkpoint approved
→ candidate/evidence frozen
→ reviewed
→ adjudicated
→ milestone-ready
→ Maintainer milestone decision
```

| Transition | Required input | Prepared or performed by | Decision authority | Stop or rollback |
|---|---|---|---|---|
| `checkpoint approved → candidate/evidence frozen` | exact candidate, authority set, evidence set, gaps, and validated review batch | Conductor | approved checkpoint | candidate, evidence, or checkpoint is not fixed |
| `candidate/evidence frozen → reviewed` | one validated packet per perspective | fresh Breakers | none | packet or evidence inconsistency |
| `reviewed → adjudicated` | all required uncontaminated reports | fresh Adjudicator | none | missing or contaminated report |
| `adjudicated → milestone-ready` | blocking dispositions closed and all subjects covered | Conductor assesses readiness | none | blocker, incomplete finding, or stale candidate |
| `milestone-ready → Maintainer milestone decision` | exact candidate and adjudication record | Maintainer | Maintainer | candidate or required evidence changed |

A Milestone that first creates or changes candidate artifacts uses the Boundary
implementation path to produce them, then starts a separate review-only
Milestone checkpoint for the exact candidate.

### Mandatory return to `proposed`

The affected work stops and returns to a proposed contract delta when it
requires any of:

- public-contract or normative-authority change;
- invariant, support, security, data, dependency, or compatibility change;
- expanded lifecycle or consumer range;
- materially different canonical owner;
- a new reason to retain an old path;
- a new stable code;
- a new schema or durable field; or
- an adjudication disposition that changes approved checkpoint content.

## Targeted multiple-perspective review

A Boundary change has no permanent lens list.

The Conductor derives a bounded plan from approved checkpoint content and
creates the stable `review_assignments`. Two, three, four, or another bounded
number of perspectives may be used.

Every Breaker receives:

- the same validated frozen batch context;
- one perspective assignment;
- no other Breaker report; and
- the exact evidence and out-of-range statement for that assignment.

A separate fresh Adjudicator runs after all required reports arrive. See
[Fixed review packets](review-packet.md) for the batch interface, validator,
invalidation rules, and manual procedures.

## Workflow-change bootstrap

A pull request that introduces or changes this workflow cannot treat its
candidate text as accepted review authority.

For the initial Issue #94 pull request:

- controlling authorities are named by path, section, and the base SHA;
- Issue #94 and the PR body are captured as exact snapshots with digests;
- the exact base, merge-base, target SHA, target tree, and changed-file paths are
  recorded;
- candidate workflow files are evidence under review, not review authority;
- included subjects, out-of-range areas, evidence, gaps, and PA-1/PA-2/PA-3
  coverage are frozen;
- a new immutable-by-process comment is posted for each batch ID and is never
  edited; any change creates a new batch ID and comment;
- three ordinary fresh Breaker sessions inspect governance/authority,
  executability/proportionality, and fixed-context/campaign containment;
- a separate ordinary fresh Adjudicator verifies the reports; and
- a Maintainer separately decides merge.

For later workflow revisions, use the last merged workflow revision as the
review authority and treat the candidate revision as the target.

## Campaign-specific review plans

R01-R14 is the external review plan for the current pre-v0.1 Foundation
campaign only. The existing adjudication requires one complete rerun after the
current remediation, so that rerun remains a completion condition of the same
campaign.

R01-R14 is not a normal pull-request gate, permanent taxonomy, generic skill
payload, or automatic plan for a future milestone. Future plans are derived
from the claims and risks present at that milestone.

## Manual execution

The workflow remains usable without a skill:

1. read current governance, contribution policy, the Issue, applicable
   `AGENTS.md`, and normative authorities;
2. classify the change using the canonical Routine predicate;
3. record owners, old paths, structured claims, ranges, evidence requirements,
   review assignments, and gaps;
4. commission a fresh Contract Designer when a decision is unresolved;
5. prepare `checkpoint_content`, compute its digest, and obtain a separate
   approval envelope;
6. create a fresh Implementer handoff only for a Boundary implementation path;
7. freeze the exact candidate and create all packet files;
8. run `node scripts/validate-review-batch.mjs <packet...>`;
9. run one fresh Breaker session per validated packet without sharing reports;
10. run a separate fresh Adjudicator after all reports arrive;
11. have the Conductor assess transition readiness; and
12. have a Maintainer separately make the merge, milestone, or release decision.

## Optional explicit skills

Personal or workspace skills may assist with Conduct, Break, and Adjudicate.
They are created and installed outside the repository. Each skill states in its
`description` and body that it is used only through explicit `$skill-name`
invocation.

Skills are optional adapters, not authorities. They read current tracked
procedure and authorities at invocation time, remain manually replaceable, and
do not make repository or GitHub writes merely because they were invoked.
