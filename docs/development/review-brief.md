# Manual review brief

## Purpose

A review brief gives fresh Breaker and Adjudicator sessions one shared,
human-readable view of an exact Boundary or Milestone candidate.

During the pre-v0.1 pilot, the brief is Markdown. It is prepared manually by
the Conductor and may be posted as an unedited pull-request comment or retained
as a temporary review artifact. It is workflow evidence, not product authority.

No JSON schema, packet digest, generated batch, or validator is required.

## Required format

```markdown
# Aizign review brief

## Identity

- brief_id: issue-<n>-pr-<n>-v<n>
- repository: owner/name
- change_class: Boundary change | Milestone review
- issue: <permalink>
- pull_request: <permalink or not applicable>
- target_sha: <40-hex commit>
- base_sha: <40-hex commit>
- merge_base_sha: <40-hex commit>
- changed_paths:
  - <path>
- workflow_mode: merged | bootstrap
- workflow_authority: <path and exact revision>
- expected_breaker_reports: <count>

## Accepted decision

<Copy the accepted contract or process decision. Link the Issue/ADR record.>

## Controlling authorities

- <path>@<revision> — <relevant section and purpose>

## Canonical owner and old paths

- canonical owner: <path or component>
- old/overlapping path: <deleted | migrated | provisional with trigger | retained for distinct responsibility>

## In scope

- <area>

## Out of scope

- <area and reason>

## Claims, failure cases, and evidence

| Claim or question | Concrete failure case | Evidence to inspect |
|---|---|---|
| <what should be true> | <how it could fail> | <path, test, command, fixture, or retained artifact> |

## Evidence available

- <exact evidence and result>

## Known gaps

- <gap, owner or next action>

## Perspective assignments

### P1 — <title>

- question: <one bounded question>
- failure models:
  - <failure model>
- required evidence:
  - <path or evidence item>
- out of scope:
  - <area>

### P2 — <title, when required>

...

## Review execution

- Breaker skill: `$aizign-break`
- Adjudicator skill: `$aizign-adjudicate`
- Other Breaker reports supplied to each Breaker: no
```

## Preparation rules

The Conductor checks the following before the first Breaker starts:

- the target commit exists and matches the pull-request head when applicable;
- base, merge-base, and changed paths describe the reviewed diff;
- the accepted decision is quoted or linked unambiguously;
- controlling authorities are exact enough to locate;
- scope, owner, old paths, evidence, and gaps are explicit;
- every perspective has one bounded question, failure models, required
  evidence, and out-of-scope areas; and
- `expected_breaker_reports` equals the number of perspective assignments.

A successful manual check means the brief is usable. It does not prove that the
claims are true or complete.

## Invalidation

Create a new `brief_id` when any of these changes:

- target SHA, base, merge-base, or changed paths;
- accepted decision or controlling authority;
- in-scope or out-of-scope area;
- canonical owner or old-path disposition;
- material claim, failure case, known gap, or perspective assignment.

Later CI or observational evidence for the same target may be appended without
creating a new brief, provided it does not change a reviewed claim or scope.

Do not edit an active brief in place in a way that hides what the Breakers
received. Post or retain a new version and mark the previous one superseded.

## Breaker report identity

Each Breaker report starts with:

```text
brief_id:
perspective:
target_sha:
other Breaker reports visible: false
repository/GitHub writes performed: none
```

The report uses `established`, `not established`, or `incomplete` for each
candidate and separates observed fact from inference.

## Adjudication input

The Adjudicator receives:

- the complete review brief;
- all reports expected by the brief;
- access to the exact target and controlling authorities; and
- relevant evidence referenced by the brief.

A missing or mismatched report is `INCOMPLETE`. The Adjudicator independently
verifies source findings and may recommend `blocked`, `needs evidence`, or
`ready for Maintainer decision`; it does not authorize merge or release.
