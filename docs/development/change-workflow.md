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
The exact fixed-context interface and manual review procedures are in
[Fixed review packets](review-packet.md).

## Applicability

Classify the change before implementation.

### Routine change

A Routine change stays inside an accepted owner-local contract and does not
change a normative authority, public behavior, durable state, support boundary,
compatibility decision, security/data boundary, lifecycle commitment, or
repository process policy.

Examples include a typo, prose correction with no claim change, internal
refactor, or bounded bug fix inside an accepted contract.

Required:

- owner-local tests when behavior changes;
- normal CI; and
- ordinary review where otherwise required.

A standing contract checkpoint, independent Breaker, or multiple-perspective
review is not required.

### Boundary change

A Boundary change affects a contract or boundary such as:

- Protocol, public API, stable code, or durable format;
- hard invariant, support claim, compatibility, retry, or unknown policy;
- adapter, process, security, data, dependency, or release boundary; or
- contribution, review, merge, or repository-governance procedure.

Required:

- Development Conductor assessment;
- contract checkpoint prepared by the Conductor and approved by a Maintainer;
- one canonical owner and complete old-path disposition;
- applicable ranges and falsification plan;
- fresh implementation session;
- targeted fresh-session Breaker review;
- separate fresh source adjudication;
- Conductor transition-readiness assessment; and
- separate Maintainer merge decision.

### Milestone review

A Milestone review evaluates an exact candidate such as a Foundation freeze,
release candidate, or dogfood entry point.

Required:

- exact candidate and evidence binding;
- milestone-specific claims, failure models, and review perspectives;
- independent adjudication; and
- Maintainer milestone or release decision.

A previous campaign plan is not automatically reused.

## Permanent rules

### No silent contract change

An Implementer must not change an authority, invariant, public claim, support
boundary, compatibility decision, lifecycle range, stable code, schema field,
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

A Boundary change states how its claim could be false and names the test,
fixture, mutation, failure sequence, or observation that must detect it. A final
result alone does not prove an unobserved mechanism.

### Review exact code and authority

Review uses an exact revision, the approved checkpoint, applicable normative
authorities, declared ranges, and relevant evidence. An Implementer's safety
narrative and green test counts are not substitutes for source evidence.

`No finding` means the assigned range was inspected and no counterexample was
established. Missing access or evidence is `INCOMPLETE`.

## Roles

Role separation is logical. A role may be performed by a person, model,
provider, or future Aizign automation. For a Boundary change, one model session
must not self-complete contract design, implementation, Breaker review, and
adjudication.

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
- release decision.

A Maintainer must not treat a Conductor readiness report, completed template,
or green CI as sufficient proof by itself.

The same human may also act as Conductor, but the record must separate:

```text
Conductor assessment:
Maintainer decision:
```

### Development Conductor

The Development Conductor owns composition, ranges, evidence status, role
handoffs, and transition-readiness assessment rather than universal technical
expertise.

Inputs:

- current repository and exact revision;
- current Issue and pull request;
- `GOVERNANCE.md`, `CONTRIBUTING.md`, this procedure, and applicable
  `AGENTS.md` files;
- current normative authorities; and
- known findings and evidence.

Produces:

- change class and current workflow state;
- commitment, lifecycle, consumer, proof, and review ranges;
- canonical owner and duplicate-owner candidates;
- checkpoint draft;
- Contract Designer and Implementer handoffs;
- targeted review coverage map and packets;
- Adjudicator handoff; and
- transition-readiness report for the Maintainer.

Must not:

- implement production code;
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
- applicable ranges; and
- falsification plan.

Must not implement production code in the same Boundary-change session or
change a contract merely because one implementation is convenient.

### Implementer

Inputs:

- approved checkpoint and approval reference;
- normative authorities;
- bounded contexts or process surfaces;
- allowed implementation freedom;
- prohibited changes;
- proof and falsification plan; and
- old-path disposition.

Produces:

- implementation;
- focused tests and lifecycle evidence;
- closure note;
- discovered contract divergence; and
- unresolved evidence gaps.

Must not silently change the checkpoint, add an unauthorized stable claim or
path, retain an old path indefinitely as a precaution, or rewrite authority or
tests merely to make the implementation pass.

### Breaker

One fresh Breaker session receives one fixed packet and one assigned
perspective.

Produces findings only:

- claim under review;
- candidate counterexample or failure sequence;
- exact repository evidence;
- `established`, `not established`, or `incomplete` status; and
- evidence still required.

Must not implement corrections, view other Breaker reports, integrate findings,
assign final severity, recommend merge, or silently expand the assigned
perspective.

### Adjudicator

A separate fresh Adjudicator receives the exact target, approved checkpoint,
fixed packets, raw Breaker reports, normative authorities, and declared ranges.

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

## Required ranges

A Boundary change records each applicable range as included and assigned,
explicitly out of range with a reason and owner where needed, or an evidence
gap.

### Commitment range

- `WIRE`
- `DURABLE`
- `SUPPORT`
- `PROVISIONAL`
- `INTERNAL`
- `PROCESS`

`INTERNAL` or `PROCESS` must not hide an effect that belongs to another class.
`PROVISIONAL` requires an owner and a removal or promotion condition.

### Product/runtime lifecycle profile

- single call;
- concurrent calls;
- child process lifetime;
- model-visible tool lifetime;
- adapter/plugin lifetime;
- process restart;
- operator follow-up;
- release/tag lifecycle.

### Repository/process lifecycle profile

- proposal and decision;
- checkpoint preparation;
- Maintainer approval;
- role handoff;
- implementation pull request;
- review batch;
- adjudication;
- merge authorization;
- release authorization;
- post-merge or post-release follow-up.

A change may use both lifecycle profiles.

### Product/runtime consumer profile

- normative documents;
- Rust implementation;
- TypeScript implementation;
- CLI;
- adapter;
- testkit/fake;
- benchmark/timing;
- release workflow;
- public documentation.

### Repository/process consumer profile

- Maintainers;
- contributors;
- coding agents;
- repository documentation;
- Issue templates;
- pull-request templates;
- personal or workspace skill adapters;
- CI or release tooling;
- public contributor documentation.

## Workflow states

The full Boundary/Milestone sequence is:

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
→ released
```

`released` applies only when the change participates in a release.

| Transition | Required input | Prepared or performed by | Decision authority | Stop or rollback |
|---|---|---|---|---|
| Enter `proposed` | problem, current authorities, known findings, candidate class | Conductor and Contract Designer | design work only | authority or decision range cannot be bounded |
| `proposed → checkpoint prepared` | contract delta, non-goals, owner, old paths, ranges, falsification plan, ADR decision | Conductor from Contract Designer evidence | none | ambiguous owner, omitted range, undisposed path, or unresolved decision |
| `checkpoint prepared → checkpoint approved` | exact checkpoint snapshot and references | Maintainer | Maintainer | disputed authority, range, or content |
| `checkpoint approved → implementing` | verified approval and fresh Implementer handoff | Conductor prepares; Implementer executes | approved checkpoint | checkpoint, authority, or range changes |
| `implementing → evidence complete` | fixed implementation revision, focused evidence, closure note, limitations | Implementer; Conductor checks completeness | none | contract divergence, missing proof, or undisposed path |
| `evidence complete → reviewed` | exact target/base binding, approved checkpoint, coverage map, fixed packets | Conductor freezes; Breakers review | none | target, packet, or required evidence is incomplete |
| `reviewed → adjudicated` | all required uncontaminated reports and fixed context | Adjudicator | none | missing, contaminated, or inconsistent input |
| `adjudicated → merge-ready` | blocking dispositions closed and declared ranges covered | Conductor assesses readiness | none | blocker, incomplete finding, changed contract, or stale target |
| `merge-ready → merged` | exact candidate, required CI, repository requirements | configured actor performs | Maintainer | candidate or evidence changed, or blocker remains |
| `merged → released` | exact release candidate and release requirements | configured mechanism performs | Maintainer and release authority | candidate, approval, or release evidence mismatch |

### Mandatory return to `proposed`

The affected work stops and returns to a proposed contract delta when it
requires any of:

- public-behavior or normative-authority change;
- invariant, support, or compatibility change;
- expanded lifecycle or consumer range;
- materially different canonical owner;
- a new reason to retain an old path;
- a new stable code;
- a new schema or durable field; or
- an adjudication disposition that changes the approved checkpoint.

## Contract checkpoint

The Conductor prepares the checkpoint; a Maintainer approves or rejects the
exact snapshot.

Use this template:

```markdown
## Contract checkpoint

> This record authorizes a workflow transition for the stated revision and
> range. It does not amend or replace a product/runtime authority.

- **Checkpoint ID:** <stable identifier>
- **Development Conductor:** <identity or role assignment>
- **Workflow revision:** <exact commit>
- **Change class:** Routine change | Boundary change | Milestone review
- **Contract/decision revision:** <permalink or immutable reference>
- **Normative authorities:**
  - <path, revision, and section>
- **Canonical owner:** <one owner for each changed policy or surface>
- **Duplicate owners to remove:** <paths or None>
- **Old-path disposition:**
  - <path> — deleted | migrated | provisional until <trigger> | retained for <distinct responsibility>
- **Commitment range:**
  - Included: <WIRE | DURABLE | SUPPORT | PROVISIONAL | INTERNAL | PROCESS>
  - Explicitly out of range: <class, reason, and owner>
  - Evidence gaps: <gap and owner or None>
- **Lifecycle range:**
  - Included: <selected product/runtime and/or repository/process scopes>
  - Explicitly out of range: <scope, reason, and owner>
  - Evidence gaps: <gap and owner or None>
- **Consumer range:**
  - Included: <selected consumers>
  - Explicitly out of range: <consumer, reason, and owner>
  - Evidence gaps: <gap and owner or None>
- **Falsifying evidence:**
  - <claim> would be false if <mutation, counterexample, or failure sequence>.
  - <test, fixture, or observation> must detect it.
- **Required targeted review:**
  - Perspective count: <bounded number>
  - Coverage: <claim/range → perspective IDs>
  - Initially withheld inputs: <for example other Breaker reports>
- **Implementation scope:** <ADR/specification | implementation | review-only>
- **Checkpoint digest:** <sha256 of this exact snapshot>
- **Maintainer decision:** awaiting approval | approved | rejected
- **Maintainer identity:** <verified identity or empty>
- **Approval reference:** <permalink or immutable reference or empty>
```

Editing an approved checkpoint creates a new checkpoint ID, digest, and
approval record.

For ADR-first work, approve the ADR/specification scope first. Approve
implementation only after the controlling authority merges and the checkpoint
is updated.

## Targeted multiple-perspective review

A Boundary change has no permanent lens list.

The Conductor derives a bounded plan from the approved checkpoint, commitment
classes, lifecycle ranges, consumer ranges, failure models, and known evidence
gaps. Two, three, four, or another bounded number of perspectives may be used.

Every included claim and range maps to at least one perspective in a coverage
map. Missing coverage is `INCOMPLETE` and prevents the batch from starting.

Every Breaker receives:

- the same frozen shared batch context;
- one perspective assignment;
- no other Breaker report; and
- the exact evidence and out-of-range statement for that assignment.

A separate fresh Adjudicator runs after all required reports arrive. See
[Fixed review packets](review-packet.md) for the interface, invalidation rules,
and manual procedures.

## Workflow-change bootstrap

A pull request that introduces or changes this workflow cannot treat its
candidate text as accepted review authority.

For the initial Issue #94 PR:

- current tracked governance and contribution files remain controlling;
- Issue #94 is the frozen design basis;
- the exact base, merge-base, target SHA, and changed-file set are recorded;
- candidate workflow files are evidence under review;
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
payload, or automatic plan for a future milestone. Future review plans are
derived from the claims and risks present at that milestone.

## Manual execution

The workflow is usable without Codex or a skill:

1. read current governance, contribution policy, the Issue, applicable
   `AGENTS.md`, and normative authorities;
2. classify the change and record ranges, owners, old paths, and evidence gaps;
3. commission a fresh Contract Designer when a decision is unresolved;
4. prepare the checkpoint and obtain a separate Maintainer decision;
5. create a self-contained fresh Implementer handoff;
6. stop and return to proposal on contract divergence;
7. freeze an exact review batch and one packet per perspective;
8. run one fresh Breaker session per packet without sharing reports;
9. run a separate fresh Adjudicator after all reports arrive;
10. have the Conductor assess transition readiness; and
11. have a Maintainer separately make the merge or release decision.

## Optional explicit skills

Personal or workspace skills may assist with Conduct, Break, and Adjudicate.
They are created and installed outside the repository. Each skill must state in
its `description` and body that it is used only through explicit `$skill-name`
invocation.

Skills are optional adapters, not authorities. They read this current tracked
procedure and the applicable repository authorities at invocation time, remain
manually replaceable, and do not make repository or GitHub writes merely
because they were invoked. The repository does not register or own the skill
packages.
