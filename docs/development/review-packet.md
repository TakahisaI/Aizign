# Fixed review packets

## Status and authority

This file is the required fixed-context interface delegated by
[`change-workflow.md`](change-workflow.md) for Boundary and Milestone reviews.
It defines workflow evidence, not product or runtime authority.

A review packet prevents reviewers from independently reconstructing mutable
Issue, pull-request, CI, milestone, or release context. It does not prove that a
claim is correct. Breakers still inspect exact source and a separate
Adjudicator still verifies their findings.

The complete batch is validated with:

```sh
node scripts/validate-review-batch.mjs <packet-1.json> <packet-2.json> ...
```

Digest agreement alone is not packet validity. The validator checks the closed
interface, nested content digests, cross-field consistency, shared context,
coverage, and perspective uniqueness before a review begins.

## Batch model

A targeted review has:

- one frozen shared `batch_context`;
- structured checkpoint claims, ranges, evidence requirements, and review
  assignments;
- one packet file per perspective; and
- one fresh Breaker session per validated packet.

All packets in a batch contain byte-equivalent canonical `batch_context` data
and the same `batch_context_sha256`. Only `packet_id`, `packet_sha256`, and the
single `assignment` differ.

The batch is frozen after all packet files pass the batch validator and before
the first Breaker session begins.

## Required binding

### Controlling authorities

Record each controlling authority with:

- stable authority ID;
- repository path;
- exact revision;
- relevant section; and
- purpose.

For the initial workflow bootstrap, controlling governance and contribution
authorities are read from the base SHA. Candidate workflow files are review
evidence, not controlling authority.

### Workflow mode

Record either:

- `merged`: the last merged workflow and review-packet paths at one exact
  revision; or
- `bootstrap`: no candidate workflow is used as authority, and the workflow
  revision equals the target base SHA.

### Target and comparison base

Record:

- target commit SHA;
- target tree SHA;
- pull-request number and head SHA when applicable;
- base ref;
- base SHA;
- merge-base SHA; and
- the exact changed-file path list.

A pull-request review uses the merge base to define the changed range. A target
SHA or changed-file count alone is insufficient.

Useful read-only commands include:

```sh
git rev-parse <target-sha>
git rev-parse '<target-sha>^{tree}'
git merge-base <base-sha> <target-sha>
git diff --name-only <merge-base-sha>..<target-sha>
git diff <merge-base-sha>..<target-sha>
```

### Checkpoint content and approval

Record:

- exact `checkpoint_content`;
- `checkpoint_sha256`, calculated from canonical `checkpoint_content` only;
- an approval envelope outside the hash input; and
- the approval envelope's `approved_checkpoint_sha256`, which must equal the
  calculated checkpoint digest when approved.

Do not hash a field that contains its own digest. Adding approval metadata does
not change checkpoint content or its digest.

### Frozen mutable context

Freeze Issue and pull-request bodies that define the reviewed claim. Each
snapshot has:

- stable snapshot ID;
- kind and number;
- source reference;
- capture time;
- exactly one of inline `content` or repository-relative `artifact_path`; and
- SHA-256 of the exact inline UTF-8 bytes or artifact bytes.

A later comment or body edit is not injected into an active batch. Create a new
batch when it changes binding context.

### External constraints and retained artifacts

External constraints use the same content envelope: source, capture time,
exactly one of inline content or artifact path, and a verified SHA-256.

Repository evidence records path and exact revision. Retained evidence uses an
artifact envelope whose bytes are rehashed by the validator.

### Subjects and coverage

The checkpoint defines stable IDs for:

- claims;
- ranges; and
- evidence requirements.

The validator requires every claim, every range whose disposition is not
`out_of_range`, and every evidence requirement to appear in one or more review
assignments.

The batch `coverage` table uses only those stable IDs. Free-text claims are not
accepted as coverage keys. Every perspective in coverage must have exactly one
packet, and every packet assignment must exactly match the checkpoint's review
assignment with that perspective ID.

## Packet interface

Each packet uses `aizign.review-packet/v1`:

```json
{
  "schema": "aizign.review-packet/v1",
  "packet_id": "issue-94-pr-95-0123456789ab-pa1",
  "packet_sha256": "sha256:<packet digest>",
  "batch_id": "issue-94-pr-95-0123456789ab-v3",
  "batch_context_sha256": "sha256:<batch context digest>",
  "batch_context": {
    "schema": "aizign.review-batch-context/v1",
    "context_id": "issue-94-pr-95-0123456789ab-context-v3",
    "created_at": "2026-08-25T00:00:00Z",
    "repository": "TakahisaI/Aizign",
    "workflow": {
      "mode": "bootstrap",
      "procedure_path": null,
      "review_packet_path": null,
      "revision": "fedcba9876543210fedcba9876543210fedcba98"
    },
    "controlling_authorities": [
      {
        "authority_id": "AUTH-GOVERNANCE",
        "path": "GOVERNANCE.md",
        "revision": "fedcba9876543210fedcba9876543210fedcba98",
        "section": "Roles and decisions",
        "purpose": "Controls Maintainer, merge, and release authority"
      }
    ],
    "target": {
      "sha": "0123456789abcdef0123456789abcdef01234567",
      "tree_sha": "89abcdef0123456789abcdef0123456789abcdef",
      "pull_request_number": 95,
      "pull_request_head_sha": "0123456789abcdef0123456789abcdef01234567",
      "base_ref": "main",
      "base_sha": "fedcba9876543210fedcba9876543210fedcba98",
      "merge_base_sha": "fedcba9876543210fedcba9876543210fedcba98",
      "changed_files": [
        ".github/ISSUE_TEMPLATE/proposal.yml",
        ".github/pull_request_template.md"
      ]
    },
    "checkpoint": {
      "checkpoint_content": {
        "schema": "aizign.checkpoint/v1",
        "checkpoint_id": "issue-94-checkpoint-v1",
        "workflow_revision": "fedcba9876543210fedcba9876543210fedcba98",
        "change_class": "Boundary change",
        "contract_revision": "issue-94-body-v3",
        "normative_authorities": [
          {
            "authority_id": "AUTH-GOVERNANCE",
            "path": "GOVERNANCE.md",
            "revision": "fedcba9876543210fedcba9876543210fedcba98",
            "section": "Roles and decisions",
            "purpose": "Controls Maintainer authority"
          }
        ],
        "canonical_owners": [
          {
            "owner_id": "OWNER-WORKFLOW",
            "surface": "Boundary change operating procedure",
            "path": "docs/development/change-workflow.md"
          }
        ],
        "duplicate_owners_to_remove": [],
        "old_path_dispositions": [],
        "claims": [
          {
            "claim_id": "CLM-MAINTAINER-AUTHORITY",
            "statement": "Maintainer approval, merge, and release authority remain separate from Conductor assessment.",
            "authority_ids": ["AUTH-GOVERNANCE"],
            "falsification": "The candidate would be false if a Conductor could approve or merge without a separately recorded Maintainer decision."
          }
        ],
        "ranges": [
          {
            "range_id": "RNG-PROCESS",
            "kind": "commitment",
            "value": "PROCESS",
            "disposition": "included",
            "reason": "The candidate changes repository review procedure.",
            "owner_or_follow_up": "OWNER-WORKFLOW"
          }
        ],
        "evidence_requirements": [
          {
            "evidence_id": "EVD-AUTHORITY-SEPARATION",
            "subject_ids": ["CLM-MAINTAINER-AUTHORITY", "RNG-PROCESS"],
            "method": "Inspect governance, contribution policy, ADR, workflow, and templates at the exact revisions.",
            "expected_detection": "A role crossover must produce an established finding.",
            "owner": "PA-1"
          }
        ],
        "review_assignments": [
          {
            "perspective_id": "PA-1",
            "title": "Governance and authority",
            "question": "Does the candidate preserve Maintainer authority and prevent Conductor role crossover?",
            "failure_models": [
              "The Conductor can edit the candidate artifacts or approve the resulting change."
            ],
            "subject_ids": [
              "CLM-MAINTAINER-AUTHORITY",
              "RNG-PROCESS",
              "EVD-AUTHORITY-SEPARATION"
            ],
            "required_checks": [
              "GOVERNANCE.md",
              "CONTRIBUTING.md",
              "docs/adr/0016-adopt-the-conductor-led-boundary-change-workflow.md",
              "docs/development/change-workflow.md"
            ],
            "assignment_out_of_range": [
              "product implementation correctness"
            ]
          }
        ],
        "implementation_scope": "review-only",
        "known_evidence_gaps": []
      },
      "checkpoint_sha256": "sha256:<checkpoint content digest>",
      "approval": {
        "decision": "approved",
        "approved_checkpoint_sha256": "sha256:<same checkpoint content digest>",
        "maintainer_identity": "TakahisaI",
        "approved_at": "2026-08-25T00:00:00Z",
        "approval_reference": "https://github.com/TakahisaI/Aizign/issues/94"
      }
    },
    "issue_pr_snapshots": [
      {
        "snapshot_id": "SNAP-ISSUE-94",
        "kind": "issue",
        "number": 94,
        "source_reference": "https://github.com/TakahisaI/Aizign/issues/94",
        "captured_at": "2026-08-25T00:00:00Z",
        "content": "<exact Issue body>",
        "artifact_path": null,
        "sha256": "sha256:<exact UTF-8 content digest>"
      }
    ],
    "external_constraints": [],
    "evidence": [
      {
        "evidence_id": "EVIDENCE-WORKFLOW",
        "kind": "repository",
        "path": "docs/development/change-workflow.md",
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "purpose": "Candidate procedure under review"
      }
    ],
    "coverage": [
      {
        "subject_id": "CLM-MAINTAINER-AUTHORITY",
        "perspective_ids": ["PA-1"]
      },
      {
        "subject_id": "RNG-PROCESS",
        "perspective_ids": ["PA-1"]
      },
      {
        "subject_id": "EVD-AUTHORITY-SEPARATION",
        "perspective_ids": ["PA-1"]
      }
    ],
    "global_out_of_range": [
      {
        "area": "product/runtime behavior",
        "reason": "The candidate changes process artifacts only.",
        "owner_or_follow_up": "none"
      }
    ],
    "known_evidence_gaps": []
  },
  "assignment": {
    "perspective_id": "PA-1",
    "title": "Governance and authority",
    "question": "Does the candidate preserve Maintainer authority and prevent Conductor role crossover?",
    "failure_models": [
      "The Conductor can edit the candidate artifacts or approve the resulting change."
    ],
    "subject_ids": [
      "CLM-MAINTAINER-AUTHORITY",
      "RNG-PROCESS",
      "EVD-AUTHORITY-SEPARATION"
    ],
    "required_checks": [
      "GOVERNANCE.md",
      "CONTRIBUTING.md",
      "docs/adr/0016-adopt-the-conductor-led-boundary-change-workflow.md",
      "docs/development/change-workflow.md"
    ],
    "assignment_out_of_range": [
      "product implementation correctness"
    ]
  }
}
```

The example uses placeholders and is not a valid review packet until all
content, digests, revisions, and assignments are complete and the batch
validator succeeds.

## Closed interface rules

The validator rejects:

- missing required fields;
- unknown fields at every defined object level;
- unknown schema identifiers;
- wrong types or invalid enums;
- malformed SHA-1 or SHA-256 values;
- a PR target whose target SHA differs from its PR head SHA;
- bootstrap workflow revision that differs from the base SHA;
- checkpoint digest mismatch or approval/digest mismatch;
- duplicate IDs;
- references to unknown authority, claim, range, evidence, or perspective IDs;
- an inline/artifact content envelope with neither or both values;
- nested snapshot or artifact digest mismatch;
- unsafe absolute or parent-traversing artifact paths;
- different batch contexts inside one batch;
- duplicate or missing perspective packets;
- a packet assignment that differs from its checkpoint assignment;
- incomplete subject coverage; and
- packet or batch-context digest mismatch.

## Digest rules

Canonical JSON is UTF-8 JSON with object keys sorted lexicographically, array
order preserved, Unicode preserved, and no insignificant whitespace. Numbers
must be safe integers; use strings for timestamps, versions, and identifiers.

Calculate:

```text
checkpoint_sha256 = SHA-256(canonical(checkpoint_content))
batch_context_sha256 = SHA-256(canonical(batch_context))
packet_sha256 = SHA-256(canonical(packet with packet_sha256 omitted))
```

The approval envelope and `checkpoint_sha256` are not part of
`checkpoint_content`. The packet digest does include the stored
`batch_context_sha256` and full `batch_context`.

## Content and artifact envelopes

For snapshots and retained artifacts:

- `content` is a UTF-8 string or `null`;
- `artifact_path` is a repository-relative path or `null`;
- exactly one is non-null; and
- `sha256` covers the exact content bytes or file bytes.

The validator resolves artifact paths from the repository root (its current
working directory). A reviewer must receive the same bytes named by the
validated packet.

## Batch validation

Run all packet files in one command:

```sh
node scripts/validate-review-batch.mjs \
  review-packets/pa-1.json \
  review-packets/pa-2.json \
  review-packets/pa-3.json
```

A successful exit means the supplied files form one internally consistent
batch under the tracked interface. It does not prove the reviewed claims.

Never validate packets one by one and infer batch equivalence from separate
successes.

## Invalidation

Create a new batch ID and new packet files when any binding input changes:

- target SHA or tree SHA;
- base SHA or merge-base SHA;
- exact changed-file list;
- checkpoint content, digest, or approval;
- controlling authority or workflow revision;
- frozen Issue or pull-request snapshot;
- claim, range, evidence requirement, or review assignment;
- retained evidence; or
- known evidence gap.

### Binding context and observational evidence

A change to binding context invalidates the batch.

Later observational evidence, such as a CI job becoming green or a new
non-binding comment, is not silently added. Check it separately at merge or
milestone readiness, or create a new batch when it materially changes the
adjudication.

## Bootstrap batch record

For the initial Issue #94 workflow review:

1. use a new batch ID for every target head;
2. post the batch record in a new Issue or PR comment;
3. never edit that batch comment;
4. name controlling authority paths, sections, and base revisions;
5. include exact Issue and PR body snapshots or immutable artifacts and their
   digests;
6. list every changed file path, not only the count;
7. record claims, ranges, evidence, gaps, review assignments, and coverage; and
8. provide one validated packet per PA-1/PA-2/PA-3 session.

A permalink is provenance only. Reviewers verify the exact embedded content and
digests. If the comment is edited or any binding value changes, discard it and
create a new batch ID and comment.

## Manual equivalent: Conductor packet preparation

1. resolve exact repository, target, tree, base, merge-base, and changed paths;
2. identify controlling authorities at exact revisions;
3. prepare checkpoint content, calculate its digest, and verify approval;
4. freeze Issue, PR, external-constraint, and retained evidence bytes;
5. record structured claims, ranges, evidence requirements, and assignments;
6. build coverage from stable subject IDs;
7. copy one identical `batch_context` into one packet per perspective;
8. add exactly one matching assignment to each packet;
9. calculate nested, context, and packet digests;
10. validate all packet files together; and
11. start no reviewer until validation succeeds.

## Manual equivalent: Breaker

1. start a fresh session with exactly one validated packet and no other Breaker
   report;
2. verify target/base binding, controlling authorities, checkpoint, and packet
   identity;
3. investigate only the assigned subject IDs and failure models;
4. construct a candidate counterexample or failure sequence;
5. inspect exact source, tests, specifications, and frozen snapshots;
6. distinguish observed fact from inference;
7. classify each candidate as `established`, `not established`, or
   `incomplete`;
8. cite exact repository evidence; and
9. return findings only.

If another Breaker report is visible in the session, return:

```text
status: CONTAMINATED
reason: another Breaker report was visible
required_action: start a new fresh session with only this packet
```

Do not claim the report was successfully ignored after it entered the session.

### Breaker output

```markdown
# Aizign Breaker report

## Review identity

- packet_id:
- packet_sha256:
- batch_id:
- perspective_id:
- workflow_revision:
- target_sha:
- target_tree_sha:
- base_sha:
- merge_base_sha:
- other Breaker reports visible: false
- repository/GitHub writes performed: none

## Assigned subjects

- claim IDs:
- range IDs:
- evidence IDs:
- explicit out-of-range areas:

## Claim and candidate counterexample

- claim:
- candidate counterexample or failure sequence:

## Evidence inspected

List exact paths, symbols, tests, fixtures, and frozen snapshot references.

## Findings

### <perspective-id>-<number>: <title>

- status: established | not established | incomplete
- basis: observed fact | inference
- repository evidence:
- concrete counterexample or failure sequence:
- affected subject IDs:
- correction or claim reduction required:
- evidence still required:

## Checked and held

List assigned subjects deliberately checked without an established
counterexample.

## Evidence gaps

List every incomplete area and required evidence.

## Out-of-range referrals

List possible concerns without investigating or assigning severity.
```

## Manual equivalent: Adjudicator

1. start another fresh session after all required uncontaminated reports arrive;
2. verify target, base, authorities, workflow mode, checkpoint, packets,
   coverage, and report identity consistency;
3. create a source-finding register covering every raw finding;
4. reinspect source and authority evidence independently;
5. classify each source finding as `established`, `rejected`, or `incomplete`;
6. integrate only findings with the same causal mechanism, affected
   commitment, broken claim, and minimal disposition;
7. assign severity from verified impact rather than report count;
8. choose implementation correction, path deletion, claim reduction,
   provisional status, or bounded defer;
9. state the proof required before the next transition; and
10. recommend the next state without authorizing merge or release.

A bounded defer is complete only when it records the known limitation, impact,
safe current boundary, owner, re-evaluation trigger, retained evidence, and
compatibility or migration treatment where applicable. The current Foundation
campaign may label such a complete campaign-specific defer `D1`; the generic
workflow does not make `D1` a permanent taxonomy.
